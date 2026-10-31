/**
 * `agents-io-herdr exec-shim`: the dedicated user's forced command on an agent machine (docs/exec.md
 * N9). sshd starts it for the collector's key only (`ForceCommand`, and `command=` on the
 * key), as that user and outside the sandbox; `SSH_ORIGINAL_COMMAND` names what to do:
 *
 * - `run`: one JSON line (the spec: argv, cwd, env, the profile the collector made, the roots, the
 *   deadline), the stdin bytes, then `cancel` lines. It checks with realpath what the collector could
 *   not read — cwd and the write paths inside the roots, no symlink on the way, none in a directory
 *   marked `.exec-private` — and looks for that marker under the roots by name, adding a deny of each
 *   marked directory at the end of the profile. It runs `/usr/bin/true` under the profile, then the
 *   command under `/usr/bin/sandbox-exec` in its own process group with
 *   HOME the user's `~/work` and TMPDIR `~/exec/<effect>/tmp`. It stops the group itself at the
 *   deadline (so the run ends even if the collector is gone), on `cancel`, and on EOF (ssh closed).
 *   Output goes back in frames (src/exec/wire.ts), at most what the collector keeps of each stream;
 *   the collector redacts.
 * - `sweep`: SIGKILL to every process of this user except this one and its ancestors (sshd's session
 *   process is this user's too); reports how many and their program names, never their arguments.
 * - `probe`: the S checks of src/exec/probe.ts as this user, and S8 (the user boundary).
 * - `upload`, `download`: with N10.
 *
 * It refuses to do anything unless this user looks like what scripts/exec-user-setup.sh makes: not
 * root, its home root's and closed to writes (so no shell start-up file can be planted there). That
 * also keeps a sweep from ever running as a person.
 */
import { lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "../system.ts";
import { within } from "./ceiling.ts";
import { privateAbove, scanRoots } from "./deny.ts";
import { OVERSHOOT } from "./output.ts";
import { runProbe, userChecks } from "./probe.ts";
import { Proc, type ProcEnd, removeDir, resolveCommand } from "./run.ts";
import { ProfileError, preflight, privateRule, SANDBOX_EXEC, type Spawner } from "./sandbox.ts";
import { CH_END, CH_STDERR, CH_STDOUT, frame, frames, SHIM_OPS, SPEC_MAX, StreamReader, WireError } from "./wire.ts";

/** Output is sent at least this often while a run goes. */
const FLUSH_MS = 250;
/** One frame of output at most. */
const PIECE = 16 * 1024;
const EFFECT_ID = /^eff_[A-Za-z0-9_-]{1,96}$/;
/** The `.exec-private` scan of a run's roots stops here; roots holding more refuse the run. */
export const PRIVATE_SCAN_MAX = 100_000;

export interface ShimIo {
  /** `SSH_ORIGINAL_COMMAND`. */
  command: string | undefined;
  stdin: NodeJS.ReadableStream;
  /** stdout: frames only. */
  out: (b: Buffer) => void;
  err: (s: string) => void;
  now: () => number;
  uid: number;
  /** This user's home (the directory database's, not $HOME). */
  home: string;
  pid: number;
  exec: Exec;
  /** null: this user may run the shim; otherwise why not. */
  interlock: () => string | null;
  /** null: no sandbox (tests of the process handling only). */
  sandboxExec?: string | null;
  spawn?: Spawner;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  graceMs?: number;
}

/** The dedicated user's shape: not root; a home of root's that no one else can write. */
export function realInterlock(uid: number, home: string): string | null {
  if (uid === 0) return "the exec shim does not run as root";
  try {
    const st = statSync(home);
    if (st.uid !== 0 || (st.mode & 0o022) !== 0)
      return `${home} is not root's and closed to writes: this is not a dedicated runner user (scripts/exec-user-setup.sh)`;
  } catch {
    return `no ${home}`;
  }
  return null;
}

export interface RunSpec {
  effect: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** Where a bare argv[0] is looked up (the collector's PATH; absent from an older one: env's). */
  path?: string;
  /** The run's HOME (the user's `~/work`). */
  home: string;
  /** The run's TMPDIR: `~/exec/<effect>/tmp`. */
  tmp: string;
  profile: string;
  /** `cache`: the cacheDirs, not looked into for `.exec-private` (absent from an older collector). */
  roots: { read: string[]; write: string[]; cache?: string[] };
  stdinBytes: number;
  deadline: number;
  outputBytes: number;
}

const strs = (v: unknown, max: number) =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 32_768);
const abs = (v: unknown): v is string => typeof v === "string" && v.startsWith("/") && v.length <= 4096;

export function parseRunSpec(v: unknown): RunSpec | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  if (typeof s.effect !== "string" || !EFFECT_ID.test(s.effect)) return null;
  if (!strs(s.argv, 256) || (s.argv as string[]).length < 1) return null;
  if (!abs(s.cwd) || !abs(s.home) || !abs(s.tmp) || typeof s.profile !== "string") return null;
  const env = s.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) return null;
  if (!Object.values(env).every((x) => typeof x === "string")) return null;
  if (s.path !== undefined && (typeof s.path !== "string" || s.path.length > 32_768)) return null;
  const roots = s.roots as { read?: unknown; write?: unknown } | undefined;
  if (!roots || !strs(roots.read, 256) || !strs(roots.write, 256)) return null;
  if (![...(roots.read as string[]), ...(roots.write as string[])].every(abs)) return null;
  const cache = (roots as { cache?: unknown }).cache;
  if (cache !== undefined && !(strs(cache, 64) && (cache as string[]).every(abs))) return null;
  for (const k of ["stdinBytes", "deadline", "outputBytes"] as const)
    if (!Number.isSafeInteger(s[k]) || (s[k] as number) < 0) return null;
  if ((s.stdinBytes as number) > 64 * 1024 || (s.outputBytes as number) > 1024 * 1024) return null;
  return s as unknown as RunSpec;
}

/** A path with no symlink on the way: its real path is itself. */
function isReal(p: string): boolean {
  try {
    return realpathSync(p) === p;
  } catch {
    return false;
  }
}

/** Why the run's paths do not fit, as `[reason, message]`, or null. */
export function checkPaths(spec: RunSpec): [string, string] | null {
  const read = spec.roots.read.filter(isReal);
  const write = spec.roots.write.filter(isReal);
  if (!isReal(spec.cwd)) return ["path_denied", "cwd does not exist or has a symlink on the way"];
  if (![...read, ...write].some((r) => within(spec.cwd, r))) return ["path_outside", "cwd is outside the roots"];
  for (const w of spec.roots.write) {
    try {
      lstatSync(w);
    } catch {
      continue;
    }
    if (!isReal(w)) return ["path_denied", `${w} has a symlink on the way`];
  }
  return null;
}

/**
 * The `.exec-private` marker in this user's directories, which the collector cannot read: cwd or a
 * write path in a marked directory is `path_denied`; every marked directory under the roots (not
 * under the cache directories, which only runs fill) is found by name, for the profile to deny. A
 * scan that cannot finish refuses the run — a marker it did not reach would not hold.
 */
export function privateDirs(
  spec: RunSpec,
  home: string,
  max = PRIVATE_SCAN_MAX,
): { dirs: string[] } | { refused: [string, string] } {
  const all = [...new Set([...spec.roots.read, ...spec.roots.write])];
  // The outermost root a path is in: the marker is looked for all the way up to it.
  const top = (p: string) => all.filter((r) => within(p, r)).sort((a, b) => a.length - b.length)[0] ?? p;
  if (privateAbove(spec.cwd, top(spec.cwd)))
    return { refused: ["path_denied", "cwd is in a directory marked .exec-private"] };
  for (const w of spec.roots.write)
    if (privateAbove(w, top(w))) return { refused: ["path_denied", `${w} is in a directory marked .exec-private`] };
  const outer = all.filter((r) => !all.some((o) => o !== r && within(r, o)));
  const scan = scanRoots(outer, { home, skip: spec.roots.cache ?? [], maxEntries: max });
  if (scan.truncated)
    return {
      refused: [
        "path_denied",
        `the roots hold more than ${max} entries, too many to look for .exec-private in: list narrower roots`,
      ],
    };
  return { dirs: scan.hits.filter((h) => h.why === "private").map((h) => h.path) };
}

/** Output of one stream to the collector: at most its share, in pieces, at least every FLUSH_MS. */
class Forward {
  seen = 0;
  #sent = 0;
  #pending: Buffer[] = [];
  #size = 0;
  readonly #cap: number;
  readonly #ch: number;
  readonly #out: (b: Buffer) => void;

  constructor(ch: number, outputBytes: number, out: (b: Buffer) => void) {
    this.#ch = ch;
    this.#cap = outputBytes + OVERSHOOT;
    this.#out = out;
  }

  write(b: Buffer): void {
    this.seen += b.length;
    const room = this.#cap - this.#sent - this.#size;
    if (room <= 0) return;
    const part = b.length > room ? b.subarray(0, room) : b;
    this.#pending.push(Buffer.from(part));
    this.#size += part.length;
    if (this.#size >= PIECE) this.flush();
  }

  flush(): void {
    if (!this.#size) return;
    const data = Buffer.concat(this.#pending);
    this.#pending = [];
    this.#sent += this.#size;
    this.#size = 0;
    for (const f of frames(this.#ch, data, Math.min(PIECE, this.#cap))) this.#out(f);
  }
}

const endFrame = (io: ShimIo, v: Record<string, unknown>) => io.out(frame(CH_END, Buffer.from(JSON.stringify(v))));

export async function shim(io: ShimIo): Promise<number> {
  const op = (io.command ?? "").trim();
  if (!(SHIM_OPS as readonly string[]).includes(op)) {
    io.err(
      op
        ? `exec-shim: "${op.slice(0, 40)}" is not something this key runs (${SHIM_OPS.join(", ")})\n`
        : `exec-shim: this key runs only the exec shim (${SHIM_OPS.join(", ")}); no shell\n`,
    );
    return 2;
  }
  const no = io.interlock();
  if (no) {
    io.err(`exec-shim: ${no}\n`);
    return 3;
  }
  switch (op) {
    case "run":
      return run(io);
    case "sweep":
      return sweep(io);
    case "probe":
      return probe(io);
    default:
      endFrame(io, { state: "failed", exit: null, signal: null, reason: "unsupported" });
      return 0;
  }
}

async function run(io: ShimIo): Promise<number> {
  const r = new StreamReader(io.stdin);
  const fail = (reason: string, message = "") => {
    if (message) io.err(`exec-shim: ${message}\n`);
    endFrame(io, { state: "failed", exit: null, signal: null, reason, bytes: { stdout: 0, stderr: 0 } });
    return 0;
  };
  let spec: RunSpec | null = null;
  try {
    const line = await r.line(SPEC_MAX);
    spec = line === null ? null : parseRunSpec(JSON.parse(line));
  } catch (e) {
    return fail("bad_spec", e instanceof WireError ? e.message : "the spec does not read");
  }
  if (!spec) return fail("bad_spec", "the spec does not read");
  const dir = join(io.home, "exec", spec.effect);
  if (spec.tmp !== join(dir, "tmp")) return fail("bad_spec", `TMPDIR must be ${join(dir, "tmp")}`);
  const stdin = spec.stdinBytes ? await r.bytes(spec.stdinBytes) : null;
  if (spec.stdinBytes && !stdin) {
    endFrame(io, { state: "cancelled", exit: null, signal: null, reason: "eof", bytes: { stdout: 0, stderr: 0 } });
    return 0;
  }
  const bad = checkPaths(spec);
  if (bad) return fail(bad[0], bad[1]);
  const marked = privateDirs(spec, io.home);
  if ("refused" in marked) return fail(...marked.refused);
  let rule: string;
  try {
    rule = privateRule(marked.dirs);
  } catch (e) {
    if (e instanceof ProfileError) return fail("path_denied", `a directory marked .exec-private: ${e.message}`);
    throw e;
  }
  const sandboxExec = io.sandboxExec === undefined ? SANDBOX_EXEC : io.sandboxExec;
  mkdirSync(join(io.home, "exec"), { recursive: true, mode: 0o700 });
  removeDir(dir, (s) => io.err(`${s}\n`));
  mkdirSync(spec.tmp, { recursive: true, mode: 0o700 });
  const done = (n: number) => {
    removeDir(dir, (s) => io.err(`${s}\n`));
    return n;
  };
  let profileFile: string | null = null;
  if (sandboxExec !== null) {
    profileFile = join(dir, "profile.sb");
    writeFileSync(profileFile, spec.profile + rule, { mode: 0o600 });
    const why = await preflight(profileFile, { sandboxExec, spawn: io.spawn });
    if (why) return done(fail("sandbox_unavailable", why));
  }
  const env: Record<string, string> = { ...spec.env, HOME: spec.home, TMPDIR: `${spec.tmp}/` };
  const program = resolveCommand(spec.argv[0] ?? "", {
    path: spec.path ?? env.PATH ?? "",
    cwd: spec.cwd,
    exec: io.exec,
  });
  if (!program) return done(fail("not_found"));
  const out = new Forward(CH_STDOUT, spec.outputBytes, io.out);
  const err = new Forward(CH_STDERR, spec.outputBytes, io.out);
  const timer = setInterval(() => {
    out.flush();
    err.flush();
  }, FLUSH_MS);
  timer.unref();
  const p = new Proc(
    {
      argv: [program, ...spec.argv.slice(1)],
      cwd: spec.cwd,
      env,
      stdin,
      deadline: spec.deadline,
      profileFile,
      sandboxExec: sandboxExec ?? undefined,
    },
    { now: io.now, onStdout: (b) => out.write(b), onStderr: (b) => err.write(b), graceMs: io.graceMs },
  );
  // The collector says cancel, or goes away (EOF): the group stops.
  void (async () => {
    for (;;) {
      let l: string | null;
      try {
        l = await r.line(1024);
      } catch {
        l = null;
      }
      if (l === null) {
        p.stop("cancelled", "eof", io.graceMs);
        return;
      }
      if (l.trim() === "cancel") p.stop("cancelled", "cancel", io.graceMs);
    }
  })();
  const end: ProcEnd = await p.done;
  clearInterval(timer);
  out.flush();
  err.flush();
  endFrame(io, { ...end, bytes: { stdout: out.seen, stderr: err.seen } });
  return done(0);
}

/** This process and its ancestors, from a `pid ppid` table. */
export function ancestors(self: number, parents: Map<number, number>): Set<number> {
  const keep = new Set<number>();
  for (let p: number | undefined = self; p !== undefined && p > 0 && !keep.has(p); p = parents.get(p)) keep.add(p);
  return keep;
}

function sweep(io: ShimIo): number {
  const ps = io.exec("/bin/ps", ["-axo", "pid=,ppid=,uid=,comm="], 10_000);
  if (!ps || ps.code !== 0) {
    endFrame(io, { state: "failed", reason: "ps", killed: 0, comms: [] });
    return 0;
  }
  const rows = ps.stdout
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), comm: (m[4] ?? "").trim() }));
  const keep = ancestors(io.pid, new Map(rows.map((r) => [r.pid, r.ppid])));
  const kill =
    io.kill ??
    ((pid: number, sig: NodeJS.Signals) => {
      try {
        process.kill(pid, sig);
      } catch {
        // Gone already.
      }
    });
  const killed = rows.filter((r) => r.uid === io.uid && !keep.has(r.pid));
  for (const r of killed) kill(r.pid, "SIGKILL");
  const comms = [...new Set(killed.map((r) => r.comm.split("/").pop() ?? r.comm))].slice(0, 50);
  endFrame(io, { state: "done", killed: killed.length, comms });
  return 0;
}

async function probe(io: ShimIo): Promise<number> {
  const r = new StreamReader(io.stdin);
  let opts: { ownerHome?: unknown; ownerUid?: unknown; shared?: unknown; launchd?: unknown } = {};
  try {
    const line = await r.line(64 * 1024);
    if (line) opts = JSON.parse(line) as typeof opts;
  } catch {
    // No options: the user checks that need them are skipped.
  }
  const base = join(io.home, "exec", `probe-${io.pid}`);
  const results = [
    ...userChecks({
      uid: io.uid,
      home: io.home,
      ownerHome: typeof opts.ownerHome === "string" ? opts.ownerHome : null,
      shared: typeof opts.shared === "string" ? opts.shared : null,
      exec: io.exec,
    }),
    ...(await runProbe({
      base,
      sandboxExec: io.sandboxExec ?? SANDBOX_EXEC,
      exec: io.exec,
      launchd: opts.launchd === true,
      ownerUid: Number.isSafeInteger(opts.ownerUid) && (opts.ownerUid as number) > 0 ? (opts.ownerUid as number) : null,
    })),
  ];
  for (const x of results)
    io.out(
      frame(
        CH_STDOUT,
        Buffer.from(`${x.ok ? "ok  " : "FAIL"} ${x.id.padEnd(4)} ${x.what}${x.detail ? ` (${x.detail})` : ""}\n`),
      ),
    );
  const failed = results.filter((x) => !x.ok).length;
  endFrame(io, { state: "done", checks: results.length, failed });
  return 0;
}
