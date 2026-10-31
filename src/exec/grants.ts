/**
 * Whether a call may be taken (docs/exec.md N5): the owner, the
 * deadline, the ceiling, the command's tier, and — for the grant tier — the owner's grant.
 *
 * - A grant comes in `call.grant`, filled by LB's server from an approved `node_grants` row (an agent
 *   cannot put one there). This machine checks it all again: this node, this generation, approved by
 *   this machine's owner, not expired on LB's clock, no longer than the ceiling's `grants.maxMinutes`.
 * - `once`: for this command only (its commandHash), and once: used ids are kept in
 *   `exec/grants-used.jsonl` (0600) for a day, so LB replaying one gets `grant_invalid`.
 * - `window`: only if the ceiling allows windows; the same conversation, cwd inside the grant's; never
 *   for a group turn, never for a run that widens the ceiling.
 * - Widening (network through the proxy, writes in `widenOnGrant.write`) takes a once grant, and only
 *   where the runner sweeps the user's processes afterwards (`runner: "user"`); on a person's own
 *   computer it is `widen_disabled` until the sandbox can reap what escapes its process group (S9).
 * - A new generation (4410) voids every grant by itself: grants name their generation. The used list
 *   stays, like the effect ledger.
 * - A turn no one is at (`attended: false`) gets nothing, auto commands included, unless the ceiling
 *   has `unattended: true`.
 */
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { writePrivate } from "../store.ts";
import { type Ceiling, intersect } from "./ceiling.ts";
import { matchCommand } from "./commands.ts";
import {
  type CallAnswer,
  type CallFrame,
  commandHash,
  type ExecArgs,
  type Network,
  parseExecArgs,
  refuse,
  STDIN_MAX,
} from "./frames.ts";

/** Used once grants are remembered this long (longer than any grant lives). */
export const USED_KEEP_MS = 24 * 3_600_000;
/** A deadline may be at most this much beyond the ceiling's longest run. */
export const DEADLINE_SLACK_MS = 60_000;

export interface Grant {
  id: string;
  node: string;
  generation: number;
  kind: "once" | "window";
  /** once: the command it is for. */
  commandHash: string | null;
  /** window: the conversation and the directory it covers. */
  scope: { conversation: string; cwd: string } | null;
  approvedBy: string;
  approvedAt: number;
  expiresAt: number;
  card: string | null;
}

const GRANT_ID = /^gr_[A-Za-z0-9_-]{1,96}$/;
const str = (v: unknown, max = 200) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
const ms = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null);

/** A grant as LB sends it, or null. */
export function parseGrant(v: unknown): Grant | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const g = v as Record<string, unknown>;
  const id = str(g.id, 100);
  const node = str(g.node);
  const approvedBy = str(g.approvedBy);
  const approvedAt = ms(g.approvedAt);
  const expiresAt = ms(g.expiresAt);
  if (!id || !GRANT_ID.test(id) || !node || !approvedBy || !approvedAt || !expiresAt) return null;
  if (!Number.isSafeInteger(g.generation) || (g.kind !== "once" && g.kind !== "window")) return null;
  const hash = typeof g.commandHash === "string" && /^[0-9a-f]{64}$/.test(g.commandHash) ? g.commandHash : null;
  let scope: Grant["scope"] = null;
  if (g.scope && typeof g.scope === "object") {
    const s = g.scope as Record<string, unknown>;
    const conversation = str(s.conversation);
    const cwd = str(s.cwd, 4096);
    if (conversation && cwd) scope = { conversation, cwd };
  }
  if (g.kind === "once" && !hash) return null;
  if (g.kind === "window" && !scope) return null;
  return {
    id,
    node,
    generation: g.generation as number,
    kind: g.kind,
    commandHash: hash,
    scope,
    approvedBy,
    approvedAt,
    expiresAt,
    card: str(g.card),
  };
}

/** Once grants already used here: `exec/grants-used.jsonl`, one `{id, at}` per line, kept a day. */
export class GrantsUsed {
  readonly path: string;
  #now: () => number;
  #used = new Map<string, number>();
  /** Lines that did not read (cut short by a crash): the file is rewritten without them. */
  #unreadable = 0;

  constructor(path: string, now: () => number) {
    this.path = path;
    this.#now = now;
    if (!existsSync(path)) return;
    chmodSync(path, 0o600);
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const v = JSON.parse(line) as { id?: unknown; at?: unknown };
        if (typeof v.id === "string" && typeof v.at === "number") this.#used.set(v.id, v.at);
        else this.#unreadable++;
      } catch {
        this.#unreadable++;
      }
    }
    this.prune();
  }

  has(id: string): boolean {
    return this.#used.has(id);
  }

  get size(): number {
    return this.#used.size;
  }

  /** Written (and synced) before the run starts, like the effect it is used for. */
  use(id: string): void {
    if (this.#used.has(id)) throw new Error(`grant ${id} was used already`);
    const at = this.#now();
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ id, at })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#used.set(id, at);
  }

  /** Forgets ids used more than a day ago; rewrites the file when any went. */
  prune(): void {
    const now = this.#now();
    let changed = false;
    for (const [id, at] of this.#used)
      if (now - at > USED_KEEP_MS) {
        this.#used.delete(id);
        changed = true;
      }
    if (!changed && !this.#unreadable) return;
    writePrivate(this.path, [...this.#used].map(([id, at]) => `${JSON.stringify({ id, at })}\n`).join(""));
    this.#unreadable = 0;
  }
}

export interface GrantCheck {
  nodeId: string;
  generation: number;
  owner: string;
  /** LB's time now: this machine's clock and the skew at the last welcome. */
  lbNow: number;
  ceiling: Ceiling;
  commandHash: string;
  conversation: string;
  /** The run's cwd, expanded. */
  cwd: string;
  group: boolean;
  widened: boolean;
  used: GrantsUsed;
}

/** null: the grant covers this run; otherwise why not (`grant_invalid`'s message). */
export function checkGrant(g: Grant, o: GrantCheck): string | null {
  if (g.node !== o.nodeId) return "the grant is for another node";
  if (g.generation !== o.generation) return "the grant is for another generation";
  if (g.approvedBy !== o.owner) return "the grant was not approved by this machine's owner";
  if (o.lbNow >= g.expiresAt) return "the grant has expired";
  if (g.expiresAt <= g.approvedAt || g.expiresAt - g.approvedAt > o.ceiling.file.grants.maxMinutes * 60_000)
    return `the grant is longer than this machine allows (${o.ceiling.file.grants.maxMinutes} min)`;
  if (g.kind === "once") {
    if (g.commandHash !== o.commandHash) return "the grant is for another command";
    if (o.used.has(g.id)) return "the grant was used already";
    return null;
  }
  if (!o.ceiling.file.grants.window) return "this machine takes no window grants";
  if (o.group) return "no window grants for a group turn";
  if (o.widened) return "widening takes a once grant";
  if (g.scope?.conversation !== o.conversation) return "the grant is for another conversation";
  const root = expandIn(g.scope.cwd, o.ceiling.home);
  if (!root || !(o.cwd === root || o.cwd.startsWith(`${root}/`))) return "cwd is outside the grant's directory";
  return null;
}

function expandIn(p: string, home: string): string | null {
  if (p === "~") return home;
  if (p.startsWith("~/")) return `${home}/${p.slice(2)}`.replace(/\/+$/, "");
  return p.startsWith("/") ? p.replace(/\/+$/, "") || "/" : null;
}

export interface AdmitContext {
  ceiling: Ceiling;
  nodeId: string;
  /** The owner LB named (node.json); null until then: nothing is admitted. */
  owner: string | null;
  generation: number;
  lbNow: number;
  used: GrantsUsed;
  /** For tests: whether a path exists (the private marker). */
  exists?: (p: string) => boolean;
}

/** A call that may run: what, where, until when, under which grant. */
export interface Admission {
  args: ExecArgs;
  tier: "auto" | "grant";
  why: string;
  cwd: string;
  write: string[];
  effective: { network: Network; write: string[]; maxSeconds: number; outputBytes: number };
  commandHash: string;
  grant: Grant | null;
  /** The call's deadline, cut to the ceiling's longest run. */
  deadline: number;
}

/**
 * exec.v1 against the owner, the deadline, the ceiling and the grant, in that order. The once grant
 * is not marked used here: the run's claim does that, with the effect (N7).
 */
export function admitExec(
  call: CallFrame,
  ctx: AdmitContext,
): { ok: true; admission: Admission } | { ok: false; answer: CallAnswer } {
  const no = (a: CallAnswer) => ({ ok: false as const, answer: a });
  const args = parseExecArgs(call.args);
  const origin = call.origin;
  if (!args || !origin || call.deadline === null)
    return no(refuse("bad_request", "exec.v1 needs argv, cwd and policy"));
  const c = ctx.ceiling;
  const f = c.file;
  if (!ctx.owner || (origin.person !== ctx.owner && !f.others.includes(origin.person)))
    return no(refuse("not_owner", "not for this machine's owner"));
  if (call.deadline <= ctx.lbNow) return no(refuse("deadline_passed", "the deadline has passed"));
  if (call.deadline > ctx.lbNow + f.limits.maxSeconds * 1000 + DEADLINE_SLACK_MS)
    return no(refuse("deadline_too_far", `this machine runs a command for at most ${f.limits.maxSeconds} s`));
  if (args.stdin !== null && Buffer.byteLength(args.stdin, "utf8") > STDIN_MAX)
    return no(refuse("too_large", "stdin is larger than 64 KiB"));
  const fit = intersect(c, args, { exists: ctx.exists });
  if (!fit.ok) return no(refuse(fit.code, fit.message));
  const m = matchCommand(f.commands, args, { where: origin.where, groupTurns: f.groupTurns });
  if (m.tier === "never") return no(refuse("never", `this command is never run here (${m.why})`));
  const widened = fit.widened.length > 0;
  if (widened && f.runner !== "user")
    return no(refuse("widen_disabled", `widening on a grant is off on this machine (${fit.widened.join(", ")})`));
  const tier = widened ? "grant" : m.tier;
  const why = widened ? fit.widened.join(", ") : m.why;
  const hash = commandHash({
    argv: args.argv,
    cwd: args.cwd,
    shell: args.shell,
    network: args.policy.network,
    write: args.policy.write,
  });
  const deadline = Math.min(call.deadline, ctx.lbNow + f.limits.maxSeconds * 1000);
  const admitted = (grant: Grant | null) => ({
    ok: true as const,
    admission: {
      args,
      tier,
      why,
      cwd: fit.cwd,
      write: fit.write,
      effective: fit.effective,
      commandHash: hash,
      grant,
      deadline,
    },
  });
  // No one there (a routine or a follow-up turn): nothing at all, auto included, unless the ceiling
  // says so (an agent machine yes, a person's own computer no).
  if (!origin.attended && !f.unattended) return no(refuse("unattended", "not in an unattended turn"));
  if (tier === "auto") return admitted(null);
  const group = origin.where === "group";
  if (call.grant === null || call.grant === undefined)
    return no(
      refuse("needs_grant", `needs the owner's grant (${why})`, {
        tier: "grant",
        commandHash: hash,
        maxMinutes: f.grants.maxMinutes,
        window: f.grants.window && !group && !widened,
      }),
    );
  const g = parseGrant(call.grant);
  if (!g) return no(refuse("grant_invalid", "the grant does not read"));
  const bad = checkGrant(g, {
    nodeId: ctx.nodeId,
    generation: ctx.generation,
    owner: ctx.owner,
    lbNow: ctx.lbNow,
    ceiling: c,
    commandHash: hash,
    conversation: origin.conversation,
    cwd: fit.cwd,
    group,
    widened,
    used: ctx.used,
  });
  if (bad) return no(refuse("grant_invalid", bad));
  return admitted(g);
}
