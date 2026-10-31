/**
 * The node connection v2 (docs/exec.md N1; acceptance cases 3, 8 and 10): hello / welcome
 * v2, async calls, effects sent again until LB acknowledges them, 4410 and 4408 reconnecting at once
 * (then backing off), a silent LB, a wake.
 */
import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CallAnswer, LbLink, type LinkOptions, SILENT_MS, WAKE_GAP_MS } from "../src/collector.ts";
import { CLOSE_GENERATION, CLOSE_SILENT, type EffectReport, VERSION, type Welcome } from "../src/exec/frames.ts";

const T0 = Date.parse("2026-10-27T12:00:00Z");
const EFF = "eff_q3vjz7k2m4n6p8r0s2t4v6x8yz";

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
  }
  addEventListener(t: string, f: (ev: { data?: unknown; code?: number }) => void) {
    this.#on[t] = f;
  }
  /** LB sends a frame. */
  lb(m: Record<string, unknown>) {
    this.#on.message?.({ data: JSON.stringify(m) });
  }
  /** LB closes the connection. */
  lbClose(code: number) {
    this.readyState = 3;
    this.#on.close?.({ code });
  }
  of(t: string) {
    return this.sent.filter((f) => f.t === t);
  }
}

const report = (over: Partial<EffectReport> = {}): EffectReport => ({
  effect_id: EFF,
  state: "done",
  exit: 0,
  signal: null,
  stdout: "ok\n",
  stderr: "",
  redacted: { stdout: 0, stderr: 0 },
  truncated: false,
  bytes: { stdout: 3, stderr: 0 },
  sha256: { stdout: "x", stderr: "y" },
  startedAt: T0,
  endedAt: T0 + 1000,
  grant: null,
  reason: null,
  ...over,
});

const WELCOME = { t: "welcome", generation: 3, owner: "owner-1", now: T0, exec: true };

function setup(over: Partial<LinkOptions> = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const sockets: FakeWs[] = [];
  const logs: string[] = [];
  const downs: (number | null)[] = [];
  const welcomes: Welcome[] = [];
  const link = new LbLink({
    url: "https://lb.example",
    nodeId: "node-1",
    key: privateKey,
    machine: "host-a",
    log: (s) => logs.push(s),
    onCall: () => ({ ok: false, error: { code: "unsupported", message: "" } }),
    onWelcome: (w) => {
      welcomes.push(w);
      return true;
    },
    onDown: (c) => downs.push(c),
    random: () => 0.5,
    connect: () => {
      const ws = new FakeWs();
      sockets.push(ws);
      return ws;
    },
    ...over,
  });
  const ws = () => sockets.at(-1) as FakeWs;
  /** Challenge and welcome on the newest socket. */
  const link_ = (welcome: Record<string, unknown> = WELCOME) => {
    ws().lb({ t: "challenge", nonce: "bm9uY2U=" });
    ws().lb(welcome);
  };
  return { link, sockets, ws, logs, downs, welcomes, publicKey, linkUp: link_ };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("link v2", () => {
  it("forwards transfer chunks only on a welcomed link and sends binary chunks before effects", () => {
    const chunks: unknown[] = [];
    const s = setup({ onChunk: (c) => chunks.push(c) });
    const c = { effect_id: EFF, node: "node-1", seq: 0, last: true, data: "AP+A" };
    expect(s.link.sendChunk(c)).toBe(false);
    s.link.start();
    s.ws().lb({ t: "chunk", ...c });
    expect(chunks).toEqual([]);
    s.linkUp();
    s.ws().lb({ t: "chunk", ...c });
    s.ws().lb({ t: "chunk", ...c, data: "!" });
    expect(chunks).toEqual([c]);
    expect(s.link.sendChunk(c)).toBe(true);
    s.link.sendEffect(report({ data: { path: "a", size: 3, sha256: "f".repeat(64) } }));
    expect(
      s
        .ws()
        .sent.slice(-2)
        .map((m) => m.t),
    ).toEqual(["chunk", "effect"]);
    s.link.stop();
    expect(s.link.sendChunk(c)).toBe(false);
  });

  it("says hello v2: generation, caps and ceiling as given, the clock; still signs lb-node:<nonce>", () => {
    const ceiling = { sha: "0123456789abcdef", summary: { preset: "agent-user" } };
    const s = setup({ hello: () => ({ caps: ["sessions", "exec.v1"], generation: 3, ceiling }) });
    s.link.start();
    s.ws().lb({ t: "challenge", nonce: "bm9uY2U=" });
    const hello = s.ws().sent[0] as Record<string, unknown>;
    expect(hello).toEqual({
      t: "hello",
      node: "node-1",
      sig: hello.sig,
      version: VERSION,
      caps: ["sessions", "exec.v1"],
      machine: { name: "host-a", platform: process.platform },
      generation: 3,
      ceiling,
      clock: T0,
    });
    expect(verify(null, Buffer.from("lb-node:bm9uY2U="), s.publicKey, Buffer.from(String(hello.sig), "base64"))).toBe(
      true,
    );
    // Without a provider: sessions only, generation 0, no ceiling.
    const bare = setup();
    bare.link.start();
    bare.ws().lb({ t: "challenge", nonce: "bm9uY2U=" });
    expect(bare.ws().sent[0]).toMatchObject({ caps: ["sessions"], generation: 0 });
    expect(bare.ws().sent[0]).not.toHaveProperty("ceiling");
    s.link.stop();
    bare.link.stop();
  });

  it("hands the welcome over; an old LB's bare welcome still links and sessions go as before (I-10)", () => {
    const s = setup();
    s.link.send({ t: "sessions", sessions: [] });
    s.link.start();
    s.linkUp({ t: "welcome" });
    expect(s.welcomes).toEqual([{ generation: null, owner: null, now: null, exec: false }]);
    expect(s.link.up).toBe(true);
    expect(s.ws().of("sessions")).toHaveLength(1);
    expect(s.logs).toContain("linked to LB (no exec there)");
    s.linkUp();
    expect(s.welcomes[1]).toEqual({ generation: 3, owner: "owner-1", now: T0, exec: true });
    s.link.stop();
  });

  it("a welcome naming another owner (retired): the link stops and stays down", () => {
    const s = setup({ onWelcome: () => false });
    s.link.start();
    s.linkUp();
    expect(s.link.up).toBe(false);
    expect(s.ws().closed).toEqual([{ code: 1000, reason: "stopping" }]);
    expect(s.logs.join("\n")).toContain("retired");
    vi.advanceTimersByTime(30 * 60_000);
    expect(s.sockets).toHaveLength(1);
  });

  it("sends unacknowledged effects after every welcome until LB acknowledges them (I-3)", () => {
    let pending = [report()];
    const acked: string[] = [];
    const s = setup({
      pending: () => pending,
      onEffectAck: (id) => {
        acked.push(id);
        pending = pending.filter((r) => r.effect_id !== id);
      },
    });
    s.link.start();
    // Ended while the link was down: not sent, kept.
    s.link.sendEffect(report({ effect_id: "eff_later" }));
    expect(s.ws().sent).toEqual([]);
    s.linkUp();
    expect(s.ws().of("effect")).toEqual([{ t: "effect", ...report() }]);
    // Dropped before LB's ack: sent again on the next connection.
    s.ws().lbClose(1006);
    vi.advanceTimersByTime(5000);
    s.linkUp();
    expect(s.ws().of("effect")).toHaveLength(1);
    s.ws().lb({ t: "effect_ack", effect_id: EFF });
    s.ws().lb({ t: "effect_ack", effect_id: "not an id" });
    expect(acked).toEqual([EFF]);
    s.ws().lbClose(1006);
    vi.advanceTimersByTime(10_000);
    s.linkUp();
    expect(s.ws().of("effect")).toEqual([]);
    // Ended while linked: sent at once.
    s.link.sendEffect(report({ effect_id: "eff_now" }));
    expect(s.ws().of("effect")).toMatchObject([{ effect_id: "eff_now" }]);
    s.link.stop();
  });

  it("answers calls asynchronously, error.data included, and only on the connection the call came on", async () => {
    let release: (a: CallAnswer) => void = () => undefined;
    const seen: unknown[] = [];
    const s = setup({
      onCall: (op, _args, call) => {
        seen.push([op, call.effectId, call.generation, call.origin?.where]);
        if (op === "session.read") return { ok: true, data: { entries: [] } };
        return new Promise<CallAnswer>((r) => {
          release = r;
        });
      },
    });
    s.link.start();
    s.linkUp();
    const ws = s.ws();
    ws.lb({ t: "call", id: "c0", op: "session.read", args: { id: "a" } });
    expect(ws.of("result")).toEqual([{ t: "result", id: "c0", ok: true, data: { entries: [] } }]);
    const origin = { conversation: "c", turn: "t", person: "p", agent: "a", attended: true, where: "group" };
    const call = { t: "call", id: "c1", op: "exec.v1", effect_id: EFF, deadline: T0 + 60_000, generation: 3, origin };
    ws.lb({ ...call, args: { argv: ["true"] } });
    expect(seen[1]).toEqual(["exec.v1", EFF, 3, "group"]);
    expect(ws.of("result")).toHaveLength(1);
    const data = { tier: "grant", commandHash: "h", maxMinutes: 30, window: true };
    release({ ok: false, error: { code: "needs_grant", message: "", data } });
    await Promise.resolve();
    expect(ws.of("result")[1]).toEqual({
      t: "result",
      id: "c1",
      ok: false,
      error: { code: "needs_grant", message: "", data },
    });
    // The connection went while the answer was pending: LB has settled that call as offline.
    ws.lb({ ...call, id: "c2", args: {} });
    ws.lbClose(1006);
    vi.advanceTimersByTime(5000);
    s.linkUp();
    release({ ok: true, data: { effect_id: EFF, state: "running" } });
    await Promise.resolve();
    expect(ws.of("result")).toHaveLength(2);
    expect(s.ws().of("result")).toEqual([]);
    // A handler that throws still answers.
    const t = setup({
      onCall: () => {
        throw new Error("boom");
      },
    });
    t.link.start();
    t.linkUp();
    t.ws().lb({ t: "call", id: "c3", op: "session.read", args: {} });
    expect(t.ws().of("result")).toMatchObject([{ id: "c3", ok: false, error: { code: "internal" } }]);
    s.link.stop();
    t.link.stop();
  });

  it("4410: says so, links again at once; again within a minute backs off 5 s, 10 s (±20 %) (I-8)", () => {
    const s = setup();
    s.link.start();
    s.linkUp();
    s.ws().lbClose(CLOSE_GENERATION);
    expect(s.downs).toEqual([CLOSE_GENERATION]);
    expect(s.link.up).toBe(false);
    vi.advanceTimersByTime(0);
    expect(s.sockets).toHaveLength(2);
    s.linkUp();
    s.ws().lbClose(CLOSE_GENERATION);
    vi.advanceTimersByTime(4999);
    expect(s.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(s.sockets).toHaveLength(3);
    s.ws().lbClose(CLOSE_GENERATION);
    vi.advanceTimersByTime(9999);
    expect(s.sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(s.sockets).toHaveLength(4);
    // A quiet minute: at once again.
    s.linkUp();
    vi.advanceTimersByTime(61_000);
    s.ws().lb({ t: "ping" });
    s.ws().lbClose(CLOSE_GENERATION);
    vi.advanceTimersByTime(0);
    expect(s.sockets).toHaveLength(5);
    s.link.stop();
  });

  it("the jitter stays within ±20 %; 4408 counts on its own; other closes back off 5 s to 60 s, 4401/4403 wait 5 min", () => {
    for (const [r, wait] of [
      [0, 4000],
      [1, 6000],
    ] as const) {
      const s = setup({ random: () => r });
      s.link.start();
      s.ws().lbClose(CLOSE_SILENT);
      vi.advanceTimersByTime(0);
      s.ws().lbClose(CLOSE_SILENT);
      vi.advanceTimersByTime(wait - 1);
      expect(s.sockets).toHaveLength(2);
      vi.advanceTimersByTime(1);
      expect(s.sockets).toHaveLength(3);
      // A 4410 now is not "the same code again": at once.
      s.ws().lbClose(CLOSE_GENERATION);
      vi.advanceTimersByTime(0);
      expect(s.sockets).toHaveLength(4);
      s.link.stop();
    }
    const s = setup();
    s.link.start();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = s.sockets.length;
      s.ws().lbClose(1006);
      let waited = 0;
      while (s.sockets.length === before) {
        vi.advanceTimersByTime(1000);
        waited += 1000;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([5000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    s.ws().lbClose(4403);
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(s.sockets).toHaveLength(7);
    vi.advanceTimersByTime(1);
    expect(s.sockets).toHaveLength(8);
    s.link.stop();
  });

  it("nothing from LB for 75 s: gives the connection up without waiting for a close, links again at once", () => {
    const s = setup();
    s.link.start();
    s.linkUp();
    // LB's pings keep it alive.
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(30_000);
      s.ws().lb({ t: "ping" });
    }
    expect(s.ws().of("pong")).toHaveLength(4);
    expect(s.sockets).toHaveLength(1);
    const first = s.ws();
    vi.advanceTimersByTime(SILENT_MS + 5000);
    expect(first.closed).toEqual([{ code: CLOSE_SILENT, reason: "silent" }]);
    expect(s.downs).toEqual([null]);
    expect(s.logs.join("\n")).toContain("nothing from LB for");
    // Scheduled from inside a timer, fake timers run a 0 ms timeout 1 ms later.
    vi.advanceTimersByTime(1);
    expect(s.sockets).toHaveLength(2);
    // The late close of the old socket changes nothing.
    first.lbClose(1006);
    expect(s.downs).toEqual([null]);
    s.link.stop();
  });

  it("a wake (a look 30 s late) links again at once, also cutting a long wait short", () => {
    const woke: number[] = [];
    const s = setup({ onWake: (g) => woke.push(g) });
    s.link.start();
    s.linkUp();
    vi.advanceTimersByTime(5000);
    // The lid closed for ten minutes: timers did not run, the clock moved on.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    vi.advanceTimersByTime(5000);
    expect(woke).toHaveLength(1);
    expect(woke[0]).toBeGreaterThan(WAKE_GAP_MS);
    expect(s.sockets[0]?.closed).toEqual([{ code: 1000, reason: "woke" }]);
    vi.advanceTimersByTime(1);
    expect(s.sockets).toHaveLength(2);
    // Revoked (5 min wait), then a wake: at once.
    s.linkUp();
    s.ws().lbClose(4403);
    vi.advanceTimersByTime(5000);
    expect(s.sockets).toHaveLength(2);
    vi.setSystemTime(Date.now() + 60_000);
    vi.advanceTimersByTime(5001);
    expect(s.sockets).toHaveLength(3);
    s.link.stop();
  });
});
