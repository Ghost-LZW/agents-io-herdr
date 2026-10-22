/**
 * When an agent in a herdr pane is worth a notification, from what `agent.list` says every few
 * seconds. No I/O here: the caller passes the rows, the clock and how long the keyboard and mouse
 * have been idle.
 *
 * - blocked (a permission prompt or a question): once per blocked stretch, after `blockedAfterMs`,
 *   and not while the person is looking at that pane (it goes out when they leave, if still blocked);
 * - done: a working stretch of at least `doneMinTurnMs` that has been over for `doneSettleMs`
 *   (a working → idle → working flap within that time is one stretch); dropped when the person was
 *   looking at the pane, held during quiet hours and sent as one overnight list when they end;
 * - `unknown` changes nothing; panes that are gone are forgotten.
 */
import type { HerdrAgent } from "./herdr.ts";

export interface WatchRules {
  blockedAfterMs: number;
  doneSettleMs: number;
  doneMinTurnMs: number;
  /** Keyboard and mouse idle for less than this, and the pane focused in herdr: the person is looking. */
  presentIdleMs: number;
  /** Quiet hours as minutes after midnight, local; null: none. */
  quiet: { start: number; end: number } | null;
  /** Blocked notices also wait for quiet hours to end. */
  quietBlocked: boolean;
}

export const DEFAULT_RULES: WatchRules = {
  blockedAfterMs: 60_000,
  doneSettleMs: 30_000,
  doneMinTurnMs: 120_000,
  presentIdleMs: 180_000,
  quiet: { start: 23 * 60, end: 8 * 60 },
  quietBlocked: false,
};

export interface OvernightItem {
  agent: HerdrAgent;
  turnMs: number;
  endedAt: number;
}

export type Notice =
  | { kind: "blocked"; agent: HerdrAgent }
  | { kind: "done"; agent: HerdrAgent; turnMs: number }
  | { kind: "overnight"; items: OvernightItem[] };

interface PaneState {
  status: string;
  since: number;
  /** The pane was already there when watching began: `since` is a lower bound. */
  sinceStart: boolean;
  /** Start of the current working stretch (kept through a blocked dialog and a short flap). */
  workingSince: number | null;
  /** When the stretch last stopped working. */
  endedAt: number | null;
  blockedSent: boolean;
  doneHandled: boolean;
}

export interface Tick {
  agents: HerdrAgent[];
  now: number;
  /** Keyboard and mouse idle time; null when unknown (never counts as present). */
  idleMs: number | null;
  /** Minutes after local midnight. */
  minuteOfDay: number;
}

/** What the watcher knows of one pane, for a status listing. */
export interface PaneView {
  key: string;
  status: string;
  since: number;
  sinceStart: boolean;
}

export function inQuiet(rules: WatchRules, minute: number): boolean {
  const q = rules.quiet;
  if (!q || q.start === q.end) return false;
  return q.start < q.end ? minute >= q.start && minute < q.end : minute >= q.start || minute < q.end;
}

/** A pane and the program in it: a new program in the same pane is a new key. */
export const paneKey = (a: Pick<HerdrAgent, "pane_id" | "terminal_id">) => `${a.pane_id}|${a.terminal_id}`;
const idle = (s: string) => s === "idle" || s === "done";

export class Watcher {
  #rules: WatchRules;
  #panes = new Map<string, PaneState>();
  #overnight = new Map<string, OvernightItem>();
  #ticks = 0;

  constructor(rules: WatchRules) {
    this.#rules = rules;
  }

  /** The panes as last seen. */
  snapshot(): PaneView[] {
    return [...this.#panes.entries()].map(([key, st]) => ({
      key,
      status: st.status,
      since: st.since,
      sinceStart: st.sinceStart,
    }));
  }

  tick(t: Tick): Notice[] {
    const r = this.#rules;
    const out: Notice[] = [];
    const quiet = inQuiet(r, t.minuteOfDay);
    const first = this.#ticks++ === 0;
    const seen = new Set<string>();
    for (const a of t.agents) {
      if (!a.agent) continue;
      const key = paneKey(a);
      seen.add(key);
      const status = a.agent_status;
      let st = this.#panes.get(key);
      if (!st) {
        // Found already running: blocked counts from now, a finished turn is not news.
        st = {
          status,
          since: t.now,
          sinceStart: first,
          workingSince: status === "working" ? t.now : null,
          endedAt: null,
          blockedSent: false,
          doneHandled: status !== "working",
        };
        this.#panes.set(key, st);
      }
      if (status !== "unknown" && status !== st.status) {
        if (status === "working") {
          const resumed = st.workingSince !== null && (st.endedAt === null || t.now - st.endedAt < r.doneSettleMs);
          if (!resumed) {
            st.workingSince = t.now;
            st.doneHandled = false;
          }
          st.endedAt = null;
        } else if (st.status === "working" || (st.status === "blocked" && st.workingSince !== null)) {
          if (idle(status)) st.endedAt = t.now;
        }
        if (status === "blocked") st.blockedSent = false;
        st.status = status;
        st.since = t.now;
        st.sinceStart = false;
      }
      const present = t.idleMs !== null && t.idleMs < r.presentIdleMs && a.focused;
      if (st.status === "blocked" && !st.blockedSent && t.now - st.since >= r.blockedAfterMs) {
        if (!present && !(quiet && r.quietBlocked)) {
          out.push({ kind: "blocked", agent: a });
          st.blockedSent = true;
        }
      }
      if (idle(st.status) && !st.doneHandled && st.endedAt !== null && st.workingSince !== null) {
        if (t.now - st.endedAt >= r.doneSettleMs) {
          const turnMs = st.endedAt - st.workingSince;
          if (turnMs >= r.doneMinTurnMs && !present) {
            if (quiet) this.#overnight.set(key, { agent: a, turnMs, endedAt: st.endedAt });
            else out.push({ kind: "done", agent: a, turnMs });
          }
          st.doneHandled = true;
          st.workingSince = null;
        }
      }
    }
    for (const key of [...this.#panes.keys()]) if (!seen.has(key)) this.#panes.delete(key);
    if (!quiet && this.#overnight.size) {
      // Still there and still finished; newer work in the pane replaces the overnight entry.
      const items = [...this.#overnight.entries()]
        .filter(([key]) => {
          const st = this.#panes.get(key);
          return st && idle(st.status) && st.workingSince === null;
        })
        .map(([, v]) => v);
      this.#overnight.clear();
      if (items.length) out.push({ kind: "overnight", items });
    }
    return out;
  }
}
