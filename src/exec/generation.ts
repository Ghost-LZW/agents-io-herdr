/**
 * The node's generation (docs/exec.md N4). `node.json` (0600) keeps
 * `{node, owner, generation}`; LB's welcome v2 hands out the current generation and owner:
 *
 * - First trust: a node paired before node.json existed (or by an LB that did not say the owner)
 *   takes the first owner and generation a welcome v2 names (docs/exec.md, compatibility).
 * - A higher generation, the same owner: kept. Grants and running work of the old one are void (the
 *   collector does that on 4410; a welcome after a bump missed while offline says so too).
 * - A lower one: exec stays off (`stale_generation`); never wound back.
 * - Another owner (the account changed hands): `exec/retired` is written, the link stops and does not
 *   come back until this machine is paired again (Grok's retire mark).
 * - No generation (an LB before exec): exec off (`lb_old`); sessions as before.
 * - The clocks more than 30 s apart: exec off (`clock_skew`).
 *
 * The collector reads node.json every pass (10 s): another node id there means `sessions pair` ran
 * again on this machine, and the older process stops (launchd starts it again as the new node).
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { writePrivate } from "../store.ts";
import type { Gate, GateCode } from "./calls.ts";
import type { Welcome } from "./frames.ts";
import type { ExecPaths } from "./paths.ts";

/** Further apart than this, LB's clock and this machine's: no exec. */
export const CLOCK_SKEW_MS = 30_000;

export interface NodeRecord {
  node: string;
  /** The owner's LB actor id; null until LB has said it. */
  owner: string | null;
  /** 0 until LB has said it. */
  generation: number;
}

export function readNodeRecord(path: string): NodeRecord | null {
  let v: Partial<NodeRecord>;
  try {
    v = JSON.parse(readFileSync(path, "utf8")) as Partial<NodeRecord>;
  } catch {
    return null;
  }
  if (!v || typeof v.node !== "string" || !v.node) return null;
  const g = v.generation;
  return {
    node: v.node,
    owner: typeof v.owner === "string" && v.owner ? v.owner : null,
    generation: typeof g === "number" && Number.isSafeInteger(g) && g >= 0 ? g : 0,
  };
}

export const writeNodeRecord = (path: string, r: NodeRecord) => writePrivate(path, `${JSON.stringify(r, null, 2)}\n`);

/**
 * After `sessions pair`: the new node, its owner as LB answered (null from an LB that does not say),
 * no generation yet; a retired mark goes (pairing again is the only way to clear it).
 */
export function paired(p: ExecPaths, node: string, owner: string | null): void {
  writeNodeRecord(p.node, { node, owner, generation: 0 });
  rmSync(p.retired, { force: true });
}

export type WelcomeOutcome =
  | { kind: "ok"; firstTrust: boolean; advanced: boolean }
  | { kind: "old" }
  | { kind: "stale" }
  | { kind: "retired" };

const closed = (code: GateCode, reason: string): Gate => ({ open: false, code, reason });

export class Generation {
  readonly paths: ExecPaths;
  /** The node this process links as. */
  readonly nodeId: string;
  #now: () => number;
  #log: (s: string) => void;
  #record: NodeRecord;
  #gate: Gate = closed("exec_off", "not_linked");
  /** LB's clock minus this machine's at the last welcome (grant expiry is checked on LB's time). */
  skewMs = 0;

  constructor(o: { paths: ExecPaths; nodeId: string; now: () => number; log: (s: string) => void }) {
    this.paths = o.paths;
    this.nodeId = o.nodeId;
    this.#now = o.now;
    this.#log = o.log;
    const r = readNodeRecord(o.paths.node);
    if (r && r.node === o.nodeId) this.#record = r;
    else {
      // Paired before node.json, or node.json is of an older pairing: the first welcome is trusted.
      this.#record = { node: o.nodeId, owner: null, generation: 0 };
      writeNodeRecord(o.paths.node, this.#record);
    }
  }

  get record(): NodeRecord {
    return { ...this.#record };
  }

  get generation(): number {
    return this.#record.generation;
  }

  get retired(): boolean {
    return existsSync(this.paths.retired);
  }

  gate(): Gate {
    return this.retired ? closed("retired", "owner_changed") : this.#gate;
  }

  onWelcome(w: Welcome): WelcomeOutcome {
    const r = this.#record;
    if (w.generation === null) {
      this.#gate = closed("exec_off", "lb_old");
      return { kind: "old" };
    }
    if (r.owner && w.owner && w.owner !== r.owner) {
      const at = new Date(this.#now()).toISOString();
      writePrivate(this.paths.retired, `${JSON.stringify({ at, node: r.node, owner: r.owner, lbOwner: w.owner })}\n`);
      this.#gate = closed("retired", "owner_changed");
      this.#log(`LB names another owner for node ${r.node}: this machine is retired until it is paired again`);
      return { kind: "retired" };
    }
    if (w.generation < r.generation) {
      this.#gate = closed("stale_generation", "lb_behind");
      this.#log(`LB says generation ${w.generation}, this machine holds ${r.generation}: exec stays off`);
      return { kind: "stale" };
    }
    const firstTrust = !r.owner && !!w.owner;
    const advanced = r.generation > 0 && w.generation > r.generation;
    const next: NodeRecord = { node: r.node, owner: w.owner ?? r.owner, generation: w.generation };
    if (next.owner !== r.owner || next.generation !== r.generation) {
      writeNodeRecord(this.paths.node, next);
      this.#record = next;
    }
    if (firstTrust) this.#log(`first welcome: generation ${w.generation}, owner as LB says`);
    if (advanced)
      this.#log(`generation ${r.generation} → ${w.generation}: the old one's grants and running work are void`);
    this.skewMs = w.now === null ? 0 : w.now - this.#now();
    if (w.now === null || Math.abs(this.skewMs) > CLOCK_SKEW_MS) {
      this.#gate = closed("clock_skew", "clock_skew");
      if (w.now !== null)
        this.#log(`this machine's clock is ${Math.round(this.skewMs / 1000)} s off LB's: exec stays off`);
    } else this.#gate = w.exec ? { open: true, generation: w.generation } : closed("exec_off", "lb_off");
    return { kind: "ok", firstTrust, advanced };
  }

  /** The link is down: nothing new until the next welcome. */
  onLinkDown(): void {
    this.#gate = closed("exec_off", "not_linked");
  }

  /** Why this process is no longer the node in node.json (paired again), or null. */
  identityChanged(): string | null {
    const r = readNodeRecord(this.paths.node);
    if (!r) return null;
    if (r.node !== this.nodeId) return `this machine was paired again (node.json names node ${r.node})`;
    if (this.#record.owner && r.owner !== this.#record.owner) return "node.json names another owner";
    return null;
  }
}
