/**
 * One page of a session's transcript, for LB's `session.read` (docs/sessions.md): people's prompts, the
 * agent's words, tool calls and their results, each redacted on this machine before it leaves, each
 * cut to `ENTRY_MAX` characters; a page holds at most `PAGE_MAX` entries and `PAGE_CHARS` characters.
 * Thinking, reasoning, request records and other bookkeeping lines are left out.
 */
import { readFileSync } from "node:fs";
import { redact } from "./redact.ts";
import type { AgentKind } from "./sessions.ts";

export type EntryRole = "user" | "assistant" | "tool" | "tool_result";

export interface Entry {
  n: number;
  at: string | null;
  role: EntryRole;
  /** The tool's name (tool, tool_result when known). */
  tool?: string;
  text: string;
  truncated?: boolean;
}

export interface Page {
  total: number;
  offset: number;
  entries: Entry[];
  /** The offset of the next page, null at the end. */
  next: number | null;
  /** The offset of the previous page, null at the start. */
  prev: number | null;
  /** How many secret-looking strings were hidden on this page. */
  redacted: number;
}

export const ENTRY_MAX = 2000;
export const TOOL_MAX = 600;
export const PAGE_MAX = 100;
export const PAGE_DEFAULT = 30;
export const PAGE_CHARS = 40_000;

type Raw = Omit<Entry, "n">;
type Line = Record<string, unknown>;

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));

function claudeEntries(d: Line, out: Raw[]): void {
  const at = typeof d.timestamp === "string" ? d.timestamp : null;
  const msg = d.message as { content?: unknown } | undefined;
  if (!msg || (d.type !== "user" && d.type !== "assistant") || d.isMeta) return;
  const content = msg.content;
  if (typeof content === "string") {
    if (content.trim()) out.push({ at, role: d.type === "user" ? "user" : "assistant", text: content });
    return;
  }
  if (!Array.isArray(content)) return;
  for (const c of content as Line[]) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "text" && str(c.text).trim())
      out.push({ at, role: d.type === "user" ? "user" : "assistant", text: str(c.text) });
    else if (c.type === "tool_use") out.push({ at, role: "tool", tool: str(c.name), text: str(c.input) });
    else if (c.type === "tool_result") {
      const r = c.content;
      const text = Array.isArray(r)
        ? (r as Line[]).map((x) => (x?.type === "text" ? str(x.text) : `[${str(x?.type)}]`)).join("\n")
        : str(r);
      out.push({ at, role: "tool_result", text });
    }
  }
}

function codexEntries(d: Line, out: Raw[]): void {
  const at = typeof d.timestamp === "string" ? d.timestamp : null;
  const pl = (d.payload ?? {}) as Line;
  if (d.type === "event_msg" && pl.type === "user_message") {
    out.push({ at, role: "user", text: str(pl.message) });
    return;
  }
  if (d.type !== "response_item") return;
  if (pl.type === "message" && pl.role === "assistant") {
    const content = Array.isArray(pl.content) ? (pl.content as Line[]) : [];
    const text = content
      .filter((c) => c?.type === "output_text")
      .map((c) => str(c.text))
      .join("\n");
    if (text.trim()) out.push({ at, role: "assistant", text });
  } else if (pl.type === "function_call" || pl.type === "custom_tool_call" || pl.type === "local_shell_call") {
    out.push({ at, role: "tool", tool: str(pl.name || pl.type), text: str(pl.arguments ?? pl.input ?? pl.action) });
  } else if (pl.type === "function_call_output" || pl.type === "custom_tool_call_output") {
    const o = pl.output;
    const text = Array.isArray(o)
      ? (o as Line[]).map((x) => (typeof x?.text === "string" ? x.text : `[${str(x?.type)}]`)).join("\n")
      : typeof o === "object" && o !== null && "output" in o
        ? str((o as Line).output)
        : str(o);
    out.push({ at, role: "tool_result", text });
  }
}

/** Every entry of a transcript, unredacted (callers page and redact). */
export function entriesOf(path: string, agent: AgentKind): Raw[] {
  const out: Raw[] = [];
  const handle = agent === "claude" ? claudeEntries : codexEntries;
  for (const l of readFileSync(path, "utf8").split("\n")) {
    if (!l.trim()) continue;
    let d: Line;
    try {
      d = JSON.parse(l) as Line;
    } catch {
      continue;
    }
    if (d && typeof d === "object") handle(d, out);
  }
  return out;
}

/**
 * A page of entries. Without `offset` the last page (what the session is doing now); `limit`
 * defaults to `PAGE_DEFAULT`, at most `PAGE_MAX`; a page stops early at `PAGE_CHARS` characters.
 */
export function pageOf(raw: Raw[], o: { offset?: number | null; limit?: number | null } = {}): Page {
  const total = raw.length;
  const limit = Math.max(1, Math.min(PAGE_MAX, Math.floor(o.limit ?? PAGE_DEFAULT)));
  const offset = Math.max(0, Math.min(total, o.offset == null ? total - limit : Math.floor(o.offset)));
  const entries: Entry[] = [];
  let chars = 0;
  let redacted = 0;
  for (let n = offset; n < total && entries.length < limit; n++) {
    const e = raw[n] as Raw;
    const max = e.role === "tool" || e.role === "tool_result" ? TOOL_MAX : ENTRY_MAX;
    const r = redact(e.text, { strict: true });
    redacted += r.count;
    const cut = r.text.length > max;
    const text = cut ? `${r.text.slice(0, max)}…` : r.text;
    if (entries.length > 0 && chars + text.length > PAGE_CHARS) break;
    chars += text.length;
    entries.push({
      n,
      at: e.at,
      role: e.role,
      ...(e.tool ? { tool: e.tool } : {}),
      text,
      ...(cut ? { truncated: true } : {}),
    });
  }
  const end = offset + entries.length;
  return {
    total,
    offset,
    entries,
    next: end < total ? end : null,
    prev: offset > 0 ? Math.max(0, offset - limit) : null,
    redacted,
  };
}

export function readPage(
  path: string,
  agent: AgentKind,
  o: { offset?: number | null; limit?: number | null } = {},
): Page {
  return pageOf(entriesOf(path, agent), o);
}
