/**
 * The bridge between herdr and Feishu, as an agents-io host:
 *
 * - every couple of seconds it reads `agent.list`, and the watcher's rules decide what is news
 *   (an agent blocked on a dialog, a long turn finished); each notice goes to the owner's
 *   workbench group, one topic per pane (or to the owner's DM when there is no workbench);
 * - what comes back through the daemon's host queue — the owner's replies in a pane's topic (or
 *   quote-replies in the DM), dialog buttons, a few commands, the owner-binding code — becomes
 *   `agent.prompt` / `agent.send_keys` on that pane, or a short answer.
 *
 * Only the bound owner drives anything; nobody else is answered beyond a polite refusal. No model
 * is involved anywhere: routing is the binding table this host pushes, the rest is code.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import type { Config, SpawnRule } from "./config.ts";
import { type FeishuApi, FeishuError, isScopeError } from "./feishu.ts";
import {
  closeTab,
  createTab,
  createWorkspace,
  type Herdr,
  type HerdrAgent,
  HerdrError,
  type HerdrTab,
  listAgents,
  listPanes,
  listTabs,
  listWorkspaces,
  promptAgent,
  readAgent,
  readPane,
  runInPane,
  sendKeys,
  sendPaneKeys,
  startAgent,
} from "./herdr.ts";
import { type Command, commandOf, type Strings, strings } from "./i18n.ts";
import { progressOf } from "./live.ts";
import {
  ACTION_PREFIX,
  agentName,
  answerPages,
  buttons,
  fence,
  KEY_ACTION,
  keyLabel,
  liveMessage,
  noticeMessages,
  placeOf,
  quietLabel,
  statusMessage,
} from "./notice.ts";
import {
  PANE_KEY_ACTION,
  type PaneCommand,
  paneButtons,
  paneCommandOf,
  panesMessage,
  resolvePane,
  shortId,
  VIEW_ACTION,
  VIEW_LINES,
  viewMessage,
} from "./panes.ts";
import type {
  Binding,
  BindingTable,
  ContentBlock,
  DeliverResult,
  InboundItem,
  RenderedMessage,
  ReplyRoute,
} from "./protocol.ts";
import { redact } from "./redact.ts";
import { type DialogOption, optionsOf, summaryOf, tailOf } from "./screen.ts";
import { lookup, realSecretSource, type SecretSource } from "./secrets.ts";
import {
  firstPrompt,
  type HookRunner,
  hookEnv,
  isClose,
  laterPrompt,
  prepareDir,
  ruleFor,
  runHook,
  type Spawned,
  spawnedFor,
  spawnedRoute,
  startupAnswer,
  topicOf,
  triggered,
} from "./spawn.ts";
import {
  clearSetup,
  hashCode,
  type LiveCard,
  normalizeCode,
  readSetup,
  SETUP_MAX_ATTEMPTS,
  type Store,
  type Thread,
  writePrivate,
} from "./store.ts";
import { minuteOfDay } from "./system.ts";
import type { TranscriptSource, Turn } from "./transcript.ts";
import { inQuiet, type Notice, type PaneView, paneKey, Watcher } from "./watch.ts";

export const CHANNEL = "lark-bot";
export const CONSUMER = "herdr";
export const HOST_NAME = "agents-io-herdr";
const PROMPT_MAX = 8000;
const READ_LINES = 80;
const DONE_READ_LINES = 300;
const SCREEN_LINES = 20;
/** A notice that could not be sent is retried for this long, then dropped. */
const SEND_TTL_MS = 30 * 60_000;

/** What the bridge needs of the daemon connection (AioClient, or a fake). */
export interface AioPort {
  readonly online: boolean;
  /** The last `host.hello` answer (its `features`), when connected. */
  readonly hello?: { features?: string[] } | null;
  request<T>(type: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export interface BridgeOptions {
  config: Config;
  machine: string;
  herdr: Herdr;
  aio: AioPort;
  /** The app's REST client; null: the workbench cannot be created automatically. */
  feishu: FeishuApi | null;
  store: Store;
  /** Agents' own transcripts (the whole turn); none: notices show the screen only. */
  transcripts?: TranscriptSource;
  /** Where `spawn` environment values (`env:…`, `keychain:…`) are looked up. */
  secrets?: SecretSource;
  /** Runs `spawn` hooks (tests replace it). */
  runHook?: HookRunner;
  /** Waiting between polls (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  idleMs?: () => number | null;
  log?: (msg: string) => void;
}

interface PendingNotice {
  notice: Notice;
  screen: string | null;
  turn: Turn | null;
  options: DialogOption[];
  operationId: string;
  /** The id a new thread for this pane gets (fixed, so a retried send carries the same buttons). */
  newThreadId: string;
  firstAt: number;
  nextAt: number;
  tries: number;
}

interface Destination {
  chatId: string;
  workbench: boolean;
}

/** The pane a topic or a screen card is about: the same program only. */
interface PaneRef {
  paneId: string;
  terminalId: string;
}

/** How an answer about a pane goes back: in a pane's topic, or under the message it answers. */
interface PaneReply {
  topic: boolean;
  /** `about`: a reply to this answer reaches that pane. */
  send(message: RenderedMessage, about: HerdrAgent | null): Promise<void>;
  /** It worked: a reaction on the owner's message (`text` when there is none, or it cannot be put). */
  done(text: string, about: HerdrAgent): Promise<void>;
}

/** The reaction that says "sent" on the owner's message (Feishu's emoji list). */
const ACK_EMOJI = "DONE";

const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newId = () => randomBytes(6).toString("hex");

const textOf = (content: ContentBlock[] | undefined) =>
  (content ?? [])
    .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

/** The Feishu message ids a message replies to: its topic root, its parent, a quoted message. */
export function repliedTo(item: InboundItem): string[] {
  const ids = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v) ids.add(v);
  };
  const cc = item.input.channelContext ?? {};
  add(cc.parentMessageId);
  add(item.envelope.parentMessageId);
  add(cc.rootMessageId);
  add(item.envelope.rootMessageId);
  for (const c of item.envelope.content ?? []) if (c.type === "quote") add(c.fromMessageId);
  return [...ids];
}

function actionOf(item: InboundItem): { actionId: string; messageId: string | null } | null {
  for (const c of item.envelope.content ?? []) {
    if (c.type === "event" && c.name === "action" && typeof c.data.actionId === "string") {
      return { actionId: c.data.actionId, messageId: typeof c.data.messageId === "string" ? c.data.messageId : null };
    }
  }
  return null;
}

export class Bridge {
  readonly #o: BridgeOptions;
  readonly #c: Config;
  readonly #s: Strings;
  readonly #watcher: Watcher;
  readonly #now: () => number;
  #queue: PendingNotice[] = [];
  #pushed: string | null = null;
  #inbox: Promise<void> = Promise.resolve();
  #herdrDown = false;
  #lastPrune = 0;
  #noOwnerLogged = false;
  /** Reactions were refused for want of the scope: answers are words until a restart. */
  #noReactions = false;
  /** Live cards: when each was last updated and what it showed (by turn id). */
  #liveShown = new Map<string, { at: number; json: string }>();
  /** Spawned agents whose waiting dialog was put in their place already (until it closes). */
  #asked = new Set<string>();
  /** When each spawned agent's progress was last edited. */
  #spawnShown = new Map<string, number>();
  /** Panes whose live card was settled lately, by pane key → chat: a done notice there points at it. */
  #liveSettled = new Map<string, { chatId: string; at: number }>();

  constructor(o: BridgeOptions) {
    this.#o = o;
    this.#c = o.config;
    this.#s = strings(o.config.locale);
    this.#watcher = new Watcher(o.config.rules);
    this.#now = o.now ?? Date.now;
  }

  get store(): Store {
    return this.#o.store;
  }

  #log(msg: string): void {
    this.#o.log?.(msg);
  }

  get paused(): boolean {
    return existsSync(this.#c.paths.pauseFile);
  }

  // ---- the binding table ---------------------------------------------------------------------

  #setupPending(): boolean {
    const f = readSetup(this.#c.paths.setupFile);
    if (!f) return false;
    if (f.expiresAt <= this.#now() || f.attempts >= SETUP_MAX_ATTEMPTS) {
      clearSetup(this.#c.paths.setupFile);
      this.#log("setup: the code expired");
      return false;
    }
    return true;
  }

  /**
   * What the daemon routes to this host; everything else matches nothing and is dropped. Kept
   * while the host is away (`onHostDown: keep`): the owner's replies wait in the durable queue.
   */
  bindingTable(): BindingTable {
    const ch = { channel: CHANNEL, account: this.#c.account };
    const { owner, workbench } = this.store.state;
    const b: Binding[] = [
      { id: "herdr:buttons", match: { ...ch, actionPrefix: ACTION_PREFIX }, on: "host", note: "dialog buttons" },
    ];
    if (owner) {
      b.push({
        id: "herdr:owner-dm",
        match: { ...ch, conversationKind: "dm", senders: [owner.id] },
        on: "host",
        note: "the owner's DM",
      });
    }
    if (this.#setupPending()) {
      b.push({
        id: "herdr:setup-dm",
        match: { ...ch, conversationKind: "dm" },
        on: "host",
        note: "owner binding code",
      });
    }
    if (workbench) {
      b.push({
        id: "herdr:workbench",
        match: { ...ch, conversation: workbench.chatId },
        on: "host",
        note: "workbench",
      });
    }
    if (owner) {
      b.push({
        id: "herdr:owner-mention",
        match: { ...ch, conversationKind: "group", senders: [owner.id], mentions: ["self"] },
        on: "host",
        note: "the owner @-mentioning the bot in a group",
      });
    }
    // Agents started from a message: the owner's trigger (the channel hints `dispatch`), and in a
    // topic (or a group) where one of them runs, what the owner says next.
    for (const r of this.#c.spawn) {
      const m = { channel: r.channel, account: r.account, senders: [r.owner] };
      b.push({
        id: `herdr:spawn:${r.id}`,
        match: { ...m, mentions: ["self"] },
        on: "host",
        note: `${r.id}: the trigger`,
      });
      const where = new Set(
        this.store.state.spawned.filter((x) => x.rule === r.id && x.closedAt === null).map((x) => x.conversationId),
      );
      for (const conversation of [...where].sort()) {
        b.push({
          id: `herdr:spawn:${r.id}:${sha(conversation).slice(0, 8)}`,
          match: { ...m, conversation },
          on: "host",
          note: `${r.id}: a running agent's chat`,
        });
      }
    }
    const identities = owner
      ? [{ channel: CHANNEL, channelUserId: owner.id, principal: "owner", labels: ["owner"] }]
      : [];
    const body = { bindings: b, identities, onHostDown: "keep" as const };
    return { version: `h-${sha(JSON.stringify(body)).slice(0, 16)}`, ...body };
  }

  /** Pushes the table when it changed since the last push (or `force`, after a reconnect). */
  async pushBindings(force = false): Promise<void> {
    if (!this.#o.aio.online) return;
    const table = this.bindingTable();
    if (!force && table.version === this.#pushed) return;
    try {
      await this.#o.aio.request("bindings.put", { table });
      this.#pushed = table.version;
      this.#log(`bindings ${table.version}: ${table.bindings.map((x) => x.id).join(", ")}`);
    } catch (e) {
      this.#log(`bindings.put failed: ${(e as Error).message}`);
    }
  }

  // ---- watching herdr ------------------------------------------------------------------------

  /** One round: read herdr, decide, send. */
  async tick(): Promise<void> {
    const now = this.#now();
    await this.pushBindings();
    let agents: HerdrAgent[] | null = null;
    try {
      agents = await listAgents(this.#o.herdr);
      if (this.#herdrDown) this.#log("herdr is back");
      this.#herdrDown = false;
    } catch (e) {
      if (!this.#herdrDown) this.#log(`cannot read herdr: ${(e as Error).message}`);
      this.#herdrDown = true;
    }
    if (agents) {
      const notices = this.#watcher.tick({
        agents,
        now,
        idleMs: this.#o.idleMs?.() ?? null,
        minuteOfDay: minuteOfDay(new Date(now), this.#c.timeZone),
      });
      await this.#closeGone(agents);
      await this.#followSpawned(agents, now);
      await this.#live(agents, now);
      const paused = this.paused;
      const spawnedPanes = new Set(
        this.store.state.spawned.filter((x) => x.closedAt === null).map((x) => `${x.paneId}|${x.terminalId}`),
      );
      for (const n of notices.filter((x) => x.kind === "overnight" || !spawnedPanes.has(paneKey(x.agent)))) {
        this.#log(
          `${n.kind}${n.kind === "overnight" ? ` x${n.items.length}` : ` ${n.agent.pane_id}`}${paused ? " (paused: dropped)" : ""}`,
        );
        if (!paused) await this.#enqueue(n, now);
      }
    }
    if (this.paused && this.#queue.length) {
      this.#log(`paused: dropping ${this.#queue.length} unsent notice(s)`);
      this.#queue.length = 0;
    }
    await this.#flush(now);
    if (now - this.#lastPrune > 3600_000) {
      this.#lastPrune = now;
      this.store.prune(now);
      this.store.save();
    }
  }

  async #enqueue(n: Notice, now: number): Promise<void> {
    let screen: string | null = null;
    let options: DialogOption[] = [];
    let turn: Turn | null = null;
    if (n.kind !== "overnight") {
      try {
        // A dialog is at the bottom; a finished turn's conclusion is at the start of its last message.
        const raw = await readAgent(this.#o.herdr, n.agent.pane_id, n.kind === "done" ? DONE_READ_LINES : READ_LINES);
        screen = n.kind === "done" ? summaryOf(raw, SCREEN_LINES) : tailOf(raw, SCREEN_LINES);
        if (n.kind === "blocked") options = optionsOf(screen);
      } catch (e) {
        this.#log(`reading ${n.agent.pane_id} failed: ${(e as Error).message}`);
      }
      try {
        turn = (await this.#o.transcripts?.turn(n.agent)) ?? null;
      } catch (e) {
        this.#log(`reading the transcript of ${n.agent.pane_id} failed: ${(e as Error).message}`);
      }
    }
    const subject = n.kind === "overnight" ? "overnight" : `${n.agent.terminal_id}:${n.kind}`;
    this.#queue.push({
      notice: n,
      screen,
      turn,
      options,
      operationId: `herdr:n:${sha(`${this.#o.machine}\n${subject}\n${now}`).slice(0, 32)}`,
      newThreadId: newId(),
      firstAt: now,
      nextAt: now,
      tries: 0,
    });
  }

  /** Where notices go: the workbench, else the owner's DM (also the fallback when the workbench refuses). */
  #destinations(): Destination[] {
    const { owner, workbench } = this.store.state;
    const out: Destination[] = [];
    if (workbench) out.push({ chatId: workbench.chatId, workbench: true });
    if (owner?.dmChat) out.push({ chatId: owner.dmChat, workbench: false });
    return out;
  }

  #route(chatId: string, extra: Partial<ReplyRoute> = {}): ReplyRoute {
    return { channel: CHANNEL, account: this.#c.account, conversationId: chatId, ...extra };
  }

  /** Into a pane's thread: its workbench topic (replying to `to`, else its root), or the DM. */
  #threadRoute(t: Thread, to?: string | null): ReplyRoute {
    if (t.workbench)
      return this.#route(t.chatId, { threadId: t.threadId ?? "topic", replyToMessageId: to ?? t.rootMessageId });
    return to ? this.#route(t.chatId, { replyToMessageId: to }) : this.#route(t.chatId);
  }

  async #deliver(operationId: string, route: ReplyRoute, message: RenderedMessage): Promise<DeliverResult> {
    return await this.#o.aio.request<DeliverResult>("deliver", { operationId, route, message }, 60_000);
  }

  async #flush(now: number): Promise<void> {
    for (const p of [...this.#queue]) {
      if (p.nextAt > now) continue;
      const drop = () => this.#queue.splice(this.#queue.indexOf(p), 1);
      if (!this.#destinations().length) {
        if (!this.#noOwnerLogged) this.#log(`nowhere to send notices: ${this.#s.noDestination}`);
        this.#noOwnerLogged = true;
        drop();
        continue;
      }
      try {
        if (await this.#sendNotice(p, now)) drop();
        else throw new Error("every destination refused it");
      } catch (e) {
        p.tries++;
        p.nextAt = now + Math.min(300_000, 5000 * 2 ** p.tries);
        this.#log(`notice ${p.operationId} not sent (try ${p.tries}): ${(e as Error).message}`);
        if (now - p.firstAt > SEND_TTL_MS) {
          drop();
          this.#log(`gave up on ${p.operationId}`);
        }
      }
    }
  }

  /** True once delivered somewhere; throws when the daemon cannot be asked (retried later). */
  async #sendNotice(p: PendingNotice, now: number): Promise<boolean> {
    const n = p.notice;
    const st = this.store;
    for (const d of this.#destinations()) {
      const operationId = `${p.operationId}:${sha(d.chatId).slice(0, 8)}`;
      if (n.kind === "overnight") {
        const [msg] = noticeMessages(n, this.#view(p, d, null)) as [RenderedMessage];
        const r = await this.#deliver(operationId, this.#route(d.chatId), msg);
        if (r.status === "rejected") {
          this.#log(`overnight list refused in ${d.workbench ? "the workbench" : "the DM"}: ${r.error ?? ""}`);
          continue;
        }
        if (r.providerMessageId) st.remember(r.providerMessageId, null);
        st.save();
        return true;
      }
      const a = n.agent;
      const thread = st.openThread(paneKey(a), d.chatId);
      const threadId = thread?.id ?? p.newThreadId;
      const [msg, ...more] = noticeMessages(n, this.#view(p, d, threadId)) as [RenderedMessage, ...RenderedMessage[]];
      const { r, thread: t } = await this.#toPane(a, d, msg, operationId, threadId, now);
      if (r.status === "rejected") {
        this.#log(`notice for ${a.pane_id} refused in ${d.workbench ? "the workbench" : "the DM"}: ${r.error ?? ""}`);
        continue;
      }
      if (t && n.kind === "blocked") t.options = p.options;
      st.save();
      if (r.status === "unknown") this.#log(`notice ${operationId}: outcome unknown (not sent again)`);
      if (t && more.length) await this.#sendMore(t, operationId, more);
      return true;
    }
    return false;
  }

  /**
   * A message about a pane into its thread in `d`: a reply in its open thread, or the root of a
   * new one (`threadId`). The thread is recorded once the message is there (not saved here).
   */
  async #toPane(
    a: HerdrAgent,
    d: Destination,
    msg: RenderedMessage,
    operationId: string,
    threadId: string,
    now: number,
  ): Promise<{ r: DeliverResult; thread: Thread | null; route: ReplyRoute }> {
    const st = this.store;
    const key = paneKey(a);
    const thread = st.openThread(key, d.chatId);
    const route = thread ? this.#threadRoute(thread) : this.#route(d.chatId);
    const r = await this.#deliver(operationId, route, msg);
    if (r.status === "rejected") return { r, thread, route };
    const mid = r.providerMessageId;
    let t = thread;
    if (!t && mid) {
      t = {
        id: threadId,
        paneKey: key,
        paneId: a.pane_id,
        terminalId: a.terminal_id,
        agent: agentName(a),
        place: placeOf(a),
        chatId: d.chatId,
        workbench: d.workbench,
        rootMessageId: mid,
        threadId: d.workbench ? (r.providerThreadId ?? null) : null,
        options: [],
        openedAt: now,
        lastAt: now,
        closedAt: null,
      };
      st.state.threads.push(t);
    }
    if (t) {
      t.lastAt = now;
      if (t.workbench && !t.threadId && r.providerThreadId) t.threadId = r.providerThreadId;
      if (mid) st.remember(mid, t.id);
    }
    return { r, thread: t, route };
  }

  // ---- live cards ----------------------------------------------------------------------------

  /** The daemon can edit what this host sent (agents-io `deliver.update`). */
  #canUpdate(): boolean {
    return this.#o.aio.hello?.features?.includes("deliver.update") ?? false;
  }

  /**
   * Live cards, once per tick: a long working stretch gets one (the transcript's process as
   * Feishu's thinking bubble), it follows the transcript while the stretch lasts, and is
   * settled with the answer when it ends (or the pane goes).
   */
  async #live(agents: HerdrAgent[], now: number): Promise<void> {
    const cfg = this.#c.live;
    const src = this.#o.transcripts;
    if (!cfg || !src || !this.#o.aio.online || !this.#canUpdate()) return;
    for (const [k, v] of this.#liveSettled) if (now - v.at > 10 * 60_000) this.#liveSettled.delete(k);
    const views = new Map(this.#watcher.snapshot().map((v) => [v.key, v]));
    const byKey = new Map(agents.filter((a) => a.agent).map((a) => [paneKey(a), a]));
    const st = this.store.state;
    for (const card of [...st.live]) {
      const a = byKey.get(card.paneKey);
      const v = views.get(card.paneKey);
      // A card from before a restart whose pane still works: this process carries it on (the watcher's stretch is new).
      if (a && v && v.workingSince !== null && !this.#liveShown.has(card.turnId)) {
        card.stretch = v.workingSince;
        this.#liveShown.set(card.turnId, { at: 0, json: "" });
        this.store.save();
      }
      if (!a || !v || v.workingSince !== card.stretch) await this.#settleLive(card, a ?? null, now);
      else if (now - (this.#liveShown.get(card.turnId)?.at ?? 0) >= cfg.everyMs) await this.#updateLive(card, a, now);
    }
    if (this.paused || inQuiet(this.#c.rules, minuteOfDay(new Date(now), this.#c.timeZone))) return;
    const idleMs = this.#o.idleMs?.() ?? null;
    const spawned = new Set(st.spawned.filter((x) => x.closedAt === null).map((x) => `${x.paneId}|${x.terminalId}`));
    for (const a of byKey.values()) {
      const v = views.get(paneKey(a));
      if (!v || v.workingSince === null || now - v.workingSince < cfg.afterMs) continue;
      if (spawned.has(v.key)) continue;
      if (a.agent_status !== "working" && a.agent_status !== "blocked") continue;
      if (st.live.some((c) => c.paneKey === v.key)) continue;
      // Someone looking at the pane does not need it on the phone.
      if (idleMs !== null && idleMs < this.#c.rules.presentIdleMs && a.focused) continue;
      await this.#openLive(a, v, now);
    }
  }

  #liveStatus(a: HerdrAgent | null): "running" | "requires_action" {
    return a?.agent_status === "blocked" ? "requires_action" : "running";
  }

  async #openLive(a: HerdrAgent, v: PaneView, now: number): Promise<void> {
    let turn: Turn | null = null;
    try {
      turn = (await this.#o.transcripts?.turn(a)) ?? null;
    } catch (e) {
      this.#log(`reading the transcript of ${a.pane_id} failed: ${(e as Error).message}`);
    }
    // Nothing to follow (no transcript, or not written yet): the done notice will do.
    if (!turn) return;
    const stretch = v.workingSince as number;
    const turnId = `herdr-${sha(`${this.#o.machine}\n${v.key}\n${stretch}`).slice(0, 24)}`;
    const operationId = `herdr:live:${turnId}`;
    const progress = progressOf(turn, { turnId, status: this.#liveStatus(a), startedAt: stretch });
    for (const d of this.#destinations()) {
      const msg = liveMessage(a, turn, { machine: this.#o.machine, s: this.#s, topic: d.workbench, progress });
      const threadId = this.store.openThread(v.key, d.chatId)?.id ?? newId();
      try {
        const { r, route } = await this.#toPane(
          a,
          d,
          msg,
          `${operationId}:${sha(d.chatId).slice(0, 8)}`,
          threadId,
          now,
        );
        if (r.status === "rejected" || !r.providerMessageId) {
          this.#log(
            `live card for ${a.pane_id} refused in ${d.workbench ? "the workbench" : "the DM"}: ${r.error ?? ""}`,
          );
          continue;
        }
        const card: LiveCard = {
          paneKey: v.key,
          paneId: a.pane_id,
          stretch,
          turnId,
          threadId,
          messageId: r.providerMessageId,
          chatId: route.conversationId,
          replyTo: route.replyToMessageId ?? null,
          topic: route.threadId ?? null,
          operationId,
          seq: 0,
          startedAt: now,
        };
        this.store.state.live.push(card);
        this.store.save();
        this.#liveShown.set(turnId, { at: now, json: JSON.stringify(progress.steps) });
        this.#log(`live card for ${a.pane_id} opened`);
        return;
      } catch (e) {
        this.#log(`live card for ${a.pane_id} not sent: ${(e as Error).message}`);
        return;
      }
    }
  }

  #liveRoute(c: LiveCard): ReplyRoute {
    return this.#route(c.chatId, {
      ...(c.topic ? { threadId: c.topic } : {}),
      ...(c.replyTo ? { replyToMessageId: c.replyTo } : {}),
    });
  }

  async #update(c: LiveCard, message: RenderedMessage, final: boolean): Promise<{ status: string; error?: string }> {
    c.seq++;
    return await this.#o.aio.request<{ status: string; error?: string }>(
      "deliver.update",
      {
        operationId: final ? `${c.operationId}:final` : `${c.operationId}:u${c.seq}`,
        route: this.#liveRoute(c),
        providerMessageId: c.messageId,
        message,
        sequence: c.seq,
        ...(final ? { final: true } : {}),
      },
      60_000,
    );
  }

  async #updateLive(c: LiveCard, a: HerdrAgent, now: number): Promise<void> {
    let turn: Turn | null = null;
    try {
      turn = (await this.#o.transcripts?.turn(a)) ?? null;
    } catch {
      return;
    }
    const progress = progressOf(turn, { turnId: c.turnId, status: this.#liveStatus(a), startedAt: c.stretch });
    const json = JSON.stringify([progress.status, progress.steps]);
    const shown = this.#liveShown.get(c.turnId);
    this.#liveShown.set(c.turnId, { at: now, json: shown?.json ?? "" });
    if (shown?.json === json) return;
    const msg = liveMessage(a, turn, { machine: this.#o.machine, s: this.#s, topic: !!c.topic, progress });
    try {
      const r = await this.#update(c, msg, false);
      if (r.status === "rejected") this.#log(`live card for ${c.paneId}: update refused: ${r.error ?? ""}`);
      this.#liveShown.set(c.turnId, { at: now, json });
    } catch (e) {
      this.#log(`live card for ${c.paneId}: update failed: ${(e as Error).message}`);
    }
  }

  /** The stretch ended (or the pane went): the card's last state, its answer and the bubble closed. */
  async #settleLive(c: LiveCard, a: HerdrAgent | null, now: number): Promise<void> {
    let turn: Turn | null = null;
    try {
      if (a) turn = (await this.#o.transcripts?.turn(a)) ?? null;
    } catch {
      // the card settles with what it showed
    }
    // A card from before a restart: this process did not see its stretch end, so it cannot say it finished.
    const seen = this.#liveShown.has(c.turnId);
    const answer = !a ? this.#s.ended : !seen ? this.#s.liveLost : turn?.answer.trim() ? redact(turn.answer).text : "";
    const progress = progressOf(turn, {
      turnId: c.turnId,
      status: a && seen ? "completed" : "interrupted",
      startedAt: c.stretch,
      endedAt: now,
      answer,
    });
    const msg = liveMessage(a ?? ({ pane_id: c.paneId, agent: null } as HerdrAgent), turn, {
      machine: this.#o.machine,
      s: this.#s,
      topic: !!c.topic,
      progress,
    });
    try {
      const r = await this.#update(c, msg, true);
      if (r.status === "rejected") this.#log(`live card for ${c.paneId}: settling refused: ${r.error ?? ""}`);
    } catch (e) {
      // The daemon is away: try again next tick.
      this.#log(`live card for ${c.paneId}: settling failed: ${(e as Error).message}`);
      return;
    }
    const st = this.store.state;
    st.live = st.live.filter((x) => x !== c);
    this.store.save();
    this.#liveShown.delete(c.turnId);
    this.#liveSettled.set(c.paneKey, { chatId: c.chatId, at: now });
    this.#log(`live card for ${c.paneId} settled`);
  }

  // ---- agents started from a message (config `spawn`) ----------------------------------------

  async #onSpawnChannel(rule: SpawnRule, item: InboundItem): Promise<void> {
    const env = item.envelope;
    const st = this.store.state;
    // The trigger starts a new agent (also in a topic that has one: the owner asked for another).
    const t = triggered(rule, item);
    if (t.start) {
      await this.#mark(item, "working");
      return this.#spawn(rule, t.item);
    }
    const target =
      spawnedFor(st.spawned, item, repliedTo(item)) ?? (env.conversation.kind === "dm" ? this.#latestIn(item) : null);
    if (!target) return;
    const text = laterPrompt(item);
    if (!text) return;
    if (isClose(textOf(env.content))) return this.#closeSpawned(target, item);
    await this.#mark(item, "working");
    const s = this.#s;
    const pane = this.#spawnedPane(target);
    const say = async (t: string) => {
      await this.#spawnSay(target, { text: t }, `herdr:sp:${sha(item.channelRef).slice(0, 24)}`, env.id);
    };
    const a = await pane;
    if (!a) return say(s.spawnGone);
    // A waiting dialog: a number or esc picks; anything else is not typed into it.
    const key = /^\s*([1-9]|esc)\s*$/i.exec(textOf(env.content))?.[1]?.toLowerCase();
    const keyed = a.agent_status === "blocked" && key !== undefined;
    try {
      if (keyed) await sendKeys(this.#o.herdr, target.paneId, [key]);
      else await promptAgent(this.#o.herdr, target.paneId, text);
    } catch (e) {
      const code = e instanceof HerdrError ? e.code : "error";
      if (code === "agent_blocked") return this.#spawnAskChoice(target, env.id);
      return say(s.failed(code));
    }
    target.turnAt ??= this.#now();
    target.lastAt = this.#now();
    if (!keyed) this.#markedBy(target, item);
    this.store.save();
    this.#log(`spawn ${target.id}: ${keyed ? "key" : `prompt (${text.length} chars)`}`);
  }

  /**
   * The channel's mark on the owner's message (a reaction where the channel has one): `working`
   * when taken, `done` / `failed` / `none` later. Cosmetic: a daemon without `message.ack` or a
   * channel without marks changes nothing.
   */
  async #mark(item: InboundItem, state: "working" | "done" | "failed" | "none"): Promise<void> {
    const env = item.envelope;
    if (env.replyRoute) await this.#markMessage(env.replyRoute, env.id, state);
  }

  async #markMessage(
    route: ReplyRoute,
    messageId: string,
    state: "working" | "done" | "failed" | "none",
  ): Promise<void> {
    if (!this.#o.aio.hello?.features?.includes("message.ack")) return;
    try {
      await this.#o.aio.request("message.ack", { route, messageId, state }, 15_000);
    } catch (e) {
      this.#log(`mark ${state} on ${route.channel} message: ${(e as Error).message}`);
    }
  }

  /** The owner's message joins the turn under way (its mark turns done with the answer). */
  #markedBy(sp: Spawned, item: InboundItem): void {
    const route = item.envelope.replyRoute;
    if (!route) return;
    sp.marked = [...(sp.marked ?? []), { route, messageId: item.envelope.id }].slice(-20);
  }

  /** In a direct conversation without topics: the newest agent running there. */
  #latestIn(item: InboundItem): Spawned | null {
    const env = item.envelope;
    return (
      this.store.state.spawned
        .filter(
          (x) =>
            x.closedAt === null &&
            x.channel === env.channel &&
            x.account === env.account &&
            x.conversationId === env.conversation.id,
        )
        .at(-1) ?? null
    );
  }

  /** The owner's `/close`: the agent's tab closes, its turn (if any) settles, the chat is not routed for it any more. */
  async #closeSpawned(sp: Spawned, item: InboundItem): Promise<void> {
    const now = this.#now();
    try {
      // Agents started before tabs were recorded: the tab of their pane.
      const tab =
        sp.tabId ??
        (await listPanes(this.#o.herdr)).find((p) => p.pane_id === sp.paneId && p.terminal_id === sp.terminalId)
          ?.tab_id;
      if (tab) await closeTab(this.#o.herdr, tab);
    } catch (e) {
      this.#log(`spawn ${sp.id}: closing its tab failed: ${(e as Error).message}`);
    }
    sp.closedAt = now;
    for (const m of sp.marked ?? []) await this.#markMessage(m.route, m.messageId, "none");
    sp.marked = [];
    this.store.save();
    this.#log(`spawn ${sp.id}: closed by the owner`);
    await this.#mark(item, "done");
    await this.#spawnSay(sp, { text: this.#s.spawnClosed }, `herdr:sp:${sp.id}:closed`, item.envelope.id);
    await this.pushBindings();
  }

  /** The agent's pane, if it still runs the same program. */
  async #spawnedPane(sp: Spawned): Promise<HerdrAgent | null> {
    try {
      const a = (await listAgents(this.#o.herdr)).find(
        (x) => x.pane_id === sp.paneId && x.terminal_id === sp.terminalId,
      );
      return a ?? null;
    } catch {
      return null;
    }
  }

  #envOf(rule: SpawnRule): Record<string, string> {
    const src = this.#o.secrets ?? realSecretSource(process.env);
    const out: Record<string, string> = {};
    for (const [k, ref] of Object.entries(rule.env)) {
      const r = lookup([ref], src);
      if (!r.ok) throw new Error(`${k}: ${r.reason}`);
      out[k] = r.value;
    }
    return out;
  }

  async #spawn(rule: SpawnRule, item: InboundItem): Promise<void> {
    const env = item.envelope;
    const now = this.#now();
    const id = newId();
    const op = `herdr:sp:${sha(item.channelRef).slice(0, 24)}`;
    const route: ReplyRoute = {
      channel: env.channel,
      account: env.account,
      conversationId: env.conversation.id,
      ...(env.conversation.threadId ? { threadId: env.conversation.threadId } : {}),
      replyToMessageId: env.id,
    };
    if (this.paused) {
      await this.#deliver(`${op}:paused`, route, { text: this.#s.paused }).catch(() => undefined);
      return;
    }
    let paneId: string;
    let terminalId: string;
    let tabId: string | undefined;
    let label = `${rule.id}-${id.slice(0, 4)}`;
    try {
      const dir = prepareDir(rule, id);
      const env = this.#envOf(rule);
      for (const [i, hook] of rule.before.entries()) {
        const r = await (this.#o.runHook ?? runHook)(hook, {
          cwd: dir,
          env: { ...env, ...hookEnv(rule, item, dir, id) },
        });
        if (r.code === 0) continue;
        const why = `hook ${i + 1} (${basename(hook.run[0] ?? "")}) ${r.code === null ? "did not finish" : `exited ${r.code}`}`;
        this.#log(`spawn ${rule.id}: ${why}: ${oneLine(r.output).slice(-300)}`);
        if (hook.required) throw new Error(`${why}: ${oneLine(r.output).slice(-200)}`);
      }
      const h = this.#o.herdr;
      const ws = (await listWorkspaces(h)).find((w) => w.label === rule.workspace);
      const opened = ws
        ? await createTab(h, { workspaceId: ws.workspace_id, label, cwd: dir, env })
        : await (async () => {
            // The workspace's own first tab has no environment of its own: a tab in it does.
            const w = await createWorkspace(h, { label: rule.workspace, cwd: dir });
            return await createTab(h, {
              workspaceId: w.workspace.workspace_id,
              label,
              cwd: dir,
              env: this.#envOf(rule),
            });
          })();
      paneId = opened.root_pane.pane_id;
      tabId = opened.tab.tab_id;
      label = opened.tab.label || label;
      await startAgent(h, {
        name: `${rule.id}-${id}`,
        kind: rule.kind,
        paneId,
        args: rule.args,
        onDialog: startupAnswer,
        ...(this.#o.sleep ? { sleep: this.#o.sleep } : {}),
      });
      const a = (await listAgents(h)).find((x) => x.pane_id === paneId);
      terminalId = a?.terminal_id ?? opened.root_pane.terminal_id;
      await promptAgent(h, paneId, firstPrompt(rule, item, now));
    } catch (e) {
      const why = e instanceof HerdrError ? `${e.code}: ${e.message}` : (e as Error).message;
      this.#log(`spawn ${rule.id} failed: ${why}`);
      await this.#mark(item, "failed");
      await this.#deliver(`${op}:failed`, route, { text: this.#s.spawnFailed(why) }).catch(() => undefined);
      return;
    }
    const sp: Spawned = {
      id,
      rule: rule.id,
      paneId,
      terminalId,
      ...(tabId ? { tabId } : {}),
      channel: env.channel,
      account: env.account,
      conversationId: env.conversation.id,
      topic: topicOf(item),
      startMessageId: env.id,
      sent: [],
      progressId: null,
      progressSeq: 0,
      turnAt: now,
      sawWork: false,
      ...(env.replyRoute ? { marked: [{ route: env.replyRoute, messageId: env.id }] } : {}),
      startedAt: now,
      lastAt: now,
      closedAt: null,
    };
    this.store.state.spawned.push(sp);
    this.store.save();
    this.#log(`spawn ${rule.id}: agent ${id} in ${paneId}`);
    await this.pushBindings();
    await this.#spawnProgress(sp, this.#s.spawnStarted(`herdr ${rule.workspace}/${label} (${paneId})`), false, env.id);
  }

  /** A message from the agent into its place; remembered so a reply to it reaches the agent. */
  async #spawnSay(sp: Spawned, msg: RenderedMessage, operationId: string, replyTo?: string): Promise<string | null> {
    try {
      const r = await this.#deliver(operationId, spawnedRoute(sp, replyTo), msg);
      if (r.status === "rejected") {
        this.#log(`spawn ${sp.id}: message refused: ${r.error ?? ""}`);
        return null;
      }
      if (r.providerMessageId) {
        sp.sent.push(r.providerMessageId);
        if (sp.sent.length > 200) sp.sent.splice(0, sp.sent.length - 200);
      }
      this.store.save();
      return r.providerMessageId ?? null;
    } catch (e) {
      this.#log(`spawn ${sp.id}: message not sent: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * The turn's progress message: sent once, then edited (where the daemon can edit what it sent);
   * `final` settles it with the answer. Without editing, only the first and the final go out.
   */
  async #spawnProgress(sp: Spawned, text: string, final: boolean, replyTo?: string): Promise<void> {
    const base = `herdr:sp:${sp.id}:t${sp.startedAt}:${sp.turnAt ?? 0}`;
    if (sp.progressId && this.#canUpdate()) {
      sp.progressSeq++;
      try {
        const r = await this.#o.aio.request<{ status: string; error?: string }>(
          "deliver.update",
          {
            operationId: final ? `${base}:final` : `${base}:u${sp.progressSeq}`,
            route: spawnedRoute(sp),
            providerMessageId: sp.progressId,
            message: { text },
            sequence: sp.progressSeq,
            ...(final ? { final: true } : {}),
          },
          60_000,
        );
        // A refused edit answers status "rejected" (not an error): the answer must still go out.
        if (r.status === "delivered") return;
        this.#log(`spawn ${sp.id}: progress not updated (${r.status}${r.error ? `: ${r.error}` : ""})`);
        if (!final) return;
      } catch (e) {
        this.#log(`spawn ${sp.id}: progress not updated: ${(e as Error).message}`);
        if (!final) return;
      }
    }
    if (!final && sp.progressId) return;
    const id = await this.#spawnSay(sp, { text }, final ? `${base}:answer` : `${base}:open`, replyTo);
    if (!final) {
      sp.progressId = id;
      sp.progressSeq = 0;
    }
    this.store.save();
  }

  async #spawnAskChoice(sp: Spawned, replyTo?: string): Promise<void> {
    let screen = "";
    try {
      screen = tailOf(await readAgent(this.#o.herdr, sp.paneId, READ_LINES), SCREEN_LINES);
    } catch {
      // nothing to show: the words alone
    }
    await this.#spawnSay(
      sp,
      { text: this.#s.spawnChoice(fence(redact(screen).text).slice(1)) },
      `herdr:sp:${sp.id}:ask:${sha(screen).slice(0, 12)}`,
      replyTo,
    );
  }

  /** Every tick: each spawned agent's turn followed; its answer goes out when it stops; gone ones close. */
  async #followSpawned(agents: HerdrAgent[], now: number): Promise<void> {
    const st = this.store.state;
    const open = st.spawned.filter((x) => x.closedAt === null);
    if (!open.length) return;
    const views = new Map(this.#watcher.snapshot().map((v) => [v.key, v]));
    let closed = false;
    for (const sp of open) {
      const key = `${sp.paneId}|${sp.terminalId}`;
      const a = agents.find((x) => paneKey(x) === key);
      if (!a) {
        sp.closedAt = now;
        closed = true;
        this.#log(`spawn ${sp.id}: pane gone`);
        if (sp.turnAt !== null) await this.#spawnProgress(sp, this.#s.spawnGone, true);
        for (const m of sp.marked ?? []) await this.#markMessage(m.route, m.messageId, "failed");
        sp.marked = [];
        continue;
      }
      if (sp.turnAt === null) continue;
      const status = a.agent_status;
      if (status === "working" || status === "blocked") sp.sawWork = true;
      if (status === "blocked" && !this.#asked.has(sp.id)) {
        this.#asked.add(sp.id);
        await this.#spawnAskChoice(sp);
      }
      if (status !== "blocked") this.#asked.delete(sp.id);
      const v = views.get(key);
      const settled = sp.sawWork && (status === "idle" || status === "done") && v && now - v.since >= 4000;
      if (!settled) {
        if (now - (this.#spawnShown.get(sp.id) ?? 0) >= 30_000 && sp.progressId && this.#canUpdate()) {
          this.#spawnShown.set(sp.id, now);
          await this.#spawnProgress(sp, this.#s.spawnWorking(this.#s.duration(now - sp.turnAt)), false);
        }
        continue;
      }
      let turn: Turn | null = null;
      try {
        turn = (await this.#o.transcripts?.turn(a)) ?? null;
      } catch (e) {
        this.#log(`spawn ${sp.id}: transcript not read: ${(e as Error).message}`);
      }
      const tools = turn?.steps.filter((x) => x.kind === "tool").length ?? 0;
      const head = this.#s.spawnDone(this.#s.duration(now - sp.turnAt), turn?.steps.length ?? 0, tools);
      const answer = turn?.answer.trim() ? redact(turn.answer.trim()).text : this.#s.spawnNoAnswer;
      sp.lastAt = now;
      const pages = answerPages(`${answer}\n\n${head}`);
      await this.#spawnProgress(sp, pages[0] ?? head, true);
      for (const [i, p] of pages.slice(1).entries()) {
        await this.#spawnSay(sp, { text: p }, `herdr:sp:${sp.id}:t${sp.turnAt}:more${i + 1}`);
      }
      for (const m of sp.marked ?? []) await this.#markMessage(m.route, m.messageId, "done");
      sp.marked = [];
      sp.turnAt = null;
      sp.sawWork = false;
      sp.progressId = null;
      this.#spawnShown.delete(sp.id);
      this.store.save();
    }
    if (closed) {
      this.store.save();
      await this.pushBindings();
    }
  }

  /** What did not fit on the notice, after it in its topic; a part that cannot be sent is logged and skipped. */
  async #sendMore(t: Thread, operationId: string, more: RenderedMessage[]): Promise<void> {
    for (const [i, m] of more.entries()) {
      try {
        const r = await this.#deliver(`${operationId}:m${i + 1}`, this.#threadRoute(t), m);
        if (r.providerMessageId) this.store.remember(r.providerMessageId, t.id);
        if (r.status === "rejected") this.#log(`part ${i + 1} of ${operationId} refused: ${r.error ?? ""}`);
      } catch (e) {
        this.#log(`part ${i + 1} of ${operationId} not sent: ${(e as Error).message}`);
        break;
      }
    }
    this.store.save();
  }

  #view(p: PendingNotice, d: Destination, threadId: string | null) {
    return {
      machine: this.#o.machine,
      screen: p.screen,
      turn: p.turn,
      timeZone: this.#c.timeZone,
      s: this.#s,
      topic: d.workbench,
      threadId,
      options: p.options,
      live: p.notice.kind !== "overnight" && this.#liveSettled.get(paneKey(p.notice.agent))?.chatId === d.chatId,
    };
  }

  /** Panes no longer in herdr (or running something else now): their threads close, a topic says so. */
  async #closeGone(agents: HerdrAgent[]): Promise<void> {
    const live = new Set(agents.filter((a) => a.agent).map(paneKey));
    const gone = this.store.state.threads.filter((t) => t.closedAt === null && !live.has(t.paneKey));
    if (!gone.length) return;
    const now = this.#now();
    for (const t of gone) t.closedAt = now;
    this.store.save();
    for (const t of gone) {
      this.#log(`pane ${t.paneId} ended; thread ${t.id} closed`);
      if (!t.workbench || this.paused || !this.#o.aio.online) continue;
      await this.#say(t, this.#threadRoute(t), { text: this.#s.ended }, `herdr:end:${t.id}`);
    }
  }

  // ---- what comes back from Feishu ---------------------------------------------------------

  /** An `inbound` push: taken once (by channelRef), handled in order, acknowledged at once. */
  onInbound(item: InboundItem): Promise<boolean> {
    if (!this.store.firstTime(item.channelRef)) return Promise.resolve(true);
    this.store.save();
    this.#inbox = this.#inbox
      .then(() => this.#handle(item))
      .catch((e: Error) => this.#log(`inbound ${item.channelRef}: ${e.message}`));
    return Promise.resolve(true);
  }

  /** Resolves when every inbound item taken so far has been handled. */
  async settled(): Promise<void> {
    let last: Promise<void>;
    do {
      last = this.#inbox;
      await last;
    } while (last !== this.#inbox);
  }

  #isOwner(item: InboundItem): boolean {
    const o = this.store.state.owner;
    const s = item.envelope.sender;
    return !!o && s.channelUserId === o.id && s.evidence === "platform_signed" && !s.isBot;
  }

  async #handle(item: InboundItem): Promise<void> {
    const env = item.envelope;
    const rule = ruleFor(this.#c.spawn, item);
    if (rule) return this.#onSpawnChannel(rule, item);
    if (env.channel !== CHANNEL || env.account !== this.#c.account) return;
    // Other bots are never answered (two bots refusing each other would never stop).
    if (env.sender.isBot) return;
    const action = actionOf(item);
    if (action) return this.#onAction(item, action.actionId, action.messageId);
    const text = textOf(item.input.content?.length ? item.input.content : env.content);
    if (env.conversation.kind === "dm" && /^\d{8}$/.test(normalizeCode(text)) && this.#setupPending()) {
      return this.#onCode(item, text);
    }
    const thread = this.store.threadOf(env.conversation.id, repliedTo(item), env.conversation.threadId);
    if (thread) {
      const pc = paneCommandOf(text, true);
      if (pc && this.#isOwner(item)) return this.#paneCommand(pc, thread, this.#threadReply(item, thread));
      return this.#onReply(item, thread, text);
    }
    if (!this.#isOwner(item)) return;
    // A reply to a screen card (or to an answer under one): that pane.
    const view = this.store.viewOf(env.conversation.id, repliedTo(item));
    if (view && this.#paneChat(env.conversation.id)) {
      const pc = paneCommandOf(text, true) ?? { cmd: "send", ref: null, text };
      return this.#paneCommand(pc, view, this.#plainReply(item));
    }
    const cmd = commandOf(text);
    if (cmd) return this.#command(item, cmd);
    const pc = paneCommandOf(text, false);
    if (pc) {
      // A screen says what is on the computer: only where nobody but the owner and the bot reads.
      if (!this.#paneChat(env.conversation.id)) return this.#answer(item, { text: this.#s.paneNotHere });
      return this.#paneCommand(pc, null, this.#plainReply(item));
    }
    const wb = this.store.state.workbench;
    // The owner said something that is neither a reply nor a command: say what works.
    if (
      env.conversation.kind === "dm" ||
      (wb && env.conversation.id === wb.chatId && env.conversation.kind === "group")
    ) {
      await this.#answer(item, { text: this.#s.help(this.#o.machine) });
    }
  }

  /** A short answer to an inbound message, where it came from (in its topic, quoting it). */
  async #answer(
    item: InboundItem,
    message: RenderedMessage,
    thread: Thread | null = null,
    n = 0,
    about: HerdrAgent | null = null,
  ): Promise<void> {
    const route = item.envelope.replyRoute;
    if (!route) return;
    const operationId = `herdr:re:${sha(item.channelRef).slice(0, 32)}:${n}`;
    try {
      const r = await this.#deliver(operationId, route, message);
      if (r.providerMessageId) {
        if (about)
          this.store.rememberView({
            messageId: r.providerMessageId,
            chatId: route.conversationId,
            paneId: about.pane_id,
            terminalId: about.terminal_id,
          });
        else this.store.remember(r.providerMessageId, thread?.id ?? null);
        this.store.save();
      }
      if (r.status === "rejected") this.#log(`answer ${operationId} refused: ${r.error ?? ""}`);
    } catch (e) {
      this.#log(`answer ${operationId} not sent: ${(e as Error).message}`);
    }
  }

  /** Says something in a thread; never throws. */
  async #say(t: Thread, route: ReplyRoute, message: RenderedMessage, operationId: string): Promise<void> {
    try {
      const r = await this.#deliver(operationId, route, message);
      if (r.providerMessageId) {
        this.store.remember(r.providerMessageId, t.id);
        if (t.workbench && !t.threadId && r.providerThreadId) t.threadId = r.providerThreadId;
        this.store.save();
      }
    } catch (e) {
      this.#log(`thread ${t.id}: ${operationId} not sent: ${(e as Error).message}`);
    }
  }

  // -- the owner-binding code

  async #onCode(item: InboundItem, text: string): Promise<void> {
    const path = this.#c.paths.setupFile;
    const f = readSetup(path);
    const env = item.envelope;
    if (!f || env.sender.evidence !== "platform_signed") return;
    if (hashCode(text) !== f.codeHash) {
      const attempts = f.attempts + 1;
      const left = SETUP_MAX_ATTEMPTS - attempts;
      if (left > 0) writePrivate(path, `${JSON.stringify({ ...f, attempts })}\n`);
      else clearSetup(path);
      this.#log(`setup: a wrong code (${left} tries left)`);
      await this.#answer(item, { text: this.#s.codeWrong(left) });
      if (left <= 0) await this.pushBindings();
      return;
    }
    const st = this.store.state;
    const id = env.sender.channelUserId;
    if (st.owner && st.owner.id !== id) {
      // Someone else now: the old owner's workbench and threads are not theirs.
      st.workbench = null;
      st.workbenchError = null;
      for (const t of st.threads) t.closedAt ??= this.#now();
    }
    st.owner = { id, dmChat: env.conversation.id, boundAt: this.#now() };
    clearSetup(path);
    this.store.save();
    this.#log("setup: owner bound");
    await this.pushBindings();
    await this.#answer(item, { text: this.#s.bound });
    await this.#ensureWorkbench(item, 1);
  }

  /** Creates the workbench group (owner + bot) unless there is one; says how it went in the DM. */
  async #ensureWorkbench(item: InboundItem, n: number): Promise<void> {
    const st = this.store.state;
    if (st.workbench) return this.#answer(item, { text: this.#s.workbenchExists }, null, n);
    const owner = st.owner;
    if (!owner) return;
    const feishu = this.#o.feishu;
    // The daemon's lark-bot makes the group when it can (`conversation.create`); an older daemon: our own REST call.
    const viaAio = this.#o.aio.hello?.features?.includes("conversation.create") ?? false;
    if (!this.#c.workbench.create || (!viaAio && !feishu)) {
      const why = !this.#c.workbench.create ? "workbench.create is false" : "no app credentials";
      return this.#answer(item, { text: this.#s.workbenchFailed(why) }, null, n);
    }
    const name = this.#c.workbench.name ?? this.#s.workbenchName(this.#o.machine);
    const description = this.#s.workbenchDescription(this.#o.machine);
    const uuid = sha(`${owner.id}\n${owner.boundAt}`).slice(0, 32);
    let chatId: string;
    try {
      if (viaAio) {
        ({ conversationId: chatId } = await this.#o.aio.request<{ conversationId: string }>(
          "conversation.create",
          {
            operationId: `herdr:workbench:${uuid}`,
            channel: CHANNEL,
            account: this.#c.account,
            name,
            description,
            owner: owner.id,
            members: [owner.id],
          },
          60_000,
        ));
      } else if (feishu) {
        ({ chatId } = await feishu.createChat({ name, description, ownerId: owner.id, uuid }));
      } else throw new Error("no app credentials");
    } catch (e) {
      const why = e instanceof FeishuError ? `${e.code}: ${e.message}` : (e as Error).message;
      st.workbenchError = why;
      this.store.save();
      this.#log(`workbench: creating the group failed: ${why}`);
      return this.#answer(item, { text: this.#s.workbenchFailed(why) }, null, n);
    }
    st.workbench = { chatId, via: "created", setAt: this.#now() };
    st.workbenchError = null;
    this.store.save();
    this.#log("workbench: group created");
    await this.pushBindings();
    try {
      const r = await this.#deliver(`herdr:hello:${sha(chatId).slice(0, 16)}`, this.#route(chatId), {
        text: this.#s.workbenchHello(this.#o.machine),
      });
      if (r.providerMessageId) this.store.remember(r.providerMessageId, null);
      this.store.save();
    } catch (e) {
      this.#log(`workbench: hello not sent: ${(e as Error).message}`);
    }
    await this.#answer(item, { text: this.#s.workbenchCreated(name) }, null, n);
  }

  // -- commands

  async #command(item: InboundItem, cmd: Command): Promise<void> {
    const env = item.envelope;
    const s = this.#s;
    switch (cmd) {
      case "status":
        return this.#answer(item, await this.statusCard());
      case "help":
        return this.#answer(item, { text: s.help(this.#o.machine) });
      case "pause":
        writePrivate(this.#c.paths.pauseFile, `${new Date(this.#now()).toISOString()}\n`);
        this.#log("paused from Feishu");
        return this.#answer(item, { text: s.pausedNow });
      case "resume":
        rmSync(this.#c.paths.pauseFile, { force: true });
        this.#log("resumed from Feishu");
        return this.#answer(item, { text: s.resumedNow });
      case "workbench": {
        if (env.conversation.kind === "dm") return this.#ensureWorkbench(item, 0);
        const st = this.store.state;
        if (st.workbench?.chatId === env.conversation.id) return this.#answer(item, { text: s.workbenchSame });
        st.workbench = { chatId: env.conversation.id, via: "mention", setAt: this.#now() };
        st.workbenchError = null;
        this.store.save();
        this.#log("workbench: set by mention");
        await this.pushBindings();
        return this.#answer(item, { text: s.workbenchSet });
      }
    }
  }

  /** The `status` card: every agent in herdr now. */
  async statusCard(): Promise<RenderedMessage> {
    let agents: HerdrAgent[] | null = null;
    let error: string | null = null;
    try {
      agents = await listAgents(this.#o.herdr);
    } catch (e) {
      error = (e as Error).message;
    }
    return statusMessage({
      machine: this.#o.machine,
      agents,
      error,
      views: this.#watcher.snapshot(),
      now: this.#now(),
      s: this.#s,
      paused: this.paused,
      quiet: quietLabel(this.#c.rules.quiet),
      workbench: !!this.store.state.workbench,
    });
  }

  // -- replies and buttons

  /** The pane of a thread, if it still runs the same program; closes the thread when it does not. */
  async #paneOf(t: Thread): Promise<{ ok: true; agent: HerdrAgent } | { ok: false; gone: boolean; reason: string }> {
    let agents: HerdrAgent[];
    try {
      agents = await listAgents(this.#o.herdr);
    } catch (e) {
      return { ok: false, gone: false, reason: e instanceof HerdrError ? e.code : (e as Error).message };
    }
    const a = agents.find((x) => x.pane_id === t.paneId);
    if (!a || a.terminal_id !== t.terminalId || !a.agent) {
      t.closedAt ??= this.#now();
      this.store.save();
      return { ok: false, gone: true, reason: "pane_gone" };
    }
    return { ok: true, agent: a };
  }

  /** The dialog's choices as the pane shows them now (else the last ones seen). */
  async #currentOptions(t: Thread): Promise<DialogOption[]> {
    try {
      const fresh = optionsOf(tailOf(await readAgent(this.#o.herdr, t.paneId, READ_LINES), SCREEN_LINES));
      if (fresh.length) {
        t.options = fresh;
        this.store.save();
      }
    } catch {
      // The stored ones then.
    }
    return t.options;
  }

  async #waitingForChoice(t: Thread, route: ReplyRoute, op: string): Promise<void> {
    const options = await this.#currentOptions(t);
    const msg: RenderedMessage = options.length
      ? { text: this.#s.waitingChoice, actions: buttons(t.id, options, this.#s) }
      : { text: this.#s.waitingChoiceNoOptions };
    await this.#say(t, route, msg, op);
  }

  /** A message in a pane's thread: the owner's text goes to the agent; anyone else is told no. */
  async #onReply(item: InboundItem, t: Thread, text: string): Promise<void> {
    const env = item.envelope;
    const s = this.#s;
    const here = env.replyRoute ?? this.#threadRoute(t, env.id);
    const op = `herdr:re:${sha(item.channelRef).slice(0, 32)}:0`;
    const say = (msg: string) => this.#say(t, here, { text: msg }, op);
    if (!this.#isOwner(item)) return say(s.notOwner);
    if (t.closedAt !== null) return say(s.gone);
    if (this.paused) return say(s.paused);
    if (!text) return say(s.textOnly);
    if (text.length > PROMPT_MAX) return say(s.tooLong(PROMPT_MAX));
    const pane = await this.#paneOf(t);
    if (!pane.ok) return say(pane.gone ? s.gone : s.herdrDown(pane.reason));
    if (pane.agent.agent_status === "blocked") return this.#waitingForChoice(t, here, op);
    try {
      await promptAgent(this.#o.herdr, t.paneId, text);
    } catch (e) {
      const code = e instanceof HerdrError ? e.code : "error";
      if (code === "agent_blocked") return this.#waitingForChoice(t, here, op);
      this.#log(`prompt to ${t.paneId} failed: ${code}`);
      return say(s.failed(code));
    }
    this.#log(`prompt to ${t.paneId} (${text.length} chars)`);
    // A reply to the owner's own message reaches the same pane, as a reply to an answer would.
    this.store.remember(env.id, t.id);
    this.store.save();
    return this.#ack(item, () => say(s.sent));
  }

  /** "Sent": a reaction on the owner's message; `fallback` (words) when it cannot be put. */
  async #ack(item: InboundItem, fallback: () => Promise<void>): Promise<void> {
    const feishu = this.#o.feishu;
    if (!feishu || this.#noReactions) return fallback();
    try {
      await feishu.react(item.envelope.id, ACK_EMOJI);
    } catch (e) {
      if (isScopeError(e)) {
        this.#noReactions = true;
        this.#log("reactions refused (scope im:message.reactions:write_only missing): answering in words");
      } else this.#log(`reaction failed: ${(e as Error).message}`);
      return fallback();
    }
  }

  async #onAction(item: InboundItem, actionId: string, messageId: string | null): Promise<void> {
    if (VIEW_ACTION.test(actionId) || PANE_KEY_ACTION.test(actionId)) return this.#onPaneAction(item, actionId);
    const m = KEY_ACTION.exec(actionId);
    if (!m) return;
    const t = this.store.thread(m[1] as string);
    const key = m[2] as string;
    if (!t) return this.#log(`button for an unknown thread ${m[1]}`);
    // The same chat: a card forwarded elsewhere presses nothing.
    if (item.envelope.conversation.id !== t.chatId) return this.#log(`button of thread ${t.id} from another chat`);
    const s = this.#s;
    const here = this.#threadRoute(t, messageId);
    const op = `herdr:re:${sha(item.channelRef).slice(0, 32)}:0`;
    const say = (msg: string) => this.#say(t, here, { text: msg }, op);
    if (!this.#isOwner(item)) return say(s.notOwner);
    if (t.closedAt !== null) return say(s.gone);
    if (this.paused) return say(s.paused);
    const pane = await this.#paneOf(t);
    if (!pane.ok) return say(pane.gone ? s.gone : s.herdrDown(pane.reason));
    try {
      await sendKeys(this.#o.herdr, t.paneId, [key]);
    } catch (e) {
      const code = e instanceof HerdrError ? e.code : "error";
      this.#log(`keys to ${t.paneId} failed: ${code}`);
      return say(s.failed(code));
    }
    this.#log(`keys to ${t.paneId}: ${key}`);
    return say(s.pressed(keyLabel(key)));
  }

  // -- looking at and driving any pane

  /** The owner's DM and the workbench: chats nobody but the owner and the bot read. */
  #paneChat(chatId: string): boolean {
    const { owner, workbench } = this.store.state;
    return chatId === owner?.dmChat || chatId === workbench?.chatId;
  }

  /** Answers in a pane's topic (or under its notice in the DM). */
  #threadReply(item: InboundItem, t: Thread, to: string | null = item.envelope.id): PaneReply {
    const route = (to === item.envelope.id ? item.envelope.replyRoute : null) ?? this.#threadRoute(t, to);
    const op = `herdr:re:${sha(item.channelRef).slice(0, 32)}:0`;
    const send = (msg: RenderedMessage) => this.#say(t, route, msg, op);
    return {
      topic: t.workbench,
      send,
      done: (text) => {
        if (actionOf(item)) return send({ text });
        this.store.remember(item.envelope.id, t.id);
        this.store.save();
        return this.#ack(item, () => send({ text }));
      },
    };
  }

  /** Answers under the message; `about` makes a reply to the answer reach that pane. */
  #plainReply(item: InboundItem): PaneReply {
    const send = (msg: RenderedMessage, about: HerdrAgent | null) => this.#answer(item, msg, null, 0, about);
    return {
      topic: false,
      send,
      done: (text, about) => {
        if (actionOf(item)) return send({ text }, about);
        // A reply to the owner's own message reaches the same pane, as a reply to a screen card does.
        const env = item.envelope;
        this.store.rememberView({
          messageId: env.id,
          chatId: env.conversation.id,
          paneId: about.pane_id,
          terminalId: about.terminal_id,
        });
        this.store.save();
        return this.#ack(item, () => send({ text }, about));
      },
    };
  }

  /**
   * `/ls`, `/view`, `/send`, `/keys`. `scope`: the pane of the topic or screen card the command came in
   * (it must still run the same program); else the command names its pane.
   */
  async #paneCommand(pc: PaneCommand, scope: PaneRef | null, reply: PaneReply): Promise<void> {
    const s = this.#s;
    const say = (text: string, about: HerdrAgent | null = null) => reply.send({ text }, about);
    if (pc.cmd === "usage") return say(s.paneUsage);
    let panes: HerdrAgent[];
    let tabs: HerdrTab[] = [];
    try {
      panes = await listPanes(this.#o.herdr);
      if (pc.cmd === "panes" || !scope) tabs = await listTabs(this.#o.herdr);
    } catch (e) {
      return say(s.herdrDown(e instanceof HerdrError ? e.code : (e as Error).message));
    }
    if (pc.cmd === "panes") return reply.send(panesMessage({ machine: this.#o.machine, panes, tabs, s }), null);
    let pane: HerdrAgent;
    if (scope) {
      const p = panes.find((x) => x.pane_id === scope.paneId && x.terminal_id === scope.terminalId);
      if (!p) return say(s.paneGone(shortId(scope.paneId, panes)));
      pane = p;
    } else {
      const r = resolvePane(pc.ref ?? "", panes, tabs);
      if (!r.ok) {
        const ids = r.candidates.map((p) => p.pane_id);
        return say(r.candidates.length ? s.paneAmbiguous(pc.ref ?? "", ids) : s.paneNotFound(pc.ref ?? ""));
      }
      pane = r.pane;
    }
    const id = shortId(pane.pane_id, panes);
    if (pc.cmd === "view") return this.#showPane(pane, id, pc.lines ?? VIEW_LINES, reply);
    if (this.paused) return say(s.paused);
    try {
      if (pc.cmd === "keys") {
        await sendPaneKeys(this.#o.herdr, pane.pane_id, pc.keys);
        this.#log(`keys to ${pane.pane_id}: ${pc.keys.length}`);
        return reply.done(s.paneKeysSent(id, pc.keys.join(" ")), pane);
      }
      if (!pc.text) return say(s.textOnly);
      if (pc.text.length > PROMPT_MAX) return say(s.tooLong(PROMPT_MAX));
      if (pane.agent) {
        if (pane.agent_status === "blocked") return this.#showPane(pane, id, VIEW_LINES, reply, s.paneWaiting);
        await promptAgent(this.#o.herdr, pane.pane_id, pc.text);
      } else {
        await runInPane(this.#o.herdr, pane.pane_id, pc.text);
      }
      this.#log(`text to ${pane.pane_id} (${pc.text.length} chars)`);
      return reply.done(s.paneSent(id), pane);
    } catch (e) {
      const code = e instanceof HerdrError ? e.code : "error";
      if (code === "agent_blocked") return this.#showPane(pane, id, VIEW_LINES, reply, s.paneWaiting);
      if (code === "invalid_key") return say(s.badKey((e as Error).message));
      this.#log(`input to ${pane.pane_id} failed: ${code}`);
      return say(s.failed(code));
    }
  }

  /** A pane's screen as a card (a dialog's choices as buttons); `note` goes above it. */
  async #showPane(pane: HerdrAgent, id: string, lines: number, reply: PaneReply, note?: string): Promise<void> {
    let screen: string;
    try {
      screen = tailOf(await readPane(this.#o.herdr, pane.pane_id, lines + 20), lines);
    } catch (e) {
      return reply.send({ text: this.#s.herdrDown(e instanceof HerdrError ? e.code : (e as Error).message) }, null);
    }
    const options = pane.agent_status === "blocked" ? optionsOf(screen) : [];
    const msg = viewMessage({
      machine: this.#o.machine,
      pane,
      id,
      screen,
      s: this.#s,
      footer: reply.topic ? this.#s.viewFooterTopic : this.#s.viewFooter(id),
      actions: pane.agent_status === "blocked" ? paneButtons(pane.terminal_id, options, this.#s) : [],
    });
    this.#log(`screen of ${pane.pane_id} (${lines} lines)`);
    return reply.send(note ? { ...msg, text: `${note}\n${msg.text}` } : msg, pane);
  }

  /** A screen card's buttons: refresh it, or press a dialog's key in that terminal. */
  async #onPaneAction(item: InboundItem, actionId: string): Promise<void> {
    const env = item.envelope;
    const chatId = env.conversation.id;
    if (!this.#isOwner(item)) return this.#answer(item, { text: this.#s.notOwner });
    if (!this.#paneChat(chatId)) return this.#log("a pane button from another chat");
    const messageId = actionOf(item)?.messageId ?? null;
    const t = messageId ? this.store.threadOf(chatId, [messageId], undefined) : null;
    const reply = t ? this.#threadReply(item, t, messageId) : this.#plainReply(item);
    const view = VIEW_ACTION.exec(actionId);
    const key = PANE_KEY_ACTION.exec(actionId);
    const terminalId = (view?.[1] ?? key?.[1]) as string;
    let panes: HerdrAgent[];
    try {
      panes = await listPanes(this.#o.herdr);
    } catch (e) {
      return reply.send({ text: this.#s.herdrDown(e instanceof HerdrError ? e.code : (e as Error).message) }, null);
    }
    const pane = panes.find((p) => p.terminal_id === terminalId);
    if (!pane) return reply.send({ text: this.#s.gone }, null);
    const scope = { paneId: pane.pane_id, terminalId };
    if (view) return this.#paneCommand({ cmd: "view", ref: null, lines: null }, scope, reply);
    return this.#paneCommand({ cmd: "keys", ref: null, keys: [key?.[2] as string] }, scope, reply);
  }
}
