/** How a notice, a status listing and the dialog buttons look on Feishu (RenderedMessage cards). */
import { basename } from "node:path";
import type { HerdrAgent } from "./herdr.ts";
import type { Strings } from "./i18n.ts";
import type { RenderedMessage } from "./protocol.ts";
import { redact } from "./redact.ts";
import type { DialogOption } from "./screen.ts";
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
  timeZone: string;
  s: Strings;
  /** The notice goes into a workbench topic (else a DM). */
  topic: boolean;
  /** Our thread id, for buttons. */
  threadId: string | null;
  options: DialogOption[];
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
