/**
 * What of an agent's pane goes into a notification: the last lines of its output, without the
 * terminal UI around them (Claude Code's side panel and input box, Codex's footer), secrets hidden.
 */
import { redact } from "./redact.ts";

/** Display width of a character: East Asian wide and fullwidth forms take two columns. */
function charWidth(cp: number): number {
  return (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
    ? 2
    : 1;
}

/** The display column of each `│` in a line. */
function barColumns(line: string): number[] {
  const cols: number[] = [];
  let col = 0;
  for (const ch of line) {
    if (ch === "│") cols.push(col);
    col += charWidth(ch.codePointAt(0) ?? 0);
  }
  return cols;
}

/** Cuts a line at a display column. */
function cutAt(line: string, column: number): string {
  let col = 0;
  let out = "";
  for (const ch of line) {
    if (col >= column) break;
    out += ch;
    col += charWidth(ch.codePointAt(0) ?? 0);
  }
  return out;
}

/**
 * A side panel shows as a `│` at the same display column on most lines (Claude Code's panel on
 * the right); everything from that column on is cut. Tables also draw `│`, but not at one column
 * on most of the screen.
 */
export function cutSidePanel(lines: string[]): string[] {
  const counts = new Map<number, number>();
  for (const l of lines) for (const c of new Set(barColumns(l))) counts.set(c, (counts.get(c) ?? 0) + 1);
  const wide = lines.filter((l) => l.trim()).length;
  let panel: number | null = null;
  for (const [col, n] of counts) if (col >= 40 && n >= wide * 0.6 && (panel === null || col < panel)) panel = col;
  return panel === null ? lines : lines.map((l) => cutAt(l, panel));
}

const RULE = /^\s*[─━═]{10,}\s*$/;
const CHROME = [
  /bypass permissions on/,
  /\? for shortcuts/,
  /Ask Codex to do anything/,
  /\/clear to save/,
  /Update available/,
  /esc to interrupt/,
  /^\s*⏵⏵/,
  /^\s*←\s*for agents/,
  /\/ps to view/,
];

/** Drops the UI under the last output: Claude Code's input box (between two rules), Codex's footer. */
export function dropChrome(lines: string[]): string[] {
  let end = lines.length;
  const rules = lines.map((l, i) => (RULE.test(l) ? i : -1)).filter((i) => i >= 0);
  // Claude Code: the input box is the last two rules near the bottom, and what is between them.
  if (rules.length >= 2) {
    const first = rules[rules.length - 2] as number;
    if (lines.length - first <= 10) end = first;
  }
  // Codex: the prompt line `› …` and the model line under it (not `› 1. Yes`, a dialog's choice).
  for (let i = end - 1; i >= Math.max(0, end - 8); i--) {
    if (/^\s*›\s(?!\s*\d{1,2}[.)]\s)/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return lines.slice(0, end).filter((l) => !RULE.test(l) && !CHROME.some((re) => re.test(l)));
}

/** The pane's lines without the UI around them, trailing spaces trimmed. */
const cleanLines = (text: string) => cutSidePanel(dropChrome(text.split("\n"))).map((l) => l.replace(/\s+$/, ""));

/** Collapses runs of blank lines and drops trailing ones. */
function squeeze(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    if (!l && (!out.length || !out[out.length - 1])) continue;
    out.push(l);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

/** The last `max` lines worth reading, blank runs collapsed, secrets hidden. */
export function tailOf(text: string, max = 20): string {
  const tail = squeeze(cleanLines(text)).slice(-max);
  // A common indent makes the block narrower on a phone.
  const indent = Math.min(...tail.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  const body = tail.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
  return redact(body).text;
}

export interface DialogOption {
  /** The key to press (`1`…`9`). */
  key: string;
  label: string;
}

/**
 * A dialog's numbered choices near the end of the tail (`❯ 1. Yes`, `  2. No…`, Codex's `› 1. …`),
 * as buttons: the number is the key to press. Two to nine choices in one run, else none.
 */
export function optionsOf(tail: string): DialogOption[] {
  const lines = tail.split("\n").slice(-15);
  // The shortcut a dialog shows after a choice, `(esc)`, `(y)`, is not part of its label.
  const label = (s: string) => s.replace(/\s*\((?:esc|enter|[a-z])\)$/i, "").slice(0, 48);
  let run: DialogOption[] = [];
  let best: DialogOption[] = [];
  for (const l of lines) {
    const m = /^\s*(?:[❯›>]\s*)?(\d)[.)]\s+(.+?)\s*$/.exec(l);
    if (m && (run.length ? Number(m[1]) === Number(run[run.length - 1]?.key) + 1 : m[1] === "1")) {
      run.push({ key: m[1] as string, label: label(m[2] as string) });
      continue;
    }
    if (run.length >= 2) best = run;
    run = m?.[1] === "1" ? [{ key: "1", label: label(m[2] as string) }] : [];
  }
  if (run.length >= 2) best = run;
  return best;
}

/** A tool call or step line, not the agent speaking: Claude Code's `⏺ Bash(…)`, Codex's `• Ran …`. */
const STEP =
  /^(?:⏺ [A-Za-z][\w.-]*\(|• (?:Ran|Edited|Explored|Read|Searched|Updated|Added|Deleted|Waited|Called|Working)\b)/;

/**
 * What a finished turn says, from its start: Claude Code's recap line (`※ recap: …`) when there is
 * one, then the head of the last message (the last `⏺ ` / `• ` line that is not a step) — the
 * conclusion comes first in a final answer, so the head says more than the tail. When the message
 * began above what was read, its last lines. Secrets hidden.
 */
export function summaryOf(text: string, max = 16): string {
  const lines = cleanLines(text);
  const recapAt = lines.findLastIndex((l) => /^※ recap:/.test(l.trim()));
  const recap: string[] = [];
  if (recapAt >= 0) {
    recap.push(lines[recapAt]?.trim() ?? "");
    for (const l of lines.slice(recapAt + 1)) {
      if (!l.trim() || /^\S/.test(l)) break;
      recap.push(l.trim());
    }
  }
  const body = recapAt >= 0 ? lines.slice(0, recapAt) : lines;
  const start = body.findLastIndex((l) => /^(?:⏺|•) /.test(l) && !STEP.test(l));
  // The message began above what was read: its last lines, after the recap.
  const head = (start < 0 ? body.slice(-max) : body.slice(start)).filter((l) => !/^✻ /.test(l.trim()));
  const out = squeeze(head);
  const shown = out.slice(0, max);
  if (out.length > max) shown.push("…");
  return redact([...recap, ...(recap.length ? [""] : []), ...shown].join("\n")).text;
}
