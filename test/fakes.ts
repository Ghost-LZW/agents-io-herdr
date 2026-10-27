/**
 * Fakes for tests: an agents-io daemon speaking the host protocol on a temp unix socket, a herdr
 * socket server, a Feishu Open API behind an injected fetch, and synthetic inbound items. Every id
 * here is made up (`on_test_…`, `oc_test_…`, `om_test_…`).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Config, resolveConfig } from "../src/config.ts";
import type { HerdrAgent, HerdrTab } from "../src/herdr.ts";
import type {
  BindingTable,
  ContentBlock,
  DeliverResult,
  Frame,
  InboundItem,
  RenderedMessage,
  ReplyRoute,
  ResultFrame,
} from "../src/protocol.ts";

export { agent } from "./fixtures.ts";

export const OWNER = "on_test_owner";
export const STRANGER = "on_test_stranger";
export const DM = "oc_test_dm";
export const WORKBENCH = "oc_test_workbench";
export const ACCOUNT = "herdr";

/** A temp directory short enough for unix socket paths. */
export function tempDir(): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "aioh-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

export function testConfig(dir: string, raw: Record<string, unknown> = {}): Config {
  return resolveConfig(
    { dataDir: join(dir, "d"), timeZone: "UTC", locale: "en", machine: "my-mac", ...raw },
    { env: {}, home: join(dir, "home"), file: join(dir, "cfg", "config.json"), platform: "linux" },
  );
}

// ---- the daemon -------------------------------------------------------------------------------

export interface Delivery {
  operationId: string;
  route: ReplyRoute;
  message: RenderedMessage;
}

export class FakeAio {
  readonly socket: string;
  readonly token = "test-token-0123456789abcdef";
  readonly frames: Frame[] = [];
  readonly tables: BindingTable[] = [];
  readonly delivered: Delivery[] = [];
  /** Make a delivery fail: return a status other than delivered. */
  refuse: ((d: Delivery) => string | null) | null = null;
  /** Features `host.hello` answers. */
  features = ["host.takeover"];
  /** `message.ack` requests, in order. */
  readonly acks: { messageId: string; state: string }[] = [];
  /** `deliver.update` requests, in order. */
  readonly updates: Frame[] = [];
  updateMessage(f: Frame | undefined): RenderedMessage {
    return (f?.message ?? { text: "" }) as RenderedMessage;
  }
  /** `conversation.create` requests, and what they answer (an error code fails them). */
  readonly creates: Frame[] = [];
  createAnswer: { chatId: string } | { error: string } = { chatId: "oc_test_workbench" };
  #server: Server;
  #conns = new Set<Socket>();
  #seq = 0;
  #results = new Map<string, DeliverResult>();
  #topics = new Map<string, string>();
  #waiting = new Map<string, (f: ResultFrame) => void>();
  host: Socket | null = null;

  constructor(socket: string) {
    this.socket = socket;
    this.#server = createServer((c) => this.#accept(c));
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.socket), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.socket}.token`, `${this.token}\n`, { mode: 0o600 });
    await new Promise<void>((r) => this.#server.listen(this.socket, r));
  }

  async stop(): Promise<void> {
    for (const c of this.#conns) c.destroy();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }

  /** Drops every connection (a daemon restart, as the host sees it). */
  dropAll(): void {
    for (const c of this.#conns) c.destroy();
  }

  get lastTable(): BindingTable | undefined {
    return this.tables.at(-1);
  }

  #accept(c: Socket): void {
    this.#conns.add(c);
    c.on("close", () => {
      this.#conns.delete(c);
      if (this.host === c) this.host = null;
    });
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this.#frame(c, JSON.parse(line) as Frame);
        nl = buf.indexOf("\n");
      }
    });
  }

  #reply(c: Socket, id: string, value: unknown): void {
    c.write(`${JSON.stringify({ v: 1, type: "result", id, ok: true, value })}\n`);
  }

  #fail(c: Socket, id: string, code: string, message = code): void {
    c.write(`${JSON.stringify({ v: 1, type: "result", id, ok: false, error: { code, message } })}\n`);
  }

  #frame(c: Socket, f: Frame) {
    this.frames.push(f);
    if (f.v !== 1) return this.#fail(c, String(f.id), "invalid_frame");
    if (f.type === "result") {
      const w = this.#waiting.get(String(f.id));
      this.#waiting.delete(String(f.id));
      w?.(f as ResultFrame);
      return;
    }
    const id = String(f.id);
    if (f.type === "host.hello") {
      if (f.token !== this.token) return this.#fail(c, id, "unauthorized");
      if (f.consumer) this.host = c;
      return this.#reply(c, id, {
        name: f.name,
        protocol: 1,
        host: !!f.consumer,
        bindings: { version: this.lastTable?.version ?? null, active: !!this.lastTable },
        features: this.features,
      });
    }
    if (f.type === "bindings.put") {
      const table = f.table as BindingTable;
      const previous = this.lastTable?.version;
      this.tables.push(table);
      return this.#reply(c, id, {
        version: table.version,
        previous,
        changed: previous !== table.version,
        active: true,
      });
    }
    if (f.type === "deliver") {
      const d: Delivery = {
        operationId: String(f.operationId),
        route: f.route as ReplyRoute,
        message: f.message as RenderedMessage,
      };
      const prior = this.#results.get(d.operationId);
      if (prior) return this.#reply(c, id, { ...prior, duplicate: true });
      this.delivered.push(d);
      const refused = this.refuse?.(d) ?? null;
      const mid = `om_test_${++this.#seq}`;
      let thread: string | undefined;
      if (d.route.threadId && d.route.replyToMessageId) {
        const root = d.route.replyToMessageId;
        thread = this.#topics.get(root) ?? `omt_test_${this.#seq}`;
        this.#topics.set(root, thread);
        this.#topics.set(mid, thread);
      }
      const r: DeliverResult = refused
        ? {
            operationId: d.operationId,
            sessionKey: "host:t",
            route: d.route,
            status: "rejected",
            attempts: 1,
            error: refused,
            duplicate: false,
          }
        : {
            operationId: d.operationId,
            sessionKey: "host:t",
            route: d.route,
            status: "delivered",
            attempts: 1,
            providerMessageId: mid,
            ...(thread ? { providerThreadId: thread } : {}),
            duplicate: false,
          };
      this.#results.set(d.operationId, r);
      return this.#reply(c, id, r);
    }
    if (f.type === "message.ack") {
      this.acks.push({ messageId: String(f.messageId), state: String(f.state) });
      return this.#reply(c, id, { messageId: f.messageId, state: f.state });
    }
    if (f.type === "deliver.update") {
      this.updates.push(f);
      return this.#reply(c, id, {
        operationId: f.operationId,
        providerMessageId: f.providerMessageId,
        status: "delivered",
        duplicate: false,
      });
    }
    if (f.type === "conversation.create") {
      this.creates.push(f);
      const a = this.createAnswer;
      if ("error" in a) return this.#fail(c, id, "channel_error", a.error);
      return this.#reply(c, id, {
        operationId: f.operationId,
        channel: f.channel,
        account: f.account,
        conversationId: a.chatId,
        duplicate: false,
      });
    }
    return this.#fail(c, id, "unsupported");
  }

  /** Pushes one inbound item to the host and waits for its answer. */
  push(item: InboundItem): Promise<ResultFrame> {
    const c = this.host;
    if (!c) throw new Error("no host connected");
    const id = `d_${++this.#seq}`;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      c.write(`${JSON.stringify({ v: 1, type: "inbound", id, item })}\n`);
    });
  }

  /** Deliveries since `from`, as a compact list. */
  since(from: number): Delivery[] {
    return this.delivered.slice(from);
  }
}

// ---- inbound items ------------------------------------------------------------------------------

let ref = 0;

export interface Msg {
  from?: string;
  chat?: string;
  kind?: "dm" | "group" | "thread" | "other";
  text?: string;
  threadId?: string;
  rootMessageId?: string;
  parentMessageId?: string;
  action?: { actionId: string; messageId: string };
  isBot?: boolean;
  evidence?: "platform_signed" | "none";
  id?: string;
}

/** An inbound item as the daemon would push it for a lark-bot message or card click. */
export function inbound(m: Msg): InboundItem {
  const id = m.id ?? (m.action ? `card:ev_${++ref}` : `om_test_in_${++ref}`);
  const chat = m.chat ?? DM;
  const kind = m.kind ?? (m.action ? "other" : chat === DM ? "dm" : "group");
  const content: ContentBlock[] = m.action
    ? [
        {
          type: "event",
          name: "action",
          data: { actionId: m.action.actionId, messageId: m.action.messageId, value: null },
        },
      ]
    : [
        ...(m.parentMessageId && (!m.threadId || m.parentMessageId !== m.rootMessageId)
          ? [{ type: "quote" as const, text: "", fromMessageId: m.parentMessageId }]
          : []),
        ...(m.text !== undefined ? [{ type: "text" as const, text: m.text }] : []),
      ];
  const replyRoute: ReplyRoute = {
    channel: "lark-bot",
    account: ACCOUNT,
    conversationId: chat,
    ...(m.threadId ? { threadId: m.threadId } : {}),
    replyToMessageId: m.action ? m.action.messageId : id,
  };
  const channelContext: Record<string, string> = {};
  if (m.rootMessageId) channelContext.rootMessageId = m.rootMessageId;
  if (m.parentMessageId) channelContext.parentMessageId = m.parentMessageId;
  const from = m.from ?? OWNER;
  return {
    cursor: ref,
    channelRef: `channel:lark-bot/${id}`,
    account: ACCOUNT,
    bindingId: "herdr:test",
    input: {
      inputId: `in_${ref}`,
      origin: {
        kind: "human",
        principal: from === OWNER ? { id: "owner", labels: ["owner"] } : null,
        evidence: m.evidence ?? "platform_signed",
        via: `lark-bot:${ACCOUNT}:${chat}`,
        adapter: "lark-bot",
      },
      content,
      replyRoute,
      channelRef: `channel:lark-bot/${id}`,
      channelContext,
    },
    envelope: {
      v: 1,
      id,
      channel: "lark-bot",
      account: ACCOUNT,
      conversation: { id: chat, kind, ...(m.threadId ? { threadId: m.threadId } : {}) },
      sender: { channelUserId: from, evidence: m.evidence ?? "platform_signed", ...(m.isBot ? { isBot: true } : {}) },
      content,
      ...(m.rootMessageId ? { rootMessageId: m.rootMessageId } : {}),
      ...(m.parentMessageId ? { parentMessageId: m.parentMessageId } : {}),
      replyRoute,
      admission: "dispatch",
    },
    receivedAt: 0,
  };
}

// ---- herdr --------------------------------------------------------------------------------------

const READS = new Set([
  "agent.list",
  "agent.get",
  "agent.read",
  "pane.list",
  "pane.read",
  "tab.list",
  "workspace.list",
]);
/** Key names the fake accepts; herdr refuses others (`invalid_key`) before writing anything. */
const KEYS = /^(?:[1-9]|esc|enter|tab|up|down|left|right|space|backspace|ctrl\+[a-z])$/;

export class FakeHerdr {
  readonly socket: string;
  /** Every pane; the ones with `agent` set are agents. */
  agents: HerdrAgent[] = [];
  tabs: HerdrTab[] = [];
  screens = new Map<string, string>();
  calls: [string, Record<string, unknown>][] = [];
  /** Error code for a method, e.g. `agent.prompt` → `agent_blocked`. */
  errors = new Map<string, string>();
  workspaces: { workspace_id: string; label: string }[] = [];
  #made = 0;
  /** agent.start answers agent_pane_busy this many times first (a new tab's shell not ready yet). */
  busyStarts = 0;
  /** A question every agent asks at startup (until a key answers it with enter). */
  startupDialog: string | null = null;
  /** Panes where an agent was started and herdr has not seen it ready yet. */
  #starting = new Set<string>();
  /** Panes whose history herdr cannot read now (a full-screen program in a dialog): only `visible` works. */
  visibleOnly = new Set<string>();
  #server: Server;

  constructor(socket: string) {
    this.socket = socket;
    this.#server = createServer((c) => {
      let buf = "";
      c.setEncoding("utf8");
      c.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        const req = JSON.parse(buf.slice(0, nl)) as { id: string; method: string; params: Record<string, unknown> };
        this.calls.push([req.method, req.params]);
        const bad = req.method.endsWith("send_keys") && this.#result(req.method, req.params) === null;
        const pane = String(req.params.target ?? req.params.pane_id ?? "");
        const history =
          req.method.endsWith(".read") && req.params.source !== "visible" && this.visibleOnly.has(pane)
            ? `cannot read ${req.params.lines} lines while ${pane} is blocked: its alternate-screen history can only be captured by scrolling while idle. Wait and retry, or use --source visible`
            : null;
        const early = req.method === "agent.prompt" && this.#starting.has(pane);
        const err = bad
          ? "invalid_key"
          : history
            ? "read_unavailable"
            : early
              ? "agent_not_ready"
              : req.method === "agent.start" && this.busyStarts > 0 && this.busyStarts--
                ? "agent_pane_busy"
                : this.errors.get(req.method);
        const answer = err
          ? { id: req.id, error: { code: err, message: history ?? `${req.method}: ${err}` } }
          : { id: req.id, result: this.#result(req.method, req.params) };
        c.end(`${JSON.stringify(answer)}\n`);
      });
    });
  }

  #result(method: string, params: Record<string, unknown>): unknown {
    if (method === "workspace.list") return { workspaces: this.workspaces };
    if (method === "workspace.create") {
      const w = { workspace_id: `w${this.workspaces.length + 10}`, label: String(params.label) };
      this.workspaces.push(w);
      return {
        workspace: w,
        tab: { tab_id: `${w.workspace_id}:t1` },
        root_pane: { pane_id: `${w.workspace_id}:p1`, terminal_id: "term_ws" },
      };
    }
    if (method === "tab.create") {
      const n = ++this.#made;
      const pane = `${params.workspace_id}:pn${n}`;
      this.agents.push({ ...agentRow(pane, `term_made_${n}`), cwd: String(params.cwd) });
      return {
        tab: { tab_id: `t${n}`, label: params.label },
        root_pane: { pane_id: pane, terminal_id: `term_made_${n}` },
      };
    }
    if (method === "agent.start") {
      // Like herdr over the socket: answered at once, ready a moment later (after one agent.get).
      const pane = String(params.pane_id);
      this.agents = this.agents.map((a) =>
        a.pane_id === pane ? { ...a, agent: String(params.kind), agent_status: "unknown" } : a,
      );
      this.#starting.add(pane);
      return { agent: { pane_id: pane, launch_pending: true } };
    }
    if (method === "agent.get") {
      const pane = String(params.target);
      if (this.startupDialog && this.#starting.has(pane)) {
        this.agents = this.agents.map((a) => (a.pane_id === pane ? { ...a, agent_status: "blocked" } : a));
        this.screens.set(pane, this.startupDialog);
        return { agent: { pane_id: pane, launch_pending: false, interactive_ready: false, agent_status: "blocked" } };
      }
      if (this.#starting.has(pane) && this.agents.find((a) => a.pane_id === pane)?.agent_status === "blocked") {
        this.agents = this.agents.map((a) => (a.pane_id === pane ? { ...a, agent_status: "unknown" } : a));
      }
      if (this.#starting.delete(pane)) {
        this.agents = this.agents.map((a) => (a.pane_id === pane ? { ...a, agent_status: "idle" } : a));
        return { agent: { pane_id: pane, launch_pending: true, interactive_ready: false, agent_status: "unknown" } };
      }
      const a = this.agents.find((x) => x.pane_id === pane);
      return { agent: { ...a, interactive_ready: a?.agent_status === "idle" } };
    }
    if (method === "agent.list") return { agents: this.agents.filter((a) => a.agent) };
    if (method === "pane.list") return { panes: this.agents };
    if (method === "tab.list") return { tabs: this.tabs };
    if (method === "agent.read") return { read: { text: this.screens.get(String(params.target)) ?? "" } };
    if (method === "pane.read") return { read: { text: this.screens.get(String(params.pane_id)) ?? "" } };
    if (method.endsWith("send_keys") && (params.keys as string[]).some((k) => !KEYS.test(k))) return null;
    if (method === "agent.send_keys" && this.startupDialog && (params.keys as string[]).at(-1) === "enter") {
      // The startup question answered: the agent goes on starting.
      this.startupDialog = null;
    }
    return {};
  }

  /** Calls other than reading. */
  get actions(): [string, Record<string, unknown>][] {
    return this.calls.filter(([m]) => !READS.has(m));
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.socket), { recursive: true });
    await new Promise<void>((r) => this.#server.listen(this.socket, r));
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.#server.close(() => r()));
  }
}

/** A plain shell pane as herdr lists it (no agent yet). */
function agentRow(pane: string, terminal: string): HerdrAgent {
  return { pane_id: pane, terminal_id: terminal, agent: null, agent_status: "unknown", focused: false };
}

// ---- Feishu Open API ---------------------------------------------------------------------------

export interface FeishuCall {
  url: string;
  body: Record<string, unknown>;
  auth: string | null;
}

/** A fetch answering the token and chat-create endpoints; `chat` decides the create answer. */
export function fakeFeishu(chat: { code: number; chatId?: string; msg?: string } = { code: 0, chatId: WORKBENCH }) {
  const calls: FeishuCall[] = [];
  /** The answer code for reactions (99991672: the scope is missing). */
  const reactions = { code: 0 };
  const f = (async (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, body: JSON.parse(String(init.body)), auth: headers.authorization ?? null });
    if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
      return new Response(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "t-test-token", expire: 7200 }));
    }
    if (url.includes("/im/v1/chats")) {
      return new Response(
        JSON.stringify({
          code: chat.code,
          msg: chat.msg ?? "ok",
          ...(chat.chatId ? { data: { chat_id: chat.chatId } } : {}),
        }),
      );
    }
    if (/\/im\/v1\/messages\/[^/]+\/reactions$/.test(url)) {
      return new Response(JSON.stringify({ code: reactions.code, msg: reactions.code ? "Access denied" : "ok" }));
    }
    return new Response(JSON.stringify({ code: 404, msg: "not found" }), { status: 404 });
  }) as typeof fetch;
  /** The reactions put so far: [message id, emoji]. */
  const reacted = () =>
    calls
      .filter((c) => c.url.endsWith("/reactions"))
      .map((c) => [
        decodeURIComponent(c.url.split("/messages/")[1]?.split("/")[0] ?? ""),
        (c.body.reaction_type as { emoji_type: string }).emoji_type,
      ]);
  return { fetch: f, calls, reactions, reacted };
}

/** Waits until `check` holds (polling), or fails after `ms`. */
export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}
