/**
 * exec.v1 on the node connection (docs/exec.md N1), written out by hand like
 * src/protocol.ts: hello / welcome v2, a call's effect id, deadline, generation, grant and origin,
 * results that may carry `error.data`, `effect` / `effect_ack`, `chunk`, the close codes, and the two
 * hashes LB and this machine must work out alike (docs/exec.md, hashes). test/fixtures/exec-contract.json is the
 * contract; LB keeps a verbatim copy and checks the same frames. Receivers ignore unknown fields.
 */
import { createHash } from "node:crypto";

/** hello's `version`: 2 adds `generation`, `ceiling` and `clock` (an old LB drops them). */
export const VERSION = "agents-io-herdr-sessions/2";

/** No hello, or not in time. */
export const CLOSE_BAD_HELLO = 4400;
/** The owner has not confirmed the pairing yet. */
export const CLOSE_PENDING = 4401;
/** Revoked, unknown, or a bad signature. */
export const CLOSE_REFUSED = 4403;
/** Nothing heard for too long (LB closes with it first, then terminates; this side too, at 75 s). */
export const CLOSE_SILENT = 4408;
/** A newer connection of the same node took over. */
export const CLOSE_REPLACED = 4409;
/** LB moved the node to a new generation: running work stops, grants go, the effect ledger stays. */
export const CLOSE_GENERATION = 4410;

/** The four requests that do something on this machine. */
export const EXEC_OPS = ["exec.v1", "upload.v1", "download.v1", "cancel.v1"] as const;
export type ExecOp = (typeof EXEC_OPS)[number];
export const isExecOp = (op: unknown): op is ExecOp => (EXEC_OPS as readonly unknown[]).includes(op);

/** The caps beyond `sessions`: only while the ceiling file is valid and the machine is not retired. */
export const EXEC_CAPS = ["exec.v1", "transfer.v1", "agents.v1"] as const;

/** Refusal codes the Box added (the contract's `box.refusals`); they end the list below. */
export const BOX_REFUSALS = ["not_found", "tool_mismatch", "exists", "use_relative_path"] as const;

/**
 * Refusal codes (docs/exec.md N1); `session.read` keeps its own (`paused`, `session_gone`,
 * `unreadable`). `bad_request`: a call this side cannot read (no effect id, deadline or origin).
 */
export const REFUSALS = [
  "unsupported",
  "bad_request",
  "exec_off",
  "retired",
  "clock_skew",
  "stale_generation",
  "deadline_passed",
  "deadline_too_far",
  "over_ceiling",
  "never",
  "needs_grant",
  "grant_invalid",
  "widen_disabled",
  "not_owner",
  "unattended",
  "busy",
  "runner_unavailable",
  "sandbox_unavailable",
  "path_outside",
  "path_denied",
  "too_large",
  "effect_conflict",
  // The Box (docs/exec.md, Linux / Box): the person has no directory there, the installed tool is not
  // the version asked for, an argument names a path through `~` (only relative paths reach a tool).
  ...BOX_REFUSALS,
] as const;
export type RefusalCode = (typeof REFUSALS)[number];

/** `result.error.data`: at most this many bytes of JSON, or it is left out. */
export const DATA_MAX = 4096;
/** LB's limits on `result.error` (its `resultFrame`). */
const CODE_MAX = 64;
const MESSAGE_MAX = 1000;
/** Raw bytes in one `chunk` (base64 on the wire). */
export const CHUNK_MAX = 512 * 1024;
/**
 * LB takes no frame larger than this (its WebSocketServer's maxPayload) and closes with 1009; an
 * `effect` frame stays under it because each stream is cut to output.ts's ESCAPED_MAX.
 */
export const FRAME_MAX = 2 * 1024 * 1024;
/** LB's call ids and effect ids are at most this long. */
const ID_MAX = 100;

export type Where = "dm" | "group" | "routine" | "followup";
const WHERE: readonly string[] = ["dm", "group", "routine", "followup"];

/** Who the call is for (LB fills it from the turn; never from the agent). */
export interface Origin {
  conversation: string;
  turn: string;
  person: string;
  agent: string;
  attended: boolean;
  where: Where;
}

export interface Ceiling {
  /** The first 16 hex digits of the ceiling file's sha256. */
  sha: string;
  summary: Record<string, unknown>;
}

/** What hello v2 says beyond v1, read afresh on every connect. */
export interface HelloState {
  caps: string[];
  /** The generation this machine holds; 0 until LB has told it one (paired before node.json). */
  generation: number;
  /** null: no valid ceiling file (then `caps` is `["sessions"]`). */
  ceiling: Ceiling | null;
}

export function helloFrame(o: {
  node: string;
  sig: string;
  machine: { name: string; platform: string };
  state: HelloState;
  clock: number;
}): Record<string, unknown> {
  return {
    t: "hello",
    node: o.node,
    sig: o.sig,
    version: VERSION,
    caps: o.state.caps,
    machine: o.machine,
    generation: o.state.generation,
    ...(o.state.ceiling && { ceiling: o.state.ceiling }),
    clock: o.clock,
  };
}

/** What LB's welcome says; an old LB sends `{t:"welcome"}` and every field is null (exec stays off). */
export interface Welcome {
  generation: number | null;
  /** The owner's LB actor id. */
  owner: string | null;
  /** LB's clock (ms), for the skew. */
  now: number | null;
  /** LB's `LB_NODE_EXEC` and the owner's confirmation of the exec cap together. */
  exec: boolean;
}

const count = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null);
const text = (v: unknown, max = ID_MAX): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : null;

export function parseWelcome(m: Record<string, unknown>): Welcome {
  return {
    generation: count(m.generation),
    owner: text(m.owner, 200),
    now: count(m.now),
    exec: m.exec === true,
  };
}

/** A call from LB. The exec fields are there when LB sends an exec op; checked where they are used. */
export interface CallFrame {
  id: string;
  op: string;
  /** As LB sent them: the args hash is of these, not of a normalised copy. */
  args: Record<string, unknown>;
  effectId: string | null;
  deadline: number | null;
  generation: number | null;
  /** Filled by LB's server from an approved `node_grants` row, never by the agent; checked by N5. */
  grant: unknown;
  origin: Origin | null;
}

const EFFECT_ID = /^eff_[A-Za-z0-9_-]{1,96}$/;

export function parseOrigin(v: unknown): Origin | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const conversation = text(o.conversation, 200);
  const turn = text(o.turn, 200);
  const person = text(o.person, 200);
  const agent = text(o.agent, 200);
  if (!conversation || !turn || !person || !agent || typeof o.attended !== "boolean") return null;
  if (typeof o.where !== "string" || !WHERE.includes(o.where)) return null;
  return { conversation, turn, person, agent, attended: o.attended, where: o.where as Where };
}

/** null: not a call this side can answer at all (no id or op). */
export function parseCall(m: Record<string, unknown>): CallFrame | null {
  const id = text(m.id);
  if (m.t !== "call" || !id || typeof m.op !== "string") return null;
  const args =
    m.args && typeof m.args === "object" && !Array.isArray(m.args) ? (m.args as Record<string, unknown>) : {};
  return {
    id,
    op: m.op,
    args,
    effectId: typeof m.effect_id === "string" && EFFECT_ID.test(m.effect_id) ? m.effect_id : null,
    deadline: count(m.deadline),
    generation: count(m.generation),
    grant: m.grant ?? null,
    origin: parseOrigin(m.origin),
  };
}

/** exec.v1's arguments (docs/exec.md N1). */
export interface ExecArgs {
  argv: string[];
  /** `~/…` or absolute, as LB sent it (the command hash is of this, not of the expansion). */
  cwd: string;
  /** true: argv is a shell and its script; always at least the grant tier. */
  shell: boolean;
  stdin: string | null;
  env: Record<string, string>;
  /** `open` only ever passes on the Box's install cell (`box-install`); anywhere else it is over the ceiling. */
  policy: { network: Network; write: string[] };
}

/** What a run may reach: nothing, the local filtering proxy, or (the install cell only) the network itself. */
export type Network = "off" | "proxy" | "open";

/** At most this many bytes of stdin in a call. */
export const STDIN_MAX = 64 * 1024;
const ARG_MAX = 32 * 1024;

/** exec.v1's arguments, or null when they do not read (`bad_request`). Sizes past STDIN_MAX are the caller's (`too_large`). */
export function parseExecArgs(a: Record<string, unknown>): ExecArgs | null {
  const { argv, cwd, shell, stdin, env, policy } = a;
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 256) return null;
  if (!argv.every((x) => typeof x === "string" && x.length <= ARG_MAX) || argv[0] === "") return null;
  if (typeof cwd !== "string" || !cwd || cwd.length > 4096) return null;
  if (shell !== undefined && typeof shell !== "boolean") return null;
  if (stdin !== undefined && stdin !== null && typeof stdin !== "string") return null;
  const vars: Record<string, string> = {};
  if (env !== undefined && env !== null) {
    if (typeof env !== "object" || Array.isArray(env) || Object.keys(env).length > 32) return null;
    for (const [k, v] of Object.entries(env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) || typeof v !== "string" || v.length > 4096) return null;
      vars[k] = v;
    }
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const p = policy as Record<string, unknown>;
  if (p.network !== "off" && p.network !== "proxy" && p.network !== "open") return null;
  const write = p.write ?? [];
  if (!Array.isArray(write) || write.length > 16) return null;
  if (!write.every((w) => typeof w === "string" && w.length > 0 && w.length <= 4096)) return null;
  return {
    argv: argv as string[],
    cwd,
    shell: shell === true,
    stdin: typeof stdin === "string" ? stdin : null,
    env: vars,
    policy: { network: p.network, write: write as string[] },
  };
}

export interface Refusal {
  code: string;
  message: string;
  /** At most DATA_MAX bytes of JSON (`needs_grant`: tier, commandHash, maxMinutes, window). */
  data?: Record<string, unknown>;
}

export type CallAnswer = { ok: true; data: unknown } | { ok: false; error: Refusal };

export const refuse = (code: RefusalCode, message = "", data?: Record<string, unknown>): CallAnswer => ({
  ok: false,
  error: { code, message, ...(data && { data }) },
});

/** A result frame within LB's limits: `error.data` over DATA_MAX is left out rather than cut. */
export function resultFrame(id: string, a: CallAnswer): Record<string, unknown> {
  if (a.ok) return { t: "result", id, ok: true, data: a.data };
  const { code, message, data } = a.error;
  const fits = data !== undefined && Buffer.byteLength(JSON.stringify(data)) <= DATA_MAX;
  return {
    t: "result",
    id,
    ok: false,
    error: { code: code.slice(0, CODE_MAX), message: message.slice(0, MESSAGE_MAX), ...(fits && { data }) },
  };
}

export type EffectState = "running" | "done" | "failed" | "timeout" | "cancelled" | "unknown";
export type FinalState = Exclude<EffectState, "running">;
export const FINAL_STATES: readonly FinalState[] = ["done", "failed", "timeout", "cancelled", "unknown"];

export interface Pair<T> {
  stdout: T;
  stderr: T;
}

/**
 * How an effect ended, as the `effect` frame says it. The output is redacted here already (strict);
 * `redacted` counts the places, `bytes` are the lengths before redaction, `sha256` is of the
 * redacted text (never of the original: a short secret could be guessed against it).
 */
export interface EffectReport {
  effect_id: string;
  state: EffectState;
  exit: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  redacted: Pair<number>;
  truncated: boolean;
  bytes: Pair<number>;
  sha256: Pair<string>;
  startedAt: number;
  endedAt: number | null;
  grant: string | null;
  /** Why, when it is not plain: `host_restart` / `collector_restart` (unknown), `runner_protocol`… */
  reason: string | null;
  /** A file transfer's file once it is through (`upload.v1`, `download.v1`): `{path, size, sha256}`. */
  data?: Record<string, unknown>;
}

export const effectFrame = (r: EffectReport): Record<string, unknown> => ({ t: "effect", ...r });

export function parseEffectAck(m: Record<string, unknown>): string | null {
  return m.t === "effect_ack" && typeof m.effect_id === "string" && EFFECT_ID.test(m.effect_id) ? m.effect_id : null;
}

/** A piece of a file: LB → machine for an upload, machine → LB for a download. */
export interface Chunk {
  effect_id: string;
  /** The node the transfer belongs to: LB binds a chunk to its effect's node. */
  node: string;
  seq: number;
  /** base64 of at most CHUNK_MAX bytes. */
  data: string;
  last: boolean;
}

export const chunkFrame = (c: Chunk): Record<string, unknown> => ({ t: "chunk", ...c });

export function parseChunk(m: Record<string, unknown>): Chunk | null {
  if (m.t !== "chunk" || typeof m.effect_id !== "string" || !EFFECT_ID.test(m.effect_id)) return null;
  const node = text(m.node);
  const seq = count(m.seq);
  if (!node || seq === null || typeof m.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(m.data)) return null;
  if (Buffer.byteLength(m.data, "base64") > CHUNK_MAX) return null;
  return { effect_id: m.effect_id, node, seq, data: m.data, last: m.last === true };
}

/**
 * Canonical JSON (docs/exec.md, hashes): object keys sorted (by UTF-16 code unit, JavaScript's default sort), no
 * whitespace, UTF-8 as is (nothing escaped beyond what JSON must), keys whose value is undefined left
 * out, arrays in their order.
 */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonical(x))).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const sorted = (v: unknown) => (Array.isArray(v) ? [...v].sort() : v);

/** `sha256(canonical({op, args}))`, hex; `args.policy.write` sorted, every other array as it is. */
export function argsHash(op: string, args: Record<string, unknown>): string {
  const policy = args.policy;
  const a =
    policy && typeof policy === "object" && !Array.isArray(policy) && "write" in policy
      ? { ...args, policy: { ...policy, write: sorted((policy as Record<string, unknown>).write) } }
      : args;
  return sha256(canonical({ op, args: a }));
}

/** What a once grant names (docs/exec.md N5). `cwd` as sent, not expanded; `write` sorted. */
export interface Command {
  argv: string[];
  cwd: string;
  shell: boolean;
  network: Network;
  write: string[];
}

export const commandHash = (c: Command): string =>
  sha256(canonical({ argv: c.argv, cwd: c.cwd, shell: c.shell, network: c.network, write: [...c.write].sort() }));
