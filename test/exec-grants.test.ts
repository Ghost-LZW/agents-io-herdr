/**
 * Whether a call may be taken (docs/exec.md N5; acceptance cases 7 and 9): the owner, the
 * deadline, the tier, and the owner's grant — expired, used, another generation, too long, another
 * command, a window in another conversation or a group turn — and widening only where the runner
 * sweeps. Then the collector: hello says exec.v1 and the ceiling while it is valid, calls are
 * admitted and handed to the runner (a fake one here; test/exec-run.test.ts has the real one), and
 * `exec off` makes it say hello again with sessions only.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keepNodeKey, newNodeKey, runCollector, type SessionsConfig, sessionsPaths } from "../src/collector.ts";
import { type Ceiling, parseCeiling, resolveCeiling } from "../src/exec/ceiling.ts";
import { type CallFrame, commandHash, type Origin } from "../src/exec/frames.ts";
import { writeNodeRecord } from "../src/exec/generation.ts";
import { admitExec, type Grant, GrantsUsed, USED_KEEP_MS } from "../src/exec/grants.ts";
import { execPaths } from "../src/exec/paths.ts";
import type { Runner, RunPlan } from "../src/exec/run.ts";
import type { Exec } from "../src/system.ts";

/** The contract's group call with its once grant, and the needs_grant sample (test/fixtures/exec-contract.json). */
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "exec-contract.json"), "utf8")) as {
  frames: {
    call: {
      exec_group_granted: {
        id: string;
        op: string;
        effect_id: string;
        deadline: number;
        generation: number;
        grant: { node: string; commandHash: string };
        origin: unknown;
        args: Record<string, unknown>;
      };
    };
    result: { refused: { needs_grant: { error: { data: { commandHash: string } } } } };
  };
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp() {
  const d = mkdtempSync(join(tmpdir(), "aio-herdr-grant-"));
  dirs.push(d);
  return d;
}

const T0 = 1_761_300_000_000;
const NODE = "00000000-0000-4000-8000-00000000000a";
const OWNER = "00000000-0000-4000-8000-0000000000b1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const CONV = "00000000-0000-4000-8000-0000000000d1";

function ceilingOf(home: string, over: Record<string, unknown> = {}): Ceiling {
  const raw = JSON.stringify({
    version: 2,
    runner: "same",
    read: { roots: ["~/repos/app"] },
    write: ["~/repos/app/build"],
    grants: { maxMinutes: 15, window: true },
    limits: { maxSeconds: 120 },
    ...over,
  });
  const p = parseCeiling(raw);
  if (!p.ok) throw new Error(p.problems.join("; "));
  const r = resolveCeiling(p.file, { raw, home });
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.ceiling;
}

const origin = (over: Partial<Origin> = {}): Origin => ({
  conversation: CONV,
  turn: "inp_0001",
  person: OWNER,
  agent: "00000000-0000-4000-8000-0000000000c1",
  attended: true,
  where: "dm",
  ...over,
});

function call(argv: string[], over: Partial<CallFrame> & { args?: Record<string, unknown> } = {}): CallFrame {
  const { args, ...rest } = over;
  return {
    id: "c1",
    op: "exec.v1",
    effectId: "eff_g1",
    deadline: T0 + 60_000,
    generation: 3,
    grant: null,
    origin: origin(),
    args: {
      argv,
      cwd: "~/repos/app",
      shell: false,
      stdin: null,
      env: {},
      policy: { network: "off", write: [] },
      ...args,
    },
    ...rest,
  };
}

const hashOf = (argv: string[], cwd = "~/repos/app") =>
  commandHash({ argv, cwd, shell: false, network: "off", write: [] });

const grant = (over: Partial<Grant> = {}): Grant => ({
  id: "gr_0001",
  node: NODE,
  generation: 3,
  kind: "once",
  commandHash: hashOf(["git", "push"]),
  scope: null,
  approvedBy: OWNER,
  approvedAt: T0 - 60_000,
  expiresAt: T0 + 600_000,
  card: "om_0001",
  ...over,
});

function setup(over: Record<string, unknown> = {}) {
  const d = temp();
  const home = join(d, "home");
  const c = ceilingOf(home, over);
  const used = new GrantsUsed(join(d, "grants-used.jsonl"), () => T0);
  const ctx = { ceiling: c, nodeId: NODE, owner: OWNER, generation: 3, lbNow: T0, used };
  return { d, home, c, used, ctx, admit: (x: CallFrame) => admitExec(x, ctx) };
}

const code = (r: ReturnType<typeof admitExec>) => (r.ok ? "ok" : r.answer.ok ? "?" : r.answer.error.code);
const message = (r: ReturnType<typeof admitExec>) => (!r.ok && !r.answer.ok ? r.answer.error.message : "");

describe("admitting a call", () => {
  it("an auto command runs with what is in effect; a grant one says what to ask the owner for", () => {
    const { admit } = setup({ commands: { default: "grant", auto: ["git status"] } });
    const ok = admit(call(["git", "status"]));
    expect(ok).toMatchObject({
      ok: true,
      admission: { tier: "auto", why: "git status", grant: null, deadline: T0 + 60_000 },
    });
    const r = admit(call(["git", "push"]));
    expect(r).toEqual({
      ok: false,
      answer: {
        ok: false,
        error: {
          code: "needs_grant",
          message: "needs the owner's grant (default)",
          data: { tier: "grant", commandHash: hashOf(["git", "push"]), maxMinutes: 15, window: true },
        },
      },
    });
  });

  it("not the owner, a passed or too-far deadline, a never command, too much stdin (I-9)", () => {
    const { admit } = setup({ others: [OTHER] });
    expect(code(admit(call(["ls"], { origin: origin({ person: "someone-else" }) })))).toBe("not_owner");
    expect(code(admit(call(["git", "status"], { origin: origin({ person: OTHER }) })))).toBe("needs_grant");
    expect(code(admit(call(["ls"], { deadline: T0 })))).toBe("deadline_passed");
    expect(code(admit(call(["ls"], { deadline: T0 + 120_000 + 60_001 })))).toBe("deadline_too_far");
    expect(code(admit(call(["sudo", "ls"])))).toBe("never");
    expect(code(admit(call(["cat"], { args: { stdin: "x".repeat(64 * 1024 + 1) } })))).toBe("too_large");
    expect(code(admit(call(["ls"], { args: { argv: [] } })))).toBe("bad_request");
    const nobody = admitExec(call(["ls"]), { ...setup().ctx, owner: null });
    expect(code(nobody)).toBe("not_owner");
  });

  it("an unattended turn gets nothing, auto commands included, unless the ceiling allows", () => {
    const s = setup({ commands: { default: "grant", auto: ["ls"] } });
    const away = origin({ attended: false, where: "routine" });
    expect(code(s.admit(call(["ls"], { origin: away })))).toBe("unattended");
    expect(code(s.admit(call(["git", "push"], { origin: away })))).toBe("unattended");
    expect(code(s.admit(call(["ls"])))).toBe("ok");
    const m = setup({ commands: { default: "grant", auto: ["ls"] }, unattended: true });
    expect(code(m.admit(call(["ls"], { origin: away })))).toBe("ok");
    expect(code(m.admit(call(["git", "push"], { origin: away })))).toBe("needs_grant");
  });

  it("a group turn asks even for auto commands, and never gets a window", () => {
    const { admit } = setup({ commands: { default: "grant", auto: ["ls"] } });
    const r = admit(call(["ls"], { origin: origin({ where: "group" }) }));
    expect(!r.ok && !r.answer.ok && r.answer.error).toMatchObject({
      code: "needs_grant",
      message: "needs the owner's grant (group)",
      data: { window: false },
    });
    const w = grant({ kind: "window", commandHash: null, scope: { conversation: CONV, cwd: "~/repos/app" } });
    expect(message(admit(call(["ls"], { origin: origin({ where: "group" }), grant: w })))).toBe(
      "no window grants for a group turn",
    );
  });
});

describe("checking the owner's grant (I-7)", () => {
  it("a valid once grant admits the run, under it; used once, it is refused", () => {
    const { admit, used } = setup();
    const r = admit(call(["git", "push"], { grant: grant() }));
    expect(r).toMatchObject({ ok: true, admission: { tier: "grant", grant: { id: "gr_0001" } } });
    used.use("gr_0001");
    expect(message(admit(call(["git", "push"], { grant: grant() })))).toBe("the grant was used already");
  });

  it("expired, another generation or node, not the owner's, too long, another command: grant_invalid", () => {
    const { admit } = setup();
    const bad = (g: Partial<Grant> | Record<string, unknown>) => {
      const r = admit(call(["git", "push"], { grant: { ...grant(), ...g } }));
      return [code(r), message(r)];
    };
    expect(bad({ expiresAt: T0 })).toEqual(["grant_invalid", "the grant has expired"]);
    expect(bad({ generation: 2 })).toEqual(["grant_invalid", "the grant is for another generation"]);
    expect(bad({ node: "another-node" })).toEqual(["grant_invalid", "the grant is for another node"]);
    expect(bad({ approvedBy: OTHER })).toEqual(["grant_invalid", "the grant was not approved by this machine's owner"]);
    expect(bad({ approvedAt: T0 - 60_000, expiresAt: T0 - 60_000 + 15 * 60_000 + 1 })).toEqual([
      "grant_invalid",
      "the grant is longer than this machine allows (15 min)",
    ]);
    expect(bad({ commandHash: hashOf(["git", "push", "--tags"]) })).toEqual([
      "grant_invalid",
      "the grant is for another command",
    ]);
    expect(bad({ id: "not-a-grant" })).toEqual(["grant_invalid", "the grant does not read"]);
  });

  it("a window grant: the same conversation and directory; none where the ceiling takes no windows", () => {
    const w = grant({ kind: "window", commandHash: null, scope: { conversation: CONV, cwd: "~/repos/app" } });
    const { admit } = setup();
    expect(code(admit(call(["git", "push"], { grant: w })))).toBe("ok");
    expect(message(admit(call(["git", "push"], { grant: w, origin: origin({ conversation: "another" }) })))).toBe(
      "the grant is for another conversation",
    );
    const narrow = { ...w, scope: { conversation: CONV, cwd: "~/repos/app/src" } };
    expect(message(admit(call(["git", "push"], { grant: narrow })))).toBe("cwd is outside the grant's directory");
    const s = setup({ grants: { maxMinutes: 15, window: false } });
    expect(message(s.admit(call(["git", "push"], { grant: w })))).toBe("this machine takes no window grants");
  });

  it("widening: off on a person's own computer; elsewhere a once grant for exactly this run", () => {
    const own = setup({ widenOnGrant: { network: "off", write: ["~/repos/app"] } });
    const wide = { args: { policy: { network: "off", write: ["~/repos/app/src"] } } };
    expect(code(own.admit(call(["make"], wide)))).toBe("widen_disabled");
    const d = temp();
    const home = join(d, "users", "agent");
    const agent = ceilingOf(home, {
      runner: "user",
      user: { name: "agent", home },
      read: { roots: ["~/work"] },
      write: ["~/work/out"],
      commands: { default: "auto" },
      widenOnGrant: { network: "off", write: ["~/work"] },
    });
    const used = new GrantsUsed(join(d, "used.jsonl"), () => T0);
    const ctx = { ceiling: agent, nodeId: NODE, owner: OWNER, generation: 3, lbNow: T0, used };
    const run = (g: unknown) =>
      admitExec(
        call(["make"], { grant: g, args: { cwd: "~/work", policy: { network: "off", write: ["~/work/src"] } } }),
        ctx,
      );
    const asked = run(null);
    expect(!asked.ok && !asked.answer.ok && asked.answer.error).toMatchObject({
      code: "needs_grant",
      message: "needs the owner's grant (write ~/work/src)",
      data: { window: false },
    });
    const h = commandHash({ argv: ["make"], cwd: "~/work", shell: false, network: "off", write: ["~/work/src"] });
    expect(code(run(grant({ commandHash: h })))).toBe("ok");
    const w = grant({ kind: "window", commandHash: null, scope: { conversation: CONV, cwd: "~/work" } });
    expect(message(run(w))).toBe("widening takes a once grant");
  });

  it("the contract's group call with its once grant is admitted where the ceiling has the proxy", () => {
    const d = temp();
    const home = join(d, "home");
    const c = ceilingOf(home, {
      read: { roots: ["~/repos/工程"] },
      write: ["~/repos/工程"],
      network: "proxy",
      proxy: { port: 18_080, allow: ["example.org"] },
      envPass: ["PATH", "LANG", "TERM"],
      limits: { maxSeconds: 1800 },
    });
    const m = fixture.frames.call.exec_group_granted;
    const frame: CallFrame = {
      id: m.id,
      op: m.op,
      args: m.args,
      effectId: m.effect_id,
      deadline: m.deadline,
      generation: m.generation,
      grant: m.grant,
      origin: m.origin as Origin,
    };
    const used = new GrantsUsed(join(d, "used.jsonl"), () => T0);
    const r = admitExec(frame, { ceiling: c, nodeId: m.grant.node, owner: OWNER, generation: 3, lbNow: T0, used });
    expect(r).toMatchObject({ ok: true, admission: { tier: "grant", why: "shell", commandHash: m.grant.commandHash } });
    const asked = admitExec(
      { ...frame, grant: null },
      { ceiling: c, nodeId: NODE, owner: OWNER, generation: 3, lbNow: T0, used },
    );
    expect(!asked.ok && !asked.answer.ok && asked.answer.error.data).toEqual({
      tier: "grant",
      commandHash: fixture.frames.result.refused.needs_grant.error.data.commandHash,
      maxMinutes: 15,
      window: false,
    });
  });
});

describe("used once grants", () => {
  it("are kept on disk (0600), read again, and forgotten after a day; a torn line is dropped", () => {
    const d = temp();
    const path = join(d, "exec", "grants-used.jsonl");
    let now = T0;
    const u = new GrantsUsed(path, () => now);
    u.use("gr_a");
    expect(() => u.use("gr_a")).toThrow(/used already/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, `${readFileSync(path, "utf8")}{"id":"gr_b","a`);
    now = T0 + 1000;
    const again = new GrantsUsed(path, () => now);
    expect(again.has("gr_a")).toBe(true);
    expect(again.size).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify({ id: "gr_a", at: T0 })}\n`);
    now = T0 + USED_KEEP_MS + 1;
    again.prune();
    expect(again.has("gr_a")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("");
  });
});

// ---- in the collector -----------------------------------------------------------------------------

class FakeWs {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closed: { code?: number; reason?: string }[] = [];
  #on: Record<string, (ev: { data?: unknown; code?: number }) => void> = {};
  send(s: string) {
    this.sent.push(JSON.parse(s) as Record<string, unknown>);
  }
  close(code?: number, reason?: string) {
    this.closed.push({ code, reason });
    this.readyState = 3;
    this.#on.close?.({ code });
  }
  addEventListener(t: string, f: (ev: { data?: unknown; code?: number }) => void) {
    this.#on[t] = f;
  }
  lb(m: Record<string, unknown>) {
    this.#on.message?.({ data: JSON.stringify(m) });
  }
  of(t: string) {
    return this.sent.filter((f) => f.t === t);
  }
}

const noProcesses: Exec = (cmd) => (cmd === "ps" || cmd === "lsof" ? { code: 0, stdout: "", stderr: "" } : null);

describe("the ceiling and grants in the collector", () => {
  it("hello says exec.v1 and the ceiling; calls are admitted; exec off says hello again with sessions only", async () => {
    const home = temp();
    const paths = sessionsPaths({}, home);
    const ep = execPaths(paths.dir);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    chmodSync(paths.dir, 0o700);
    writeNodeRecord(ep.node, { node: NODE, owner: OWNER, generation: 3 });
    mkdirSync(join(home, "repos", "app"), { recursive: true });
    writeFileSync(
      ep.ceiling,
      JSON.stringify({ version: 2, read: { roots: ["~/repos/app"] }, commands: { default: "grant", auto: ["ls"] } }),
      { mode: 0o600 },
    );
    const keyFile = join(paths.dir, "node-key.pem");
    keepNodeKey(newNodeKey(), { file: keyFile }, noProcesses);
    const c: SessionsConfig = {
      machine: "host-a",
      recentHours: 24,
      intervalSec: 10,
      report: { lbUrl: "https://lb.example", nodeId: NODE, keyFile },
    };
    const sockets: FakeWs[] = [];
    let n = 0;
    const plans: RunPlan[] = [];
    // Runs end at once with `done`: the effect frame follows the `running` result.
    const runner: Runner = {
      kind: "same",
      prepare: async (plan) => {
        plans.push(plan);
        return {
          ok: true,
          prepared: {
            discard: () => undefined,
            start: () => ({
              pgid: null,
              stop: () => undefined,
              done: Promise.resolve({
                state: "done" as const,
                exit: 0,
                signal: null,
                reason: null,
                stdout: "x\n",
                stderr: "",
                redacted: { stdout: 0, stderr: 0 },
                truncated: false,
                bytes: { stdout: 2, stderr: 0 },
              }),
            }),
          },
        };
      },
    };
    const exec = (id: string, argv: string[]) => ({
      t: "call",
      id,
      op: "exec.v1",
      effect_id: `eff_${id}`,
      deadline: T0 + 60_000,
      generation: 3,
      grant: null,
      origin: origin(),
      args: { argv, cwd: "~/repos/app", shell: false, stdin: null, env: {}, policy: { network: "off", write: [] } },
    });
    await runCollector(c, paths, {
      home,
      env: {},
      exec: noProcesses,
      now: () => T0,
      log: () => undefined,
      herdr: async () => null,
      parent: () => 1,
      pid: 111,
      bootAt: () => T0 - 3_600_000,
      runner: () => runner,
      connect: () => {
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
      sleep: async () => {
        // Let a reconnect at once (a timer of 0) happen first.
        await new Promise((r) => setTimeout(r, 5));
        const ws = sockets.at(-1);
        n++;
        if (n === 1) {
          ws?.lb({ t: "challenge", nonce: "bm9uY2U=" });
          ws?.lb({ t: "welcome", generation: 3, owner: OWNER, now: T0, exec: true });
          ws?.lb(exec("a1", ["ls"]));
          ws?.lb(exec("a2", ["git", "push"]));
        } else if (n === 2) writeFileSync(ep.off, "");
        else if (n === 3) ws?.lb({ t: "challenge", nonce: "bm9uY2U=" });
        else writeFileSync(paths.pid, "222\n");
      },
    });
    const [first, second] = sockets;
    expect(first?.sent[0]).toMatchObject({
      t: "hello",
      caps: ["sessions", "exec.v1"],
      generation: 3,
      ceiling: { sha: expect.stringMatching(/^[0-9a-f]{16}$/), summary: { version: 2, exec: "on" } },
    });
    // a2 is refused at once; a1 is answered once the runner has prepared it.
    expect(first?.of("result")).toEqual([
      {
        t: "result",
        id: "a2",
        ok: false,
        error: {
          code: "needs_grant",
          message: "needs the owner's grant (default)",
          data: { tier: "grant", commandHash: hashOf(["git", "push"]), maxMinutes: 15, window: false },
        },
      },
      {
        t: "result",
        id: "a1",
        ok: true,
        data: {
          effect_id: "eff_a1",
          state: "running",
          effective: { network: "off", write: [], maxSeconds: 120, outputBytes: 65_536 },
        },
      },
    ]);
    expect(first?.of("effect")).toMatchObject([{ effect_id: "eff_a1", state: "done", exit: 0, stdout: "x\n" }]);
    expect(plans).toMatchObject([{ effectId: "eff_a1", argv: ["ls"], cwd: join(home, "repos", "app"), home: null }]);
    expect(plans[0]?.env).toMatchObject({ TERM: "dumb" });
    expect(plans[0]?.env).not.toHaveProperty("HOME");
    // exec off: the link says hello again at once, with sessions only and no ceiling.
    expect(first?.closed).toEqual([{ code: 1000, reason: "relink" }]);
    expect(second?.sent[0]).toMatchObject({ t: "hello", caps: ["sessions"], generation: 3 });
    expect(second?.sent[0]).not.toHaveProperty("ceiling");
  });
});
