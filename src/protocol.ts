/**
 * The part of the agents-io host protocol this project speaks (agents-io `docs/HOSTS.md`,
 * `packages/protocol/src/host.ts`), written out by hand: a host talks to the `aio` daemon over its
 * unix socket and never imports agents-io at runtime. Receivers ignore unknown fields, so these
 * types list only what is read or sent here.
 */

/** Wire protocol major version; every frame carries it as `v`. */
export const PROTOCOL_VERSION = 1 as const;

/** Where a message goes. `threadId` + `replyToMessageId` reply in a topic (Lark `reply_in_thread`). */
export interface ReplyRoute {
  channel: string;
  account: string;
  conversationId: string;
  threadId?: string;
  replyToMessageId?: string;
}

/** Channel-neutral message; lark-bot renders text + sections + actions as a card. */
export interface RenderedMessage {
  text: string;
  sections?: { kind: "body" | "details" | "status" | "footer"; text: string; collapsed?: boolean }[];
  /** Clicks come back as inbound `event` content named `action` with `{ actionId, messageId }`. */
  actions?: { id: string; label: string; style?: "primary" | "danger" }[];
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "quote"; text: string; fromMessageId?: string }
  | { type: "event"; name: string; data: Record<string, unknown> }
  | { type: "image" | "file" | "audio"; ref: string; mime: string; name?: string }
  | { type: "transcript" | "ref"; [k: string]: unknown };

export type ConversationKind = "dm" | "group" | "thread" | "meeting" | "call" | "mail" | "other";
export type Evidence = "platform_signed" | "dkim_pass" | "device_only" | "none";

/** What the channel said about one inbound message (the daemon strips `raw`). */
export interface InboundEnvelope {
  v: 1;
  id: string;
  channel: string;
  account: string;
  conversation: { id: string; kind: ConversationKind; threadId?: string };
  sender: { channelUserId: string; displayName?: string; isBot?: boolean; evidence: Evidence };
  content: ContentBlock[];
  mentions?: { id: string; name?: string; isBot?: boolean }[];
  /** Lark `root_id` / `parent_id` (agents-io 638eccf and later). */
  rootMessageId?: string;
  parentMessageId?: string;
  replyRoute: ReplyRoute | null;
  admission?: "dispatch" | "observe" | "drop";
  sentAt?: number;
}

export interface InputRecord {
  inputId: string;
  origin: {
    kind: string;
    principal: { id: string; labels: string[] } | null;
    evidence: string;
    self?: boolean;
    via: string;
    adapter: string;
  };
  content: ContentBlock[];
  replyRoute: ReplyRoute | null;
  channelRef?: string;
  channelContext: Record<string, string | number | boolean>;
}

/** One entry of the daemon's durable host inbound queue. */
export interface InboundItem {
  cursor: number;
  /** `channel:<channel>/<message id>`; the at-least-once dedup key. */
  channelRef: string;
  account: string;
  bindingId: string;
  input: InputRecord;
  envelope: InboundEnvelope;
  receivedAt: number;
}

export interface BindingMatch {
  channel?: string;
  account?: string;
  conversation?: string;
  conversationKind?: ConversationKind;
  senders?: string[];
  labels?: string[];
  principal?: string;
  known?: boolean;
  mentions?: string[];
  keywords?: string[];
  actionPrefix?: string;
  includeSelf?: boolean;
}

export interface Binding {
  id: string;
  match: BindingMatch;
  on: "dispatch" | "context" | "digest" | "host" | "drop";
  note?: string;
}

export interface IdentityEntry {
  channel: string;
  channelUserId: string;
  principal: string;
  labels: string[];
}

export interface BindingTable {
  version: string;
  bindings: Binding[];
  identities: IdentityEntry[];
  expiresAt?: number;
  onHostDown?: "keep" | "suspend";
}

export interface HostHelloResult {
  name: string;
  protocol: number;
  host: boolean;
  bindings: { version: string | null; active: boolean; suspended?: string };
  inbound?: { consumer: string; acked: number; head: number };
  replaced?: { name: string };
  features?: string[];
}

export interface BindingsPutResult {
  version: string;
  previous?: string;
  changed: boolean;
  active: boolean;
  suspended?: string;
}

export interface DeliverResult {
  operationId: string;
  sessionKey: string;
  route: ReplyRoute;
  status: "delivered" | "rejected" | "unknown";
  attempts: number;
  providerMessageId?: string;
  /** The topic the message is in (Lark `thread_id`), agents-io 638eccf and later. */
  providerThreadId?: string;
  error?: string;
  duplicate: boolean;
}

/** Any frame on the wire. */
export interface Frame {
  v: number;
  type: string;
  id?: string;
  [k: string]: unknown;
}

export interface ResultFrame extends Frame {
  type: "result";
  id: string;
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
}
