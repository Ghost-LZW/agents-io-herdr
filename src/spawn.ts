/**
 * Agents started from a message: the owner writes the trigger on another channel (a personal
 * account's trigger word, through a channel plugin that hints `dispatch`), and herdr gets a new tab with
 * an agent in it, given the owner's words, the message they quoted and where it all is. The
 * agent's answer goes back under the message; what the owner says later in the same topic (or in
 * reply to the agent) is typed into the same agent.
 *
 * Nothing here knows the channel: the rule (config `spawn`) names it, its owner, the agent kind,
 * the skills to link into the agent's directory and what to tell the agent first.
 */

import { spawn as run } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { SpawnHook, SpawnRule } from "./config.ts";
import type { ContentBlock, InboundItem, ReplyRoute } from "./protocol.ts";

/** One spawned agent: where it came from and how to answer there. */
export interface Spawned {
  id: string;
  rule: string;
  paneId: string;
  terminalId: string;
  /** The herdr tab it runs in (closed with it). */
  tabId?: string;
  /** The conversation (and topic) it answers in, and the message that started it. */
  channel: string;
  account: string;
  conversationId: string;
  /** The topic it is in (as the channel names it: Lark, by the topic's root message), when there is one. */
  topic: string | null;
  startMessageId: string;
  /** Messages it sent there (a reply to one of them is for it). */
  sent: string[];
  /** The progress message of the turn under way (edited while it works, then into the answer). */
  progressId: string | null;
  progressSeq: number;
  /** A prompt went in and its answer has not gone out yet: since when; null: nothing pending. */
  turnAt: number | null;
  /** herdr saw the agent work (or ask) since `turnAt`. */
  sawWork: boolean;
  /** The owner's messages this turn answers (marked working; done when the answer goes out). */
  marked?: { route: ReplyRoute; messageId: string }[];
  startedAt: number;
  lastAt: number;
  closedAt: number | null;
}

const text = (content: ContentBlock[]) =>
  content
    .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

const quotes = (content: ContentBlock[]) =>
  content.filter((c): c is Extract<ContentBlock, { type: "quote" }> => c.type === "quote");

/** The rule whose channel, account and owner this message is from, if any. */
export function ruleFor(rules: SpawnRule[], item: InboundItem): SpawnRule | null {
  const env = item.envelope;
  return (
    rules.find(
      (r) =>
        r.channel === env.channel &&
        r.account === env.account &&
        r.owner === env.sender.channelUserId &&
        env.sender.evidence === "platform_signed" &&
        !env.sender.isBot,
    ) ?? null
  );
}

/** The topic a message is in (Lark names a topic by its root message). */
export const topicOf = (item: InboundItem) => item.envelope.conversation.threadId ?? null;

/** The spawned agent a later message is for: the same topic, or a reply to one of its messages. */
export function spawnedFor(list: Spawned[], item: InboundItem, replied: string[]): Spawned | null {
  const env = item.envelope;
  const open = list.filter(
    (s) =>
      s.closedAt === null &&
      s.channel === env.channel &&
      s.account === env.account &&
      s.conversationId === env.conversation.id,
  );
  const topic = topicOf(item);
  if (topic) {
    const t = open.filter((s) => s.topic === topic || s.startMessageId === topic).at(-1);
    if (t) return t;
  }
  for (const id of replied) {
    const s = open.filter((x) => x.sent.includes(id) || x.startMessageId === id).at(-1);
    if (s) return s;
  }
  return null;
}

/** The first prompt: the rule's preamble, where the owner is, what they quoted and said. */
export function firstPrompt(rule: SpawnRule, item: InboundItem, now: number): string {
  const env = item.envelope;
  const ctx = item.input.channelContext ?? {};
  const where = [
    `channel: ${env.channel} (account ${env.account})`,
    `conversation: ${env.conversation.id} (${env.conversation.kind}${typeof ctx.chatName === "string" ? `, "${ctx.chatName}"` : ""})`,
    env.conversation.threadId ? `topic (thread root message): ${env.conversation.threadId}` : "",
    `message: ${env.id}`,
    env.parentMessageId ? `replying to message: ${env.parentMessageId}` : "",
    `sent: ${new Date(env.sentAt ?? now).toISOString()}`,
  ].filter(Boolean);
  const q = quotes(env.content).map(
    (x) => `> ${x.text.replace(/\n/g, "\n> ")}${x.fromMessageId ? `\n(quoted message ${x.fromMessageId})` : ""}`,
  );
  return [
    rule.preamble.trim(),
    `Where you were called:\n${where.map((l) => `- ${l}`).join("\n")}`,
    q.length ? `The message they quoted:\n${q.join("\n\n")}` : "",
    `What they asked:\n${text(env.content) || "(nothing more: read the place and work out what is wanted)"}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** A later message for a running agent: what was said, and what it quoted. */
export function laterPrompt(item: InboundItem): string {
  const env = item.envelope;
  const q = quotes(env.content).map((x) => `> ${x.text.replace(/\n/g, "\n> ")}`);
  return [q.join("\n"), text(env.content)].filter(Boolean).join("\n\n");
}

/**
 * The agent's directory: `cwd/<id>` (or `cwd` itself when agents share it), with the rule's skills
 * linked into `.claude/skills` and `.agents/skills` (so Claude Code and Codex both find them).
 * Links that are there already stay.
 */
export function prepareDir(rule: SpawnRule, id: string): string {
  const dir = rule.dirPerAgent ? join(rule.cwd, id) : rule.cwd;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const sub of [".claude/skills", ".agents/skills"]) {
    const into = join(dir, sub);
    mkdirSync(into, { recursive: true });
    for (const skill of rule.skills) {
      const at = join(into, basename(skill));
      if (existsSync(at) || isLink(at)) continue;
      symlinkSync(skill, at);
    }
  }
  return dir;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Where the agent's messages go: in a topic, into the topic itself (its root anchors the reply:
 * a reply anchored on a message inside the topic can fail to find the topic's root); elsewhere,
 * as a reply to the message that called it.
 */
export function spawnedRoute(s: Spawned, replyTo?: string): ReplyRoute {
  return {
    channel: s.channel,
    account: s.account,
    conversationId: s.conversationId,
    ...(s.topic ? { threadId: s.topic, replyToMessageId: s.topic } : { replyToMessageId: replyTo ?? s.startMessageId }),
  };
}

/**
 * Whether an addressed message starts an agent, and its words without the trigger. Outside a
 * direct conversation the channel only addresses the trigger; in one, `rule.trigger` decides.
 */
export function triggered(rule: SpawnRule, item: InboundItem): { start: boolean; item: InboundItem } {
  const env = item.envelope;
  if (env.admission === "observe") return { start: false, item };
  if (env.conversation.kind !== "dm" || !rule.trigger) return { start: true, item };
  const t = rule.trigger;
  const first = env.content.findIndex((c) => c.type === "text");
  const block = env.content[first];
  if (!block || block.type !== "text") return { start: false, item };
  const words = block.text.trimStart();
  const next = words.charAt(t.length);
  if (!words.startsWith(t) || (next !== "" && !/\s/.test(next))) return { start: false, item };
  const content = env.content.map((c, i) =>
    i === first ? { type: "text" as const, text: words.slice(t.length).trimStart() } : c,
  );
  return { start: true, item: { ...item, input: { ...item.input, content }, envelope: { ...env, content } } };
}

/**
 * A harness's own question at startup that starting it already answers (the owner configured the
 * rule): trusting the working directory (Claude Code, Codex), accepting bypass mode (Claude
 * Code). The keys that pick the yes, or null for anything else (that one stays for a person).
 */
export function startupAnswer(screen: string): string[] | null {
  const known = [
    /trust this folder|trust the (?:contents|files) of this (?:folder|directory)|do you trust/i,
    /bypass permissions mode/i,
  ];
  if (!known.some((re) => re.test(screen))) return null;
  const lines = screen.split("\n");
  const option = (l: string) => /^\s*(?:[❯›>]\s*)?(?:\d+[.)]\s*)?(?:Yes|No)\b/i.test(l);
  const yes = lines.findIndex((l) => option(l) && /^\s*(?:[❯›>]\s*)?(?:\d+[.)]\s*)?Yes\b/i.test(l));
  if (yes < 0) return null;
  const num = /^\s*(?:[❯›>]\s*)?(\d+)[.)]/.exec(lines[yes] ?? "")?.[1];
  if (num) return [num];
  const at = lines.findIndex((l) => option(l) && /^\s*[❯›>]/.test(l));
  if (at < 0) return null;
  const moves = yes - at;
  return [...Array(Math.abs(moves)).fill(moves > 0 ? "down" : "up"), "enter"];
}

/** What a hook did: its exit code (null: killed at the timeout, or not started) and the end of its output. */
export interface HookResult {
  code: number | null;
  output: string;
}

export type HookRunner = (h: SpawnHook, o: { cwd: string; env: Record<string, string> }) => Promise<HookResult>;

/** Runs a hook as a child process (never blocking the bridge), its output kept to the last 2000 characters. */
export const runHook: HookRunner = (h, o) =>
  new Promise((resolve) => {
    let output = "";
    const keep = (b: Buffer) => {
      output = (output + b.toString("utf8")).slice(-2000);
    };
    const [cmd, ...args] = h.run;
    const child = run(cmd as string, args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), h.timeoutMs);
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, output: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

/** The environment a hook sees about the agent it runs for (besides the rule's own `env`). */
export function hookEnv(rule: SpawnRule, item: InboundItem, dir: string, id: string): Record<string, string> {
  const env = item.envelope;
  return {
    HERDR_SPAWN_RULE: rule.id,
    HERDR_SPAWN_ID: id,
    HERDR_SPAWN_DIR: dir,
    HERDR_SPAWN_CHANNEL: env.channel,
    HERDR_SPAWN_ACCOUNT: env.account,
    HERDR_SPAWN_CONVERSATION: env.conversation.id,
    HERDR_SPAWN_TOPIC: env.conversation.threadId ?? "",
    HERDR_SPAWN_MESSAGE: env.id,
  };
}

/** `/close` (or `/end`) alone: the owner ends the agent of this topic. */
export const isClose = (text: string) => /^\s*\/(?:close|end)\s*$/i.test(text);
