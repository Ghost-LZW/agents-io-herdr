/**
 * New work, once LB's side and the ceiling let it in (docs/exec.md N7): the call is
 * admitted (src/exec/grants.ts), the runner prepares it (the profile compiles; nothing is claimed
 * yet), then — synchronously, after looking at the ledger once more — the effect is written
 * `running` with its once grant marked used, and only then the process starts. LB hears `running`
 * at once; the end comes as an `effect` frame when the run is over.
 *
 * - At most `limits.concurrent` runs at a time (`busy`).
 * - `cancel.v1` stops a running effect (SIGTERM to its group, SIGKILL 5 s later); it is an effect of
 *   its own that ends at once: exit 0 when the target was running here, 1 when it was not.
 * - A new generation (4410, or a welcome after a missed bump), LB taking exec back (4403, a welcome
 *   with exec off, another owner…: src/collector.ts) and exec turned off here cancel every run
 *   (`generation_changed`, `revoked`, `lb_off`…, `exec_off`); a collector on its way out cancels
 *   them and, for what has not ended within the grace, writes `unknown` (`collector_restart`). Runs a
 *   collector that died left going are stopped by the next one by their process group (acceptance
 *   case 13).
 * - The dedicated user's runner (`runner: "user"`) is swept — every process of that user left over,
 *   except the shim's own — only while nothing runs: when the collector starts, after a run that
 *   wrote or went through the proxy, after runs were stopped (a new generation, exec off), and at
 *   least every 15 minutes, new work answered `busy` until then. With exec off here the
 *   sweep that is due still happens, by the last ceiling's runner, but not every 15 minutes: nothing
 *   new starts. A sweep that fails is no sweep: still due, tried again a minute later, new work held
 *   back meanwhile once one is overdue. `setsid` escapes live at most 15 minutes plus a deadline
 *   either way, or until a sweep gets through.
 * - The Box (`runner: "bwrap"`, src/exec/box.ts): exec.v1, upload.v1 and download.v1 are admitted
 *   by `admitBox` and run by the bwrap runner, the same ledger, claim and limits around them. An
 *   upload's `chunk` frames come in through `chunk` (kept in order until the run has started); a
 *   download's go out through `sendChunk`. A transfer cannot outlive its link: when it drops, they
 *   stop (`link_lost`) — LB asks again under a new effect id.
 */
import { existsSync, realpathSync } from "node:fs";
import { writePrivate } from "../store.ts";
import type { Exec } from "../system.ts";
import { admitBox, type BoxAdmission } from "./box.ts";
import { known } from "./calls.ts";
import type { Ceiling } from "./ceiling.ts";
import { within } from "./ceiling.ts";
import type { Scan } from "./deny.ts";
import { type EffectLedger, report } from "./effects.ts";
import {
  type CallAnswer,
  type CallFrame,
  CHUNK_MAX,
  type Chunk,
  type EffectReport,
  type ExecArgs,
  refuse,
} from "./frames.ts";
import { type Admission, admitExec, type GrantsUsed } from "./grants.ts";
import { type Runner, type RunPlan, reapOrphans, type Started, type SweepReport } from "./run.ts";
import { gitHooksPaths } from "./sandbox.ts";

/** The dedicated user is swept at least this often. */
export const SWEEP_EVERY_MS = 15 * 60_000;
/** A sweep that failed is tried again after this. */
export const SWEEP_RETRY_MS = 60_000;
/** On its way out the collector waits this long for cancelled runs to end. */
const SHUTDOWN_WAIT_MS = 6000;
const EFFECT_ID = /^eff_[A-Za-z0-9_-]{1,96}$/;

/** What a take needs to know besides the call: the ceiling now, and LB's side (generation.ts). */
export interface TakeContext {
  ceiling: Ceiling;
  scan: Scan | null;
  nodeId: string;
  owner: string | null;
  generation: number;
  /** LB's time now (this clock and the skew at the last welcome). */
  lbNow: number;
  /** Whether the gate is still open in this generation (looked at again after the runner prepared). */
  open?: () => boolean;
}

export interface ExecutorOptions {
  ledger: EffectLedger;
  used: GrantsUsed;
  /** The runner for this ceiling (same user, or the dedicated user's). */
  runnerFor: (c: Ceiling) => Runner;
  /** The collector's environment: envPass takes its values from here. */
  env: Record<string, string | undefined>;
  now: () => number;
  log: (s: string) => void;
  exec: Exec;
  /** An effect has ended: to LB if linked (the ledger keeps it until acknowledged either way). */
  sendEffect: (r: EffectReport) => void;
  /** A download's piece to LB; false when it could not go (no link). */
  sendChunk?: (c: Chunk) => boolean;
  /** Where the Box's helpers are (default /usr/lib/box); tests point at this checkout. */
  boxLib?: string;
  /** Where the last sweep is written. */
  sweepFile?: string;
  graceMs?: number;
}

interface Running {
  started: Started;
  /** Wrote, or went through the proxy: the dedicated user is swept once it is over. */
  widens: boolean;
  done: Promise<void>;
  /** A file transfer: it stops when the link goes. */
  transfer?: boolean;
}

/** An upload's chunks that came before its run started (LB may send them right after the call). */
interface Intake {
  node: string;
  queue: Chunk[];
  bytes: number;
  /** What may wait: the upload's size and a piece more (beyond it the run sees a gap and fails). */
  limit: number;
  started: Started | null;
}

/** A run whose runner threw: failed, nothing of its output. */
const failedOutcome = (reason: string) => ({
  state: "failed" as const,
  exit: null,
  signal: null,
  stdout: "",
  stderr: "",
  redacted: { stdout: 0, stderr: 0 },
  truncated: false,
  bytes: { stdout: 0, stderr: 0 },
  reason,
});

/** Proxy variables for `network: "proxy"` (N13's proxy on its fixed port). */
function proxyEnv(port: number): Record<string, string> {
  const url = `http://127.0.0.1:${port}`;
  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    ALL_PROXY: url,
    https_proxy: url,
    http_proxy: url,
    all_proxy: url,
    NODE_USE_ENV_PROXY: "1",
  };
}

const DEFAULT_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * Where argv[0] is looked up: the collector's own PATH when envPass has it, else the default — never
 * a PATH from LB's request, which could name a script in a read root `ls` (an auto command) instead.
 */
export const lookupPath = (c: Ceiling, outer: Record<string, string | undefined>): string =>
  (c.envPass.includes("PATH") ? outer.PATH : undefined) || DEFAULT_PATH;

/**
 * A run's environment: only envPass names, from the collector's environment and then LB's request
 * (already limited to envPass); TERM=dumb; git commits under the ceiling's name; caches in the first
 * cacheDir; the proxy for `network: "proxy"`. HOME and TMPDIR are the runner's.
 */
export function runEnv(
  c: Ceiling,
  requested: Record<string, string>,
  outer: Record<string, string | undefined>,
  network: "off" | "proxy",
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const n of c.envPass) {
    const v = outer[n];
    if (v !== undefined) env[n] = v;
  }
  for (const [k, v] of Object.entries(requested)) if (c.envPass.includes(k)) env[k] = v;
  env.PATH ??= DEFAULT_PATH;
  env.TERM = "dumb";
  const name = c.file.gitIdentity?.name;
  if (name) {
    env.GIT_AUTHOR_NAME = name;
    env.GIT_COMMITTER_NAME = name;
  }
  const cache = c.cache[0];
  if (cache) {
    env.XDG_CACHE_HOME = cache;
    env.npm_config_cache = `${cache}/npm`;
    env.PIP_CACHE_DIR = `${cache}/pip`;
    env.UV_CACHE_DIR = `${cache}/uv`;
  }
  if (network === "proxy" && c.file.proxy) Object.assign(env, proxyEnv(c.file.proxy.port));
  return env;
}

/** A path as seatbelt sees it (symlinks resolved), when it exists. */
const real = (p: string) => {
  try {
    return existsSync(p) ? realpathSync(p) : p;
  } catch {
    return p;
  }
};

export class Executor {
  #o: ExecutorOptions;
  #running = new Map<string, Running>();
  /** Effect ids being prepared: the same id again meanwhile is not prepared twice. */
  #preparing = new Set<string>();
  /**
   * `at` 0: not swept since this collector started — new work waits for it. `failedAt`: the last
   * sweep failed then; it stays due (and `at` where it was), tried again after SWEEP_RETRY_MS.
   */
  #sweep = { at: 0, due: true, busy: false, failedAt: 0 };
  /** Uploads being prepared or running, by effect id. */
  #intake = new Map<string, Intake>();
  /** Chunks that matched nothing here, logged once per effect id. */
  #strays = new Set<string>();

  constructor(o: ExecutorOptions) {
    this.#o = o;
  }

  get running(): number {
    return this.#running.size;
  }

  /** Runs the last collector left going (its effects were turned `unknown` when the ledger opened). */
  reap(): number[] {
    const runs = this.#o.ledger.recovered
      .filter((e) => e.reason === "collector_restart" && e.proc)
      .map((e) => e.proc as { pgid: number; spawnedAt: number });
    return reapOrphans(runs, { now: this.#o.now, exec: this.#o.exec, log: this.#o.log, graceMs: this.#o.graceMs });
  }

  /** exec.v1 and cancel.v1, after the ledger and the gate (calls.ts). */
  async take(call: CallFrame, hash: string, x: TakeContext): Promise<CallAnswer> {
    if (call.op === "cancel.v1") return this.#cancel(call, hash, x);
    if (x.ceiling.file.runner === "bwrap") return this.#takeBox(call, hash, x);
    if (call.op !== "exec.v1") return refuse("unsupported", "file transfer is the Box's (runner bwrap) only");
    const a = admitExec(call, { ...x, used: this.#o.used });
    if (!a.ok) return a.answer;
    const ad = a.admission;
    const id = call.effectId as string;
    const runner = this.#o.runnerFor(x.ceiling);
    const full = this.#full(x.ceiling, runner);
    if (full) return refuse("busy", full);
    if (this.#preparing.has(id)) return refuse("busy", "this effect is being started; ask again for its state");
    this.#preparing.add(id);
    let p: Awaited<ReturnType<Runner["prepare"]>>;
    try {
      p = await runner.prepare(this.#plan(call, ad, x));
    } finally {
      this.#preparing.delete(id);
    }
    if (!p.ok) return refuse(p.code, p.message);
    // While it was being prepared: a new generation or exec off, the same id, the limit filled up.
    const seen = this.#o.ledger.lookup(id, hash);
    const late =
      x.open && !x.open()
        ? refuse("stale_generation", "the generation changed or exec went off while the run was being prepared")
        : seen.kind === "conflict"
          ? refuse("effect_conflict", "this effect id was used with other arguments")
          : seen.kind === "known"
            ? known(seen.entry, call.origin)
            : this.#full(x.ceiling, runner)
              ? refuse("busy", this.#full(x.ceiling, runner) as string)
              : ad.grant?.kind === "once" && this.#o.used.has(ad.grant.id)
                ? refuse("grant_invalid", "the grant was used already")
                : null;
    if (late) {
      p.prepared.discard();
      return late;
    }
    // On disk before anything starts: the effect, and the once grant with it.
    this.#o.ledger.claim({
      effect_id: id,
      op: call.op,
      argsHash: hash,
      node: x.nodeId,
      origin: call.origin,
      generation: x.generation,
      deadline: ad.deadline,
      grant: ad.grant?.id ?? null,
    });
    if (ad.grant?.kind === "once") this.#o.used.use(ad.grant.id);
    const started = p.prepared.start();
    if (started.pgid) this.#o.ledger.attach(id, { pgid: started.pgid, spawnedAt: this.#o.now() });
    const widens = ad.write.length > 0 || ad.effective.network === "proxy";
    const done = started.done.then(
      (o) => this.#ended(id, () => this.#o.ledger.finish(id, o)),
      (e: Error) =>
        this.#ended(id, () => this.#o.ledger.finish(id, failedOutcome(`runner: ${e.message.slice(0, 200)}`))),
    );
    this.#running.set(id, { started, widens, done });
    return { ok: true, data: { effect_id: id, state: "running", effective: ad.effective } };
  }

  /**
   * The Box: admitted by src/exec/box.ts, prepared by the bwrap runner (its preflight), then claimed
   * and started like any run; an upload's early chunks wait in its intake until then.
   */
  async #takeBox(call: CallFrame, hash: string, x: TakeContext): Promise<CallAnswer> {
    const a = admitBox(call, {
      ceiling: x.ceiling,
      owner: x.owner,
      lbNow: x.lbNow,
      env: this.#o.env,
      lib: this.#o.boxLib,
    });
    if (!a.ok) return a.answer;
    const ad: BoxAdmission = a.admission;
    const id = call.effectId as string;
    const runner = this.#o.runnerFor(x.ceiling);
    if (!runner.prepareBox) return refuse("runner_unavailable", "this runner does not run the Box's jobs");
    const full = this.#full(x.ceiling, runner);
    if (full) return refuse("busy", full);
    if (this.#preparing.has(id)) return refuse("busy", "this effect is being started; ask again for its state");
    this.#preparing.add(id);
    const t = ad.job.transfer;
    const upload = t?.kind === "upload";
    if (t?.kind === "upload")
      this.#intake.set(id, { node: x.nodeId, queue: [], bytes: 0, limit: t.size + CHUNK_MAX, started: null });
    const node = x.nodeId;
    const send = this.#o.sendChunk;
    let p: Awaited<ReturnType<NonNullable<Runner["prepareBox"]>>>;
    try {
      p = await runner.prepareBox(
        // On this machine's clock, which the runner goes by (the ledger keeps LB's).
        { ...ad.job, effectId: id, deadline: ad.deadline - (x.lbNow - this.#o.now()) },
        {
          seccomp: x.ceiling.file.seccompBpf,
          send: (c) =>
            send?.({ effect_id: id, node, seq: c.seq, data: c.data.toString("base64"), last: c.last }) ?? false,
        },
      );
    } finally {
      this.#preparing.delete(id);
    }
    const drop = () => upload && this.#intake.delete(id);
    if (!p.ok) {
      drop();
      return refuse(p.code, p.message);
    }
    const seen = this.#o.ledger.lookup(id, hash);
    const late =
      x.open && !x.open()
        ? refuse("stale_generation", "the generation changed or exec went off while the run was being prepared")
        : seen.kind === "conflict"
          ? refuse("effect_conflict", "this effect id was used with other arguments")
          : seen.kind === "known"
            ? known(seen.entry, call.origin)
            : this.#full(x.ceiling, runner)
              ? refuse("busy", this.#full(x.ceiling, runner) as string)
              : null;
    if (late) {
      drop();
      p.prepared.discard();
      return late;
    }
    this.#o.ledger.claim({
      effect_id: id,
      op: call.op,
      argsHash: hash,
      node: x.nodeId,
      origin: call.origin,
      generation: x.generation,
      deadline: ad.deadline,
      grant: null,
    });
    const started = p.prepared.start();
    if (started.pgid) this.#o.ledger.attach(id, { pgid: started.pgid, spawnedAt: this.#o.now() });
    const intake = this.#intake.get(id);
    if (intake) {
      intake.started = started;
      for (const c of intake.queue.splice(0)) this.#feed(started, c);
    }
    const done = started.done.then(
      (o) => this.#ended(id, () => this.#o.ledger.finish(id, o)),
      (e: Error) =>
        this.#ended(id, () => this.#o.ledger.finish(id, failedOutcome(`runner: ${e.message.slice(0, 200)}`))),
    );
    this.#running.set(id, { started, widens: false, done, transfer: ad.job.transfer !== null });
    return { ok: true, data: { effect_id: id, state: "running", effective: ad.effective } };
  }

  #feed(started: Started, c: Chunk): void {
    started.feed?.({ seq: c.seq, data: Buffer.from(c.data, "base64"), last: c.last });
  }

  /**
   * A `chunk` frame from LB: the next piece of an upload being prepared or running here (another
   * node's, or one that matches nothing, is dropped and logged once). Before the run starts they are
   * kept, at most the upload's size and a piece more.
   */
  chunk(c: Chunk): void {
    const i = this.#intake.get(c.effect_id);
    if (!i || i.node !== c.node) {
      if (!this.#strays.has(c.effect_id)) {
        this.#strays.add(c.effect_id);
        if (this.#strays.size > 256) this.#strays.clear();
        this.#o.log(`exec: a chunk of ${c.effect_id} matches no upload here; dropped`);
      }
      return;
    }
    if (i.started) {
      this.#feed(i.started, c);
      return;
    }
    i.bytes += Buffer.byteLength(c.data, "base64");
    if (i.bytes <= i.limit) i.queue.push(c);
  }

  /** The link went: transfers stop (their chunks cannot reach either side now); other runs go on. */
  stopTransfers(reason: string): number {
    let n = 0;
    for (const r of this.#running.values())
      if (r.transfer) {
        r.started.stop("cancelled", reason);
        n++;
      }
    return n;
  }

  #ended(id: string, finish: () => ReturnType<EffectLedger["finish"]>): void {
    this.#intake.delete(id);
    const r = this.#running.get(id);
    this.#running.delete(id);
    // null: no longer running in the ledger (the collector gave it up as unknown on its way out).
    const e = finish();
    if (e) this.#o.sendEffect(report(e));
    if (r?.widens) this.#sweep.due = true;
  }

  /** Why nothing new is taken now, or null. */
  #full(c: Ceiling, runner: Runner): string | null {
    if (this.#running.size >= c.file.limits.concurrent)
      return `this machine runs at most ${c.file.limits.concurrent} command(s) at a time`;
    if (runner.sweep && (this.#sweep.busy || this.#o.now() - this.#sweep.at >= SWEEP_EVERY_MS))
      return "clearing up the runner's leftover processes first; try again shortly";
    return null;
  }

  #plan(call: CallFrame, ad: Admission, x: TakeContext): RunPlan {
    const c = x.ceiling;
    const args: ExecArgs = ad.args;
    const same = c.file.runner === "same";
    // The dedicated user's directories cannot be resolved from here; its paths are real by setup.
    const r = (list: string[]) => (same ? list.map(real) : list);
    const read = [...new Set([...c.read, ...c.tool])];
    const write = [...new Set([...ad.write, ...c.cache])];
    const roots = [...read, ...write];
    // `open` never gets this far (intersect: over_ceiling off the install cell).
    const network = ad.effective.network === "proxy" ? "proxy" : "off";
    return {
      effectId: call.effectId as string,
      argv: args.argv,
      cwd: ad.cwd,
      env: runEnv(c, args.env, this.#o.env, network),
      path: lookupPath(c, this.#o.env),
      stdin: args.stdin,
      // On this machine's clock, which the runner and the shim go by (the ledger keeps LB's).
      deadline: ad.deadline - (x.lbNow - this.#o.now()),
      outputBytes: c.file.limits.outputBytes,
      profile: {
        home: c.home,
        read: r(read),
        write: r(write),
        deny: c.deny,
        private: same ? r((x.scan?.hits ?? []).filter((h) => h.why === "private").map((h) => h.path)) : [],
        noWrite: same
          ? r(gitHooksPaths(c.home, ad.cwd, (dir) => !roots.some((root) => within(dir, root) && dir !== root)))
          : [],
        network,
        proxyPort: c.file.proxy?.port ?? null,
      },
      roots: { read, write, cache: c.cache },
      home: same ? null : `${c.home}/work`,
    };
  }

  /** cancel.v1: an effect of its own that ends at once; the target ends `cancelled` when its group is gone. */
  #cancel(call: CallFrame, hash: string, x: TakeContext): CallAnswer {
    const origin = call.origin;
    const target = call.args.target;
    if (!origin || call.deadline === null || typeof target !== "string" || !EFFECT_ID.test(target))
      return refuse("bad_request", "cancel.v1 needs args.target, an effect id");
    // The Box serves everyone: a run is cancelled by the person it runs for, not the node's owner.
    const box = x.ceiling.file.runner === "bwrap";
    const of = this.#o.ledger.get(target)?.origin;
    if (!x.owner || (!box && origin.person !== x.owner && !x.ceiling.file.others.includes(origin.person)))
      return refuse("not_owner", "not for this machine's owner");
    if (box && of && of.person !== origin.person) return refuse("not_owner", "that effect runs for someone else");
    if (box && of && of.conversation !== origin.conversation)
      return refuse("effect_conflict", "that effect runs in another conversation");
    if (call.deadline <= x.lbNow) return refuse("deadline_passed", "the deadline has passed");
    const id = call.effectId as string;
    this.#o.ledger.claim({
      effect_id: id,
      op: call.op,
      argsHash: hash,
      node: x.nodeId,
      origin: call.origin,
      generation: x.generation,
      deadline: call.deadline,
      grant: null,
    });
    const r = this.#running.get(target);
    r?.started.stop("cancelled", "cancel");
    const was = this.#o.ledger.get(target);
    const e = this.#o.ledger.finish(id, {
      state: "done",
      exit: r ? 0 : 1,
      signal: null,
      stdout: "",
      stderr: "",
      redacted: { stdout: 0, stderr: 0 },
      truncated: false,
      bytes: { stdout: 0, stderr: 0 },
      reason: r ? null : was ? "not_running" : "not_found",
    });
    if (!e) return refuse("bad_request", "cancel.v1 could not be recorded");
    this.#o.sendEffect(report(e));
    return { ok: true, data: { ...report(e), target: { effect_id: target, state: was?.state ?? null } } };
  }

  /** Every run stops (`cancelled`): a new generation, LB taking exec back, or exec turned off here. */
  stopAll(reason: string): number {
    for (const r of this.#running.values()) r.started.stop("cancelled", reason);
    // What they started outside their group goes once they are over.
    if (this.#running.size) this.#sweep.due = true;
    return this.#running.size;
  }

  /**
   * The collector is going: every run is cancelled; what has not ended once the grace is over is
   * written `unknown` (`collector_restart`) — its process group, if any is left, is the next one's.
   */
  async shutdown(waitMs = SHUTDOWN_WAIT_MS): Promise<void> {
    if (!this.#running.size) return;
    this.stopAll("collector_restart");
    const all = Promise.all([...this.#running.values()].map((r) => r.done));
    await Promise.race([all, new Promise((r) => setTimeout(r, waitMs).unref())]);
    for (const id of [...this.#running.keys()]) {
      this.#running.delete(id);
      const e = this.#o.ledger.abandon(id, "collector_restart");
      if (e) this.#o.sendEffect(report(e));
    }
  }

  /**
   * Each collector pass and after each run: the dedicated user is swept when nothing runs and it is
   * due (at start, after a widening run or a stop, every 15 minutes). `off`: exec is off here — only
   * a sweep that is due, none every 15 minutes (nothing new runs to leave anything). One that failed
   * (the runner answered null or threw) counts for nothing: tried again a minute later.
   */
  async tick(c: Ceiling | null, o: { off?: boolean } = {}): Promise<SweepReport | null> {
    if (!c) return null;
    const runner = this.#o.runnerFor(c);
    if (!runner.sweep || this.#running.size || this.#sweep.busy) return null;
    const now = this.#o.now();
    if (!this.#sweep.due && (o.off || now - this.#sweep.at < SWEEP_EVERY_MS)) return null;
    if (this.#sweep.failedAt && now - this.#sweep.failedAt < SWEEP_RETRY_MS) return null;
    this.#sweep.busy = true;
    let r: SweepReport | null = null;
    try {
      r = await runner.sweep();
    } catch (e) {
      this.#o.log(`exec: sweep failed: ${(e as Error).message}`);
    } finally {
      const first = this.#sweep.at === 0;
      // Not swept: still due, and the 15 minutes still count from the last sweep that was (new work
      // stays `busy` once they are over), so what escaped is not taken for gone.
      if (!r) {
        this.#sweep = { ...this.#sweep, due: true, busy: false, failedAt: this.#o.now() };
        this.#o.log(`exec: nothing swept; trying again in ${SWEEP_RETRY_MS / 1000} s`);
      } else this.#sweep = { at: this.#o.now(), due: false, busy: false, failedAt: 0 };
      if (r) {
        if (r.killed)
          this.#o.log(
            `exec: swept ${r.killed} process(es) left by ${first ? "an earlier collector" : "earlier runs"}: ${r.comms.join(", ")}`,
          );
        if (this.#o.sweepFile)
          writePrivate(
            this.#o.sweepFile,
            `${JSON.stringify({ at: this.#sweep.at, first, killed: r.killed, comms: r.comms })}\n`,
          );
      }
    }
    return r;
  }
}
