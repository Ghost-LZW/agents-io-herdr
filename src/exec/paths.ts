/**
 * Where exec keeps its files, next to the collector's (`AGENTS_IO_HERDR_SESSIONS_DIR`, by default
 * `~/.config/agents-io-herdr`; docs/exec.md). All of them are this user's, 0600 in 0700 directories,
 * and none is readable or writable from inside the sandbox.
 */
import { join } from "node:path";

export interface ExecPaths {
  /** `{node, owner, generation}`: whom LB says this node belongs to, and which generation it is in. */
  node: string;
  dir: string;
  /** The effect ledger: what ran here, one JSON line per change. */
  effects: string;
  /** Present: LB named another owner; nothing links again until this machine is paired anew. */
  retired: string;
  /** The ceiling file (N2): no file, no exec. */
  ceiling: string;
  /** The off switch (`exec off`). */
  off: string;
  /** Once grants already used (N5). */
  grantsUsed: string;
  /** The last sweep of the dedicated user's processes (N9): when, how many were left. */
  sweep: string;
}

export function execPaths(sessionsDir: string): ExecPaths {
  const dir = join(sessionsDir, "exec");
  return {
    node: join(sessionsDir, "node.json"),
    dir,
    effects: join(dir, "effects.jsonl"),
    retired: join(dir, "retired"),
    ceiling: join(sessionsDir, "exec-ceiling.json"),
    off: join(sessionsDir, "exec.off"),
    grantsUsed: join(dir, "grants-used.jsonl"),
    sweep: join(dir, "sweep.json"),
  };
}
