import { describe, expect, it } from "vitest";
import { parseQuiet } from "../src/config.ts";
import { minuteOfDay } from "../src/system.ts";
import { DEFAULT_RULES, inQuiet, type Notice, type Tick, Watcher } from "../src/watch.ts";
import { agent } from "./fixtures.ts";

const S = 1000;
const NOON = 12 * 60;

/** Runs a timeline of (seconds, status) through a watcher, ticking every 2 s; returns notices with their time. */
function play(
  timeline: [number, string][],
  until: number,
  o: {
    idleMs?: number | null;
    focused?: boolean;
    minute?: (t: number) => number;
    rules?: Partial<typeof DEFAULT_RULES>;
  } = {},
): [number, Notice][] {
  const w = new Watcher({ ...DEFAULT_RULES, ...o.rules });
  const out: [number, Notice][] = [];
  let status = timeline[0]?.[1] ?? "idle";
  for (let t = 0; t <= until; t += 2) {
    for (const [at, s] of timeline) if (at === t) status = s;
    const tick: Tick = {
      agents: [agent(status, { focused: o.focused ?? false })],
      now: t * S,
      idleMs: o.idleMs === undefined ? 3_600_000 : o.idleMs,
      minuteOfDay: o.minute ? o.minute(t) : NOON,
    };
    for (const n of w.tick(tick)) out.push([t, n]);
  }
  return out;
}

describe("Watcher", () => {
  it("tells once when an agent has been blocked for a minute", () => {
    const got = play(
      [
        [0, "working"],
        [10, "blocked"],
      ],
      300,
    );
    expect(got.map(([t, n]) => [t, n.kind])).toEqual([[70, "blocked"]]);
  });

  it("does not tell about a dialog answered within the minute", () => {
    const got = play(
      [
        [0, "working"],
        [10, "blocked"],
        [40, "working"],
      ],
      100,
    );
    expect(got).toEqual([]);
  });

  it("tells about a long turn once it has settled, with its length", () => {
    const got = play(
      [
        [0, "working"],
        [300, "done"],
      ],
      400,
    );
    expect(got.map(([t, n]) => [t, n.kind, n.kind === "done" ? n.turnMs : null])).toEqual([[330, "done", 300 * S]]);
  });

  it("counts a working → idle → working flap as one stretch", () => {
    const got = play(
      [
        [0, "working"],
        [100, "idle"],
        [110, "working"],
        [200, "done"],
      ],
      300,
    );
    expect(got.map(([t, n]) => [t, n.kind === "done" ? n.turnMs : null])).toEqual([[230, 200 * S]]);
  });

  it("keeps the stretch through a blocked dialog", () => {
    const got = play(
      [
        [0, "working"],
        [60, "blocked"],
        [90, "working"],
        [200, "done"],
      ],
      300,
    );
    expect(got.map(([, n]) => n.kind)).toEqual(["done"]);
    expect(got[0]?.[1].kind === "done" && got[0][1].turnMs).toBe(200 * S);
  });

  it("skips short turns, unknown states and panes found already finished", () => {
    expect(
      play(
        [
          [0, "working"],
          [60, "done"],
        ],
        200,
      ),
    ).toEqual([]);
    expect(
      play(
        [
          [0, "working"],
          [300, "unknown"],
        ],
        400,
      ),
    ).toEqual([]);
    expect(play([[0, "done"]], 200)).toEqual([]);
  });

  it("stays quiet while the person is looking at that pane, and tells about a dialog when they leave", () => {
    const done = play(
      [
        [0, "working"],
        [300, "done"],
      ],
      400,
      { idleMs: 5_000, focused: true },
    );
    expect(done).toEqual([]);
    const w = new Watcher(DEFAULT_RULES);
    const tick = (t: number, idleMs: number) =>
      w.tick({ agents: [agent("blocked", { focused: true })], now: t * S, idleMs, minuteOfDay: NOON });
    expect(tick(0, 1000)).toEqual([]);
    expect(tick(120, 1000)).toEqual([]);
    expect(tick(122, 400_000).map((n) => n.kind)).toEqual(["blocked"]);
  });

  it("someone at the keyboard in another pane does not count as looking", () => {
    const got = play(
      [
        [0, "working"],
        [300, "done"],
      ],
      400,
      { idleMs: 5_000, focused: false },
    );
    expect(got.map(([, n]) => n.kind)).toEqual(["done"]);
  });

  it("holds finished turns during quiet hours and sends one overnight list; blocked goes out at night", () => {
    // 22:58 at t=0; quiet from 23:00 (t=120) to 08:00, here compressed: quiet ends at t=600.
    const minute = (t: number) => (t < 120 ? 22 * 60 + 58 : t < 600 ? 23 * 60 + 30 : 8 * 60 + 1);
    const got = play(
      [
        [0, "working"],
        [300, "done"],
      ],
      700,
      { minute },
    );
    expect(got.map(([t, n]) => [t, n.kind])).toEqual([[600, "overnight"]]);
    const blocked = play(
      [
        [0, "working"],
        [200, "blocked"],
      ],
      400,
      { minute },
    );
    expect(blocked.map(([, n]) => n.kind)).toEqual(["blocked"]);
    const held = play(
      [
        [0, "working"],
        [200, "blocked"],
      ],
      400,
      { minute, rules: { quietBlocked: true } },
    );
    expect(held).toEqual([]);
  });

  it("forgets a pane that is gone", () => {
    const w = new Watcher(DEFAULT_RULES);
    w.tick({ agents: [agent("blocked")], now: 0, idleMs: null, minuteOfDay: NOON });
    expect(w.tick({ agents: [], now: 30 * S, idleMs: null, minuteOfDay: NOON })).toEqual([]);
    // Back with the same id: counts from now.
    expect(w.tick({ agents: [agent("blocked")], now: 70 * S, idleMs: null, minuteOfDay: NOON })).toEqual([]);
  });

  it("follows configured thresholds", () => {
    const got = play(
      [
        [0, "working"],
        [10, "blocked"],
      ],
      100,
      { rules: { blockedAfterMs: 20_000 } },
    );
    expect(got.map(([t, n]) => [t, n.kind])).toEqual([[30, "blocked"]]);
  });

  it("knows since when each pane is in its state, and which were there from the start", () => {
    const w = new Watcher(DEFAULT_RULES);
    w.tick({ agents: [agent("working")], now: 0, idleMs: null, minuteOfDay: NOON });
    w.tick({
      agents: [agent("blocked"), agent("idle", { pane_id: "w1:p2", terminal_id: "term_2" })],
      now: 10 * S,
      idleMs: null,
      minuteOfDay: NOON,
    });
    expect(w.snapshot()).toEqual([
      { key: "w1:p1|term_1", status: "blocked", since: 10 * S, sinceStart: false, workingSince: 0 },
      { key: "w1:p2|term_2", status: "idle", since: 10 * S, sinceStart: false, workingSince: null },
    ]);
  });
});

describe("quiet hours", () => {
  it("parses and wraps around midnight", () => {
    expect(parseQuiet(null)).toEqual({ start: 23 * 60, end: 8 * 60 });
    expect(parseQuiet("off")).toBeNull();
    expect(parseQuiet("22:30-07:00")).toEqual({ start: 22 * 60 + 30, end: 7 * 60 });
    expect(() => parseQuiet("late")).toThrow(/23:00-08:00/);
    const r = { ...DEFAULT_RULES };
    expect(inQuiet(r, 23 * 60 + 5)).toBe(true);
    expect(inQuiet(r, 7 * 60 + 59)).toBe(true);
    expect(inQuiet(r, 8 * 60)).toBe(false);
    expect(inQuiet({ ...r, quiet: { start: 13 * 60, end: 14 * 60 } }, 13 * 60 + 30)).toBe(true);
    expect(minuteOfDay(new Date("2026-10-19T15:30:00Z"), "Asia/Shanghai")).toBe(23 * 60 + 30);
  });
});
