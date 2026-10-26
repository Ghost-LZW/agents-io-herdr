/**
 * What an agent did in its last turn, from the transcript it writes itself, not from its screen:
 * Claude Code's `~/.claude/projects/<dir>/<session id>.jsonl`, Codex's
 * `~/.codex/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`. herdr names the session of each agent pane
 * (`agent_session`). The screen shows what fits; the transcript has the whole answer, every tool
 * call with its result, and the thinking when the model wrote it down.
 *
 * Only the tail of a transcript is read (they grow to tens of MB); a turn that began before it
 * comes back with `truncated`.
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HerdrAgent } from "./herdr.ts";

export type Step =
  | { kind: "thinking"; text: string }
  /** What the agent says between tool calls (not its final answer). */
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; subject: string; result: string | null; error: boolean };

export interface Turn {
  /** What the person asked (or what started the turn), as written. */
  prompt: string;
  steps: Step[];
  /** The final answer: the agent's text after its last tool call. */
  answer: string;
  /** The turn began before the part of the transcript that was read. */
  truncated: boolean;
}

export interface TranscriptSource {
  /** The agent's current (or last) turn; null when there is no transcript to read. */
  turn(agent: HerdrAgent): Promise<Turn | null>;
}

const TAIL_BYTES = 8 * 1024 * 1024;

/** The last `max` bytes of a file, from the first whole line. */
function tail(path: string, max = TAIL_BYTES): { text: string; cut: boolean } {
  const size = statSync(path).size;
  const start = Math.max(0, size - max);
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - start);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    let text = buf.subarray(0, off).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { text, cut: start > 0 };
  } finally {
    closeSync(fd);
  }
}

// biome-ignore lint/suspicious/noExplicitAny: transcript lines are foreign JSON
type Json = any;

function lines(text: string): Json[] {
  const out: Json[] = [];
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (o && typeof o === "object") out.push(o);
    } catch {
      // a half-written last line, or not JSON: skipped
    }
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The one thing a tool call is about: the command, the file, the pattern, the URL… */
export function subjectOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  for (const k of [
    "command",
    "cmd",
    "file_path",
    "notebook_path",
    "pattern",
    "query",
    "path",
    "url",
    "description",
    "prompt",
  ]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) {
      // Grep and Glob: the pattern and where.
      if ((k === "pattern" || k === "query") && typeof o.path === "string") return `${v} (${o.path})`;
      return v;
    }
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(" ");
  }
  for (const v of Object.values(o)) if (typeof v === "string" && v.trim()) return v;
  return "";
}

/** A tool result's text (a string, or text blocks; images and the like are left out). */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** Steps up to the last tool call are the process; the text after it is the answer. */
function settle(prompt: string, steps: Step[], truncated: boolean): Turn {
  const lastTool = steps.findLastIndex((s) => s.kind === "tool");
  const tailSteps = steps.slice(lastTool + 1);
  const answer = tailSteps
    .filter((s): s is Extract<Step, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const process = [...steps.slice(0, lastTool + 1), ...tailSteps.filter((s) => s.kind !== "text")];
  return { prompt, steps: process, answer, truncated };
}

// ---- Claude Code --------------------------------------------------------------------------------

/** A user line that starts a turn: something the person (or a notification) said, not a tool result. */
function claudeTurnStart(o: Json): string | null {
  if (o.type !== "user" || o.isMeta || o.isSidechain || o.isCompactSummary) return null;
  const c = o.message?.content;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (!c.some((b) => b && b.type === "text")) return null;
    text = c
      .filter((b) => b && b.type === "text")
      .map((b) => str(b.text))
      .join("\n");
  } else return null;
  // A slash command run locally (`/model`) answers itself; the model does not take a turn.
  if (/^\s*<(?:local-command-|command-name>|command-message>)/.test(text)) return null;
  return text;
}

export function claudeTurn(text: string, truncated: boolean): Turn | null {
  const rows = lines(text);
  // From the end: the last turn start that the model answered.
  let end = rows.length;
  for (let i = rows.length - 1; i >= -1; i--) {
    const prompt = i >= 0 ? claudeTurnStart(rows[i]) : truncated ? "" : null;
    if (prompt === null) continue;
    const body = rows.slice(i + 1, end);
    const answered = body.some((o) => o.type === "assistant" && !o.isSidechain && !o.isApiErrorMessage);
    if (answered) return claudeSteps(prompt, body, i < 0);
    end = Math.max(i, 0);
  }
  return null;
}

function claudeSteps(prompt: string, rows: Json[], truncated: boolean): Turn {
  const steps: Step[] = [];
  const tools = new Map<string, Extract<Step, { kind: "tool" }>>();
  for (const o of rows) {
    if (o.isSidechain || o.isApiErrorMessage) continue;
    const c = o.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== "object") continue;
      if (o.type === "assistant") {
        if (b.type === "thinking" && str(b.thinking).trim()) steps.push({ kind: "thinking", text: b.thinking });
        else if (b.type === "text" && str(b.text).trim()) steps.push({ kind: "text", text: b.text });
        else if (b.type === "tool_use" && typeof b.id === "string") {
          const s = {
            kind: "tool" as const,
            id: b.id,
            name: str(b.name),
            subject: subjectOf(b.input),
            result: null,
            error: false,
          };
          tools.set(b.id, s);
          steps.push(s);
        }
      } else if (o.type === "user" && b.type === "tool_result") {
        const s = tools.get(str(b.tool_use_id));
        if (s) {
          s.result = resultText(b.content);
          s.error = b.is_error === true;
        }
      }
    }
  }
  return settle(prompt, steps, truncated);
}

/** `~/.claude/projects/*\/<id>.jsonl` (the directory is the session's start directory, mangled). */
function claudeFile(home: string, id: string): string | null {
  const root = join(home, ".claude", "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = join(root, d, `${id}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

// ---- Codex --------------------------------------------------------------------------------------

/** Codex's own context messages, not something the person said. */
const CODEX_CONTEXT = /^\s*<(?:environment_context|user_instructions|permissions|turn_aborted|user_shell_command)/;

function codexOutput(output: unknown): string {
  if (typeof output !== "string") return output === undefined ? "" : JSON.stringify(output);
  if (output.startsWith("{")) {
    try {
      const p = JSON.parse(output);
      if (p && typeof p.output === "string") return p.output;
    } catch {
      // not the wrapped shape
    }
  }
  return output;
}

function codexArgs(s: unknown): unknown {
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function codexTurn(text: string, truncated: boolean): Turn | null {
  const rows = lines(text);
  let start = rows.findLastIndex((o) => o.type === "event_msg" && o.payload?.type === "task_started");
  let prompt = "";
  if (start < 0) {
    start = rows.findLastIndex(
      (o) =>
        o.type === "response_item" &&
        o.payload?.type === "message" &&
        o.payload.role === "user" &&
        !CODEX_CONTEXT.test(resultText((o.payload.content ?? []).map((b: Json) => ({ type: "text", text: b?.text })))),
    );
  }
  if (start < 0 && !truncated) return null;
  const steps: Step[] = [];
  const tools = new Map<string, Extract<Step, { kind: "tool" }>>();
  const call = (id: string, name: string, input: unknown) => {
    const s = {
      kind: "tool" as const,
      id,
      name,
      subject: oneLine(subjectOf(input)).slice(0, 2000),
      result: null,
      error: false,
    };
    if (id) tools.set(id, s);
    steps.push(s);
  };
  for (const o of rows.slice(start + 1)) {
    const p = o.payload;
    if (o.type !== "response_item" || !p) continue;
    const id = str(p.call_id) || str(p.id);
    if (p.type === "message") {
      const t = (Array.isArray(p.content) ? p.content : [])
        .map((b: Json) => str(b?.text))
        .join("\n")
        .trim();
      if (!t) continue;
      if (p.role === "assistant") steps.push({ kind: "text", text: t });
      else if (p.role === "user" && !CODEX_CONTEXT.test(t)) prompt ||= t;
    } else if (p.type === "reasoning") {
      const parts = (Array.isArray(p.summary) ? p.summary : []).map((b: Json) => str(b?.text)).filter(Boolean);
      if (!parts.length)
        parts.push(...(Array.isArray(p.content) ? p.content : []).map((b: Json) => str(b?.text)).filter(Boolean));
      if (parts.length) steps.push({ kind: "thinking", text: parts.join("\n\n") });
    } else if (p.type === "function_call") call(id, str(p.name), codexArgs(p.arguments));
    else if (p.type === "custom_tool_call")
      call(
        id,
        str(p.name),
        str(p.input)
          .split("\n")
          .find((l: string) => l.trim()) ?? "",
      );
    else if (p.type === "local_shell_call") call(id, "shell", p.action);
    else if (p.type === "web_search_call") call(id, "web_search", p.action);
    else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const s = tools.get(id);
      if (s) s.result = codexOutput(p.output);
    }
  }
  if (!steps.length) return null;
  return settle(prompt, steps, start < 0);
}

/** `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl`, the newest days first. */
function codexFile(codexHome: string, id: string): string | null {
  const root = join(codexHome, "sessions");
  const desc = (dir: string) => {
    try {
      return readdirSync(dir)
        .filter((n) => /^\d+$/.test(n))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  let days = 0;
  for (const y of desc(root))
    for (const m of desc(join(root, y)))
      for (const d of desc(join(root, y, m))) {
        if (++days > 120) return null;
        const dir = join(root, y, m, d);
        const hit = readdirSync(dir).find((n) => n.endsWith(`-${id}.jsonl`) || n === `${id}.jsonl`);
        if (hit) return join(dir, hit);
      }
  return null;
}

// ---- the source ---------------------------------------------------------------------------------

/** Session ids and paths are looked up once per session. */
export function transcriptSource(o: { home: string; codexHome?: string }): TranscriptSource {
  const paths = new Map<string, string | null>();
  const locate = (a: HerdrAgent): { path: string; kind: "claude" | "codex" } | null => {
    const s = a.agent_session;
    if (!s || typeof s.value !== "string" || !s.value) return null;
    const kind = a.agent === "claude" ? "claude" : a.agent === "codex" ? "codex" : null;
    if (!kind) return null;
    if (s.kind === "path") return existsSync(s.value) ? { path: s.value, kind } : null;
    if (!/^[\w-]{8,64}$/.test(s.value)) return null;
    const key = `${kind}:${s.value}`;
    let path = paths.get(key);
    if (path === undefined || (path && !existsSync(path))) {
      path =
        kind === "claude" ? claudeFile(o.home, s.value) : codexFile(o.codexHome ?? join(o.home, ".codex"), s.value);
      // Not found yet (a brand new session writes its file on the first prompt): look again next time.
      if (path) paths.set(key, path);
    }
    return path ? { path, kind } : null;
  };
  return {
    async turn(a) {
      const f = locate(a);
      if (!f) return null;
      const { text, cut } = tail(f.path);
      return f.kind === "claude" ? claudeTurn(text, cut) : codexTurn(text, cut);
    },
  };
}
