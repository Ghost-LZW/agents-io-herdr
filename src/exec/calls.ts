/**
 * LB's exec-family calls (docs/exec.md N1): `exec.v1`, `upload.v1`, `download.v1`, `cancel.v1`.
 * The effect ledger is asked first: an effect id seen before is answered from it (its state, or the
 * whole final frame), whatever the generation, and never run again — to the person and conversation
 * it was taken for only; the same id with other arguments is `effect_conflict`. Only then the gate
 * (retired, generation, clock, LB's switch, the ceiling) and the generation the call was made in. New
 * work goes to `take` — the ceiling, grants and runner (N2, N5, N7); without it nothing new is taken.
 */
import { type EffectEntry, type EffectLedger, report } from "./effects.ts";
import { argsHash, type CallAnswer, type CallFrame, isExecOp, type Origin, refuse } from "./frames.ts";

export type GateCode = "exec_off" | "retired" | "clock_skew" | "stale_generation";

/** Whether new work may be taken (generation.ts, then the ceiling); when not, the refusal and (for `exec_off`) why. */
export type Gate = { open: true; generation: number } | { open: false; code: GateCode; reason: string };

export interface ExecContext {
  ledger: EffectLedger;
  gate: () => Gate;
  /** New work, once the gate is open: checks, claims the effect and starts it (later packages). */
  take?: (call: CallFrame, argsHash: string, generation: number) => CallAnswer | Promise<CallAnswer>;
}

/**
 * A known effect as a result: the effect frame's fields (no `t`); the output may have been cleared.
 * Only for the person and the conversation it was taken for (an entry from before they were kept:
 * anyone the gate would let in); another gets `not_owner` or `effect_conflict` and nothing of it.
 */
export function known(e: EffectEntry, origin: Origin | null): CallAnswer {
  if (e.origin && origin?.person !== e.origin.person)
    return refuse("not_owner", "this effect was taken for someone else");
  if (e.origin && origin?.conversation !== e.origin.conversation)
    return refuse("effect_conflict", "this effect id was taken in another conversation");
  return { ok: true, data: { ...report(e), ...(e.outputExpired && { outputExpired: true }) } };
}

export function answerExec(call: CallFrame, ctx: ExecContext): CallAnswer | Promise<CallAnswer> {
  if (!isExecOp(call.op)) return refuse("unsupported", "this node does not do that");
  if (!call.effectId || call.deadline === null || call.generation === null || !call.origin)
    return refuse("bad_request", "an exec call needs effect_id, deadline, generation and origin");
  const hash = argsHash(call.op, call.args);
  const seen = ctx.ledger.lookup(call.effectId, hash);
  if (seen.kind === "conflict") return refuse("effect_conflict", "this effect id was used with other arguments");
  if (seen.kind === "known") return known(seen.entry, call.origin);
  const gate = ctx.gate();
  if (!gate.open) return refuse(gate.code, "", gate.code === "exec_off" ? { reason: gate.reason } : undefined);
  if (call.generation !== gate.generation)
    return refuse(
      "stale_generation",
      `the call is for generation ${call.generation}, this machine is in ${gate.generation}`,
    );
  return ctx.take ? ctx.take(call, hash, gate.generation) : refuse("runner_unavailable", "nothing runs here yet");
}
