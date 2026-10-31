/**
 * The dedicated user's runner (docs/exec.md N9): the collector keeps the control — ledger,
 * ceiling, grant, the profile — and starts each run through `ssh -T -i <runner key> <user>@127.0.0.1
 * run`, which sshd turns into that user's forced command (src/exec/shim.ts). The key is the
 * collector's (`exec/<user>_ed25519`, 0600), the host key the loopback one the collector already
 * pins (`known_hosts_local`); no ssh config, no agent, no other identity.
 *
 * - In: the spec line, the stdin bytes; `cancel` to stop; the collector closing ssh is EOF, which the
 *   shim also takes as cancel. Out: frames (src/exec/wire.ts), held to the run's limits — beyond them,
 *   or a broken frame, ssh is killed and the run is `failed` (`runner_protocol`).
 * - The shim stops the run at its deadline itself; the collector gives it 15 s more before killing ssh.
 * - `sweep` kills every process of the user left over (only while nothing runs; src/exec/executor.ts
 *   decides when). One that did not finish (no answer, or the shim's `ps` failed) is null: not swept.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  outcome,
  type Prepared,
  type ProcEnd,
  type Refused,
  type Runner,
  type RunPlan,
  type Started,
  type SweepReport,
  sinks,
} from "./run.ts";
import { buildProfile, ProfileError } from "./sandbox.ts";
import type { RunSpec } from "./shim.ts";
import { CH_END, CH_STDERR, CH_STDOUT, FrameReader, WireError } from "./wire.ts";

/** After the deadline, the shim has this long to report before ssh is killed. */
const DEADLINE_SLACK_MS = 15_000;
/** After `cancel`, the same (the shim's own grace is 5 s). */
const CANCEL_SLACK_MS = 10_000;
/** A sweep answers within this. */
const SWEEP_MS = 30_000;
/** ssh exits 255 for its own errors (no connection, the key refused). */
const SSH_FAILED = 255;

export interface UserRunnerOptions {
  user: { name: string; home: string };
  /** The runner key (`<sessions dir>/exec/<user>_ed25519`). */
  key: string;
  /** 127.0.0.1's host key (`<sessions dir>/known_hosts_local`). */
  knownHosts: string;
  now: () => number;
  log: (s: string) => void;
  ssh?: string;
  /** For tests: what starts instead of ssh, given the shim's op. */
  connect?: (op: string) => ChildProcess;
}

const ED = (s: string) => s.replace(/\/+$/, "");

export class UserRunner implements Runner {
  readonly kind = "user";
  #o: UserRunnerOptions;

  constructor(o: UserRunnerOptions) {
    this.#o = o;
  }

  /** The ssh command line for one op of the shim (no shell anywhere). */
  sshArgs(op: string): string[] {
    return [
      "-T",
      "-F",
      "/dev/null",
      "-i",
      this.#o.key,
      ...["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none"],
      ...["-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${this.#o.knownHosts}`],
      ...["-o", "GlobalKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", "-o", "ConnectTimeout=10"],
      ...["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"],
      `${this.#o.user.name}@127.0.0.1`,
      op,
    ];
  }

  #connect(op: string): ChildProcess {
    if (this.#o.connect) return this.#o.connect(op);
    return spawn(this.#o.ssh ?? "/usr/bin/ssh", this.sshArgs(op), {
      stdio: "pipe",
      env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/" },
    });
  }

  async prepare(plan: RunPlan): Promise<{ ok: true; prepared: Prepared } | Refused> {
    if (!this.#o.connect)
      for (const f of [this.#o.key, this.#o.knownHosts])
        if (!existsSync(f))
          return {
            ok: false,
            code: "runner_unavailable",
            message: `no ${f} (scripts/exec-user-setup.sh --user ${this.#o.user.name})`,
          };
    const home = ED(this.#o.user.home);
    const tmp = join(home, "exec", plan.effectId, "tmp");
    let profile: string;
    try {
      profile = buildProfile({ ...plan.profile, own: [tmp] });
    } catch (e) {
      if (e instanceof ProfileError) return { ok: false, code: "sandbox_unavailable", message: e.message };
      throw e;
    }
    const stdin = plan.stdin === null ? Buffer.alloc(0) : Buffer.from(plan.stdin, "utf8");
    const spec: RunSpec = {
      effect: plan.effectId,
      argv: plan.argv,
      cwd: plan.cwd,
      env: plan.env,
      path: plan.path,
      home: plan.home ?? join(home, "work"),
      tmp,
      profile,
      roots: plan.roots,
      stdinBytes: stdin.length,
      deadline: plan.deadline,
      outputBytes: plan.outputBytes,
    };
    return { ok: true, prepared: { start: () => this.#start(spec, stdin), discard: () => undefined } };
  }

  #start(spec: RunSpec, stdin: Buffer): Started {
    const s = sinks(spec.outputBytes);
    const reader = new FrameReader(spec.outputBytes);
    const ssh = this.#connect("run");
    let end: (ProcEnd & { bytes?: { stdout?: unknown; stderr?: unknown } }) | null = null;
    let broken: string | null = null;
    let received = 0;
    let ending: { state: "timeout" | "cancelled"; reason: string } | null = null;
    const forwarded = { stdout: 0, stderr: 0 };
    const kill = () => {
      try {
        ssh.kill("SIGKILL");
      } catch {
        // Gone already.
      }
    };
    ssh.stdin?.on("error", () => undefined);
    ssh.stdin?.write(`${JSON.stringify(spec)}\n`);
    if (stdin.length) ssh.stdin?.write(stdin);
    ssh.stdout?.on("data", (b: Buffer) => {
      if (broken) return;
      received += b.length;
      try {
        for (const f of reader.push(b)) {
          if (f.ch === CH_STDOUT) {
            forwarded.stdout += f.data.length;
            s.stdout.write(f.data);
          } else if (f.ch === CH_STDERR) {
            forwarded.stderr += f.data.length;
            s.stderr.write(f.data);
          } else if (f.ch === CH_END) {
            end = JSON.parse(f.data.toString("utf8")) as typeof end;
            ssh.stdin?.end();
          }
        }
      } catch (e) {
        broken = e instanceof WireError ? e.message : "an end frame that does not read";
        this.#o.log(`exec: the runner broke the protocol (${broken}); stopping it`);
        kill();
      }
    });
    let errText = "";
    ssh.stderr?.on("data", (b: Buffer) => {
      if (errText.length < 2000) errText += b.toString("utf8");
    });
    const guard = setTimeout(
      () => {
        ending ??= { state: "timeout", reason: "deadline" };
        kill();
      },
      Math.max(0, spec.deadline - this.#o.now()) + DEADLINE_SLACK_MS,
    );
    guard.unref();
    let cancelTimer: NodeJS.Timeout | null = null;
    const done = new Promise<ProcEnd>((resolve) => {
      ssh.on("error", () => undefined);
      // Gone, but something still holds its pipes: stop waiting for them.
      ssh.on("exit", () =>
        setTimeout(() => {
          ssh.stdout?.destroy();
          ssh.stderr?.destroy();
        }, 2000).unref(),
      );
      ssh.on("close", (code) => {
        clearTimeout(guard);
        if (cancelTimer) clearTimeout(cancelTimer);
        if (!broken)
          try {
            reader.close();
          } catch (e) {
            broken = (e as Error).message;
          }
        if (errText.trim()) this.#o.log(`exec: runner: ${errText.trim().split("\n")[0]?.slice(0, 300)}`);
        const e = end as (ProcEnd & { bytes?: { stdout?: unknown; stderr?: unknown } }) | null;
        if (broken) {
          resolve({ state: "failed", exit: null, signal: null, reason: "runner_protocol" });
          return;
        }
        if (!e || !["done", "failed", "timeout", "cancelled"].includes(e.state)) {
          if (ending) resolve({ state: ending.state, exit: null, signal: null, reason: ending.reason });
          else
            resolve({
              state: "failed",
              exit: null,
              signal: null,
              reason: code === SSH_FAILED && received === 0 ? "runner_unavailable" : "runner_protocol",
            });
          return;
        }
        const total = (n: unknown, seen: number) =>
          Number.isSafeInteger(n) && (n as number) >= seen ? (n as number) : seen;
        s.stdout.unseen(total(e.bytes?.stdout, forwarded.stdout) - forwarded.stdout);
        s.stderr.unseen(total(e.bytes?.stderr, forwarded.stderr) - forwarded.stderr);
        resolve({
          state: e.state,
          exit: Number.isSafeInteger(e.exit) ? e.exit : null,
          signal: typeof e.signal === "string" ? e.signal.slice(0, 16) : null,
          // The collector's reason for a stop it asked for (a new generation, exec off) over the shim's `cancel`.
          reason:
            e.state === "cancelled" && ending
              ? ending.reason
              : typeof e.reason === "string"
                ? e.reason.slice(0, 64)
                : null,
        });
      });
    });
    return {
      pgid: null,
      stop: (state, reason) => {
        if (ending || end) return;
        ending = { state, reason };
        ssh.stdin?.write("cancel\n");
        cancelTimer = setTimeout(kill, CANCEL_SLACK_MS);
        cancelTimer.unref();
      },
      done: done.then((e) => outcome(e, s)),
    };
  }

  async sweep(): Promise<SweepReport | null> {
    const ssh = this.#connect("sweep");
    const reader = new FrameReader(1024);
    let end: { state?: unknown; reason?: unknown; killed?: unknown; comms?: unknown } | null = null;
    ssh.stdin?.on("error", () => undefined);
    ssh.stdin?.end();
    return new Promise((resolve) => {
      const t = setTimeout(() => ssh.kill("SIGKILL"), SWEEP_MS);
      t.unref();
      ssh.stdout?.on("data", (b: Buffer) => {
        try {
          for (const f of reader.push(b)) if (f.ch === CH_END) end = JSON.parse(f.data.toString("utf8")) as typeof end;
        } catch {
          ssh.kill("SIGKILL");
        }
      });
      ssh.on("error", () => undefined);
      ssh.on("close", () => {
        clearTimeout(t);
        const e = end as { state?: unknown; reason?: unknown; killed?: unknown; comms?: unknown } | null;
        if (!e || !Number.isSafeInteger(e.killed)) {
          this.#o.log("exec: the sweep did not answer");
          resolve(null);
          return;
        }
        // The shim could not list the processes (`ps` failed): nothing was swept, whatever it counts.
        if (e.state !== "done") {
          this.#o.log(`exec: the sweep failed (${String(e.reason ?? e.state).slice(0, 64)})`);
          resolve(null);
          return;
        }
        const comms = Array.isArray(e.comms) ? e.comms.filter((c): c is string => typeof c === "string") : [];
        resolve({ killed: e.killed as number, comms: comms.slice(0, 50).map((c) => c.slice(0, 64)) });
      });
    });
  }
}
