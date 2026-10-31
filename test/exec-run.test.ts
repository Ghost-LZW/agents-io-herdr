/**
 * Running a command (docs/exec.md N7; acceptance cases 4 and 13): real `/bin/sh` children, without
 * the sandbox (test/exec-sandbox.test.ts has that, on macOS). The effect is on disk before the run
 * starts; the deadline kills the whole process group and reports what came out so far; a machine
 * that slept past the deadline reports `timeout`; at most `limits.concurrent` at a time; cancel.v1,
 * a new generation and the collector going stop runs; a collector that died leaves its runs to the
 * next, which stops them by process group — and leaves alone a group whose id was reused.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Ceiling, parseCeiling, resolveCeiling } from "../src/exec/ceiling.ts";
import { EffectLedger } from "../src/exec/effects.ts";
import { Executor } from "../src/exec/executor.ts";
import { type CallFrame, commandHash, type EffectReport, parseCall } from "../src/exec/frames.ts";
import { GrantsUsed } from "../src/exec/grants.ts";
import {
  etimeMs,
  Proc,
  type Runner,
  type RunPlan,
  reapOrphans,
  resolveCommand,
  SameUserRunner,
} from "../src/exec/run.ts";
import { realExec } from "../src/system.ts";

const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const p of pids.splice(0))
    try {
      process.kill(-p, "SIGKILL");
    } catch {
      // Gone.
    }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp() {
  const d = mkdtempSync(join(tmpdir(), "aio-herdr-run-"));
  dirs.push(d);
  return d;
}

const NODE = "00000000-0000-4000-8000-00000000000a";
const OWNER = "00000000-0000-4000-8000-0000000000b1";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(20);
  }
}

function ceilingOf(home: string, over: Record<string, unknown> = {}): Ceiling {
  const raw = JSON.stringify({
    version: 2,
    commands: { default: "auto" },
    read: { roots: ["~/repos/app"] },
    write: ["~/repos/app/out"],
    limits: { maxSeconds: 60, outputBytes: 4096, concurrent: 1 },
    grants: { maxMinutes: 15, window: true },
    envPass: ["PATH", "LANG", "TERM"],
    ...over,
  });
  const p = parseCeiling(raw);
  if (!p.ok) throw new Error(p.problems.join("; "));
  const r = resolveCeiling(p.file, { raw, home });
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.ceiling;
}

/** A shell script in the root, run by path (auto under `default: auto`; no sandbox in these tests). */
function script(home: string, name: string, body: string): string {
  const f = join(home, "repos", "app", name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
  return f;
}

function frame(id: string, argv: string[], o: { deadline?: number; op?: string; args?: object } = {}): CallFrame {
  const c = parseCall({
    t: "call",
    id: `c-${id}`,
    op: o.op ?? "exec.v1",
    effect_id: `eff_${id}`,
    deadline: o.deadline ?? Date.now() + 30_000,
    generation: 3,
    grant: null,
    origin: {
      conversation: "conv",
      turn: "inp_1",
      person: OWNER,
      agent: "agent",
      attended: true,
      where: "dm",
    },
    args: o.args ?? {
      argv,
      cwd: "~/repos/app",
      shell: false,
      stdin: null,
      env: {},
      policy: { network: "off", write: [] },
    },
  });
  if (!c) throw new Error("bad call");
  return c;
}

function setup(over: Record<string, unknown> = {}, env: Record<string, string> = { PATH: "/usr/bin:/bin" }) {
  const d = temp();
  const home = join(d, "home");
  mkdirSync(join(home, "repos", "app", "out"), { recursive: true });
  const c = ceilingOf(home, over);
  const ledger = EffectLedger.open(join(d, "exec", "effects.jsonl"), { now: Date.now, bootAt: 0 });
  const used = new GrantsUsed(join(d, "exec", "grants-used.jsonl"), Date.now);
  const base = join(d, "runs");
  const runner = new SameUserRunner({ now: Date.now, log: () => undefined, sandboxExec: null, base, graceMs: 300 });
  const sent: EffectReport[] = [];
  const x = new Executor({
    ledger,
    used,
    runnerFor: () => runner,
    env,
    now: Date.now,
    log: () => undefined,
    exec: realExec,
    sendEffect: (r) => sent.push(r),
    graceMs: 300,
  });
  const ctx = () => ({ ceiling: c, scan: null, nodeId: NODE, owner: OWNER, generation: 3, lbNow: Date.now() });
  const take = (f: CallFrame) => x.take(f, `hash-${f.effectId}`, ctx());
  return { d, home, c, ledger, used, base, runner, x, sent, take };
}

describe("a run", () => {
  it("is on disk running before it starts; ends done with its output bounded and redacted; only envPass, its own HOME", async () => {
    const s = setup({}, { PATH: "/usr/bin:/bin", LANG: "C", GH_TOKEN: "ghp_secret", SECRET_X: "nope" });
    const f = script(
      s.home,
      "show.sh",
      [
        'echo "token=abcdefghijklmnop"',
        'echo "home=$HOME"',
        'echo "tmp=$TMPDIR"',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template.
        'echo "lang=$LANG term=$TERM x=${SECRET_X:-unset} gh=${GH_TOKEN:-unset}"',
        "pwd",
        "head -c 9000 /dev/zero | tr '\\0' a",
        "echo err >&2",
      ].join("\n"),
    );
    const a = await s.take(frame("one", [f]));
    expect(a).toEqual({
      ok: true,
      data: {
        effect_id: "eff_one",
        state: "running",
        effective: { network: "off", write: [], maxSeconds: 60, outputBytes: 4096 },
      },
    });
    // Written before the process started, and its process group with it.
    expect(s.ledger.get("eff_one")).toMatchObject({
      state: "running",
      argsHash: "hash-eff_one",
      origin: { person: OWNER, conversation: "conv" },
    });
    expect(s.ledger.get("eff_one")?.proc?.pgid).toBeGreaterThan(1);
    await until(() => s.sent.length === 1);
    const e = s.sent[0] as EffectReport;
    expect(e).toMatchObject({ effect_id: "eff_one", state: "done", exit: 0, truncated: true, reason: null });
    // The run's own directory: the effect id and a suffix of its own.
    const name = /home=.*\/(eff_one\.[0-9a-f]{8})\/home\n/.exec(e.stdout)?.[1] ?? "?";
    const run = join(realpathSync(s.base), name);
    expect(e.stdout).toContain("token=[REDACTED]");
    expect(e.stdout).toContain(`home=${join(run, "home")}\n`);
    expect(e.stdout).toContain(`tmp=${join(run, "tmp")}/\n`);
    expect(e.stdout).toContain("lang=C term=dumb x=unset gh=unset\n");
    expect(e.stdout).toContain(`${join(s.home, "repos", "app")}\n`);
    expect(Buffer.byteLength(e.stdout)).toBeLessThanOrEqual(4096);
    expect(e.bytes.stdout).toBeGreaterThan(9000);
    expect(e.redacted.stdout).toBe(1);
    expect(e.stderr).toBe("err\n");
    expect(s.ledger.get("eff_one")).toMatchObject({ state: "done", exit: 0 });
    // The run's own directory is gone.
    expect(existsSync(run)).toBe(false);
  });

  it("a bare argv[0] is looked up along the collector's PATH, not a PATH LB asked for (which the run gets)", async () => {
    const s = setup();
    mkdirSync(join(s.home, "repos", "app", "bin"));
    script(s.home, "bin/ls", "echo not-ls");
    const show = script(s.home, "show-path.sh", 'echo "$PATH"');
    const asked = `${join(s.home, "repos", "app", "bin")}:/usr/bin:/bin`;
    const args = (argv: string[]) => ({
      argv,
      cwd: "~/repos/app",
      shell: false,
      stdin: null,
      env: { PATH: asked },
      policy: { network: "off", write: [] },
    });
    expect(await s.take(frame("path", [], { args: args(["ls"]) }))).toMatchObject({ ok: true });
    await until(() => s.sent.length === 1);
    expect(s.sent[0]).toMatchObject({ effect_id: "eff_path", state: "done", exit: 0 });
    expect(s.sent[0]?.stdout).not.toContain("not-ls");
    expect(s.sent[0]?.stdout).toContain("bin\n");
    expect(await s.take(frame("path2", [], { args: args([show]) }))).toMatchObject({ ok: true });
    await until(() => s.sent.length === 2);
    expect(s.sent[1]?.stdout).toBe(`${asked}\n`);
  });

  it("no such program: an effect all the same, failed (not_found)", async () => {
    const s = setup();
    expect(await s.take(frame("none", ["no-such-program-here"]))).toMatchObject({ ok: true });
    await until(() => s.sent.length === 1);
    expect(s.sent[0]).toMatchObject({ effect_id: "eff_none", state: "failed", reason: "not_found" });
  });

  it("case 4: a deadline already past is refused; one reached kills the whole group, with the output so far", async () => {
    const s = setup();
    expect(await s.take(frame("late", ["/bin/echo"], { deadline: Date.now() - 1 }))).toMatchObject({
      ok: false,
      error: { code: "deadline_passed" },
    });
    const pidFile = join(s.home, "repos", "app", "child.pid");
    const f = script(s.home, "slow.sh", `echo started\nsleep 30 &\necho $! > '${pidFile}'\nwait`);
    expect(await s.take(frame("slow", [f], { deadline: Date.now() + 1200 }))).toMatchObject({ ok: true });
    await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const child = Number(readFileSync(pidFile, "utf8"));
    pids.push(child);
    expect(alive(child)).toBe(true);
    await until(() => s.sent.length === 1, 8000);
    expect(s.sent[0]).toMatchObject({
      effect_id: "eff_slow",
      state: "timeout",
      reason: "deadline",
      stdout: "started\n",
    });
    // The grandchild went with the group.
    await until(() => !alive(child));
  });

  it("a machine that slept past the deadline: timeout on waking", async () => {
    let jump = 0;
    const now = () => Date.now() + jump;
    const out: Buffer[] = [];
    const p = new Proc(
      {
        argv: ["/bin/sleep", "30"],
        cwd: tmpdir(),
        env: { PATH: "/usr/bin:/bin" },
        stdin: null,
        deadline: Date.now() + 60_000,
        profileFile: null,
      },
      { now, onStdout: (b) => out.push(b), onStderr: () => undefined, graceMs: 200 },
    );
    if (p.pid) pids.push(p.pid);
    await sleep(100);
    // The wall clock jumps past the deadline, as after a sleep of the machine.
    jump = 120_000;
    const end = await p.done;
    expect(end).toMatchObject({ state: "timeout", reason: "deadline" });
  });

  it("at most limits.concurrent at a time: busy", async () => {
    const s = setup();
    const f = script(s.home, "wait.sh", "sleep 30");
    expect(await s.take(frame("a", [f]))).toMatchObject({ ok: true });
    expect(await s.take(frame("b", [f]))).toMatchObject({ ok: false, error: { code: "busy" } });
    expect(s.ledger.get("eff_b")).toBeUndefined();
    s.x.stopAll("test");
    await until(() => s.sent.length === 1);
    expect(s.sent[0]).toMatchObject({ effect_id: "eff_a", state: "cancelled", reason: "test" });
  });

  it("cancel.v1 stops the target (exit 0); a target not running is exit 1; both are effects of their own", async () => {
    const s = setup();
    const f = script(s.home, "wait.sh", "echo going\nsleep 30");
    expect(await s.take(frame("t", [f]))).toMatchObject({ ok: true });
    await sleep(100);
    const c = await s.take(
      frame("c1", [], { op: "cancel.v1", deadline: Date.now() + 10_000, args: { target: "eff_t" } }),
    );
    expect(c).toMatchObject({
      ok: true,
      data: {
        effect_id: "eff_c1",
        state: "done",
        exit: 0,
        reason: null,
        target: { effect_id: "eff_t", state: "running" },
      },
    });
    await until(() => s.sent.some((e) => e.effect_id === "eff_t"));
    expect(s.sent.find((e) => e.effect_id === "eff_t")).toMatchObject({ state: "cancelled", reason: "cancel" });
    const again = await s.take(
      frame("c2", [], { op: "cancel.v1", deadline: Date.now() + 10_000, args: { target: "eff_t" } }),
    );
    expect(again).toMatchObject({ ok: true, data: { exit: 1, reason: "not_running", target: { state: "cancelled" } } });
    const none = await s.take(
      frame("c3", [], { op: "cancel.v1", deadline: Date.now() + 10_000, args: { target: "eff_nothing" } }),
    );
    expect(none).toMatchObject({ ok: true, data: { exit: 1, reason: "not_found", target: { state: null } } });
    expect(s.sent.filter((e) => e.effect_id.startsWith("eff_c")).map((e) => e.effect_id)).toEqual([
      "eff_c1",
      "eff_c2",
      "eff_c3",
    ]);
  });

  it("a once grant is marked used with the claim", async () => {
    const s = setup({ commands: { default: "grant" } });
    const f = script(s.home, "x.sh", "true");
    const hash = commandHash({ argv: [f], cwd: "~/repos/app", shell: false, network: "off", write: [] });
    const call = frame("g", [f]);
    call.grant = {
      id: "gr_once",
      node: NODE,
      generation: 3,
      kind: "once",
      commandHash: hash,
      approvedBy: OWNER,
      approvedAt: Date.now() - 1000,
      expiresAt: Date.now() + 600_000,
    };
    expect(await s.take(call)).toMatchObject({ ok: true });
    expect(s.used.has("gr_once")).toBe(true);
    expect(s.ledger.get("eff_g")?.grant).toBe("gr_once");
    await until(() => s.sent.length === 1);
    const replay = frame("g2", [f]);
    replay.grant = call.grant;
    expect(await s.take(replay)).toMatchObject({ ok: false, error: { code: "grant_invalid" } });
  });

  it("the collector going: runs are cancelled, and what does not end in time is unknown", async () => {
    const s = setup({ limits: { maxSeconds: 60, outputBytes: 4096, concurrent: 2 } });
    const quick = script(s.home, "quick.sh", "sleep 30");
    // Ignores SIGTERM: still going when the collector gives up waiting.
    const stubborn = join(s.home, "repos", "app", "stubborn.pl");
    const ready = join(s.home, "repos", "app", "ready");
    writeFileSync(stubborn, `#!/usr/bin/perl\n$SIG{TERM} = 'IGNORE';\nopen(F, '>${ready}'); close(F);\nsleep 30;\n`);
    chmodSync(stubborn, 0o755);
    expect(await s.take(frame("q", [quick]))).toMatchObject({ ok: true });
    expect(await s.take(frame("s", [stubborn]))).toMatchObject({ ok: true });
    await until(() => existsSync(ready));
    await s.x.shutdown(150);
    expect(s.ledger.get("eff_q")).toMatchObject({ state: "cancelled", reason: "collector_restart" });
    expect(s.ledger.get("eff_s")).toMatchObject({ state: "unknown", reason: "collector_restart" });
    // Its group is still there for the next collector (SIGKILL comes after the 300 ms grace here).
    const pg = s.ledger.get("eff_s")?.proc?.pgid as number;
    pids.push(pg);
  });
});

describe("case 13: a collector that died", () => {
  it("the next one stops what it left running, by process group", async () => {
    const s = setup();
    const f = script(s.home, "long.sh", "sleep 30 &\nwait");
    expect(await s.take(frame("orphan", [f]))).toMatchObject({ ok: true });
    const pgid = s.ledger.get("eff_orphan")?.proc?.pgid as number;
    pids.push(pgid);
    await sleep(100);
    expect(alive(pgid)).toBe(true);
    // kill -9 of the collector: nothing more is written. A new one opens the same ledger.
    const next = EffectLedger.open(s.ledger.path, { now: Date.now, bootAt: 0 });
    expect(next.get("eff_orphan")).toMatchObject({ state: "unknown", reason: "collector_restart" });
    const x = new Executor({
      ledger: next,
      used: s.used,
      runnerFor: () => s.runner,
      env: {},
      now: Date.now,
      log: () => undefined,
      exec: realExec,
      sendEffect: () => undefined,
      graceMs: 300,
    });
    expect(x.reap()).toEqual([pgid]);
    await until(() => !alive(pgid));
  });

  it("a group id now someone else's (its first process started at another time) is left alone", () => {
    const killed: [number, string][] = [];
    const now = 1_761_300_000_000;
    const ps = (rows: string) => () => ({ code: 0, stdout: rows, stderr: "" });
    const log: string[] = [];
    // The run started 10 s ago; pid 4242 has been up for an hour.
    const r1 = reapOrphans([{ pgid: 4242, spawnedAt: now - 10_000 }], {
      now: () => now,
      exec: ps("  4242  4242    01:00:00\n  4243  4242    59:59\n"),
      kill: (p, sig) => killed.push([p, sig]),
      log: (x) => log.push(x),
    });
    expect(r1).toEqual([]);
    expect(killed).toEqual([]);
    expect(log.join("\n")).toContain("left alone");
    // The same run's group, its first process up for 10 s: stopped.
    const r2 = reapOrphans([{ pgid: 4242, spawnedAt: now - 10_000 }], {
      now: () => now,
      exec: ps("  4242  4242    00:10\n  4250  4242    00:05\n"),
      kill: (p, sig) => killed.push([p, sig]),
      graceMs: 1,
      log: () => undefined,
    });
    expect(r2).toEqual([4242]);
    expect(killed[0]).toEqual([-4242, "SIGTERM"]);
    // Its first process gone, members left: still the run's (a group id stays taken while it has members).
    const r3 = reapOrphans([{ pgid: 777, spawnedAt: now - 10_000 }], {
      now: () => now,
      exec: ps("  780   777    00:08\n"),
      kill: () => undefined,
      log: () => undefined,
    });
    expect(r3).toEqual([777]);
    expect(etimeMs("1-02:03:04")).toBe(((24 + 2) * 3600 + 3 * 60 + 4) * 1000);
    expect(etimeMs("03:04")).toBe(184_000);
  });
});

describe("argv[0]", () => {
  it("along PATH, by path, and xcrun's stubs as the real program", () => {
    const d = temp();
    const bin = join(d, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "tool"), "#!/bin/sh\n");
    chmodSync(join(bin, "tool"), 0o755);
    writeFileSync(join(bin, "plain"), "not executable");
    expect(resolveCommand("tool", { path: `/nowhere:${bin}`, cwd: d })).toBe(join(bin, "tool"));
    expect(resolveCommand("plain", { path: bin, cwd: d })).toBeNull();
    expect(resolveCommand("./bin/tool", { path: "", cwd: d })).toBe(join(bin, "tool"));
    expect(resolveCommand("missing", { path: bin, cwd: d })).toBeNull();
    if (existsSync("/usr/bin/git")) {
      const asked: string[][] = [];
      const real = resolveCommand("git", {
        path: "/usr/bin",
        cwd: d,
        exec: (cmd, args) => {
          asked.push([cmd, ...args]);
          return { code: 0, stdout: `${join(bin, "tool")}\n`, stderr: "" };
        },
      });
      expect(asked).toEqual([["/usr/bin/xcrun", "--find", "git"]]);
      expect(real).toBe(join(bin, "tool"));
    }
  });
});

describe("the executor around the runner", () => {
  /** A runner whose prepare waits until the test lets it go, and whose runs end when told. */
  function slowRunner(o: { sweep?: () => Promise<{ killed: number; comms: string[] } | null> } = {}) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const discarded: string[] = [];
    const ends: (() => void)[] = [];
    const plans: RunPlan[] = [];
    const runner: Runner = {
      kind: o.sweep ? "user" : "same",
      prepare: async (plan) => {
        plans.push(plan);
        await gate;
        return {
          ok: true,
          prepared: {
            discard: () => discarded.push(plan.effectId),
            start: () => ({
              pgid: null,
              stop: () => undefined,
              done: new Promise((resolve) =>
                ends.push(() =>
                  resolve({
                    state: "done",
                    exit: 0,
                    signal: null,
                    reason: null,
                    stdout: "",
                    stderr: "",
                    redacted: { stdout: 0, stderr: 0 },
                    truncated: false,
                    bytes: { stdout: 0, stderr: 0 },
                  }),
                ),
              ),
            }),
          },
        };
      },
      ...(o.sweep && { sweep: o.sweep }),
    };
    return { runner, release, discarded, ends, plans };
  }

  function executor(runner: Runner, over: Record<string, unknown> = {}) {
    const d = temp();
    const home = join(d, "home");
    mkdirSync(join(home, "repos", "app", "out"), { recursive: true });
    const c = ceilingOf(home, over);
    const ledger = EffectLedger.open(join(d, "effects.jsonl"), { now: Date.now, bootAt: 0 });
    const sent: EffectReport[] = [];
    let clock = Date.now();
    const x = new Executor({
      ledger,
      used: new GrantsUsed(join(d, "used.jsonl"), Date.now),
      runnerFor: () => runner,
      env: { PATH: "/usr/bin:/bin" },
      now: () => clock,
      log: () => undefined,
      exec: realExec,
      sendEffect: (r) => sent.push(r),
    });
    return { x, c, ledger, sent, now: () => clock, advance: (ms: number) => (clock += ms) };
  }

  it("the runner gets the deadline on this machine's clock; the ledger keeps LB's", async () => {
    const r = slowRunner();
    r.release();
    const e = executor(r.runner);
    // LB's clock 20 s ahead of this one.
    const lbNow = e.now() + 20_000;
    const ctx = { ceiling: e.c, scan: null, nodeId: NODE, owner: OWNER, generation: 3, lbNow };
    const f = frame("k", ["/bin/echo"], { deadline: lbNow + 30_000 });
    expect(await e.x.take(f, "h", ctx)).toMatchObject({ ok: true });
    expect(r.plans[0]?.deadline).toBe(e.now() + 30_000);
    expect(e.ledger.get("eff_k")?.deadline).toBe(lbNow + 30_000);
  });

  it("the same id while it is being prepared: busy; the gate shut meanwhile: stale_generation, prepared discarded", async () => {
    const r = slowRunner();
    const e = executor(r.runner);
    let open = true;
    const ctx = {
      ceiling: e.c,
      scan: null,
      nodeId: NODE,
      owner: OWNER,
      generation: 3,
      lbNow: Date.now(),
      open: () => open,
    };
    const first = e.x.take(frame("p", ["/bin/echo"]), "h", ctx);
    expect(await e.x.take(frame("p", ["/bin/echo"]), "h", ctx)).toMatchObject({ ok: false, error: { code: "busy" } });
    open = false;
    r.release();
    expect(await first).toMatchObject({ ok: false, error: { code: "stale_generation" } });
    expect(r.discarded).toEqual(["eff_p"]);
    expect(e.ledger.get("eff_p")).toBeUndefined();
  });

  it("the dedicated user is swept first, after a run that wrote, and every 15 minutes (busy until then)", async () => {
    const sweeps: number[] = [];
    const r = slowRunner({
      sweep: async () => {
        sweeps.push(1);
        return { killed: 0, comms: [] };
      },
    });
    r.release();
    const e = executor(r.runner, { limits: { maxSeconds: 60, outputBytes: 4096, concurrent: 2 } });
    const ctx = () => ({ ceiling: e.c, scan: null, nodeId: NODE, owner: OWNER, generation: 3, lbNow: Date.now() });
    // Not swept since start: new work waits.
    expect(await e.x.take(frame("s1", ["/bin/echo"]), "h1", ctx())).toMatchObject({
      ok: false,
      error: { code: "busy" },
    });
    await e.x.tick(e.c);
    expect(sweeps).toHaveLength(1);
    const writes = {
      argv: ["/bin/echo"],
      cwd: "~/repos/app",
      shell: false,
      stdin: null,
      env: {},
      policy: { network: "off", write: ["~/repos/app/out"] },
    };
    expect(await e.x.take(frame("s2", [], { args: writes }), "h2", ctx())).toMatchObject({ ok: true });
    // While it runs, no sweep.
    await e.x.tick(e.c);
    expect(sweeps).toHaveLength(1);
    r.ends[0]?.();
    await until(() => e.sent.length === 1);
    await e.x.tick(e.c);
    expect(sweeps).toHaveLength(2);
    // A read-only run does not make one due.
    expect(await e.x.take(frame("s3", ["/bin/echo"]), "h3", ctx())).toMatchObject({ ok: true });
    r.ends[1]?.();
    await until(() => e.sent.length === 2);
    await e.x.tick(e.c);
    expect(sweeps).toHaveLength(2);
    // 15 minutes on: busy until the next sweep.
    e.advance(15 * 60_000);
    expect(await e.x.take(frame("s4", ["/bin/echo"]), "h4", ctx())).toMatchObject({
      ok: false,
      error: { code: "busy" },
    });
    await e.x.tick(e.c);
    expect(sweeps).toHaveLength(3);
    expect(await e.x.take(frame("s5", ["/bin/echo"]), "h5", ctx())).toMatchObject({ ok: true });
  });

  it("a sweep that fails is no sweep: still due, new work still busy; tried again a minute later", async () => {
    let fails = true;
    const sweeps: string[] = [];
    const r = slowRunner({
      sweep: async () => {
        sweeps.push(fails ? "failed" : "done");
        return fails ? null : { killed: 0, comms: [] };
      },
    });
    r.release();
    const e = executor(r.runner);
    const ctx = () => ({ ceiling: e.c, scan: null, nodeId: NODE, owner: OWNER, generation: 3, lbNow: Date.now() });
    await e.x.tick(e.c);
    expect(sweeps).toEqual(["failed"]);
    expect(await e.x.take(frame("f1", ["/bin/echo"]), "h1", ctx())).toMatchObject({
      ok: false,
      error: { code: "busy" },
    });
    // Not every pass: a minute later.
    e.advance(30_000);
    await e.x.tick(e.c);
    expect(sweeps).toEqual(["failed"]);
    e.advance(30_000);
    fails = false;
    await e.x.tick(e.c);
    expect(sweeps).toEqual(["failed", "done"]);
    expect(await e.x.take(frame("f2", ["/bin/echo"]), "h2", ctx())).toMatchObject({ ok: true });
  });

  it("runs stopped (exec off): swept once they are over, exec still off; not every 15 minutes while off", async () => {
    const sweeps: number[] = [];
    const r = slowRunner({
      sweep: async () => {
        sweeps.push(1);
        return { killed: 1, comms: ["sleep"] };
      },
    });
    r.release();
    const e = executor(r.runner);
    const ctx = { ceiling: e.c, scan: null, nodeId: NODE, owner: OWNER, generation: 3, lbNow: Date.now() };
    await e.x.tick(e.c);
    expect(sweeps).toHaveLength(1);
    // A read-only run: on its own it would not make a sweep due.
    expect(await e.x.take(frame("o1", ["/bin/echo"]), "h1", ctx)).toMatchObject({ ok: true });
    expect(e.x.stopAll("exec_off")).toBe(1);
    await e.x.tick(e.c, { off: true });
    expect(sweeps).toHaveLength(1);
    r.ends[0]?.();
    await until(() => e.sent.length === 1);
    await e.x.tick(e.c, { off: true });
    expect(sweeps).toHaveLength(2);
    e.advance(15 * 60_000);
    await e.x.tick(e.c, { off: true });
    expect(sweeps).toHaveLength(2);
    // On again: the 15 minutes count.
    await e.x.tick(e.c);
    expect(sweeps).toHaveLength(3);
  });
});
