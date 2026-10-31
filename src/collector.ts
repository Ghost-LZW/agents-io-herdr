/**
 * The session collector (docs/sessions.md): scans this machine's Claude Code / Codex sessions every
 * few seconds, keeps the latest list in a local file, and — when linked — hands it to LB (the
 * server it is paired with) over the node connection (`GET /api/nodes/connect`, the node signs LB's
 * challenge with its ed25519 key). It sends one new frame, `{t:"sessions"}`, and answers `session.read`; it never
 * sends `panes` or `notice` frames and refuses `agent.prompt` / `agent.send_keys` (`unsupported`).
 *
 * Exec (docs/exec.md) drives nothing until this machine has a valid ceiling file
 * (src/exec/ceiling.ts): without one, or with `exec off`, hello says `caps: ["sessions"]` and every
 * exec call is refused. The link speaks hello / welcome v2 (the generation, src/exec/generation.ts),
 * keeps the effect ledger (src/exec/effects.ts) and sends what LB has not acknowledged after each
 * welcome; a call is admitted against the ceiling and its grant (src/exec/grants.ts) and run by the
 * ceiling's runner (src/exec/executor.ts: this user's sandboxed child, or the dedicated user's forced
 * command through ssh). A new generation, LB taking exec back (a welcome that says so, another
 * owner, 4403) and exec turned off here stop what runs; on its way out the collector stops it too,
 * and one that died leaves its runs to the next to stop. When what hello would say changes (the
 * ceiling, the switch), the link says hello again.
 *
 * Off switch: `agents-io-herdr sessions off` (a file; the collector then lists nothing, tells LB the
 * list is empty and refuses reads); `agents-io-herdr sessions uninstall` removes the launchd job.
 *
 * Exec only (`execOnly` in sessions.json, or AGENTS_IO_HERDR_EXEC_ONLY=1; the Box and its install
 * cell, docs/exec.md, Linux / Box): no sessions are collected, herdr is never asked, no `sessions`
 * frame goes out and `session.read` is `unsupported`; hello's caps leave out `sessions`. What is left
 * is the link, the ledger and exec — with `chunk` frames for the Box's file transfers.
 */
import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { BwrapRunner } from "./exec/bwrap.ts";
import { answerExec, type Gate } from "./exec/calls.ts";
import { type Ceiling, CeilingSource, capsFor, summary } from "./exec/ceiling.ts";
import { EffectLedger, report } from "./exec/effects.ts";
import { Executor } from "./exec/executor.ts";
import {
  type CallAnswer,
  type CallFrame,
  type Chunk,
  CLOSE_GENERATION,
  CLOSE_PENDING,
  CLOSE_REFUSED,
  CLOSE_SILENT,
  chunkFrame,
  type EffectReport,
  effectFrame,
  type HelloState,
  helloFrame,
  isExecOp,
  parseCall,
  parseChunk,
  parseEffectAck,
  parseWelcome,
  refuse,
  resultFrame,
  type Welcome,
} from "./exec/frames.ts";
import { Generation, type WelcomeOutcome } from "./exec/generation.ts";
import { GrantsUsed } from "./exec/grants.ts";
import { execPaths } from "./exec/paths.ts";
import { type Runner, SameUserRunner } from "./exec/run.ts";
import { UserRunner } from "./exec/user-runner.ts";
import { type HerdrAgent, herdrClient, herdrSocket, listAgents } from "./herdr.ts";
import { readPage } from "./sessionread.ts";
import { codexNames, fileOf, type MachineSession, type Parsed, scan } from "./sessions.ts";
import { writePrivate } from "./store.ts";
import type { Exec } from "./system.ts";

export const SESSIONS_LABEL = "io.agents-io-herdr.sessions";
export { VERSION } from "./exec/frames.ts";

export interface SessionsConfig {
  /** The machine's name in LB. */
  machine: string;
  /** Ended sessions are listed for this long. */
  recentHours: number;
  intervalSec: number;
  /** Link to LB; null: collect locally only. */
  report: Report | null;
  /** Exec only: no sessions, no herdr (the Box). */
  execOnly?: boolean;
}

/**
 * Where the node's ed25519 private key is kept: a file of its own (`keyFile`, PKCS#8 PEM, 0600; for a
 * headless machine, where the login keychain is locked in an ssh session and in jobs started through
 * ssh) or the login keychain (`keychainService` / `keychainAccount`, PKCS#8 DER in base64).
 * `keyFile` wins when both are set.
 */
export interface Report {
  lbUrl: string;
  nodeId: string;
  keyFile?: string;
  keychainService?: string;
  keychainAccount?: string;
}

export type KeyStore = { file: string } | { keychainService: string; keychainAccount: string };

export interface SessionsPaths {
  dir: string;
  config: string;
  off: string;
  spool: string;
  log: string;
  /** The running collector's pid: the newest one started owns it, an older one stops. */
  pid: string;
}

export function sessionsPaths(env: Record<string, string | undefined>, home: string): SessionsPaths {
  const dir = env.AGENTS_IO_HERDR_SESSIONS_DIR || join(home, ".config", "agents-io-herdr");
  return {
    dir,
    config: join(dir, "sessions.json"),
    off: join(dir, "sessions.off"),
    spool: join(dir, "sessions-latest.json"),
    log: join(dir, "logs", "sessions.log"),
    pid: join(dir, "collector.pid"),
  };
}

export function loadSessionsConfig(p: SessionsPaths, fallbackMachine: string): SessionsConfig {
  let raw: Partial<SessionsConfig> = {};
  if (existsSync(p.config)) raw = JSON.parse(readFileSync(p.config, "utf8")) as Partial<SessionsConfig>;
  return {
    machine: raw.machine || fallbackMachine,
    recentHours: raw.recentHours ?? 24,
    intervalSec: raw.intervalSec ?? 10,
    report: raw.report ?? null,
    execOnly: raw.execOnly === true,
  };
}

/** Exec only, as sessions.json says or the environment overrides (the Box's image sets it). */
export const execOnly = (c: SessionsConfig, env: Record<string, string | undefined>) =>
  c.execOnly || env.AGENTS_IO_HERDR_EXEC_ONLY === "1";

const ed25519 = (k: KeyObject) => (k.asymmetricKeyType === "ed25519" ? k : null);

/**
 * The node key, from its file or the keychain. The reason names the place, never the key. The file
 * must be this user's and readable by no one else (as ssh wants of its keys).
 */
export function loadNodeKey(r: Report, exec: Exec): { key: KeyObject } | { reason: string } {
  if (r.keyFile) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(r.keyFile);
    } catch {
      return { reason: `no key file ${r.keyFile}` };
    }
    if ((st.mode & 0o077) !== 0) return { reason: `${r.keyFile} is open to others (chmod 600 it)` };
    if (typeof process.getuid === "function" && st.uid !== process.getuid())
      return { reason: `${r.keyFile} belongs to another user` };
    try {
      const key = ed25519(createPrivateKey(readFileSync(r.keyFile, "utf8")));
      return key ? { key } : { reason: `${r.keyFile} is not an ed25519 key` };
    } catch {
      return { reason: `${r.keyFile} is not a private key` };
    }
  }
  if (r.keychainService && r.keychainAccount) {
    // The key comes back on stdout, never in an argument.
    const out = exec(
      "security",
      ["find-generic-password", "-s", r.keychainService, "-a", r.keychainAccount, "-w"],
      10_000,
    );
    if (out?.code !== 0) return { reason: `not in the keychain (${r.keychainService}), or the keychain is locked` };
    try {
      const key = ed25519(
        createPrivateKey({ key: Buffer.from(out.stdout.trim(), "base64"), format: "der", type: "pkcs8" }),
      );
      return key ? { key } : { reason: `the keychain item ${r.keychainService} is not an ed25519 key` };
    } catch {
      return { reason: `the keychain item ${r.keychainService} is not a private key` };
    }
  }
  return { reason: "no key file or keychain item configured" };
}

/** Names `security -i` takes as one word. */
const PLAIN = /^[A-Za-z0-9._@-]+$/;

/**
 * Keeps a new node key: in a 0600 file (directory 0700), or in the login keychain through
 * `security -i`, which reads its command from stdin, so the key is in no process's arguments.
 */
export function keepNodeKey(k: NewNodeKey, store: KeyStore, exec: Exec): { ok: true } | { ok: false; reason: string } {
  if ("file" in store) {
    try {
      writePrivate(store.file, k.pem);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `could not write ${store.file}: ${(e as NodeJS.ErrnoException).code ?? "error"}` };
    }
  }
  if (!PLAIN.test(store.keychainService) || !PLAIN.test(store.keychainAccount))
    return { ok: false, reason: "keychain service and account must be plain names" };
  const r = exec(
    "security",
    ["-i"],
    10_000,
    `add-generic-password -U -s ${store.keychainService} -a ${store.keychainAccount} -w ${k.privateKey}\n`,
  );
  return r?.code === 0
    ? { ok: true }
    : { ok: false, reason: "could not keep the key in the login keychain (locked? use a key file)" };
}

export interface NewNodeKey {
  /** PKCS#8 DER, base64 (the keychain form). */
  privateKey: string;
  /** PKCS#8 PEM (the file form). */
  pem: string;
  /** The raw 32-byte public key, base64 (what LB is given). */
  publicKey: string;
}

/** A new ed25519 key. */
export function newNodeKey(): NewNodeKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKey: spki.subarray(spki.length - 32).toString("base64"),
  };
}

/** LB's pairing code for a public key (LB `pairingCode`): six digits shown on LB's pairing card. */
export function pairingCode(publicKey: string): string {
  const h = createHash("sha256").update(Buffer.from(publicKey, "base64")).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export const signChallenge = (key: KeyObject, nonce: string) =>
  sign(null, Buffer.from(`lb-node:${nonce}`), key).toString("base64");

/** What a `session.read` call asks. */
export interface ReadArgs {
  id?: unknown;
  offset?: unknown;
  limit?: unknown;
}

export type { CallAnswer };

/** Answers one call from LB; only `session.read` is served. */
export function answer(op: unknown, args: ReadArgs, cache: Map<string, Parsed>, off: boolean): CallAnswer {
  if (op !== "session.read")
    return { ok: false, error: { code: "unsupported", message: "this node only lists and reads sessions" } };
  if (off) return { ok: false, error: { code: "paused", message: "sessions are switched off on this machine" } };
  const id = typeof args.id === "string" ? args.id : "";
  const p = id ? fileOf(cache, id) : null;
  if (!p) return { ok: false, error: { code: "session_gone", message: "no such session on this machine now" } };
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  try {
    const page = readPage(p.path, p.agent, { offset: num(args.offset), limit: num(args.limit) });
    return { ok: true, data: { id: p.id, agent: p.agent, cwd: p.cwd, ...page } };
  } catch (e) {
    return { ok: false, error: { code: "unreadable", message: (e as Error).message.slice(0, 200) } };
  }
}

type WS = {
  readyState: number;
  send(s: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(t: string, f: (ev: { data?: unknown; code?: number }) => void): void;
};

/** How often the link looks at the clock and at LB's silence. */
const WATCH_MS = 5000;
/** A look this late means the machine slept (a gap over 30 s is a wake). */
export const WAKE_GAP_MS = 30_000;
/** Nothing from LB for this long (it pings every 30 s): the connection is gone, whatever TCP says. */
export const SILENT_MS = 75_000;
/** 4408, 4410 or a wake again within this long: back off after all (5 s, 10 s, … ±20 %). */
const QUICK_WINDOW_MS = 60_000;
const QUICK_BACKOFF_MS = 5000;
const BACKOFF_MAX_MS = 60_000;

/** Why the link came down, for the back-off: a close code, `woke`, `relink` (this side), or null (could not open). */
type Down = number | "woke" | "relink" | null;

export interface LinkOptions {
  url: string;
  nodeId: string;
  key: KeyObject;
  machine: string;
  log: (s: string) => void;
  /**
   * Answers one call. May be async; an exec op answers within 5 s (taken, or a refusal) and its
   * outcome follows later as an `effect` frame. The result goes back only on the connection the
   * call came on.
   */
  onCall: (op: unknown, args: ReadArgs, call: CallFrame) => CallAnswer | Promise<CallAnswer>;
  /** hello v2's caps, generation and ceiling, read on every connect (default: sessions only, generation 0). */
  hello?: () => HelloState;
  /** LB's welcome. false: this machine is retired; the link stops and stays down. */
  onWelcome?: (w: Welcome) => boolean;
  /** Ended effects LB has not acknowledged (the ledger): sent again after every welcome. */
  pending?: () => EffectReport[];
  onEffectAck?: (effectId: string) => void;
  /** A piece of an upload from LB. */
  onChunk?: (c: Chunk) => void;
  /** The connection went: LB's close code, or null when this side dropped it (silence, a wake). */
  onDown?: (code: number | null) => void;
  /** The machine just woke: the gap since the last look. */
  onWake?: (gapMs: number) => void;
  /** For tests. */
  connect?: (url: string) => WS;
  retryMs?: number;
  now?: () => number;
  random?: () => number;
}

/**
 * The node connection (hello / welcome v2, docs/exec.md N1), reconnecting with back-off; `send`
 * drops frames while it is down — except effects, which the ledger keeps until LB acknowledges them.
 * LB closing with 4408 or 4410, or this machine waking, reconnects at once the first time; the same
 * again within a minute backs off. Anything else backs off from 5 s to 60 s; 4401 and 4403 wait 5 min.
 */
export class LbLink {
  #o: LinkOptions;
  #ws: WS | null = null;
  #up = false;
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;
  #ping: NodeJS.Timeout | null = null;
  #watch: NodeJS.Timeout | null = null;
  #backoff: number;
  #now: () => number;
  #lastHeard = 0;
  #lastLook = 0;
  #quick: { why: Down; at: number; n: number } | null = null;
  /** Sent on every (re)connect after the welcome. */
  latest: Record<string, unknown> | null = null;

  constructor(o: LinkOptions) {
    this.#o = o;
    this.#backoff = o.retryMs ?? 5000;
    this.#now = o.now ?? (() => Date.now());
  }

  get up(): boolean {
    return this.#up;
  }

  start(): void {
    this.#stopped = false;
    this.#lastLook = this.#now();
    this.#watch = setInterval(() => this.#look(), WATCH_MS);
    this.#watch.unref?.();
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#ping) clearInterval(this.#ping);
    if (this.#watch) clearInterval(this.#watch);
    this.#ws?.close(1000, "stopping");
    this.#ws = null;
    this.#up = false;
  }

  send(frame: Record<string, unknown>): void {
    if (frame.t === "sessions") this.latest = frame;
    if (this.#up && this.#ws?.readyState === 1) this.#ws.send(JSON.stringify(frame));
  }

  /**
   * What hello says has changed (the ceiling, the switch): hello again at once — backing off like a
   * 4410 if it keeps changing. Nothing to do while down: the next hello says it anyway.
   */
  relink(): void {
    if (!this.#up || this.#stopped) return;
    this.#o.log("what this machine allows has changed; saying hello again");
    this.#drop("relink");
  }

  /** An ended effect: sent now if linked; either way again after each welcome until LB acknowledges it. */
  sendEffect(r: EffectReport): void {
    if (this.#up && this.#ws?.readyState === 1) this.#ws.send(JSON.stringify(effectFrame(r)));
  }

  /** A piece of a download: sent now, or false when there is no link (nothing keeps it). */
  sendChunk(c: Chunk): boolean {
    if (!this.#up || this.#ws?.readyState !== 1) return false;
    this.#ws.send(JSON.stringify(chunkFrame(c)));
    return true;
  }

  #open(): void {
    const url = `${this.#o.url.replace(/^http/, "ws").replace(/\/$/, "")}/api/nodes/connect`;
    let ws: WS;
    try {
      ws = this.#o.connect ? this.#o.connect(url) : (new WebSocket(url) as unknown as WS);
    } catch (e) {
      this.#o.log(`cannot open ${url}: ${(e as Error).message}`);
      this.#retry(null);
      return;
    }
    this.#ws = ws;
    this.#lastHeard = this.#now();
    ws.addEventListener("message", (ev) => {
      if (this.#ws !== ws) return;
      this.#lastHeard = this.#now();
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!m || typeof m !== "object") return;
      if (m.t === "challenge" && typeof m.nonce === "string") {
        const state = this.#o.hello?.() ?? { caps: ["sessions"], generation: 0, ceiling: null };
        const machine = { name: this.#o.machine, platform: process.platform };
        const sig = signChallenge(this.#o.key, m.nonce);
        ws.send(JSON.stringify(helloFrame({ node: this.#o.nodeId, sig, machine, state, clock: this.#now() })));
      } else if (m.t === "welcome") this.#welcome(ws, parseWelcome(m));
      else if (m.t === "ping") ws.send(JSON.stringify({ t: "pong" }));
      else if (m.t === "effect_ack") {
        const id = parseEffectAck(m);
        if (id) this.#o.onEffectAck?.(id);
      } else if (m.t === "call") {
        const c = parseCall(m);
        if (c) this.#call(ws, c);
      } else if (m.t === "chunk" && this.#up) {
        const c = parseChunk(m);
        if (c) this.#o.onChunk?.(c);
      }
    });
    ws.addEventListener("close", (ev) => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#down(ev.code ?? null);
      this.#retry(ev.code ?? null);
    });
    ws.addEventListener("error", () => undefined);
  }

  #welcome(ws: WS, w: Welcome): void {
    if (this.#o.onWelcome?.(w) === false) {
      this.#o.log("this machine is retired: the link stays down until it is paired again");
      this.stop();
      return;
    }
    this.#up = true;
    this.#backoff = this.#o.retryMs ?? 5000;
    this.#o.log(w.generation === null ? "linked to LB (no exec there)" : `linked to LB (generation ${w.generation})`);
    if (this.latest) ws.send(JSON.stringify(this.latest));
    for (const r of this.#o.pending?.() ?? []) ws.send(JSON.stringify(effectFrame(r)));
    if (this.#ping) clearInterval(this.#ping);
    this.#ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ t: "ping" })), 30_000);
    this.#ping.unref?.();
  }

  #call(ws: WS, c: CallFrame): void {
    const reply = (r: CallAnswer) => {
      if (this.#ws === ws && ws.readyState === 1) ws.send(JSON.stringify(resultFrame(c.id, r)));
    };
    const failed = (e: unknown) => reply({ ok: false, error: { code: "internal", message: String(e).slice(0, 200) } });
    let r: CallAnswer | Promise<CallAnswer>;
    try {
      r = this.#o.onCall(c.op, c.args as ReadArgs, c);
    } catch (e) {
      failed(e);
      return;
    }
    if (r instanceof Promise) r.then(reply, failed);
    else reply(r);
  }

  /** Every few seconds: a late look is a wake; a long silence from LB is a dead connection. */
  #look(): void {
    const now = this.#now();
    const gap = now - this.#lastLook;
    this.#lastLook = now;
    if (gap > WAKE_GAP_MS) {
      this.#o.log(`woke after ${Math.round(gap / 1000)} s; linking again`);
      this.#o.onWake?.(gap);
      this.#drop("woke");
    } else if (this.#ws && now - this.#lastHeard > SILENT_MS) {
      this.#o.log(`nothing from LB for ${Math.round((now - this.#lastHeard) / 1000)} s; linking again`);
      this.#drop(CLOSE_SILENT);
    }
  }

  /** Gives up the connection without waiting for a close a dead network may never deliver, and links again. */
  #drop(why: "woke" | "relink" | typeof CLOSE_SILENT): void {
    if (this.#stopped) return;
    const ws = this.#ws;
    if (ws) {
      this.#ws = null;
      this.#down(null);
      try {
        ws.close(why === CLOSE_SILENT ? CLOSE_SILENT : 1000, why === CLOSE_SILENT ? "silent" : why);
      } catch {
        // Closing a socket that never opened: nothing to tell LB.
      }
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#retry(why);
  }

  #down(code: number | null): void {
    this.#up = false;
    if (this.#ping) clearInterval(this.#ping);
    this.#ping = null;
    this.#o.onDown?.(code);
  }

  #retry(why: Down): void {
    if (this.#stopped) return;
    let wait: number;
    if (why === CLOSE_SILENT || why === CLOSE_GENERATION || why === "woke" || why === "relink") {
      // LB asked for a new hello now (or the machine woke): at once, unless it keeps happening.
      const now = this.#now();
      const q = this.#quick;
      const n = q && q.why === why && now - q.at < QUICK_WINDOW_MS ? q.n + 1 : 0;
      this.#quick = { why, at: now, n };
      const base = Math.min(QUICK_BACKOFF_MS * 2 ** (n - 1), BACKOFF_MAX_MS);
      wait = n === 0 ? 0 : Math.round(base * (0.8 + 0.4 * (this.#o.random ?? Math.random)()));
    } else {
      // 4401: the owner has not confirmed the pairing; 4403: revoked or unknown. Try rarely.
      wait = why === CLOSE_PENDING || why === CLOSE_REFUSED ? 5 * 60_000 : this.#backoff;
      this.#backoff = Math.min(this.#backoff * 2, BACKOFF_MAX_MS);
    }
    if (typeof why === "number") this.#o.log(`LB closed the link (${why}); again in ${Math.round(wait / 1000)} s`);
    this.#timer = setTimeout(() => this.#open(), wait);
    this.#timer.unref?.();
  }
}

export interface CollectorDeps {
  home: string;
  env: Record<string, string | undefined>;
  exec: Exec;
  now: () => number;
  log: (s: string) => void;
  alive?: (pid: number) => boolean;
  herdr?: () => Promise<HerdrAgent[] | null>;
  /** The parent's pid now (`process.ppid`); for tests. */
  parent?: () => number;
  /** Waits between passes; for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** This process's pid; for tests. */
  pid?: number;
  /** When the machine booted (ms); for tests. */
  bootAt?: () => number;
  /** The node connection; for tests. */
  connect?: LinkOptions["connect"];
  /** The runner for a ceiling; for tests (default: this user's sandboxed child, or the dedicated user's). */
  runner?: (c: Ceiling) => Runner;
  /** Aborted: the collector stops (SIGTERM from launchd), stopping what runs first. */
  signal?: AbortSignal;
}

export const realAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** One collection pass (also what `agents-io-herdr sessions` prints). */
export class Collector {
  readonly cache = new Map<string, Parsed>();
  #names: { at: number; map: Map<string, string> } = { at: 0, map: new Map() };
  readonly c: SessionsConfig;
  readonly paths: SessionsPaths;
  readonly d: CollectorDeps;
  constructor(c: SessionsConfig, paths: SessionsPaths, d: CollectorDeps) {
    this.c = c;
    this.paths = paths;
    this.d = d;
  }

  get off(): boolean {
    return existsSync(this.paths.off);
  }

  async herdr(): Promise<HerdrAgent[] | null> {
    if (this.d.herdr) return this.d.herdr();
    const socket = herdrSocket(this.d.env, this.d.home);
    if (!existsSync(socket)) return null;
    try {
      return await listAgents(herdrClient(socket));
    } catch {
      return null;
    }
  }

  async once(): Promise<MachineSession[]> {
    if (this.off) return [];
    const now = this.d.now();
    if (now - this.#names.at > 60_000) this.#names = { at: now, map: codexNames(this.d.home) };
    return scan({
      home: this.d.home,
      machine: this.c.machine,
      now,
      herdr: await this.herdr(),
      exec: this.d.exec,
      alive: this.d.alive ?? realAlive,
      recentMs: this.c.recentHours * 3_600_000,
      cache: this.cache,
      codexNames: this.#names.map,
    });
  }

  frame(sessions: MachineSession[]): Record<string, unknown> {
    return { t: "sessions", machine: this.c.machine, at: new Date(this.d.now()).toISOString(), sessions };
  }
}

/**
 * Why a welcome takes back what LB had allowed — the runs going stop with it as their reason — or
 * null: a newer generation, another owner, one behind this machine's, an LB without exec, LB's switch.
 */
export function takenBack(o: WelcomeOutcome, w: Welcome): string | null {
  if (o.kind === "retired") return "retired";
  if (o.kind === "stale") return "stale_generation";
  if (o.kind === "old") return "lb_old";
  if (o.advanced) return "generation_changed";
  return w.exec ? null : "lb_off";
}

/**
 * The long-running loop launchd starts: scan, write the local file, tell LB on change (and each
 * minute). It stops (0) when the process that started it goes away: started through ssh (a headless
 * machine's launchd job runs it as `ssh localhost`, see docs/sessions.md), sshd leaves it running
 * when the connection drops, and launchd would then start a second one. Started by launchd itself
 * its parent is pid 1 and never changes. Whatever the way it was left behind, an older collector
 * also stops once a newer one has written its pid to `collector.pid`, and once node.json names
 * another node (this machine was paired again; launchd starts it again as the new one).
 */
export async function runCollector(c: SessionsConfig, paths: SessionsPaths, d: CollectorDeps): Promise<number> {
  const col = new Collector(c, paths, d);
  const only = execOnly(c, d.env);
  const parent = d.parent ?? (() => process.ppid);
  const sleep =
    d.sleep ??
    ((ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        d.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          r();
        });
      }));
  const startedBy = parent();
  const me = String(d.pid ?? process.pid);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  writePrivate(paths.pid, `${me}\n`);
  const newer = () => {
    try {
      return readFileSync(paths.pid, "utf8").trim() !== me;
    } catch {
      return false;
    }
  };
  let link: LbLink | null = null;
  let gen: Generation | null = null;
  let ledger: EffectLedger | null = null;
  let used: GrantsUsed | null = null;
  let executor: Executor | null = null;
  let ceilingsOf: CeilingSource | null = null;
  /** The last ceiling that read: its runner sweeps after exec went off. */
  let lastCeiling: Ceiling | null = null;
  /** What the last hello said of the caps and the ceiling; another answer now means hello again. */
  let said = "";
  let helloKey: (() => string) | null = null;
  if (c.report) {
    const k = loadNodeKey(c.report, d.exec);
    if ("reason" in k) d.log(`no node key: ${k.reason}; collecting locally only`);
    else {
      const ep = execPaths(paths.dir);
      const g = new Generation({ paths: ep, nodeId: c.report.nodeId, now: d.now, log: d.log });
      gen = g;
      if (g.retired) d.log(`this machine is retired (${ep.retired}): pair it again; collecting locally only`);
      else {
        const bootAt = d.bootAt?.() ?? d.now() - uptime() * 1000;
        const l = EffectLedger.open(ep.effects, { now: d.now, bootAt, log: d.log });
        ledger = l;
        const u = new GrantsUsed(ep.grantsUsed, d.now);
        used = u;
        const ceilings = new CeilingSource({ paths: ep, home: d.home, now: d.now });
        ceilingsOf = ceilings;
        const runners = new Map<string, Runner>();
        const runnerFor =
          d.runner ??
          ((ceiling: Ceiling): Runner => {
            const u = ceiling.file.runner === "user" ? ceiling.file.user : null;
            const key = u ? `user:${u.name}:${u.home}` : ceiling.file.runner;
            let r = runners.get(key);
            if (!r) {
              r =
                ceiling.file.runner === "bwrap"
                  ? new BwrapRunner({ now: d.now, log: d.log })
                  : u
                    ? new UserRunner({
                        user: u,
                        key: join(ep.dir, `${u.name}_ed25519`),
                        knownHosts: join(paths.dir, "known_hosts_local"),
                        now: d.now,
                        log: d.log,
                      })
                    : new SameUserRunner({ now: d.now, log: d.log, exec: d.exec });
              runners.set(key, r);
            }
            return r;
          });
        const x = new Executor({
          ledger: l,
          used: u,
          runnerFor,
          env: d.env,
          now: d.now,
          log: d.log,
          exec: d.exec,
          sendEffect: (r) => link?.sendEffect(r),
          sendChunk: (ch) => link?.sendChunk(ch) ?? false,
          sweepFile: ep.sweep,
        });
        executor = x;
        x.reap();
        // LB's side first (retired, generation, clock, LB's switch), then this machine's ceiling.
        const gate = (): Gate => {
          const x = g.gate();
          if (!x.open) return x;
          const st = ceilings.state();
          return st.exec.on ? x : { open: false, code: "exec_off", reason: st.exec.reason };
        };
        const helloState = () => {
          const st = ceilings.state();
          const ceiling = st.ceiling && { sha: st.ceiling.sha, summary: summary(st.ceiling.file) };
          return { caps: capsFor(st, { execOnly: only }), generation: g.generation, ceiling };
        };
        const keyOf = (h: HelloState) => JSON.stringify([h.caps, h.ceiling?.sha ?? null]);
        helloKey = () => keyOf(helloState());
        // New work: admitted against the ceiling and the grant, then run by the ceiling's runner.
        const take = (call: CallFrame, hash: string) => {
          const st = ceilings.state();
          if (!st.ceiling || !st.exec.on)
            return refuse("exec_off", "", { reason: st.exec.on ? "no_ceiling" : st.exec.reason });
          return x.take(call, hash, {
            ceiling: st.ceiling,
            scan: st.scan,
            nodeId: g.nodeId,
            owner: g.record.owner,
            generation: g.generation,
            lbNow: d.now() + g.skewMs,
            open: () => {
              const now = gate();
              return now.open && now.generation === g.generation;
            },
          });
        };
        link = new LbLink({
          url: c.report.lbUrl,
          nodeId: c.report.nodeId,
          key: k.key,
          machine: c.machine,
          log: d.log,
          onCall: (op, args, call) =>
            isExecOp(op)
              ? answerExec(call, { ledger: l, gate, take })
              : only
                ? refuse("unsupported", "this node runs exec only")
                : answer(op, args, col.cache, col.off),
          onChunk: (ch) => x.chunk(ch),
          hello: () => {
            const h = helloState();
            said = keyOf(h);
            return h;
          },
          onWelcome: (w) => {
            const o = g.onWelcome(w);
            // LB has taken exec back: what runs stops, like on a 4410 — a bump missed while offline,
            // another owner, a generation behind this machine's, an LB without exec, or LB's own
            // switch (the owner takes exec back, LB_NODE_EXEC=0; also a second welcome on a live link).
            // Clocks apart only keep new work out: nothing LB said is taken back.
            const why = takenBack(o, w);
            if (why) {
              const n = x.stopAll(why);
              if (n) d.log(`LB took exec back (${why}); stopping ${n} run(s)`);
            }
            return o.kind !== "retired";
          },
          pending: () => l.pending(g.nodeId).map(report),
          onEffectAck: (id) => void l.ack(id),
          onDown: (code) => {
            g.onLinkDown();
            // A file transfer cannot outlive its link: LB will not send the rest, nor take what is left.
            const t = x.stopTransfers("link_lost");
            if (t) d.log(`the link went; stopping ${t} file transfer(s)`);
            // A lost link leaves runs going (their effects wait for the next welcome). A 4410 or a
            // 4403 stops them; grants need nothing (each names its generation), and the ledger stays.
            if (code === CLOSE_GENERATION) {
              const n = x.stopAll("generation_changed");
              d.log(`LB moved this node to a new generation; ${n ? `stopping ${n} run(s), ` : ""}linking again`);
            } else if (code === CLOSE_REFUSED) {
              // Revoked (or unknown to LB): nothing it asked for goes on.
              const n = x.stopAll("revoked");
              if (n) d.log(`LB refused this node (revoked?); stopping ${n} run(s)`);
            }
          },
          connect: d.connect,
        });
        link.start();
      }
    }
  }
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  let last = "";
  let lastSent = 0;
  for (;;) {
    const why =
      startedBy !== 1 && parent() !== startedBy
        ? "the process that started the collector is gone (ssh closed?)"
        : newer()
          ? "a newer collector has started"
          : d.signal?.aborted
            ? "asked to stop"
            : (gen?.identityChanged() ?? null);
    if (why) {
      d.log(`${why}; stopping`);
      await executor?.shutdown();
      link?.stop();
      return 0;
    }
    ledger?.maintain();
    if (executor && ceilingsOf) {
      const st = ceilingsOf.state();
      if (st.ceiling) lastCeiling = st.ceiling;
      if (!st.exec.on && executor.running) {
        d.log(`exec is off here (${st.exec.reason}); stopping ${executor.running} run(s)`);
        executor.stopAll("exec_off");
      }
      // The sweep goes over ssh: it does not hold up the collection. With exec off (switched off, the
      // ceiling gone or broken) what the stopped runs left is swept all the same, by the last runner.
      void executor.tick(st.exec.on ? st.ceiling : lastCeiling, { off: !st.exec.on });
    }
    used?.prune();
    if (link?.up && helloKey && helloKey() !== said) link.relink();
    if (only) {
      await sleep(Math.max(2, c.intervalSec) * 1000);
      continue;
    }
    const sessions = await col.once().catch((e: Error) => {
      d.log(`scan failed: ${e.message}`);
      return null;
    });
    if (sessions) {
      const body = JSON.stringify(
        sessions.map((s) => ({ ...s, lastActivityAt: s.state === "ended" ? s.lastActivityAt : "" })),
      );
      const now = d.now();
      if (body !== last || now - lastSent > 60_000) {
        last = body;
        lastSent = now;
        const frame = col.frame(sessions);
        if (col.off) rmSync(paths.spool, { force: true });
        else writePrivate(paths.spool, `${JSON.stringify(frame, null, 2)}\n`);
        link?.send(frame);
      }
    }
    await sleep(Math.max(2, c.intervalSec) * 1000);
  }
}
