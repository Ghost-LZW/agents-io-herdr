/**
 * The node's generation (docs/exec.md N4; acceptance case 8): node.json, first trust, a higher
 * and a lower generation, another owner (retired), an old LB, the clock; and in the collector: the
 * retired mark keeps the link down, pairing again stops the older process, known effects are
 * reported after the welcome, new work is refused while there is no ceiling.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keepNodeKey, newNodeKey, runCollector, type SessionsConfig, sessionsPaths } from "../src/collector.ts";
import { EffectLedger } from "../src/exec/effects.ts";
import type { Welcome } from "../src/exec/frames.ts";
import { CLOCK_SKEW_MS, Generation, paired, readNodeRecord, writeNodeRecord } from "../src/exec/generation.ts";
import { type ExecPaths, execPaths } from "../src/exec/paths.ts";
import type { Runner, RunOutcome } from "../src/exec/run.ts";
import type { Exec } from "../src/system.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-27T12:00:00Z");
const NODE = "00000000-0000-4000-8000-00000000000a";
const OWNER = "00000000-0000-4000-8000-0000000000b1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const EFF = "eff_q3vjz7k2m4n6p8r0s2t4v6x8yz";

function temp() {
  const d = mkdtempSync(join(tmpdir(), "aio-herdr-gen-"));
  dirs.push(d);
  return d;
}

const welcome = (over: Partial<Welcome> = {}): Welcome => ({
  generation: 3,
  owner: OWNER,
  now: T0,
  exec: true,
  ...over,
});

function gen(p: ExecPaths, logs: string[] = [], now = () => T0) {
  return new Generation({ paths: p, nodeId: NODE, now, log: (s) => logs.push(s) });
}

describe("generation", () => {
  it("first trust: a node paired before node.json takes the first owner and generation LB names", () => {
    const p = execPaths(temp());
    const logs: string[] = [];
    const g = gen(p, logs);
    expect(readNodeRecord(p.node)).toEqual({ node: NODE, owner: null, generation: 0 });
    expect(statSync(p.node).mode & 0o777).toBe(0o600);
    expect(g.gate()).toEqual({ open: false, code: "exec_off", reason: "not_linked" });
    expect(g.onWelcome(welcome())).toEqual({ kind: "ok", firstTrust: true, advanced: false });
    expect(readNodeRecord(p.node)).toEqual({ node: NODE, owner: OWNER, generation: 3 });
    expect(g.gate()).toEqual({ open: true, generation: 3 });
    expect(logs.join("\n")).toContain("first welcome");
    // node.json of an older pairing is replaced the same way.
    writeNodeRecord(p.node, { node: "old-node", owner: OTHER, generation: 9 });
    const again = gen(p);
    expect(again.record).toEqual({ node: NODE, owner: null, generation: 0 });
    expect(again.onWelcome(welcome()).kind).toBe("ok");
  });

  it("a higher generation is kept (the old one's work void); a lower one keeps exec off and is never written", () => {
    const p = execPaths(temp());
    writeNodeRecord(p.node, { node: NODE, owner: OWNER, generation: 3 });
    const g = gen(p);
    expect(g.onWelcome(welcome({ generation: 4 }))).toEqual({ kind: "ok", firstTrust: false, advanced: true });
    expect(readNodeRecord(p.node)?.generation).toBe(4);
    expect(g.generation).toBe(4);
    expect(g.onWelcome(welcome({ generation: 2 }))).toEqual({ kind: "stale" });
    expect(readNodeRecord(p.node)?.generation).toBe(4);
    expect(g.gate()).toMatchObject({ open: false, code: "stale_generation" });
    // The same one again: nothing written, open.
    expect(g.onWelcome(welcome({ generation: 4 }))).toEqual({ kind: "ok", firstTrust: false, advanced: false });
    expect(g.gate()).toEqual({ open: true, generation: 4 });
  });

  it("another owner retires the machine; only pairing again clears the mark", () => {
    const p = execPaths(temp());
    writeNodeRecord(p.node, { node: NODE, owner: OWNER, generation: 3 });
    const logs: string[] = [];
    const g = gen(p, logs);
    expect(g.onWelcome(welcome({ owner: OTHER, generation: 4 }))).toEqual({ kind: "retired" });
    expect(g.retired).toBe(true);
    expect(statSync(p.retired).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(p.retired, "utf8"))).toMatchObject({ node: NODE, owner: OWNER, lbOwner: OTHER });
    expect(readNodeRecord(p.node)).toEqual({ node: NODE, owner: OWNER, generation: 3 });
    expect(g.gate()).toEqual({ open: false, code: "retired", reason: "owner_changed" });
    expect(logs.join("\n")).toContain("retired until it is paired again");
    // A later welcome naming the old owner again does not undo it.
    g.onWelcome(welcome());
    expect(g.gate()).toMatchObject({ open: false, code: "retired" });
    paired(p, "node-new", OTHER);
    expect(g.retired).toBe(false);
    expect(readNodeRecord(p.node)).toEqual({ node: "node-new", owner: OTHER, generation: 0 });
  });

  it("an old LB keeps exec off; so do clocks more than 30 s apart, and LB's own switch", () => {
    const p = execPaths(temp());
    writeNodeRecord(p.node, { node: NODE, owner: OWNER, generation: 3 });
    const g = gen(p);
    expect(g.onWelcome({ generation: null, owner: null, now: null, exec: false })).toEqual({ kind: "old" });
    expect(g.gate()).toEqual({ open: false, code: "exec_off", reason: "lb_old" });
    expect(readNodeRecord(p.node)).toEqual({ node: NODE, owner: OWNER, generation: 3 });
    g.onWelcome(welcome({ now: T0 + CLOCK_SKEW_MS + 1 }));
    expect(g.gate()).toMatchObject({ open: false, code: "clock_skew" });
    g.onWelcome(welcome({ now: T0 - CLOCK_SKEW_MS }));
    expect(g.gate()).toEqual({ open: true, generation: 3 });
    expect(g.skewMs).toBe(-CLOCK_SKEW_MS);
    g.onWelcome(welcome({ now: null }));
    expect(g.gate()).toMatchObject({ open: false, code: "clock_skew" });
    g.onWelcome(welcome({ exec: false }));
    expect(g.gate()).toEqual({ open: false, code: "exec_off", reason: "lb_off" });
    g.onWelcome(welcome());
    g.onLinkDown();
    expect(g.gate()).toEqual({ open: false, code: "exec_off", reason: "not_linked" });
  });

  it("knows when node.json names another node or owner (this machine was paired again)", () => {
    const p = execPaths(temp());
    const g = gen(p);
    g.onWelcome(welcome());
    expect(g.identityChanged()).toBeNull();
    writeNodeRecord(p.node, { node: NODE, owner: OTHER, generation: 3 });
    expect(g.identityChanged()).toBe("node.json names another owner");
    paired(p, "node-new", OWNER);
    expect(g.identityChanged()).toContain("paired again");
    rmSync(p.node);
    expect(g.identityChanged()).toBeNull();
  });
});

class FakeWs {
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  closed: (number | undefined)[] = [];
  #on: Record<string, (ev: { data?: unknown; code?: number }) => void> = {};
  send(s: string) {
    this.sent.push(JSON.parse(s) as Record<string, unknown>);
  }
  close(code?: number) {
    this.closed.push(code);
    this.readyState = 3;
  }
  addEventListener(t: string, f: (ev: { data?: unknown; code?: number }) => void) {
    this.#on[t] = f;
  }
  lb(m: Record<string, unknown>) {
    this.#on.message?.({ data: JSON.stringify(m) });
  }
  /** LB closes the connection with this code. */
  lbClose(code: number) {
    this.readyState = 3;
    this.#on.close?.({ code });
  }
  of(t: string) {
    return this.sent.filter((f) => f.t === t);
  }
}

const noProcesses: Exec = (cmd) => (cmd === "ps" || cmd === "lsof" ? { code: 0, stdout: "", stderr: "" } : null);

/** A paired collector (key file, node.json as given) run against a fake LB; `pass` drives each loop. */
async function collect(o: {
  home: string;
  pass: (n: number, ws: FakeWs | undefined, stop: () => void) => void | Promise<void>;
  logs?: string[];
  runner?: Runner;
  execOnly?: boolean;
  env?: Record<string, string>;
  herdr?: () => Promise<null>;
}) {
  const paths = sessionsPaths({}, o.home);
  const keyFile = join(paths.dir, "node-key.pem");
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  keepNodeKey(newNodeKey(), { file: keyFile }, noProcesses);
  const c: SessionsConfig = {
    machine: "host-a",
    recentHours: 24,
    intervalSec: 10,
    report: { lbUrl: "https://lb.example", nodeId: NODE, keyFile },
    ...(o.execOnly && { execOnly: true }),
  };
  const sockets: FakeWs[] = [];
  let n = 0;
  const code = await runCollector(c, paths, {
    home: o.home,
    env: o.env ?? {},
    exec: noProcesses,
    now: () => T0,
    log: (s) => o.logs?.push(s),
    herdr: o.herdr ?? (async () => null),
    parent: () => 1,
    pid: 111,
    bootAt: () => T0 - 3_600_000,
    runner: o.runner && (() => o.runner as Runner),
    connect: () => {
      const ws = new FakeWs();
      sockets.push(ws);
      return ws;
    },
    sleep: async () => {
      await o.pass(++n, sockets.at(-1), () => writeFileSync(paths.pid, "222\n"));
    },
  });
  return { code, sockets, paths, passes: n };
}

const CHALLENGE = { t: "challenge", nonce: "bm9uY2U=" };
const WELCOME = { t: "welcome", generation: 3, owner: OWNER, now: T0, exec: true };

describe("generation in the collector", () => {
  it.each(["env", "config"])(
    "exec only through %s: no session scans, frames or reads, while the exec link stays up",
    async (via) => {
      let scans = 0;
      const h = temp();
      const s = await collect({
        home: h,
        execOnly: via === "config",
        env: via === "env" ? { AGENTS_IO_HERDR_EXEC_ONLY: "1" } : {},
        herdr: async () => {
          scans++;
          return null;
        },
        pass: async (n, ws, stop) => {
          if (n === 1) {
            ws?.lb(CHALLENGE);
            ws?.lb(WELCOME);
            ws?.lb({ t: "call", id: "read", op: "session.read", args: { id: "a" } });
          }
          if (n === 3) stop();
        },
      });
      expect(scans).toBe(0);
      expect(s.sockets[0]?.of("hello")[0]?.caps).toEqual([]);
      expect(s.sockets[0]?.of("sessions")).toEqual([]);
      expect(s.sockets[0]?.of("result")).toMatchObject([{ id: "read", ok: false, error: { code: "unsupported" } }]);
      expect(existsSync(s.paths.spool)).toBe(false);
    },
  );

  it("hello says the generation held; known effects are reported after the welcome, new work refused (no ceiling)", async () => {
    const home = temp();
    const p = execPaths(sessionsPaths({}, home).dir);
    writeNodeRecord(p.node, { node: NODE, owner: OWNER, generation: 3 });
    // Running when the last collector died; and one the node this machine was paired as before ran.
    const before = new EffectLedger(p.effects, () => T0 - 60_000);
    const claims: [string, string][] = [
      [EFF, NODE],
      ["eff_oldnode", "node-before"],
    ];
    for (const [id, node] of claims)
      before.claim({
        effect_id: id,
        op: "exec.v1",
        argsHash: "a".repeat(64),
        node,
        generation: 3,
        deadline: T0 + 60_000,
        grant: null,
      });
    let ws: FakeWs | undefined;
    const origin = { conversation: "c", turn: "t", person: OWNER, agent: "a", attended: true, where: "dm" };
    const r = await collect({
      home,
      pass: (n, w, stop) => {
        ws = w;
        if (n === 1) {
          w?.lb(CHALLENGE);
          w?.lb(WELCOME);
          w?.lb({ t: "effect_ack", effect_id: EFF });
          const call = {
            t: "call",
            op: "exec.v1",
            deadline: T0 + 60_000,
            generation: 3,
            origin,
            args: { argv: ["ls"] },
          };
          w?.lb({ ...call, id: "c1", effect_id: "eff_new" });
          w?.lb({ t: "call", id: "c2", op: "agent.prompt", args: {} });
        } else stop();
      },
    });
    expect(r.code).toBe(0);
    expect(ws?.sent[0]).toMatchObject({ t: "hello", generation: 3, caps: ["sessions"] });
    // Only this node's: the old node's effect is not sent over the new node's link.
    expect(ws?.of("effect")).toMatchObject([{ effect_id: EFF, state: "unknown", reason: "collector_restart" }]);
    expect(ws?.of("result")).toEqual([
      { t: "result", id: "c1", ok: false, error: { code: "exec_off", message: "", data: { reason: "no_ceiling" } } },
      {
        t: "result",
        id: "c2",
        ok: false,
        error: { code: "unsupported", message: "this node only lists and reads sessions" },
      },
    ]);
    const after = new EffectLedger(p.effects, () => T0);
    after.load();
    expect(after.get(EFF)).toMatchObject({ state: "unknown", ackedAt: T0 });
    expect(after.get("eff_new")).toBeUndefined();
  });

  it("a welcome naming another owner: retired, the link stops; the next start does not link at all (I-8)", async () => {
    const home = temp();
    const p = execPaths(sessionsPaths({}, home).dir);
    writeNodeRecord(p.node, { node: NODE, owner: OWNER, generation: 3 });
    const logs: string[] = [];
    const first = await collect({
      home,
      logs,
      pass: (n, w, stop) => {
        if (n === 1) {
          w?.lb(CHALLENGE);
          w?.lb({ ...WELCOME, owner: OTHER, generation: 4 });
        } else stop();
      },
    });
    expect(first.code).toBe(0);
    expect(first.sockets).toHaveLength(1);
    expect(first.sockets[0]?.closed).toEqual([1000]);
    expect(readFileSync(p.retired, "utf8")).toContain(OTHER);
    // Sessions are still collected locally.
    expect(first.passes).toBe(2);
    const again: string[] = [];
    const second = await collect({ home, logs: again, pass: (_n, _w, stop) => stop() });
    expect(second.sockets).toEqual([]);
    expect(again.join("\n")).toContain("retired");
  });

  it("node.json naming another node (paired again): the older collector stops within a pass (I-8)", async () => {
    const home = temp();
    const p = execPaths(sessionsPaths({}, home).dir);
    const logs: string[] = [];
    const r = await collect({
      home,
      logs,
      pass: (n, w) => {
        if (n === 1) {
          w?.lb(CHALLENGE);
          w?.lb(WELCOME);
          paired(p, "node-new", OWNER);
        }
      },
    });
    expect(r.code).toBe(0);
    expect(r.passes).toBe(1);
    expect(logs.join("\n")).toContain("paired again");
    expect(r.sockets[0]?.closed).toEqual([1000]);
  });
});

/** Runs that go until they are stopped, then end `cancelled` with the reason they were stopped for. */
function heldRunner() {
  const stops: string[] = [];
  let started = 0;
  const runner: Runner = {
    kind: "same",
    prepare: async () => ({
      ok: true,
      prepared: {
        discard: () => undefined,
        start: () => {
          started++;
          let end: (o: RunOutcome) => void = () => undefined;
          const done = new Promise<RunOutcome>((r) => {
            end = r;
          });
          return {
            pgid: null,
            stop: (state, reason) => {
              stops.push(reason);
              end({
                state,
                exit: null,
                signal: "SIGTERM",
                reason,
                stdout: "",
                stderr: "",
                redacted: { stdout: 0, stderr: 0 },
                truncated: false,
                bytes: { stdout: 0, stderr: 0 },
              });
            },
            done,
          };
        },
      },
    }),
  };
  return { runner, stops, started: () => started };
}

describe("LB taking exec back, in the collector", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  /** A ceiling that lets `ls` run, a run of it going, then `then`; how the run ended. */
  async function runThen(then: (ws: FakeWs) => void) {
    const home = temp();
    const paths = sessionsPaths({}, home);
    const p = execPaths(paths.dir);
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    chmodSync(paths.dir, 0o700);
    mkdirSync(join(home, "repos", "app"), { recursive: true });
    writeFileSync(
      p.ceiling,
      JSON.stringify({ version: 2, read: { roots: ["~/repos/app"] }, commands: { default: "auto" } }),
      { mode: 0o600 },
    );
    writeNodeRecord(p.node, { node: NODE, owner: OWNER, generation: 3 });
    const held = heldRunner();
    const logs: string[] = [];
    const origin = { conversation: "c", turn: "t", person: OWNER, agent: "a", attended: true, where: "dm" };
    let ws: FakeWs | undefined;
    let before: string[] = [];
    const r = await collect({
      home,
      logs,
      runner: held.runner,
      pass: async (n, w, stop) => {
        if (n === 1 && w) {
          ws = w;
          w.lb(CHALLENGE);
          w.lb(WELCOME);
          w.lb({
            t: "call",
            id: "c1",
            op: "exec.v1",
            effect_id: EFF,
            deadline: T0 + 60_000,
            generation: 3,
            grant: null,
            origin,
            args: {
              argv: ["ls"],
              cwd: "~/repos/app",
              shell: false,
              stdin: null,
              env: {},
              policy: { network: "off", write: [] },
            },
          });
          await tick();
          before = [...held.stops];
          then(w);
          await tick();
        } else stop();
      },
    });
    expect(r.code).toBe(0);
    expect(ws?.of("result")).toMatchObject([{ id: "c1", ok: true, data: { state: "running" } }]);
    expect(held.started()).toBe(1);
    expect(before).toEqual([]);
    const ledger = new EffectLedger(p.effects, () => T0);
    ledger.load();
    return { ws, stops: held.stops, entry: ledger.get(EFF), logs: logs.join("\n") };
  }

  it("4403 (the node revoked): the run going is cancelled at once, `revoked`", async () => {
    const r = await runThen((ws) => ws.lbClose(4403));
    expect(r.stops).toEqual(["revoked"]);
    expect(r.entry).toMatchObject({ state: "cancelled", reason: "revoked" });
    expect(r.logs).toContain("stopping 1 run(s)");
  });

  it("a welcome with exec:false on the live link (the owner takes exec back, LB_NODE_EXEC=0): cancelled, `lb_off`, reported", async () => {
    const r = await runThen((ws) => ws.lb({ ...WELCOME, exec: false }));
    expect(r.stops).toEqual(["lb_off"]);
    expect(r.ws?.of("effect")).toMatchObject([{ effect_id: EFF, state: "cancelled", reason: "lb_off" }]);
  });

  it("another owner (retired), a generation behind, an LB without exec: cancelled, each its reason", async () => {
    expect((await runThen((ws) => ws.lb({ ...WELCOME, owner: OTHER, generation: 4 }))).stops).toEqual(["retired"]);
    expect((await runThen((ws) => ws.lb({ ...WELCOME, generation: 2 }))).stops).toEqual(["stale_generation"]);
    expect((await runThen((ws) => ws.lb({ t: "welcome" }))).stops).toEqual(["lb_old"]);
    expect((await runThen((ws) => ws.lb({ ...WELCOME, generation: 4 }))).stops).toEqual(["generation_changed"]);
  });

  it("a lost link, or clocks apart, take nothing back: the run goes on until the collector stops", async () => {
    const lost = await runThen((ws) => ws.lbClose(1006));
    expect(lost.stops).toEqual(["collector_restart"]);
    const skew = await runThen((ws) => ws.lb({ ...WELCOME, now: T0 + CLOCK_SKEW_MS + 1000 }));
    expect(skew.stops).toEqual(["collector_restart"]);
  });
});
