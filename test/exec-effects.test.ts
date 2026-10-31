/**
 * The effect ledger (docs/exec.md N3; acceptance cases 1, 2 and 11): one effect id never runs
 * twice — not on a second call, not after the collector or the machine restarts, not in a new
 * generation; a crash mid-write; the keep times.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { answerExec, type Gate } from "../src/exec/calls.ts";
import {
  type Claim,
  type EffectEntry,
  EffectLedger,
  ENTRY_KEEP_MS,
  OUTPUT_KEEP_MS,
  type Outcome,
  report,
} from "../src/exec/effects.ts";
import { argsHash, type CallAnswer, type CallFrame, parseCall } from "../src/exec/frames.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse("2026-10-27T12:00:00Z");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const EFF = "eff_q3vjz7k2m4n6p8r0s2t4v6x8yz";

function ledgerFile() {
  const d = mkdtempSync(join(tmpdir(), "aio-herdr-effects-"));
  dirs.push(d);
  return join(d, "exec", "effects.jsonl");
}

const clock = (t = T0) => {
  const c = { t, now: () => c.t };
  return c;
};

const claim = (over: Partial<Claim> = {}): Claim => ({
  effect_id: EFF,
  op: "exec.v1",
  argsHash: "a".repeat(64),
  generation: 3,
  deadline: T0 + 120_000,
  grant: null,
  ...over,
});

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  state: "done",
  exit: 0,
  signal: null,
  stdout: "token=[REDACTED]\nok\n",
  stderr: "",
  redacted: { stdout: 1, stderr: 0 },
  truncated: false,
  bytes: { stdout: 30, stderr: 0 },
  reason: null,
  ...over,
});

const lines = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const ARGS = { argv: ["sh", "-c", "echo hi >> log.txt"], cwd: "~/repos/p", shell: true, stdin: null, env: {} };
const ORIGIN = { conversation: "c", turn: "t", person: "p", agent: "a", attended: true, where: "dm" };

function execCall(over: Record<string, unknown> = {}): CallFrame {
  const c = parseCall({
    t: "call",
    id: "c1",
    op: "exec.v1",
    effect_id: EFF,
    deadline: T0 + 120_000,
    generation: 3,
    grant: null,
    origin: ORIGIN,
    args: { ...ARGS, policy: { network: "off", write: ["~/repos/p"] } },
    ...over,
  });
  if (!c) throw new Error("unreadable call");
  return c;
}

/** A gate open in `generation`, and a `take` that claims and counts what it started. */
function runner(ledger: EffectLedger, generation = 3) {
  const started: string[] = [];
  let gate: Gate = { open: true, generation };
  const ctx = {
    ledger,
    gate: () => gate,
    take: (call: CallFrame, hash: string, g: number): CallAnswer => {
      started.push(call.effectId as string);
      ledger.claim({
        effect_id: call.effectId as string,
        op: call.op,
        argsHash: hash,
        origin: call.origin,
        generation: g,
        deadline: call.deadline as number,
        grant: null,
      });
      return { ok: true, data: { effect_id: call.effectId, state: "running" } };
    },
  };
  return {
    ctx,
    started,
    setGate: (g: Gate) => {
      gate = g;
    },
  };
}

describe("effect ledger", () => {
  it("writes the effect running, on disk, before anything starts; 0600 in a 0700 directory", () => {
    const path = ledgerFile();
    const c = clock();
    const l = EffectLedger.open(path, { now: c.now, bootAt: T0 - 3_600_000 });
    const e = l.claim(claim());
    expect(e).toMatchObject({ state: "running", startedAt: T0, endedAt: null, ackedAt: null });
    expect(lines(path)).toEqual([JSON.parse(JSON.stringify(e))]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(() => l.claim(claim())).toThrow("in the ledger already");
    // Nothing to send until it ends; the hash is of the redacted text that goes out.
    expect(l.pending()).toEqual([]);
    c.t += 3000;
    const done = l.finish(EFF, outcome());
    expect(done).toMatchObject({ state: "done", exit: 0, endedAt: T0 + 3000 });
    expect(done?.sha256).toEqual({ stdout: sha("token=[REDACTED]\nok\n"), stderr: sha("") });
    expect(l.finish(EFF, outcome({ state: "failed" }))).toBeNull();
    expect(l.pending().map((x) => x.effect_id)).toEqual([EFF]);
    expect(l.ack(EFF)).toBe(true);
    expect(l.pending()).toEqual([]);
    expect(l.ack("eff_nothere")).toBe(false);
  });

  it("after the machine is paired again, the old node's effects are not sent to the new one", () => {
    const l = EffectLedger.open(ledgerFile(), { now: clock().now, bootAt: 0 });
    l.claim(claim({ effect_id: "eff_old", node: "node-old" }));
    l.claim(claim({ effect_id: "eff_new", node: "node-new" }));
    l.claim(claim({ effect_id: "eff_before" }));
    for (const id of ["eff_old", "eff_new", "eff_before"]) l.finish(id, outcome());
    // A line from before the node was kept counts as this node's.
    expect(l.pending("node-new").map((x) => x.effect_id)).toEqual(["eff_new", "eff_before"]);
    expect(l.pending().map((x) => x.effect_id)).toEqual(["eff_old", "eff_new", "eff_before"]);
    expect(l.get("eff_old")?.node).toBe("node-old");
    expect(report(l.get("eff_old") as EffectEntry)).not.toHaveProperty("node");
  });

  it("the same effect id twice starts one run and answers the second from the ledger; other args conflict (I-1)", async () => {
    const l = EffectLedger.open(ledgerFile(), { now: clock().now, bootAt: 0 });
    const r = runner(l);
    expect(await answerExec(execCall(), r.ctx)).toEqual({ ok: true, data: { effect_id: EFF, state: "running" } });
    const again = await answerExec(execCall({ id: "c2" }), r.ctx);
    expect(again).toMatchObject({ ok: true, data: { effect_id: EFF, state: "running" } });
    expect(r.started).toEqual([EFF]);
    // Write order in the policy does not make it another request; one more argument does.
    const reordered = execCall({ id: "c3", args: { ...ARGS, policy: { write: ["~/repos/p"], network: "off" } } });
    expect(await answerExec(reordered, r.ctx)).toMatchObject({ ok: true });
    const other = execCall({ id: "c4", args: { ...ARGS, argv: ["sh", "-c", "echo hi >> log.txt; echo"] } });
    expect(await answerExec(other, r.ctx)).toMatchObject({ ok: false, error: { code: "effect_conflict" } });
    expect(r.started).toEqual([EFF]);
    expect(lines(l.path)).toHaveLength(1);
  });

  it("a known effect is answered to the person and conversation it was taken for only, gate open or not", async () => {
    const path = ledgerFile();
    const l = EffectLedger.open(path, { now: clock().now, bootAt: 0 });
    const r = runner(l);
    await answerExec(execCall(), r.ctx);
    l.finish(EFF, outcome());
    expect(l.get(EFF)?.origin).toEqual({ person: "p", conversation: "c" });
    expect(report(l.get(EFF) as EffectEntry)).not.toHaveProperty("origin");
    // LB asking again for its own turn: the whole frame. Another turn in the same conversation too.
    expect(await answerExec(execCall({ id: "c2" }), r.ctx)).toMatchObject({
      ok: true,
      data: { stdout: "token=[REDACTED]\nok\n" },
    });
    expect(await answerExec(execCall({ id: "c3", origin: { ...ORIGIN, turn: "t2" } }), r.ctx)).toMatchObject({
      ok: true,
    });
    // Someone else, or another conversation: a refusal and nothing of the output — exec off as well.
    for (const gate of [undefined, { open: false, code: "exec_off", reason: "local_off" } as Gate]) {
      if (gate) r.setGate(gate);
      const other = await answerExec(execCall({ id: "c4", origin: { ...ORIGIN, person: "q" } }), r.ctx);
      expect(other).toMatchObject({ ok: false, error: { code: "not_owner" } });
      expect(JSON.stringify(other)).not.toContain("REDACTED");
      const elsewhere = await answerExec(execCall({ id: "c5", origin: { ...ORIGIN, conversation: "c-other" } }), r.ctx);
      expect(elsewhere).toMatchObject({ ok: false, error: { code: "effect_conflict" } });
      expect(JSON.stringify(elsewhere)).not.toContain("REDACTED");
    }
    expect(r.started).toEqual([EFF]);
    // Kept across a restart; a line from before origins were kept is answered as before.
    expect(EffectLedger.open(path, { now: clock().now, bootAt: 0 }).get(EFF)?.origin).toEqual({
      person: "p",
      conversation: "c",
    });
    l.claim(claim({ effect_id: "eff_older", argsHash: argsHash("exec.v1", execCall().args) }));
    const older = execCall({ id: "c6", effect_id: "eff_older", origin: { ...ORIGIN, person: "q" } });
    expect(await answerExec(older, r.ctx)).toMatchObject({
      ok: true,
      data: { effect_id: "eff_older", state: "running" },
    });
  });

  it("a collector killed mid-run: the effect is unknown on the next start, reported, never run again (I-2)", async () => {
    const path = ledgerFile();
    const c = clock();
    const first = EffectLedger.open(path, { now: c.now, bootAt: T0 - 3_600_000 });
    first.claim(claim({ argsHash: argsHash("exec.v1", execCall().args) }));
    // The process dies here; a new one starts a minute later, the machine still up.
    c.t += 60_000;
    const logs: string[] = [];
    const second = EffectLedger.open(path, { now: c.now, bootAt: T0 - 3_600_000, log: (s) => logs.push(s) });
    expect(second.get(EFF)).toMatchObject({ state: "unknown", reason: "collector_restart", endedAt: T0 + 60_000 });
    expect(logs.join("\n")).toContain("now unknown");
    expect(second.pending().map(report)).toEqual([
      report(second.get(EFF) as NonNullable<ReturnType<typeof second.get>>),
    ]);
    const r = runner(second);
    expect(await answerExec(execCall({ id: "c9" }), r.ctx)).toMatchObject({
      ok: true,
      data: { effect_id: EFF, state: "unknown", reason: "collector_restart" },
    });
    expect(r.started).toEqual([]);
    // The machine rebooted since it started: said so.
    const p2 = ledgerFile();
    EffectLedger.open(p2, { now: c.now, bootAt: 0 }).claim(claim());
    c.t += 120_000;
    const rebooted = EffectLedger.open(p2, { now: c.now, bootAt: c.t - 30_000 });
    expect(rebooted.get(EFF)).toMatchObject({ state: "unknown", reason: "host_restart" });
  });

  it("a new generation does not run old work again; the ledger outlives 4410 (I-11)", async () => {
    const path = ledgerFile();
    const c = clock();
    const l = EffectLedger.open(path, { now: c.now, bootAt: 0 });
    const r = runner(l, 3);
    await answerExec(execCall(), r.ctx);
    c.t += 2000;
    const done = l.finish(EFF, outcome());
    l.ack(EFF);
    // 4410, a reconnect, the welcome of generation 4; LB asks for the same effect again in 4.
    r.setGate({ open: true, generation: 4 });
    const again = await answerExec(execCall({ id: "c5", generation: 4 }), r.ctx);
    expect(again).toEqual({ ok: true, data: report(done as NonNullable<typeof done>) });
    expect(r.started).toEqual([EFF]);
    // Even with new work shut (clock off, retired), what is known is answered.
    r.setGate({ open: false, code: "clock_skew", reason: "clock_skew" });
    expect(await answerExec(execCall({ id: "c6", generation: 4 }), r.ctx)).toMatchObject({ ok: true });
    // New work in an old generation is not taken.
    r.setGate({ open: true, generation: 4 });
    const fresh = execCall({ id: "c7", effect_id: "eff_other", generation: 3 });
    expect(await answerExec(fresh, r.ctx)).toMatchObject({ ok: false, error: { code: "stale_generation" } });
    // A restart in between changes nothing.
    const reopened = EffectLedger.open(path, { now: c.now, bootAt: 0 });
    expect(reopened.get(EFF)).toMatchObject({ state: "done", ackedAt: T0 + 2000 });
  });

  it("refuses what it cannot read, and new work while the gate is shut (exec_off says why)", async () => {
    const l = EffectLedger.open(ledgerFile(), { now: clock().now, bootAt: 0 });
    const r = runner(l);
    expect(await answerExec(execCall({ effect_id: "bad id" }), r.ctx)).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect(await answerExec(execCall({ origin: { ...ORIGIN, where: "elsewhere" } }), r.ctx)).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    r.setGate({ open: false, code: "exec_off", reason: "no_ceiling" });
    expect(await answerExec(execCall(), r.ctx)).toEqual({
      ok: false,
      error: { code: "exec_off", message: "", data: { reason: "no_ceiling" } },
    });
    r.setGate({ open: false, code: "retired", reason: "owner_changed" });
    expect(await answerExec(execCall(), r.ctx)).toEqual({ ok: false, error: { code: "retired", message: "" } });
    expect(r.started).toEqual([]);
    const noTake = { ledger: l, gate: (): Gate => ({ open: true, generation: 3 }) };
    expect(await answerExec(execCall(), noTake)).toMatchObject({ ok: false, error: { code: "runner_unavailable" } });
    expect(await answerExec({ ...execCall(), op: "agent.prompt" }, noTake)).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
  });

  it("a line cut short by a crash is skipped and dropped; the next line starts on its own", () => {
    const path = ledgerFile();
    const c = clock();
    EffectLedger.open(path, { now: c.now, bootAt: 0 }).claim(claim());
    appendFileSync(path, '{"effect_id":"eff_half","argsHash":"b","st');
    const logs: string[] = [];
    const l = EffectLedger.open(path, { now: c.now, bootAt: 0, log: (s) => logs.push(s) });
    expect(logs.join("\n")).toContain("skipped 1 unreadable line");
    expect(l.size).toBe(1);
    expect(l.get(EFF)?.state).toBe("unknown");
    l.claim(claim({ effect_id: "eff_next" }));
    expect(lines(path).map((x) => x.effect_id)).toEqual([EFF, "eff_next"]);
    // Cut short again with no compaction in between: the next write still starts a line of its own.
    const p2 = ledgerFile();
    const a = EffectLedger.open(p2, { now: c.now, bootAt: 0 });
    a.claim(claim());
    appendFileSync(p2, '{"effect_id":"eff_ha');
    const b = new EffectLedger(p2, c.now);
    expect(b.load()).toBe(1);
    b.claim(claim({ effect_id: "eff_after" }));
    const raw = readFileSync(p2, "utf8").split("\n");
    expect(raw.filter((x) => x.startsWith("{")).length).toBe(3);
    expect(new EffectLedger(p2, c.now).load()).toBe(1);
    expect(raw.at(-1)).toBe("");
  });

  it("clears output an hour after the ack and drops the entry a day after max(deadline, end), from the disk too", () => {
    const path = ledgerFile();
    const c = clock();
    const l = EffectLedger.open(path, { now: c.now, bootAt: 0 });
    l.claim(claim({ argsHash: argsHash("exec.v1", execCall().args) }));
    c.t += 5000;
    l.finish(EFF, outcome());
    c.t += 1000;
    l.ack(EFF);
    const ackedAt = c.t;
    c.t = ackedAt + OUTPUT_KEEP_MS - 1;
    expect(l.maintain()).toBe(false);
    expect(l.get(EFF)?.stdout).toContain("ok");
    c.t = ackedAt + OUTPUT_KEEP_MS;
    expect(l.maintain()).toBe(true);
    const cleared = l.get(EFF);
    expect(cleared).toMatchObject({ stdout: "", stderr: "", outputExpired: true, state: "done", exit: 0 });
    expect(cleared?.sha256.stdout).not.toBe(cleared?.sha256.stderr);
    expect(readFileSync(path, "utf8")).not.toContain("REDACTED");
    // A known effect asked for after that: state, exit and hashes, no output, and it says so.
    const r = answerExec(execCall({ id: "c8" }), { ledger: l, gate: () => ({ open: true, generation: 3 }) });
    expect(r).toEqual({ ok: true, data: { ...report(cleared as NonNullable<typeof cleared>), outputExpired: true } });
    expect(r).toMatchObject({ data: { state: "done", exit: 0, stdout: "" } });
    // The deadline (T0 + 120 s) is later than the end: a day after it, the entry goes.
    c.t = T0 + 120_000 + ENTRY_KEEP_MS - 1;
    l.maintain();
    expect(l.get(EFF)).toBeDefined();
    c.t = T0 + 120_000 + ENTRY_KEEP_MS;
    l.maintain();
    expect(l.get(EFF)).toBeUndefined();
    expect(readFileSync(path, "utf8")).toBe("");
    // A running entry is never dropped, however old: that would let its id run again.
    l.claim(claim({ effect_id: "eff_stuck", deadline: c.t }));
    c.t += 10 * ENTRY_KEEP_MS;
    l.maintain();
    expect(l.get("eff_stuck")?.state).toBe("running");
  });

  it("compacts when old lines outnumber the live ones", () => {
    const path = ledgerFile();
    const c = clock();
    const l = EffectLedger.open(path, { now: c.now, bootAt: 0 });
    for (let i = 0; i < 70; i++) {
      const id = `eff_n${i}`;
      l.claim(claim({ effect_id: id }));
      l.finish(id, outcome());
      l.ack(id);
    }
    expect(lines(path)).toHaveLength(210);
    expect(l.maintain()).toBe(true);
    expect(lines(path)).toHaveLength(70);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(l.maintain()).toBe(false);
    // An unreadable file line from some other writer does not stop the rest loading.
    writeFileSync(path, `not json\n${readFileSync(path, "utf8")}`);
    expect(new EffectLedger(path, c.now).load()).toBe(1);
  });
});
