/**
 * The bridge's own state, one small JSON file (0600, written atomically): who the owner is, where
 * the workbench is, and which Feishu messages and topics belong to which herdr pane — so a reply
 * finds its agent after a restart. The daemon's logs are only an IO record; this is the authority.
 */
import { createHash, randomInt } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DialogOption } from "./screen.ts";
import type { Spawned } from "./spawn.ts";

export interface Owner {
  /** The owner's Feishu id as lark-bot reports senders (a union_id). */
  id: string;
  /** The owner's DM chat with the bot. */
  dmChat: string | null;
  boundAt: number;
}

export interface Workbench {
  chatId: string;
  /** `created`: the bridge made the group; `mention`: the owner named an existing group. */
  via: "created" | "mention";
  setAt: number;
}

/** One herdr pane's conversation in one chat: a topic in the workbench, or messages in the DM. */
export interface Thread {
  /** Ours: in button ids (`herdr:key:<id>:<key>`). */
  id: string;
  paneKey: string;
  paneId: string;
  terminalId: string;
  agent: string;
  place: string;
  chatId: string;
  workbench: boolean;
  /** The first notice: the topic's root. */
  rootMessageId: string;
  /** Feishu's thread id once the topic exists. */
  threadId: string | null;
  /** The choices of the last blocked dialog, to offer again. */
  options: DialogOption[];
  openedAt: number;
  lastAt: number;
  closedAt: number | null;
}

/** A running turn's live card (a process card and thinking bubble updated while it works). */
export interface LiveCard {
  paneKey: string;
  paneId: string;
  /** The working stretch it shows (`Watcher` `workingSince`). */
  stretch: number;
  turnId: string;
  threadId: string;
  messageId: string;
  /** The chat it is in and how to reach it (`ReplyRoute` fields). */
  chatId: string;
  replyTo: string | null;
  topic: string | null;
  operationId: string;
  seq: number;
  startedAt: number;
}

export interface State {
  v: 1;
  owner: Owner | null;
  workbench: Workbench | null;
  /** Why the workbench could not be made, when it could not. */
  workbenchError: string | null;
  threads: Thread[];
  /** Message id → thread id (null: not about one pane), oldest first, capped. */
  messages: [string, string | null][];
  /** Screen cards (and answers under them) → the pane they show, oldest first, capped. */
  views: View[];
  /** Live cards of turns still running (settled ones are removed). */
  live: LiveCard[];
  /** Agents started from a message (config `spawn`), open and lately closed. */
  spawned: Spawned[];
  /** Inbound items already taken (`channelRef`), oldest first, capped: the queue delivers at least once. */
  handled: string[];
}

/** A message about one pane outside its topic: a reply to it is typed into that pane. */
export interface View {
  messageId: string;
  chatId: string;
  paneId: string;
  terminalId: string;
}

const MESSAGES_MAX = 4000;
const VIEWS_MAX = 500;
const HANDLED_MAX = 1000;
/** Closed threads are kept this long, so a late reply still gets a precise answer. */
const CLOSED_KEEP_MS = 14 * 24 * 3600_000;

export const emptyState = (): State => ({
  v: 1,
  owner: null,
  workbench: null,
  workbenchError: null,
  threads: [],
  messages: [],
  views: [],
  live: [],
  spawned: [],
  handled: [],
});

/** Writes `data` to `path` atomically, 0600, in a 0700 directory. */
export function writePrivate(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export class Store {
  readonly path: string;
  state: State;

  constructor(path: string) {
    this.path = path;
    this.state = Store.read(path);
  }

  static read(path: string): State {
    if (!existsSync(path)) return emptyState();
    try {
      const s = JSON.parse(readFileSync(path, "utf8")) as Partial<State>;
      return { ...emptyState(), ...s, v: 1 };
    } catch {
      // A broken file is not worth refusing to start over; the owner can bind again.
      return emptyState();
    }
  }

  save(): void {
    writePrivate(this.path, `${JSON.stringify(this.state, null, 1)}\n`);
  }

  /** Records a message as being about `threadId` (null: about no pane). */
  remember(messageId: string, threadId: string | null): void {
    const m = this.state.messages;
    if (m.some(([id]) => id === messageId)) return;
    m.push([messageId, threadId]);
    if (m.length > MESSAGES_MAX) m.splice(0, m.length - MESSAGES_MAX);
  }

  /** Records a message as being about one pane (a screen card, an answer under one). */
  rememberView(v: View): void {
    const views = this.state.views;
    if (views.some((x) => x.messageId === v.messageId)) return;
    views.push(v);
    if (views.length > VIEWS_MAX) views.splice(0, views.length - VIEWS_MAX);
  }

  /** The pane a message replies to, through a known screen card among `ids`. */
  viewOf(chatId: string, ids: string[]): View | null {
    for (const id of ids) {
      const v = this.state.views.find((x) => x.messageId === id && x.chatId === chatId);
      if (v) return v;
    }
    return null;
  }

  /** True the first time `ref` is seen (and remembers it). */
  firstTime(ref: string): boolean {
    const h = this.state.handled;
    if (h.includes(ref)) return false;
    h.push(ref);
    if (h.length > HANDLED_MAX) h.splice(0, h.length - HANDLED_MAX);
    return true;
  }

  thread(id: string): Thread | null {
    return this.state.threads.find((t) => t.id === id) ?? null;
  }

  /** The thread a message replies into: a known message among `ids`, or a Feishu topic id. */
  threadOf(chatId: string, ids: string[], topic: string | undefined): Thread | null {
    const byId = new Map(this.state.messages);
    for (const id of ids) {
      const tid = byId.get(id);
      const t = tid ? this.thread(tid) : null;
      if (t && t.chatId === chatId) return t;
    }
    if (topic) {
      const t = this.state.threads.find((x) => x.threadId === topic && x.chatId === chatId);
      if (t) return t;
    }
    return null;
  }

  /** The open thread of a pane in a chat. */
  openThread(paneKey: string, chatId: string): Thread | null {
    return this.state.threads.find((t) => t.paneKey === paneKey && t.chatId === chatId && t.closedAt === null) ?? null;
  }

  prune(now: number): void {
    this.state.spawned = this.state.spawned.filter((x) => x.closedAt === null || now - x.closedAt < CLOSED_KEEP_MS);
    const keep = this.state.threads.filter((t) => t.closedAt === null || now - t.closedAt < CLOSED_KEEP_MS);
    if (keep.length === this.state.threads.length) return;
    const ids = new Set(keep.map((t) => t.id));
    this.state.threads = keep;
    this.state.messages = this.state.messages.filter(([, tid]) => tid === null || ids.has(tid));
  }
}

// ---- the owner-binding code -------------------------------------------------------------------

export interface SetupFile {
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

export const SETUP_TTL_MS = 15 * 60_000;
export const SETUP_MAX_ATTEMPTS = 5;

/** Digits only: what a person types back, with or without the dash or spaces. */
export const normalizeCode = (s: string) => s.replace(/[\s-]/g, "");
export const hashCode = (code: string) => createHash("sha256").update(normalizeCode(code)).digest("hex");

/** A new 8-digit code, shown as `1234-5678`. */
export function newCode(): string {
  const n = String(randomInt(0, 100_000_000)).padStart(8, "0");
  return `${n.slice(0, 4)}-${n.slice(4)}`;
}

export function writeSetup(path: string, code: string, now: number): SetupFile {
  const f: SetupFile = { codeHash: hashCode(code), expiresAt: now + SETUP_TTL_MS, attempts: 0 };
  writePrivate(path, `${JSON.stringify(f)}\n`);
  return f;
}

export function readSetup(path: string): SetupFile | null {
  if (!existsSync(path)) return null;
  try {
    const f = JSON.parse(readFileSync(path, "utf8")) as SetupFile;
    return typeof f.codeHash === "string" && typeof f.expiresAt === "number"
      ? { ...f, attempts: f.attempts ?? 0 }
      : null;
  } catch {
    return null;
  }
}

export const clearSetup = (path: string) => rmSync(path, { force: true });
