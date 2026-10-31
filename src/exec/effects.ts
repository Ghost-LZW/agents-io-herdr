/**
 * The effect ledger (docs/exec.md N3): `exec/effects.jsonl`, 0600, one JSON line per
 * change of an effect, the last line for an id winning. It is the one truth about what ran here: an
 * effect is written `running`, and synced to disk, before anything starts, so one effect id never
 * runs twice — not after a reconnect, a 4410, or a restart of the collector or of the machine. LB
 * works the ids out per turn (docs/exec.md, effect ids); a call with a known id is answered from here, whatever the
 * generation (the generation decides whether new work is taken, never whether old work is owned).
 *
 * - At start, an entry still `running` becomes `unknown` (`host_restart` when the machine has booted
 *   since it started, else `collector_restart`) and is reported; it is never run again.
 * - Kept: the output (redacted already) until an hour after LB's `effect_ack`; the entry until a day
 *   after max(deadline, end). The deadline is at most the ceiling's longest run ahead (deadline_too_far),
 *   so a replay of a dropped id cannot come later than that.
 * - A line cut short by a crash is skipped; the file is rewritten whole (compacted) when output or
 *   entries go, or when old lines outnumber the live ones.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { EffectReport, EffectState, FinalState, Pair } from "./frames.ts";

/** Output is cleared this long after LB acknowledged the effect. */
export const OUTPUT_KEEP_MS = 3_600_000;
/** An entry is dropped this long after its deadline or its end, whichever is later. */
export const ENTRY_KEEP_MS = 24 * 3_600_000;

export interface EffectEntry extends EffectReport {
  op: string;
  argsHash: string;
  /**
   * The node it was taken for (absent from lines written before it was kept). After `sessions pair`
   * the old node's effects are never sent to the new one: LB's effect ids name the node anyway.
   */
  node?: string;
  /**
   * Whom and which conversation it was taken for (absent from older lines): only they are answered
   * from the ledger. LB's ids name the turn, so its own asking again always matches.
   */
  origin?: { person: string; conversation: string };
  /** The generation the effect was taken in. */
  generation: number;
  deadline: number;
  /** When LB acknowledged the final `effect` frame; until then it is sent again after each welcome. */
  ackedAt: number | null;
  /** The output has been cleared: state, exit, sizes and hashes are left. */
  outputExpired: boolean;
  /**
   * The run's process group and when it was started (same user only): a collector that starts after
   * one that died stops what is still running in it (acceptance case 13). Written just after the
   * start, so a crash in between leaves a run without it.
   */
  proc?: { pgid: number; spawnedAt: number } | null;
}

export interface Claim {
  effect_id: string;
  op: string;
  argsHash: string;
  node?: string;
  origin?: { person: string; conversation: string } | null;
  generation: number;
  deadline: number;
  grant: string | null;
}

/** How an effect ended; the output is redacted already, `bytes` are the lengths before that. */
export interface Outcome {
  state: Exclude<FinalState, "unknown">;
  exit: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  redacted: Pair<number>;
  truncated: boolean;
  bytes: Pair<number>;
  reason: string | null;
  data?: EffectReport["data"];
}

export type Lookup = { kind: "new" } | { kind: "known"; entry: EffectEntry } | { kind: "conflict"; entry: EffectEntry };

const STATES: readonly EffectState[] = ["running", "done", "failed", "timeout", "cancelled", "unknown"];
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const EMPTY = sha256("");

function readEntry(line: string): EffectEntry | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  const e = v as Partial<EffectEntry> | null;
  if (!e || typeof e !== "object" || typeof e.effect_id !== "string" || typeof e.argsHash !== "string") return null;
  if (!STATES.includes(e.state as EffectState) || typeof e.startedAt !== "number" || typeof e.deadline !== "number")
    return null;
  return { ...(e as EffectEntry), ackedAt: e.ackedAt ?? null, outputExpired: e.outputExpired === true };
}

/** What goes into the `effect` frame (and a known effect's result): the entry without the ledger's own fields. */
export function report(e: EffectEntry): EffectReport {
  return {
    effect_id: e.effect_id,
    state: e.state,
    exit: e.exit,
    signal: e.signal,
    stdout: e.stdout,
    stderr: e.stderr,
    redacted: e.redacted,
    truncated: e.truncated,
    bytes: e.bytes,
    sha256: e.sha256,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    grant: e.grant,
    reason: e.reason,
    ...(e.data && { data: e.data }),
  };
}

export class EffectLedger {
  readonly path: string;
  #now: () => number;
  #entries = new Map<string, EffectEntry>();
  /** Lines in the file now (live or superseded). */
  #lines = 0;
  /** The file does not end in a newline (a write cut short): the next line starts on a new one. */
  #torn = false;
  /** Lines that could not be read: gone at the next compaction. */
  #unreadable = 0;
  /** What was running when the last collector stopped, now unknown (`open`). */
  recovered: EffectEntry[] = [];

  constructor(path: string, now: () => number) {
    this.path = path;
    this.#now = now;
  }

  /**
   * Loads the file, turns what was running into `unknown`, applies the keep times. `bootAt`: when the
   * machine last started (ms), to tell a reboot from a collector restart.
   */
  static open(path: string, o: { now: () => number; bootAt: number; log?: (s: string) => void }): EffectLedger {
    const l = new EffectLedger(path, o.now);
    const skipped = l.load();
    if (skipped) o.log?.(`effects: skipped ${skipped} unreadable line(s) in ${path}`);
    const lost = l.recover(o.bootAt);
    l.recovered = lost;
    if (lost.length) o.log?.(`effects: ${lost.length} effect(s) were running when this collector stopped; now unknown`);
    l.maintain();
    return l;
  }

  /** Reads the file; the number of lines it could not read. */
  load(): number {
    this.#entries.clear();
    this.#lines = 0;
    this.#torn = false;
    this.#unreadable = 0;
    if (!existsSync(this.path)) return 0;
    chmodSync(this.path, 0o600);
    const raw = readFileSync(this.path, "utf8");
    const lines = raw.split("\n");
    // The last piece is "" after a final newline; anything else is a line cut short.
    const tail = lines.pop() ?? "";
    this.#torn = tail !== "";
    let skipped = this.#torn ? 1 : 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      this.#lines++;
      const e = readEntry(line);
      if (e) this.#entries.set(e.effect_id, e);
      else skipped++;
    }
    this.#unreadable = skipped;
    return skipped;
  }

  get(id: string): EffectEntry | undefined {
    return this.#entries.get(id);
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Every entry, oldest first (`exec log`). */
  entries(): EffectEntry[] {
    return [...this.#entries.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** The same id with other arguments is a conflict, never a second run. */
  lookup(id: string, argsHash: string): Lookup {
    const e = this.#entries.get(id);
    if (!e) return { kind: "new" };
    return e.argsHash === argsHash ? { kind: "known", entry: e } : { kind: "conflict", entry: e };
  }

  /** Writes the effect `running` (on disk) before anything starts. Throws for an id already here. */
  claim(c: Claim): EffectEntry {
    if (this.#entries.has(c.effect_id)) throw new Error(`effect ${c.effect_id} is in the ledger already`);
    const e: EffectEntry = {
      effect_id: c.effect_id,
      op: c.op,
      argsHash: c.argsHash,
      ...(c.node && { node: c.node }),
      ...(c.origin && { origin: { person: c.origin.person, conversation: c.origin.conversation } }),
      generation: c.generation,
      deadline: c.deadline,
      state: "running",
      exit: null,
      signal: null,
      stdout: "",
      stderr: "",
      redacted: { stdout: 0, stderr: 0 },
      truncated: false,
      bytes: { stdout: 0, stderr: 0 },
      sha256: { stdout: EMPTY, stderr: EMPTY },
      startedAt: this.#now(),
      endedAt: null,
      grant: c.grant,
      reason: null,
      ackedAt: null,
      outputExpired: false,
    };
    this.#put(e);
    return e;
  }

  /** The end of a running effect; null when it is not running (ended already, or turned unknown). */
  finish(id: string, o: Outcome): EffectEntry | null {
    const e = this.#entries.get(id);
    if (!e || e.state !== "running") return null;
    const done: EffectEntry = {
      ...e,
      ...o,
      sha256: { stdout: sha256(o.stdout), stderr: sha256(o.stderr) },
      endedAt: this.#now(),
    };
    this.#put(done);
    return done;
  }

  /** The running effect's process group, once it has one. */
  attach(id: string, proc: { pgid: number; spawnedAt: number }): void {
    const e = this.#entries.get(id);
    if (e?.state === "running") this.#put({ ...e, proc });
  }

  /**
   * A running effect whose end will not be known (the collector is stopping it on its way out):
   * `unknown`, with the output it had so far. null when it is not running.
   */
  abandon(id: string, reason: string, o: Partial<Outcome> = {}): EffectEntry | null {
    const e = this.#entries.get(id);
    if (!e || e.state !== "running") return null;
    const stdout = o.stdout ?? "";
    const stderr = o.stderr ?? "";
    const u: EffectEntry = {
      ...e,
      ...o,
      state: "unknown",
      exit: null,
      stdout,
      stderr,
      sha256: { stdout: sha256(stdout), stderr: sha256(stderr) },
      endedAt: this.#now(),
      reason,
    };
    this.#put(u);
    return u;
  }

  /** LB has the final frame: it is not sent again. False for an id not here or not ended. */
  ack(id: string): boolean {
    const e = this.#entries.get(id);
    if (!e || e.state === "running") return false;
    if (e.ackedAt === null) this.#put({ ...e, ackedAt: this.#now() });
    return true;
  }

  /**
   * Ended effects LB has not acknowledged yet, oldest first; given a node, only its own (and those
   * from before the node was kept): another node's — this machine paired since — are not sent.
   */
  pending(node?: string): EffectEntry[] {
    return [...this.#entries.values()]
      .filter((e) => e.state !== "running" && e.ackedAt === null && (!node || !e.node || e.node === node))
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Every `running` entry becomes `unknown`: whatever ran it is gone. Never run again. */
  recover(bootAt: number): EffectEntry[] {
    const lost: EffectEntry[] = [];
    for (const e of this.#entries.values()) {
      if (e.state !== "running") continue;
      const u: EffectEntry = {
        ...e,
        state: "unknown",
        endedAt: this.#now(),
        reason: bootAt > e.startedAt ? "host_restart" : "collector_restart",
      };
      this.#put(u);
      lost.push(u);
    }
    return lost;
  }

  /** Clears output an hour after the ack, drops entries a day after max(deadline, end); compacts. */
  maintain(): boolean {
    const now = this.#now();
    let changed = false;
    for (const e of [...this.#entries.values()]) {
      if (e.state === "running") continue;
      if (now >= Math.max(e.deadline, e.endedAt ?? 0) + ENTRY_KEEP_MS) {
        this.#entries.delete(e.effect_id);
        changed = true;
      } else if (!e.outputExpired && e.ackedAt !== null && now >= e.ackedAt + OUTPUT_KEEP_MS) {
        this.#entries.set(e.effect_id, { ...e, stdout: "", stderr: "", outputExpired: true });
        changed = true;
      }
    }
    // Cleared output must leave the disk too, not only the map.
    if (changed || this.#unreadable || this.#lines > 2 * this.#entries.size + 64) {
      this.compact();
      return true;
    }
    return false;
  }

  /** Rewrites the file with one line per live entry (a temporary file, synced, renamed over it). */
  compact(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    const body = [...this.#entries.values()].map((e) => `${JSON.stringify(e)}\n`).join("");
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    this.#lines = this.#entries.size;
    this.#torn = false;
    this.#unreadable = 0;
  }

  #put(e: EffectEntry): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, `${this.#torn ? "\n" : ""}${JSON.stringify(e)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#torn = false;
    this.#lines++;
    this.#entries.set(e.effect_id, e);
  }
}
