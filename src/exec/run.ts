/**
 * Running a command (docs/exec.md N7: the collector keeps the control, a runner starts the process). The collector
 * decides — ledger, ceiling, grant, profile — and a runner starts the process:
 *
 * - `SameUserRunner` (a person's own computer): a child of the collector, as the collector's user,
 *   under `/usr/bin/sandbox-exec` with the run's profile; HOME and TMPDIR are a directory of the
 *   run's own under the system's temporary directory, removed afterwards.
 * - `UserRunner` (src/exec/user-runner.ts, an agent machine): the same through ssh into a dedicated
 *   user's forced command (src/exec/shim.ts), which runs it with the code below.
 *
 * Each run is its own process group. It ends at its deadline on the wall clock (looked at every
 * second, so a machine that slept past it ends it on waking: `timeout`), on cancel, or when it exits;
 * then SIGTERM to the group and SIGKILL 5 s later — and SIGKILL to whatever is left in the group once
 * its first process has exited. A process that left the group (`setsid`) is not reached from here:
 * the dedicated user's sweep, or S9 later (hardening #2).
 *
 * argv[0] is found outside the sandbox: a bare name along the collector's PATH (not one LB asked
 * for, which the run gets: the command's tier was given to the name as the system has it), and
 * Apple's `/usr/bin` stubs (`git`, `python3`…, which call xcrun and do not start under a deny-default
 * profile) as the real program `xcrun --find` names.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Exec } from "../system.ts";
import type { BoxJob } from "./box.ts";
import type { Outcome } from "./effects.ts";
import { BoundedSink, finishOutput } from "./output.ts";
import { buildProfile, ProfileError, type ProfileInput, preflight, SANDBOX_EXEC, type Spawner } from "./sandbox.ts";

/** After SIGTERM, the group has this long before SIGKILL. */
export const KILL_GRACE_MS = 5000;
/** How often a run looks at the wall clock for its deadline. */
const WATCH_MS = 1000;
/** Once the group is gone, output still in the pipes is waited for this long. */
const DRAIN_MS = 1000;

export type EndState = "done" | "failed" | "timeout" | "cancelled";

/** How the process ended (the output is the runner's sinks). */
export interface ProcEnd {
  state: EndState;
  exit: number | null;
  signal: string | null;
  reason: string | null;
}

export interface ProcSpec {
  /** argv[0] absolute. */
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** The bytes, or `stream`: stdin stays open for `write` and `end` (an upload's chunks). */
  stdin: Buffer | null | "stream";
  /** Open descriptors the child gets as fd 3, 4, … (bwrap's seccomp filter); closed here once it has them. */
  fds?: number[];
  /** On the wall clock (ms). */
  deadline: number;
  /** The seatbelt profile; null for bwrap (argv starts with bwrap), or unsandboxed process tests. */
  profileFile: string | null;
  sandboxExec?: string;
}

/** A command in its own process group, until it ends. */
export class Proc {
  readonly pid: number | null;
  readonly done: Promise<ProcEnd>;
  #now: () => number;
  #deadline: number;
  #ending: { state: "timeout" | "cancelled"; reason: string } | null = null;
  #exited = false;
  #watch: NodeJS.Timeout | null = null;
  #kill: NodeJS.Timeout | null = null;
  #stdin: NodeJS.WritableStream | null = null;

  constructor(
    spec: ProcSpec,
    o: { now: () => number; onStdout: (b: Buffer) => void; onStderr: (b: Buffer) => void; graceMs?: number },
  ) {
    this.#now = o.now;
    this.#deadline = spec.deadline;
    const [cmd, ...args] =
      spec.profileFile === null
        ? spec.argv
        : [spec.sandboxExec ?? SANDBOX_EXEC, "-f", spec.profileFile, "--", ...spec.argv];
    let resolveDone: (e: ProcEnd) => void = () => undefined;
    this.done = new Promise((r) => {
      resolveDone = r;
    });
    let child: ReturnType<typeof spawn>;
    try {
      // detached: a new session, so a new process group the run's signals go to.
      const stdio = spec.fds?.length ? ["pipe", "pipe", "pipe", ...spec.fds] : "pipe";
      child = spawn(cmd as string, args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: true,
        stdio: stdio as "pipe",
      });
    } catch (e) {
      this.pid = null;
      resolveDone({ state: "failed", exit: null, signal: null, reason: `spawn_failed: ${(e as Error).message}` });
      return;
    } finally {
      for (const fd of spec.fds ?? []) closeSync(fd);
    }
    this.pid = child.pid ?? null;
    child.stdout?.on("data", (b: Buffer) => o.onStdout(b));
    child.stderr?.on("data", (b: Buffer) => o.onStderr(b));
    child.stdin?.on("error", () => undefined);
    if (spec.stdin === "stream") this.#stdin = child.stdin ?? null;
    else {
      if (spec.stdin?.length) child.stdin?.write(spec.stdin);
      child.stdin?.end();
    }
    let settled = false;
    const settle = (end: ProcEnd) => {
      if (settled) return;
      settled = true;
      if (this.#watch) clearTimeout(this.#watch);
      if (this.#kill) clearTimeout(this.#kill);
      resolveDone(end);
    };
    child.on("error", (e) => {
      if (this.pid === null || !this.#exited)
        settle({ state: "failed", exit: null, signal: null, reason: `spawn_failed: ${e.message}` });
    });
    let streams = 2;
    let exitEnd: ProcEnd | null = null;
    const closed = () => {
      if (--streams <= 0 && exitEnd) settle(exitEnd);
    };
    child.stdout?.on("close", closed);
    child.stderr?.on("close", closed);
    child.on("exit", (code, signal) => {
      this.#exited = true;
      // The group's first process is gone: so is the run. What it left in the group goes too.
      this.#signal("SIGKILL");
      const late = this.#now() >= this.#deadline;
      const e = this.#ending ?? (late ? { state: "timeout" as const, reason: "deadline" } : null);
      exitEnd = { state: e?.state ?? "done", exit: code, signal: signal ?? null, reason: e?.reason ?? null };
      if (streams <= 0) settle(exitEnd);
      else
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          if (exitEnd) settle(exitEnd);
        }, DRAIN_MS).unref();
    });
    this.#arm(o.graceMs ?? KILL_GRACE_MS);
  }

  /** More of a `stream` stdin. */
  write(b: Buffer): void {
    if (b.length) this.#stdin?.write(b);
  }

  /** The end of a `stream` stdin. */
  end(): void {
    this.#stdin?.end();
    this.#stdin = null;
  }

  /** Stops the run: SIGTERM to the group now, SIGKILL after the grace. */
  stop(state: "timeout" | "cancelled", reason: string, graceMs = KILL_GRACE_MS): void {
    if (this.#ending || this.#exited || this.pid === null) return;
    this.#ending = { state, reason };
    this.#signal("SIGTERM");
    this.#kill = setTimeout(() => this.#signal("SIGKILL"), graceMs);
    this.#kill.unref();
  }

  #signal(sig: NodeJS.Signals): void {
    if (this.pid === null) return;
    try {
      process.kill(-this.pid, sig);
    } catch {
      // The group is gone already.
    }
  }

  /** The wall clock, every second: a run that slept past its deadline ends on waking. */
  #arm(graceMs: number): void {
    const look = () => {
      if (this.#exited || this.#ending) return;
      const left = this.#deadline - this.#now();
      if (left <= 0) {
        this.stop("timeout", "deadline", graceMs);
        return;
      }
      this.#watch = setTimeout(look, Math.min(left, WATCH_MS));
      this.#watch.unref();
    };
    look();
  }
}

/** `/usr/bin` programs that are xcrun stubs: the real one is what `xcrun --find` names. */
const XCRUN_STUBS = new Set([
  "git",
  "python3",
  "pip3",
  "make",
  "cc",
  "c++",
  "clang",
  "clang++",
  "gcc",
  "g++",
  "ld",
  "ar",
  "nm",
  "strip",
  "ranlib",
  "lipo",
  "otool",
  "swift",
  "swiftc",
  "lldb",
  "xcodebuild",
  "m4",
  "bison",
  "flex",
]);

const executable = (p: string) => {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/**
 * argv[0] as the program to start: a path as it is (relative to cwd), a bare name along PATH; an
 * xcrun stub as the program xcrun names. null when there is none.
 */
export function resolveCommand(name: string, o: { path: string; cwd: string; exec?: Exec }): string | null {
  let found: string | null = null;
  if (name.includes("/")) found = isAbsolute(name) ? name : resolve(o.cwd, name);
  else
    for (const dir of o.path.split(":")) {
      if (!dir.startsWith("/")) continue;
      const p = join(dir, name);
      if (executable(p)) {
        found = p;
        break;
      }
    }
  if (!found || !executable(found)) return null;
  const stub = /^\/usr\/bin\/([^/]+)$/.exec(found)?.[1];
  if (stub && XCRUN_STUBS.has(stub) && o.exec) {
    const r = o.exec("/usr/bin/xcrun", ["--find", stub], 10_000);
    const real = r?.code === 0 ? r.stdout.trim() : "";
    if (real.startsWith("/") && executable(real)) return real;
  }
  return found;
}

/** What the collector hands a runner once a call is admitted. */
export interface RunPlan {
  effectId: string;
  /** As admitted; argv[0] is found by the runner. */
  argv: string[];
  /** Absolute. */
  cwd: string;
  /** Without HOME and TMPDIR: the runner sets them. */
  env: Record<string, string>;
  /** Where a bare argv[0] is looked up: the collector's PATH, whatever LB put in `env`. */
  path: string;
  stdin: string | null;
  deadline: number;
  outputBytes: number;
  /** The profile without the run's own directories, which the runner adds. */
  profile: Omit<ProfileInput, "own">;
  /**
   * For a check of the paths where they can be read (the dedicated user's are not, from here): its
   * shim looks for `.exec-private` under them, not in `cache` (cacheDirs, the runs' own).
   */
  roots: { read: string[]; write: string[]; cache?: string[] };
  /** The run's HOME, when it is not the runner's own directory (the dedicated user's `~/work`). */
  home: string | null;
}

/** How a run ended, its output bounded and redacted: what the ledger's `finish` takes. */
export type RunOutcome = Outcome;

export interface Started {
  /** The run's process group, for a later collector to reap if this one dies (same user only). */
  pgid: number | null;
  stop(state: "timeout" | "cancelled", reason: string): void;
  done: Promise<RunOutcome>;
  /** An upload's next piece, in order (src/exec/bwrap.ts). */
  feed?(c: { seq: number; data: Buffer; last: boolean }): void;
}

export interface Prepared {
  start(): Started;
  /** Not started after all (the effect turned out known): its directory goes. */
  discard(): void;
}

export type Refused = { ok: false; code: "sandbox_unavailable" | "runner_unavailable"; message: string };

export interface SweepReport {
  killed: number;
  /** Their program names (never their arguments). */
  comms: string[];
}

export interface Runner {
  readonly kind: "same" | "user" | "bwrap";
  /**
   * Before the effect is claimed: whatever can be checked without running the command (the profile
   * compiles; the dedicated user's key is there). A refusal here means nothing was claimed.
   * Transfer (upload, download) joins this with N10.
   */
  prepare(plan: RunPlan): Promise<{ ok: true; prepared: Prepared } | Refused>;
  /** The dedicated user's processes that outlived their run: killed (only while nothing runs). */
  sweep?(): Promise<SweepReport | null>;
  /** The Box (src/exec/bwrap.ts): a job of src/exec/box.ts in bubblewrap — a tool, a transfer, an install step. */
  prepareBox?(job: BoxJob, o: BoxPrepareOptions): Promise<{ ok: true; prepared: Prepared } | Refused>;
}

export interface BoxPrepareOptions {
  /** The ceiling's seccomp filter (a compiled BPF file), or null. */
  seccomp: string | null;
  /** A download's next piece to LB; false when it could not go (the link is down). */
  send?: (c: { seq: number; data: Buffer; last: boolean }) => boolean;
}

/** Both streams bounded by the ceiling's outputBytes. */
export function sinks(outputBytes: number) {
  return { stdout: new BoundedSink(outputBytes), stderr: new BoundedSink(outputBytes) };
}

export function outcome(end: ProcEnd, s: ReturnType<typeof sinks>): RunOutcome {
  return { ...end, ...finishOutput(s.stdout, s.stderr) };
}

/** A run that never started (no such program): it is an effect all the same, `failed`. */
function notStarted(reason: string, outputBytes: number): Started {
  return {
    pgid: null,
    stop: () => undefined,
    done: Promise.resolve(outcome({ state: "failed", exit: null, signal: null, reason }, sinks(outputBytes))),
  };
}

/** Removes a run's directory; what a run made unremovable is left (logged). */
export function removeDir(dir: string, log: (s: string) => void): void {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // A run may have taken the write bit off its own directories: give it back, then again.
  }
  const open = (d: string): void => {
    try {
      chmodSync(d, 0o700);
      for (const e of readdirSync(d, { withFileTypes: true }))
        if (e.isDirectory() && !e.isSymbolicLink()) open(join(d, e.name));
    } catch {
      // Whatever cannot be opened, rm reports below.
    }
  };
  open(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    log(`exec: could not remove ${dir}: ${(e as Error).message}`);
  }
}

export interface SameUserOptions {
  now: () => number;
  log: (s: string) => void;
  /** For xcrun. */
  exec?: Exec;
  /** Where the runs' directories go (default: the system's temporary directory, real path). */
  base?: string;
  /** null: no sandbox at all — for tests of the process handling only. */
  sandboxExec?: string | null;
  /** For tests. */
  spawn?: Spawner;
  graceMs?: number;
}

/** A person's own computer: the run is the collector's child, as the collector's user, sandboxed. */
export class SameUserRunner implements Runner {
  readonly kind = "same";
  #o: SameUserOptions;

  constructor(o: SameUserOptions) {
    this.#o = o;
  }

  #base(): string {
    const base = this.#o.base ?? join(realpathSync(tmpdir()), "agents-io-herdr-exec");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    chmodSync(base, 0o700);
    return realpathSync(base);
  }

  async prepare(plan: RunPlan): Promise<{ ok: true; prepared: Prepared } | Refused> {
    const sandboxExec = this.#o.sandboxExec === undefined ? SANDBOX_EXEC : this.#o.sandboxExec;
    // Its own directory, even for an id asked twice at once (only one of them is claimed).
    const dir = join(this.#base(), `${plan.effectId}.${randomBytes(4).toString("hex")}`);
    const home = join(dir, "home");
    const tmp = join(dir, "tmp");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    let profileFile: string | null = null;
    if (sandboxExec !== null) {
      let text: string;
      try {
        text = buildProfile({ ...plan.profile, own: [home, tmp] });
      } catch (e) {
        removeDir(dir, this.#o.log);
        if (e instanceof ProfileError) return { ok: false, code: "sandbox_unavailable", message: e.message };
        throw e;
      }
      profileFile = join(dir, "profile.sb");
      writeFileSync(profileFile, text, { mode: 0o600 });
      const no = await preflight(profileFile, { sandboxExec, spawn: this.#o.spawn });
      if (no) {
        removeDir(dir, this.#o.log);
        return { ok: false, code: "sandbox_unavailable", message: no };
      }
    }
    const env: Record<string, string> = { ...plan.env, HOME: plan.home ?? home, TMPDIR: `${tmp}/` };
    const prepared: Prepared = {
      discard: () => removeDir(dir, this.#o.log),
      start: (): Started => {
        const program = resolveCommand(plan.argv[0] ?? "", { path: plan.path, cwd: plan.cwd, exec: this.#o.exec });
        if (!program) {
          removeDir(dir, this.#o.log);
          return notStarted("not_found", plan.outputBytes);
        }
        const s = sinks(plan.outputBytes);
        const p = new Proc(
          {
            argv: [program, ...plan.argv.slice(1)],
            cwd: plan.cwd,
            env,
            stdin: plan.stdin === null ? null : Buffer.from(plan.stdin, "utf8"),
            deadline: plan.deadline,
            profileFile,
            sandboxExec: sandboxExec ?? undefined,
          },
          {
            now: this.#o.now,
            onStdout: (b) => s.stdout.write(b),
            onStderr: (b) => s.stderr.write(b),
            graceMs: this.#o.graceMs,
          },
        );
        return {
          pgid: p.pid,
          stop: (state, reason) => p.stop(state, reason, this.#o.graceMs),
          done: p.done.then((end) => {
            removeDir(dir, this.#o.log);
            return outcome(end, s);
          }),
        };
      },
    };
    return { ok: true, prepared };
  }
}

/** `[[dd-]hh:]mm:ss` (ps's etime) in ms, or null. */
export function etimeMs(s: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return null;
  const [d, h, min, sec] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0)) as [number, number, number, number];
  return (((d * 24 + h) * 60 + min) * 60 + sec) * 1000;
}

/** How near a process's start must be to the recorded one to be that run (etime has whole seconds). */
const START_SLACK_MS = 3000;

/**
 * Process groups a collector that died left running (acceptance case 13): for each
 * effect it had started, the group it recorded. The group's first process, if still there, must have
 * started when the run did — otherwise its id was reused, and it is not touched. Without it, any
 * process still in the group descends from the run (a group id stays taken while it has members).
 * SIGTERM now, SIGKILL after the grace; returns the groups signalled.
 */
export function reapOrphans(
  runs: { pgid: number; spawnedAt: number }[],
  o: {
    now: () => number;
    exec: Exec;
    kill?: (pid: number, sig: NodeJS.Signals) => void;
    graceMs?: number;
    log: (s: string) => void;
  },
): number[] {
  if (!runs.length) return [];
  const ps = o.exec("ps", ["-axo", "pid=,pgid=,etime="], 10_000);
  if (!ps || ps.code !== 0) {
    o.log("exec: could not list processes; a run left by the last collector may still be going");
    return [];
  }
  const now = o.now();
  const rows = ps.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((r) => r.length === 3)
    .map(([pid, pgid, etime]) => ({ pid: Number(pid), pgid: Number(pgid), start: now - (etimeMs(etime ?? "") ?? 0) }));
  const kill =
    o.kill ??
    ((pid: number, sig: NodeJS.Signals) => {
      try {
        process.kill(pid, sig);
      } catch {
        // Gone already.
      }
    });
  const reaped: number[] = [];
  for (const r of runs) {
    if (!(r.pgid > 1)) continue;
    const members = rows.filter((x) => x.pgid === r.pgid);
    if (!members.length) continue;
    const leader = members.find((x) => x.pid === r.pgid);
    if (leader && Math.abs(leader.start - r.spawnedAt) > START_SLACK_MS) {
      o.log(`exec: process group ${r.pgid} is not the run's any more (started at another time); left alone`);
      continue;
    }
    kill(-r.pgid, "SIGTERM");
    setTimeout(() => kill(-r.pgid, "SIGKILL"), o.graceMs ?? KILL_GRACE_MS).unref();
    reaped.push(r.pgid);
  }
  if (reaped.length) o.log(`exec: stopped ${reaped.length} run(s) the last collector left going`);
  return reaped;
}
