/**
 * The Box's runner (docs/exec.md, Linux / Box): every job of src/exec/box.ts — a tool, a file in or
 * out, an install step — runs as a child of the collector in bubblewrap, never without it.
 *
 * - `bwrap --unshare-all` (with `--share-net` only for `network: "open"`, the install cell)
 *   `--die-with-parent --new-session --cap-drop ALL --clearenv`, the job's environment only; /usr
 *   read-only, /bin /sbin /lib /lib64 as links into it, a few files of /etc (and with the network
 *   resolv.conf, hosts and the CA certificates); a tmpfs /tmp, a minimal /dev, then the job's own
 *   mounts. No /proc: `--proc` does not mount in this kind of container, and the container's own
 *   would show the collector's environment and root to a process of the same user. The collector's
 *   directory (its key, the effect ledger, the ceiling) is never mounted.
 * - `--seccomp` with the ceiling's compiled filter, on a descriptor opened for each start. A filter
 *   that is named but does not open is `sandbox_unavailable`, like any other failure to set up.
 * - Before every job `/bin/true` runs under the very same arguments (the preflight): anything but
 *   exit 0 is `sandbox_unavailable`. Then the job, in a process group of its own; `--unshare-pid`
 *   makes it the only thing in its pid namespace: when it ends, or bwrap is killed, all it started
 *   goes too (`--die-with-parent`).
 * - An upload's chunks go to `box-put`'s stdin in order (a gap or more than its size stops the run,
 *   `failed`); a download is `box-get`'s stdout, sent on in pieces of CHUNK_MAX, the last one only
 *   once the helper has exited 0. Either way this side counts and hashes the bytes itself: the
 *   effect's `data`, `{path, size, sha256}`, is what went through here.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdirSync, openSync, rmSync } from "node:fs";
import { type BoxJob, HELPER_EXITS, type SandboxSpec, TMPFS_BYTES } from "./box.ts";
import { CHUNK_MAX } from "./frames.ts";
import { BoundedSink } from "./output.ts";
import {
  type BoxPrepareOptions,
  outcome,
  type Prepared,
  Proc,
  type ProcEnd,
  type Refused,
  type Runner,
  type RunOutcome,
  type Started,
  sinks,
} from "./run.ts";

/** Only this path, never one found in PATH. */
export const BWRAP = "/usr/bin/bwrap";

/** Files of /etc every sandbox gets, read-only, when they are there. */
export const ETC: readonly string[] = [
  "/etc/ld.so.cache",
  "/etc/localtime",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
];
/** …and one with the network: name resolution and the CA certificates. */
export const ETC_NET: readonly string[] = [
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/gai.conf",
  "/etc/ssl/certs",
  "/etc/ca-certificates.conf",
  "/etc/ssl/openssl.cnf",
];

/** The descriptor bwrap reads the seccomp filter from (after stdin, stdout and stderr). */
export const SECCOMP_FD = 3;

const absolute = (p: string) => p.startsWith("/") && !p.includes("\0");
const byName = ([a]: [string, string], [b]: [string, string]) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * bwrap's arguments for a sandbox, in the order bwrap applies them, ending in `-- argv…`; throws for
 * a path that is not absolute. `seccomp`: the filter is on SECCOMP_FD.
 */
export function bwrapArgs(s: SandboxSpec, o: { seccomp: boolean }): string[] {
  const paths = [s.cwd, s.argv[0] ?? "", ...s.mounts.flatMap((m) => (m.kind === "tmpfs" ? [m.dst] : [m.src, m.dst]))];
  for (const p of paths) if (!absolute(p)) throw new Error(`not an absolute path for bwrap: ${JSON.stringify(p)}`);
  const a = ["--unshare-all"];
  if (s.network === "open") a.push("--share-net");
  a.push("--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv");
  for (const [k, v] of Object.entries(s.env).sort(byName)) a.push("--setenv", k, v);
  a.push("--ro-bind", "/usr", "/usr");
  a.push("--symlink", "usr/bin", "/bin", "--symlink", "usr/sbin", "/sbin");
  a.push("--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64");
  for (const e of [...ETC, ...(s.network === "open" ? ETC_NET : [])]) a.push("--ro-bind-try", e, e);
  a.push("--dev", "/dev");
  for (const m of s.mounts) {
    if (m.kind === "tmpfs") a.push("--size", String(TMPFS_BYTES), "--tmpfs", m.dst);
    else a.push(m.kind === "ro" ? "--ro-bind" : "--bind", m.src, m.dst);
  }
  if (o.seccomp) a.push("--seccomp", String(SECCOMP_FD));
  a.push("--chdir", s.cwd, "--", ...s.argv);
  return a;
}

/** The ceiling's filter opened for one start: null when there is none, a string when it does not open. */
function openSeccomp(path: string | null): number | null | string {
  if (path === null) return null;
  try {
    if (!lstatSync(path).isFile()) return `the seccomp filter ${path} is not a file`;
    return openSync(path, "r");
  } catch {
    return `the seccomp filter ${path} does not open`;
  }
}

/** /bin/true under the arguments: null when it ran, else why not (bwrap's first line of stderr). */
function preflight(bwrap: string, args: string[], fd: number | null, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bwrap, args, {
        stdio: ["ignore", "ignore", "pipe", ...(fd === null ? [] : [fd])],
        env: {},
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      });
    } catch (e) {
      resolve(`bwrap could not be started (${(e as Error).message})`);
      return;
    } finally {
      if (fd !== null) closeSync(fd);
    }
    let err = "";
    child.stderr?.on("data", (b: Buffer) => {
      if (err.length < 2000) err += b.toString("utf8");
    });
    child.on("error", (e) => resolve(`bwrap could not be started (${e.message})`));
    child.on("close", (code, signal) => {
      if (code === 0) return resolve(null);
      const line = err.trim().split("\n")[0]?.slice(0, 300) ?? "";
      resolve(
        `the sandbox did not run /bin/true (${code === null ? signal : `exit ${code}`})${line ? `: ${line}` : ""}`,
      );
    });
  });
}

/** A transfer's bytes as they pass: counted and hashed here. */
class Tally {
  size = 0;
  #h = createHash("sha256");
  add(b: Buffer): void {
    this.size += b.length;
    this.#h.update(b);
  }
  get sha256(): string {
    return this.#h.copy().digest("hex");
  }
}

export interface BwrapOptions {
  now: () => number;
  log: (s: string) => void;
  /** For tests: a stand-in for bwrap, given the same arguments. */
  bwrap?: string;
  graceMs?: number;
  preflightMs?: number;
}

export class BwrapRunner implements Runner {
  readonly kind = "bwrap";
  #o: BwrapOptions;

  constructor(o: BwrapOptions) {
    this.#o = o;
  }

  /** Only the Box's jobs run here (src/exec/box.ts). */
  async prepare(): Promise<Refused> {
    return { ok: false, code: "runner_unavailable", message: "bwrap runs the Box's jobs only" };
  }

  async prepareBox(job: BoxJob, o: BoxPrepareOptions): Promise<{ ok: true; prepared: Prepared } | Refused> {
    const bwrap = this.#o.bwrap ?? BWRAP;
    for (const d of job.ensure)
      try {
        mkdirSync(d, { recursive: true, mode: 0o755 });
      } catch (e) {
        return {
          ok: false,
          code: "runner_unavailable",
          message: `cannot make ${d} (${(e as NodeJS.ErrnoException).code})`,
        };
      }
    let check: string[];
    let args: string[];
    try {
      check = bwrapArgs({ ...job.sandbox, argv: ["/bin/true"] }, { seccomp: o.seccomp !== null });
      args = bwrapArgs(job.sandbox, { seccomp: o.seccomp !== null });
    } catch (e) {
      return { ok: false, code: "sandbox_unavailable", message: (e as Error).message };
    }
    const fd = openSeccomp(o.seccomp);
    if (typeof fd === "string") return { ok: false, code: "sandbox_unavailable", message: fd };
    const no = await preflight(bwrap, check, fd, this.#o.preflightMs ?? 10_000);
    if (no) return { ok: false, code: "sandbox_unavailable", message: no };
    return { ok: true, prepared: { discard: () => undefined, start: () => this.#start(job, bwrap, args, o) } };
  }

  #start(job: BoxJob, bwrap: string, args: string[], o: BoxPrepareOptions): Started {
    const s = sinks(job.outputBytes);
    if (job.rawStdout) s.stdout = new BoundedSink(job.outputBytes, { redact: false });
    const end = (e: ProcEnd, data?: Record<string, unknown>): RunOutcome => ({
      ...outcome(e, s),
      ...(data && { data }),
    });
    const notStarted = (reason: string): Started => ({
      pgid: null,
      stop: () => undefined,
      done: Promise.resolve(end({ state: "failed", exit: null, signal: null, reason })),
    });
    // Install's staging directory starts empty: what an earlier try left goes now, after the claim.
    for (const d of job.reset)
      try {
        rmSync(d, { recursive: true, force: true });
        mkdirSync(d, { recursive: true, mode: 0o755 });
      } catch (e) {
        return notStarted(`reset_failed: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
      }
    const fd = openSeccomp(o.seccomp);
    if (typeof fd === "string") return notStarted("sandbox_unavailable");
    const t = job.transfer;
    const tally = new Tally();
    // Why this side stopped the run (a bad chunk, a download that cannot go out): it ends `failed`.
    let failure: string | null = null;
    const ref: { proc: Proc | null } = { proc: null };
    const fail = (reason: string) => {
      if (failure) return;
      failure = reason;
      ref.proc?.stop("cancelled", reason, this.#o.graceMs);
    };
    // A download: full pieces go at once, the rest waits; the last piece goes once the helper exited 0.
    let held: Buffer = Buffer.alloc(0);
    let seq = 0;
    const send = (data: Buffer, last: boolean) => {
      if (!o.send?.({ seq: seq++, data, last })) fail("link_lost");
    };
    const onStdout = (b: Buffer) => {
      if (t?.kind === "upload") return;
      if (t?.kind !== "download") return s.stdout.write(b);
      if (failure) return;
      tally.add(b);
      if (tally.size > t.max) return fail("too_large");
      held = Buffer.concat([held, b]);
      while (held.length > CHUNK_MAX && !failure) {
        send(held.subarray(0, CHUNK_MAX), false);
        held = held.subarray(CHUNK_MAX);
      }
    };
    const proc = new Proc(
      {
        argv: [bwrap, ...args],
        cwd: "/",
        env: {},
        stdin: t?.kind === "upload" ? "stream" : job.stdin === null ? null : Buffer.from(job.stdin, "utf8"),
        deadline: job.deadline,
        profileFile: null,
        fds: fd === null ? [] : [fd],
      },
      { now: this.#o.now, onStdout, onStderr: (b) => s.stderr.write(b), graceMs: this.#o.graceMs },
    );
    ref.proc = proc;
    let next = 0;
    let closed = false;
    const feed = (c: { seq: number; data: Buffer; last: boolean }) => {
      if (t?.kind !== "upload" || closed || failure) return;
      if (c.seq !== next) return fail("bad_chunk");
      next++;
      tally.add(c.data);
      if (tally.size > t.size) return fail("too_large");
      proc.write(c.data);
      if (c.last) {
        closed = true;
        proc.end();
      }
    };
    const done = proc.done.then((e): RunOutcome => {
      if (failure) return end({ ...e, state: "failed", reason: failure });
      if (e.state !== "done" || !job.helper) return end(e);
      const why = e.exit === 0 ? null : (HELPER_EXITS[e.exit ?? -1] ?? `exit ${e.exit}`);
      // An install step: done, its exit code and what it means; LB looks at both.
      if (!t) return end({ ...e, reason: why });
      if (why) return end({ ...e, state: "failed", reason: why });
      if (t.kind === "upload" && (tally.size !== t.size || tally.sha256 !== t.sha256))
        return end({ ...e, state: "failed", reason: "mismatch" });
      if (t.kind === "download") {
        send(held, true);
        if (failure) return end({ ...e, state: "failed", reason: failure });
      }
      return end(e, { path: t.path, size: tally.size, sha256: tally.sha256 });
    });
    return {
      pgid: proc.pid,
      stop: (state, reason) => proc.stop(state, reason, this.#o.graceMs),
      done,
      ...(t?.kind === "upload" && { feed }),
    };
  }
}
