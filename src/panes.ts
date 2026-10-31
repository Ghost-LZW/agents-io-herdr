/**
 * The owner's own look into herdr, any time: list every pane (agents and plain terminals), read
 * one's screen, type into it, press keys. Parsing, naming panes and the cards are here; the bridge
 * does the I/O.
 *
 * - `/ls`: every pane, with a "view" button each;
 * - `/view <pane> [lines]`: the pane's screen (in a pane's topic: `/view [lines]`);
 * - `/send <pane> <text>`: text and Enter (an agent: `agent.prompt`, refused while a dialog is open);
 * - `/keys <pane> <key>…`: key presses, herdr's names (`esc`, `enter`, `ctrl+c`, `up`, `1`; in a topic: `/keys …`).
 *
 * A pane is named by its id (`w1:p2`), its short id (`p2`), its tab's label or its directory.
 */
import type { HerdrAgent, HerdrTab } from "./herdr.ts";
import type { Strings } from "./i18n.ts";
import { agentName, placeOf, tabLabels, titleOf } from "./notice.ts";
import type { RenderedMessage } from "./protocol.ts";
import { processAction, screenText, viewAction } from "./terminal-controls.ts";

export { PANE_KEY_ACTION, paneButtons, VIEW_ACTION, viewAction } from "./terminal-controls.ts";

export type PaneCommand =
  | { cmd: "panes" }
  | { cmd: "view"; ref: string | null; lines: number | null }
  | { cmd: "process"; ref: string | null }
  | { cmd: "send"; ref: string | null; text: string }
  | { cmd: "keys"; ref: string | null; keys: string[] }
  | { cmd: "usage" };

const WORDS: Record<string, "panes" | "view" | "process" | "send" | "keys"> = {
  ls: "panes",
  view: "view",
  process: "process",
  send: "send",
  keys: "keys",
};

export const VIEW_LINES = 80;
export const VIEW_LINES_MAX = 200;
export const KEYS_MAX = 16;
/** A card's text stays well under Feishu's limit. */
const VIEW_BUTTONS_MAX = 10;

/**
 * A pane command (`/` and the word), or null. In a pane's topic (or a reply to its notice) only
 * `/view` and `/keys` are commands, acting on that pane; everything else there, other slash
 * commands too (the agent's own `/compact`, `/status`), is typed into the agent.
 */
export function paneCommandOf(text: string, inThread: boolean): PaneCommand | null {
  const t = text.replace(/(^|\s)@\S+/g, "$1").trim();
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(t);
  const cmd = m ? WORDS[(m[1] as string).toLowerCase()] : undefined;
  if (!m || !cmd) return null;
  const rest = (m[2] ?? "").trim();
  const words = rest ? rest.split(/\s+/) : [];
  const lines = (s: string | undefined) => (s && /^\d{1,4}$/.test(s) ? Math.min(Number(s), VIEW_LINES_MAX) : null);
  if (inThread) {
    if (cmd === "process") return words.length ? { cmd: "usage" } : { cmd, ref: null };
    if (cmd === "view" && words.length <= 1 && (!words[0] || lines(words[0])))
      return { cmd, ref: null, lines: lines(words[0]) };
    if (cmd === "keys" && words.length >= 1 && words.length <= KEYS_MAX)
      return { cmd, ref: null, keys: words.map((k) => k.toLowerCase()) };
    return cmd === "view" || cmd === "keys" ? { cmd: "usage" } : null;
  }
  switch (cmd) {
    case "panes":
      return words.length ? null : { cmd };
    case "view":
      if (words.length < 1 || words.length > 2 || (words[1] && !lines(words[1]))) return { cmd: "usage" };
      return { cmd, ref: words[0] as string, lines: lines(words[1]) };
    case "process":
      return words.length === 1 ? { cmd, ref: words[0] as string } : { cmd: "usage" };
    case "send": {
      const s = /^(\S+)\s+([\s\S]+)$/.exec(rest);
      return s ? { cmd, ref: s[1] as string, text: (s[2] as string).trim() } : { cmd: "usage" };
    }
    case "keys":
      if (words.length < 2 || words.length > KEYS_MAX + 1) return { cmd: "usage" };
      return { cmd, ref: words[0] as string, keys: words.slice(1).map((k) => k.toLowerCase()) };
  }
}

export { shortId } from "./notice.ts";

export type Resolved = { ok: true; pane: HerdrAgent } | { ok: false; candidates: HerdrAgent[] };

/** The pane `ref` names: its id, its short id, its tab's label, its directory — the first that fits. */
export function resolvePane(ref: string, panes: HerdrAgent[], tabs: HerdrTab[]): Resolved {
  const r = ref.toLowerCase();
  const label = new Map(tabs.map((t) => [t.tab_id, t.label.toLowerCase()]));
  const tests: ((p: HerdrAgent) => boolean)[] = [
    (p) => p.pane_id.toLowerCase() === r,
    (p) => p.pane_id.slice(p.pane_id.lastIndexOf(":") + 1).toLowerCase() === r,
    (p) => !!p.tab_id && label.get(p.tab_id) === r,
    (p) => placeOf(p).toLowerCase() === r,
  ];
  for (const test of tests) {
    const hits = panes.filter(test);
    if (hits.length === 1) return { ok: true, pane: hits[0] as HerdrAgent };
    if (hits.length > 1) return { ok: false, candidates: hits };
  }
  return { ok: false, candidates: [] };
}

const kindOf = (p: HerdrAgent, s: Strings) => (p.agent ? agentName(p) : s.terminalKind);

/** Tab order as herdr shows it, then pane id. */
export function sortPanes(panes: HerdrAgent[], tabs: HerdrTab[]): HerdrAgent[] {
  const num = new Map(tabs.map((t) => [t.tab_id, t.number]));
  const ord = (p: HerdrAgent) => num.get(p.tab_id ?? "") ?? Number.MAX_SAFE_INTEGER;
  return [...panes].sort((a, b) => ord(a) - ord(b) || a.pane_id.localeCompare(b.pane_id));
}

/** `ls`: every pane, one line each, a view button each (the first ten). */
export function panesMessage(o: {
  machine: string;
  panes: HerdrAgent[];
  tabs: HerdrTab[];
  s: Strings;
}): RenderedMessage {
  const { s } = o;
  const rows = sortPanes(o.panes, o.tabs);
  const footer = { kind: "footer" as const, text: s.panesFooter };
  if (!rows.length) return { text: `${s.panesHead(o.machine, 0)}\n${s.panesNone}`, sections: [footer] };
  const label = tabLabels(o.tabs);
  const lines = rows.map((p) =>
    s.paneLine(
      p.pane_id,
      label.get(p.tab_id ?? "") ?? "",
      placeOf(p),
      kindOf(p, s),
      p.agent ? s.state(p.agent_status) : "",
      titleOf(p),
    ),
  );
  const actions = rows.slice(0, VIEW_BUTTONS_MAX).map((p) => ({
    id: viewAction(p.terminal_id),
    label: s.viewLabel(p.pane_id),
  }));
  return { text: `${s.panesHead(o.machine, rows.length)}\n${lines.join("\n")}`, sections: [footer], actions };
}

/** `/view`: one pane's screen, a refresh button, and a waiting dialog's choices when there are some. */
export function viewMessage(o: {
  machine: string;
  pane: HerdrAgent;
  /** Its short id, as `ls` shows it. */
  id: string;
  screen: string;
  s: Strings;
  /** Where replies to this card go, as a footer line. */
  footer: string;
  /** Buttons before the refresh button (a dialog's keys). */
  actions?: RenderedMessage["actions"];
}): RenderedMessage {
  const { s, pane: p } = o;
  const screen = screenText(o.screen);
  const head = s.viewHead(o.machine, o.id, placeOf(p), kindOf(p, s), p.agent ? s.state(p.agent_status) : "");
  const title = titleOf(p);
  return {
    text: `${head}${title ? `\n${title}` : ""}${screen ? `\n\n${screen}` : `\n${s.viewEmpty}`}`,
    sections: [{ kind: "footer", text: o.footer }],
    actions: [
      ...(o.actions ?? []),
      { id: viewAction(p.terminal_id), label: s.refreshLabel },
      ...(p.agent ? [{ id: processAction(p.terminal_id), label: s.processLabel }] : []),
    ],
  };
}
