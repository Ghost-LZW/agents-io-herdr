/** How a notice, a status listing and the dialog buttons look on Feishu (RenderedMessage cards). */
import { basename } from "node:path";
import type { HerdrAgent } from "./herdr.ts";
import type { Strings } from "./i18n.ts";
import type { RenderedMessage } from "./protocol.ts";
import { redact } from "./redact.ts";
import type { DialogOption } from "./screen.ts";
import type { Step, Turn } from "./transcript.ts";
import type { Notice, PaneView } from "./watch.ts";
import { paneKey } from "./watch.ts";

const KIND_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  opencode: "OpenCode",
  amp: "Amp",
  cursor: "Cursor",
};

export const agentName = (a: Pick<HerdrAgent, "agent">) => KIND_NAMES[a.agent ?? ""] ?? a.agent ?? "agent";
/** The directory the agent works in, by its last component (never the full path). */
export const placeOf = (a: Pick<HerdrAgent, "foreground_cwd" | "cwd" | "pane_id">) =>
  basename(a.foreground_cwd || a.cwd || "") || a.pane_id;
export const titleOf = (a: Pick<HerdrAgent, "terminal_title_stripped">) =>
  redact((a.terminal_title_stripped ?? "").trim()).text.slice(0, 80);

/** Button ids: `herdr:key:<thread id>:<key>`. */
export const ACTION_PREFIX = "herdr:";
export const keyAction = (threadId: string, key: string) => `${ACTION_PREFIX}key:${threadId}:${key}`;
export const KEY_ACTION = /^herdr:key:([0-9a-z]{6,32}):([1-9]|esc)$/;
export const keyLabel = (key: string) => (key === "esc" ? "Esc" : key);

export const BUTTON_LABEL_MAX = 20;
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A blocked dialog's choices as buttons (`1 Yes`), and Esc. */
export function buttons(threadId: string, options: DialogOption[], s: Strings): RenderedMessage["actions"] {
  return [
    ...options.map((o) => ({
      id: keyAction(threadId, o.key),
      label: clip(`${o.key} ${o.label}`.trim(), BUTTON_LABEL_MAX),
    })),
    { id: keyAction(threadId, "esc"), label: s.escLabel },
  ];
}

export const fence = (t: string) => (t ? `\n\`\`\`\n${t.replace(/```/g, "ˋˋˋ")}\n\`\`\`` : "");

const clock = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);

export interface NoticeView {
  machine: string;
  /** What the pane shows (cleaned and redacted), or null when it could not be read. */
  screen: string | null;
  /** The turn from the agent's transcript (whole answer, every step), or null: the screen is all there is. */
  turn?: Turn | null;
  timeZone: string;
  s: Strings;
  /** The notice goes into a workbench topic (else a DM). */
  topic: boolean;
  /** Our thread id, for buttons. */
  threadId: string | null;
  options: DialogOption[];
  /** The turn has a live card in this thread (its process and answer are there). */
  live?: boolean;
}

/** UTF-8 bytes of a card's answer, and of the process on one card: well under Feishu's ~30 KB card. */
export const ANSWER_PAGE_BYTES = 10_000;
export const PROCESS_PAGE_BYTES = 8_000;
/** A tool's output in the process, from its start. */
export const RESULT_CHARS = 800;
/** Messages after the notice, at most (the oldest steps give way first). */
export const MORE_MAX = 10;

const bytes = (t: string) => Buffer.byteLength(t);
const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
const FENCE = /^\s*(`{3,}|~{3,})/;

/** Markdown in pages of at most `max` bytes; a page cut inside a code block closes it and the next reopens it. */
export function pages(text: string, max: number): string[] {
  if (bytes(text) <= max) return [text];
  const out: string[] = [];
  let cur = "";
  let fence: string | null = null;
  const push = () => {
    out.push(fence ? `${cur}\n${FENCE.exec(fence)?.[1] ?? "```"}` : cur);
    cur = fence ?? "";
  };
  for (const line of text.split("\n")) {
    // A line longer than a page is cut by characters.
    const room = Math.max(64, max - 16 - (fence ? bytes(fence) + 1 : 0));
    const pieces: string[] = [];
    let piece = "";
    for (const ch of line) {
      if (piece && bytes(piece) + bytes(ch) > room) {
        pieces.push(piece);
        piece = "";
      }
      piece += ch;
    }
    pieces.push(piece);
    for (const p of pieces) {
      if (cur && cur !== fence && bytes(cur) + 1 + bytes(p) > max - 16) push();
      cur = cur ? `${cur}\n${p}` : p;
    }
    if (FENCE.test(line)) fence = fence ? null : line;
  }
  if (cur && cur !== fence) out.push(cur);
  return out;
}

/** A long answer in messages of at most `ANSWER_PAGE_BYTES`. */
export const answerPages = (text: string) => pages(text, ANSWER_PAGE_BYTES);

/** One step of a turn as markdown: thinking, what the agent said, a tool call and the start of its output. */
export function stepText(st: Step): string {
  if (st.kind === "thinking") return `💭 ${redact(st.text.trim()).text}`;
  if (st.kind === "text") return `💬 ${redact(st.text.trim()).text}`;
  const subject = redact(clip(oneLine(st.subject), 300)).text;
  const head = `${st.result === null ? "⏳" : st.error ? "❌" : "🔧"} **${st.name}**${subject ? ` \`${subject.replace(/`/g, "ˋ")}\`` : ""}`;
  const out = (st.result ?? "").replace(/\s+$/, "");
  if (!out) return head;
  const shown =
    out.length > RESULT_CHARS ? `${out.slice(0, RESULT_CHARS)}\n… (${out.length - RESULT_CHARS} more)` : out;
  return `${head}${fence(redact(shown).text)}`;
}

/** The steps as pages; when there are more than `maxPages`, the oldest steps give way (and a line says so). */
export function processPages(steps: Step[], s: Strings, maxPages: number): string[] {
  const blocks = steps.map(stepText);
  let from = 0;
  const build = () => {
    const out: string[] = [];
    let cur = from > 0 ? s.stepsLeftOut(from) : "";
    for (const b of blocks.slice(from)) {
      for (const piece of pages(b, PROCESS_PAGE_BYTES)) {
        if (cur && bytes(cur) + 2 + bytes(piece) > PROCESS_PAGE_BYTES) {
          out.push(cur);
          cur = "";
        }
        cur = cur ? `${cur}\n\n${piece}` : piece;
      }
    }
    if (cur) out.push(cur);
    return out;
  };
  let out = build();
  while (out.length > maxPages && from < blocks.length - 1) {
    from += Math.max(1, Math.ceil((blocks.length - from) * 0.1));
    out = build();
  }
  return out;
}

/**
 * A notice, and what follows it in its topic (in the DM: replies to it) when one card cannot hold it
 * all: the rest of the answer, then the rest of the process.
 */
export function noticeMessages(n: Notice, v: NoticeView): RenderedMessage[] {
  const turn = n.kind === "overnight" ? null : v.turn;
  if (n.kind !== "overnight" && v.live) return [liveNotice(n, v)];
  if (!turn || n.kind === "overnight") return [noticeMessage(n, v)];
  const { s, machine } = v;
  const a = n.agent;
  const head =
    n.kind === "blocked"
      ? s.blockedHead(machine, placeOf(a), agentName(a))
      : s.doneHead(machine, placeOf(a), agentName(a), s.duration(n.turnMs));
  const title = titleOf(a);
  // A dialog is on the screen, not in the transcript; a finished turn is its answer.
  const answer = n.kind === "done" ? redact(turn.answer).text : "";
  const shown = answer || (v.screen ? fence(v.screen).slice(1) : "");
  const answerPages = shown ? pages(shown, ANSWER_PAGE_BYTES) : [];
  const tools = turn.steps.filter((x) => x.kind === "tool").length;
  const steps = processPages(turn.steps, s, Math.max(1, MORE_MAX + 1 - answerPages.length));
  const label = (i: number) =>
    `**${s.processHead(tools, turn.steps.length)}${steps.length > 1 ? ` (${i + 1}/${steps.length})` : ""}**`;
  const prompt = turn.prompt.trim() ? `${s.asked} ${redact(clip(oneLine(turn.prompt), 200)).text}` : "";
  const footer = v.topic ? s.footerTopic(a.pane_id) : s.footerDm(a.pane_id);
  const actions = n.kind === "blocked" && v.threadId ? buttons(v.threadId, v.options, s) : undefined;
  const top = [head, title, prompt].filter(Boolean).join("\n");
  const first = answerPages[0] ?? "";
  const main: RenderedMessage = {
    text: `${top}${first ? `\n\n${first}` : ""}`,
    sections: [
      {
        kind: "body",
        text: `${top}${first ? `\n\n${first}` : ""}${answerPages.length > 1 ? `\n\n${s.continued}` : ""}`,
      },
      ...(steps[0] ? [{ kind: "details" as const, text: `${label(0)}\n\n${steps[0]}`, collapsed: true }] : []),
      { kind: "footer", text: footer },
    ],
    ...(actions ? { actions } : {}),
  };
  const more: RenderedMessage[] = [
    ...answerPages.slice(1).map((p) => ({ text: p, sections: [{ kind: "body" as const, text: p }] })),
    ...steps.slice(1).map((p, i) => ({
      text: label(i + 1),
      sections: [{ kind: "details" as const, text: `${label(i + 1)}\n\n${p}`, collapsed: true }],
    })),
  ];
  return [main, ...more];
}

/** A notice when a live card shows the turn: a finished turn points at it; a dialog still shows the screen and its buttons. */
function liveNotice(n: Extract<Notice, { agent: unknown }>, v: NoticeView): RenderedMessage {
  const { s, machine } = v;
  const a = n.agent;
  const footer = v.topic ? s.footerTopic(a.pane_id) : s.footerDm(a.pane_id);
  if (n.kind === "blocked") {
    const text = `${s.blockedHead(machine, placeOf(a), agentName(a))}${fence(v.screen ?? "")}`;
    const actions = v.threadId ? buttons(v.threadId, v.options, s) : undefined;
    return { text, sections: [{ kind: "footer", text: footer }], ...(actions ? { actions } : {}) };
  }
  const head = s.doneHead(machine, placeOf(a), agentName(a), s.duration(n.turnMs));
  return { text: `${head}\n${s.liveAbove}`, sections: [{ kind: "footer", text: footer }] };
}

/** A running turn's live card: the head and title, and the process lark-bot draws natively. */
export function liveMessage(
  a: HerdrAgent,
  turn: Turn | null,
  o: {
    machine: string;
    s: Strings;
    topic: boolean;
    progress: RenderedMessage["progress"] & object;
  },
): RenderedMessage {
  const { s } = o;
  const p = o.progress;
  const done = p.status !== "running" && p.status !== "requires_action";
  // Settled, the card is the turn's only message: it says it finished, and how long it took.
  const head =
    p.status === "completed" && p.startedAt !== undefined && p.endedAt !== undefined
      ? s.doneHead(o.machine, placeOf(a), agentName(a), s.duration(p.endedAt - p.startedAt))
      : s.workingHead(o.machine, placeOf(a), agentName(a));
  const title = titleOf(a);
  const prompt = turn?.prompt.trim() ? `${s.asked} ${redact(clip(oneLine(turn.prompt), 200)).text}` : "";
  const top = [title, prompt].filter(Boolean).join("\n");
  const answer = done ? [top, p.answer].filter(Boolean).join("\n\n") : "";
  return {
    text: answer || top || head,
    sections: [{ kind: "status", text: done ? head : `${head}${top ? `\n${top}` : ""}` }],
    progress: { ...p, answer, ...(done ? {} : { headline: head }) },
  };
}

export function noticeMessage(n: Notice, v: NoticeView): RenderedMessage {
  const { s, machine } = v;
  if (n.kind === "overnight") {
    const lines = n.items.map((i) =>
      s.overnightItem(
        placeOf(i.agent),
        agentName(i.agent),
        titleOf(i.agent),
        s.duration(i.turnMs),
        clock(i.endedAt, v.timeZone),
      ),
    );
    return { text: `${s.overnightHead(machine)}\n${lines.join("\n")}` };
  }
  const a = n.agent;
  const head =
    n.kind === "blocked"
      ? s.blockedHead(machine, placeOf(a), agentName(a))
      : s.doneHead(machine, placeOf(a), agentName(a), s.duration(n.turnMs));
  const title = titleOf(a);
  const text = `${head}${title ? `\n${title}` : ""}${fence(v.screen ?? "")}`;
  const footer = v.topic ? s.footerTopic(a.pane_id) : s.footerDm(a.pane_id);
  const actions = n.kind === "blocked" && v.threadId ? buttons(v.threadId, v.options, s) : undefined;
  return { text, sections: [{ kind: "footer", text: footer }], ...(actions ? { actions } : {}) };
}

/** `status`: every agent in herdr, deterministic, one card. */
export function statusMessage(o: {
  machine: string;
  agents: HerdrAgent[] | null;
  error: string | null;
  views: PaneView[];
  now: number;
  s: Strings;
  paused: boolean;
  quiet: string | null;
  workbench: boolean;
}): RenderedMessage {
  const { s } = o;
  const footer = { kind: "footer" as const, text: s.statusFooter(o) };
  if (!o.agents)
    return { text: `${s.statusHead(o.machine, 0)}\n${s.statusHerdrDown(o.error ?? "?")}`, sections: [footer] };
  const rows = o.agents.filter((a) => a.agent);
  if (!rows.length) return { text: `${s.statusHead(o.machine, 0)}\n${s.statusNone}`, sections: [footer] };
  const views = new Map(o.views.map((v) => [v.key, v]));
  const order: Record<string, number> = { blocked: 0, working: 1, done: 2, idle: 3 };
  rows.sort(
    (x, y) => (order[x.agent_status] ?? 4) - (order[y.agent_status] ?? 4) || placeOf(x).localeCompare(placeOf(y)),
  );
  const lines = rows.map((a) => {
    const v = views.get(paneKey(a));
    const since = v ? `${v.sinceStart ? "≥" : ""}${s.duration(o.now - v.since)}` : "?";
    return s.statusLine(placeOf(a), agentName(a), s.state(a.agent_status), since, titleOf(a));
  });
  return { text: `${s.statusHead(o.machine, rows.length)}\n${lines.join("\n")}`, sections: [footer] };
}

export const quietLabel = (q: { start: number; end: number } | null) => {
  if (!q) return null;
  const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${hm(q.start)}-${hm(q.end)}`;
};
