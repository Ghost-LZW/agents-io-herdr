/**
 * The machine's Claude Code and Codex sessions, for LB (docs/sessions.md): what runs now and
 * what ended recently, in herdr panes, in plain terminals and headless. Read only: it reads the
 * agents' own transcript files, Claude Code's live-session registry, `ps`/`lsof`, and herdr's
 * `agent.list`; it never writes into an agent or a transcript.
 *
 * Transcripts are parsed incrementally (each file from where the last scan stopped), so a scan every
 * few seconds costs only the new lines.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { HerdrAgent } from "./herdr.ts";
import { redact } from "./redact.ts";
import type { Exec } from "./system.ts";

export type AgentKind = "claude" | "codex";
/** running: a turn is under way; waiting: open, the agent waits for a person; ended: no process. */
export type SessionState = "running" | "waiting" | "ended";

/** One session as reported (no file paths leave the machine). */
export interface MachineSession {
  id: string;
  agent: AgentKind;
  machine: string;
  cwd: string | null;
  /** The agent's title (Claude Code's ai/custom title, Codex's thread name), redacted. */
  title: string | null;
  /** The first thing a person said, redacted, at most 200 characters. */
  firstPrompt: string | null;
  state: SessionState;
  startedAt: string | null;
  lastActivityAt: string;
  /** One line: title or first prompt, then the latest words (redacted). */
  summary: string;
  /** The herdr pane it runs in, if any. */
  paneId: string | null;
  /** Run without a terminal (`claude -p`, the SDK, `codex exec`). */
  headless: boolean;
}

/** What a scan knows of one transcript file (kept between scans). */
export interface Parsed {
  path: string;
  agent: AgentKind;
  id: string;
  cwd: string | null;
  title: string | null;
  /** A title the person set (`/rename`); wins over the agent's. */
  customTitle: string | null;
  firstPrompt: string | null;
  startedAt: string | null;
  lastAt: string | null;
  lastText: string | null;
  /** A turn started (a person's prompt, a tool call) and has not ended. */
  turnOpen: boolean;
  headless: boolean;
  offset: number;
  partial: string;
  mtimeMs: number;
}

export interface ScanInput {
  home: string;
  machine: string;
  now: number;
  /** herdr's `agent.list`, or null when herdr is not there. */
  herdr: HerdrAgent[] | null;
  exec: Exec;
  /** Whether a process lives (injected for tests). */
  alive: (pid: number) => boolean;
  /** Ended sessions older than this are left out. */
  recentMs: number;
  cache: Map<string, Parsed>;
  /** Codex thread names by id (session_index.jsonl), cached by the caller. */
  codexNames?: Map<string, string>;
}

/** The roots that hold transcripts on this machine. */
export function roots(home: string): { claude: string[]; codex: string[]; registries: string[] } {
  return {
    claude: [join(home, ".config", "claude", "projects"), join(home, ".claude", "projects")],
    codex: [join(home, ".codex", "sessions"), join(home, ".config", "codex", "sessions")],
    registries: [join(home, ".config", "claude", "sessions"), join(home, ".claude", "sessions")],
  };
}

const MAX_FIRST_READ = 16 * 1024 * 1024;
const HEAD_READ = 2 * 1024 * 1024;
const TAIL_READ = 4 * 1024 * 1024;
/** A session without a process counts as running while its transcript moves (headless runs). */
const ACTIVE_MS = 120_000;

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const clean = (s: string, max: number) => oneLine(redact(s, { strict: true }).text, max);

/** Words a person typed, not a command echo, a reminder or other wrapped text. */
const isPersonText = (s: string) => {
  const t = s.trim();
  return t.length > 0 && !t.startsWith("<") && !t.startsWith("[Request interrupted");
};

function readRange(path: string, start: number, end: number): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function textOf(content: unknown, kinds: string[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c && typeof c === "object" && kinds.includes((c as { type?: string }).type ?? ""))
    .map((c) => String((c as { text?: unknown }).text ?? ""))
    .join("\n");
}

type Line = Record<string, unknown>;

function claudeLine(p: Parsed, d: Line): void {
  const ts = typeof d.timestamp === "string" ? d.timestamp : null;
  if (typeof d.sessionId === "string" && p.id === basename(p.path, ".jsonl")) p.id = d.sessionId;
  if (!p.cwd && typeof d.cwd === "string") p.cwd = d.cwd;
  if (typeof d.entrypoint === "string" && d.entrypoint.startsWith("sdk")) p.headless = true;
  const type = d.type;
  if (type === "custom-title" && typeof d.customTitle === "string") p.customTitle = d.customTitle;
  else if (type === "ai-title" && typeof d.aiTitle === "string") p.title = d.aiTitle;
  else if (type === "summary" && typeof d.summary === "string" && !p.title) p.title = d.summary;
  if (ts && (type === "user" || type === "assistant" || type === "system")) {
    if (!p.startedAt) p.startedAt = ts;
    if (!p.lastAt || ts > p.lastAt) p.lastAt = ts;
  }
  const msg = d.message as { content?: unknown; stop_reason?: unknown } | undefined;
  if (type === "user" && !d.isMeta && msg) {
    const text = textOf(msg.content, ["text"]);
    if (isPersonText(text)) {
      if (!p.firstPrompt) p.firstPrompt = clean(text, 200);
      p.lastText = text;
    }
    p.turnOpen = true;
  } else if (type === "assistant" && msg) {
    const text = textOf(msg.content, ["text"]);
    if (text.trim()) p.lastText = text;
    const tool = Array.isArray(msg.content) && msg.content.some((c) => (c as { type?: string })?.type === "tool_use");
    if (tool) p.turnOpen = true;
    else if (msg.stop_reason === "end_turn") p.turnOpen = false;
  } else if (type === "system" && d.subtype === "turn_duration") {
    p.turnOpen = false;
  }
}

function codexLine(p: Parsed, d: Line): void {
  const ts = typeof d.timestamp === "string" ? d.timestamp : null;
  const pl = (d.payload ?? {}) as Line;
  if (ts) {
    if (!p.startedAt) p.startedAt = ts;
    if (!p.lastAt || ts > p.lastAt) p.lastAt = ts;
  }
  if (d.type === "session_meta") {
    if (typeof pl.id === "string") p.id = pl.id;
    if (typeof pl.cwd === "string") p.cwd = pl.cwd;
    if (typeof pl.timestamp === "string") p.startedAt = pl.timestamp;
    const how = `${String(pl.originator ?? "")} ${String(pl.source ?? "")}`;
    if (/exec|sdk|mcp/i.test(how)) p.headless = true;
    return;
  }
  if (d.type === "turn_context" && !p.cwd && typeof pl.cwd === "string") p.cwd = pl.cwd;
  if (d.type === "event_msg") {
    if (pl.type === "user_message" && typeof pl.message === "string") {
      if (isPersonText(pl.message)) {
        if (!p.firstPrompt) p.firstPrompt = clean(pl.message, 200);
        p.lastText = pl.message;
      }
      p.turnOpen = true;
    } else if (pl.type === "task_started") p.turnOpen = true;
    else if (pl.type === "task_complete" || pl.type === "turn_aborted") {
      p.turnOpen = false;
      if (typeof pl.last_agent_message === "string" && pl.last_agent_message.trim()) p.lastText = pl.last_agent_message;
    } else if (pl.type === "agent_message" && typeof pl.message === "string") p.lastText = pl.message;
    return;
  }
  if (d.type === "response_item" && pl.type === "message") {
    if (pl.role === "assistant") {
      const text = textOf(pl.content, ["output_text"]);
      if (text.trim()) p.lastText = text;
    } else if (pl.role === "user" && !p.firstPrompt) {
      const text = textOf(pl.content, ["input_text"]);
      if (isPersonText(text)) p.firstPrompt = clean(text, 200);
    }
  }
}

/** Reads what is new in one transcript into `p` (a first read of a huge file takes its head and tail). */
export function update(p: Parsed, size: number, mtimeMs: number): void {
  if (size < p.offset) {
    // Rewritten: start over.
    Object.assign(p, fresh(p.path, p.agent), {});
  }
  p.mtimeMs = mtimeMs;
  if (size === p.offset) return;
  let chunks: string[];
  if (p.offset === 0 && size > MAX_FIRST_READ) {
    const head = readRange(p.path, 0, HEAD_READ);
    const tail = readRange(p.path, size - TAIL_READ, size);
    chunks = [head.slice(0, head.lastIndexOf("\n") + 1), tail.slice(tail.indexOf("\n") + 1)];
    p.partial = "";
  } else {
    chunks = [p.partial + readRange(p.path, p.offset, size)];
  }
  p.offset = size;
  const handle = p.agent === "claude" ? claudeLine : codexLine;
  chunks.forEach((chunk, i) => {
    const lines = chunk.split("\n");
    const rest = lines.pop() ?? "";
    if (i === chunks.length - 1) p.partial = rest.length > 1_000_000 ? "" : rest;
    for (const l of lines) {
      if (!l.trim()) continue;
      let d: Line;
      try {
        d = JSON.parse(l) as Line;
      } catch {
        continue;
      }
      if (d && typeof d === "object") handle(p, d);
    }
  });
}

export function fresh(path: string, agent: AgentKind): Parsed {
  const stem = basename(path, ".jsonl");
  return {
    path,
    agent,
    id: agent === "codex" ? (/([0-9a-f]{8}-[0-9a-f-]{27})$/i.exec(stem)?.[1] ?? stem) : stem,
    cwd: null,
    title: null,
    customTitle: null,
    firstPrompt: null,
    startedAt: null,
    lastAt: null,
    lastText: null,
    turnOpen: false,
    headless: false,
    offset: 0,
    partial: "",
    mtimeMs: 0,
  };
}

/** Transcript files changed within `sinceMs` (Claude: projects/<dir>/<id>.jsonl; Codex: sessions/Y/M/D). */
export function transcriptFiles(
  home: string,
  sinceMs: number,
): { path: string; agent: AgentKind; mtimeMs: number; size: number }[] {
  const out: { path: string; agent: AgentKind; mtimeMs: number; size: number }[] = [];
  const add = (path: string, agent: AgentKind) => {
    try {
      const st = statSync(path);
      if (st.isFile() && st.mtimeMs >= sinceMs) out.push({ path, agent, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      /* gone */
    }
  };
  const ls = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const r = roots(home);
  for (const root of r.claude)
    for (const proj of ls(root))
      for (const f of ls(join(root, proj))) if (f.endsWith(".jsonl")) add(join(root, proj, f), "claude");
  const sinceDay = new Date(sinceMs - 86_400_000);
  for (const root of r.codex)
    for (const y of ls(root))
      for (const m of ls(join(root, y)))
        for (const day of ls(join(root, y, m))) {
          // Folders are local dates; a long-running session keeps writing to its start day's folder,
          // so only skip whole days well before the window when the file itself is old (stat decides).
          const dir = join(root, y, m, day);
          if (new Date(`${y}-${m}-${day}T23:59:59`) < new Date(sinceDay.getTime() - 30 * 86_400_000)) continue;
          for (const f of ls(dir)) if (f.endsWith(".jsonl")) add(join(dir, f), "codex");
        }
  return out;
}

/** Claude Code's live-session registry (`sessions/<pid>.json`): pid, session id, status. */
export interface Registered {
  pid: number;
  sessionId: string;
  cwd: string | null;
  status: string | null;
  headless: boolean;
}

export function registry(home: string): Registered[] {
  const out: Registered[] = [];
  for (const dir of roots(home).registries) {
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue;
      try {
        const d = JSON.parse(readFileSync(join(dir, n), "utf8")) as Line;
        if (typeof d.pid !== "number" || typeof d.sessionId !== "string") continue;
        out.push({
          pid: d.pid,
          sessionId: d.sessionId,
          cwd: typeof d.cwd === "string" ? d.cwd : null,
          status: typeof d.status === "string" ? d.status : null,
          headless: typeof d.kind === "string" && d.kind !== "interactive",
        });
      } catch {
        /* half written */
      }
    }
  }
  return out;
}

/** A claude / codex process (not Codex's app-server and helpers), with its working directory. */
export interface AgentProcess {
  pid: number;
  agent: AgentKind;
  cwd: string | null;
  headless: boolean;
}

export function processes(exec: Exec): AgentProcess[] {
  const ps = exec("ps", ["-axo", "pid=,command="], 10_000);
  if (ps?.code !== 0) return [];
  const found: AgentProcess[] = [];
  for (const line of ps.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)(.*)$/.exec(line);
    if (!m) continue;
    const name = basename(m[2] as string);
    const args = m[3] ?? "";
    if (name === "claude") {
      found.push({
        pid: Number(m[1]),
        agent: "claude",
        cwd: null,
        headless: /(^|\s)(-p|--print)(\s|$)|--output-format/.test(args),
      });
    } else if (name === "codex" && !/\b(app-server|exec-server|mcp-server|mcp|login|daemon)\b/.test(args)) {
      found.push({ pid: Number(m[1]), agent: "codex", cwd: null, headless: /(^|\s)exec(\s|$)/.test(args) });
    }
  }
  if (!found.length) return found;
  const lsof = exec("lsof", ["-a", "-d", "cwd", "-Fpn", "-p", found.map((p) => p.pid).join(",")], 10_000);
  if (lsof?.stdout) {
    let pid = 0;
    for (const l of lsof.stdout.split("\n")) {
      if (l.startsWith("p")) pid = Number(l.slice(1));
      else if (l.startsWith("n")) {
        const p = found.find((x) => x.pid === pid);
        if (p) p.cwd = l.slice(1);
      }
    }
  }
  return found;
}

/** Codex thread names (`session_index.jsonl`), id → name; later lines win. */
export function codexNames(home: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const dir of [join(home, ".codex"), join(home, ".config", "codex")]) {
    const f = join(dir, "session_index.jsonl");
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, "utf8").split("\n")) {
      try {
        const d = JSON.parse(l) as Line;
        if (typeof d.id === "string" && typeof d.thread_name === "string") names.set(d.id, d.thread_name);
      } catch {
        /* skip */
      }
    }
  }
  return names;
}

export function summaryOf(p: Pick<Parsed, "title" | "firstPrompt" | "lastText">): string {
  const head = p.title ? clean(p.title, 60) : p.firstPrompt ? oneLine(p.firstPrompt, 60) : "";
  const last = p.lastText ? clean(p.lastText, 80) : "";
  if (!head) return last;
  if (!last || last === head || head.startsWith(last)) return head;
  return `${head} → 最近：${last}`;
}

const herdrKind = (a: HerdrAgent): AgentKind | null => (a.agent === "claude" || a.agent === "codex" ? a.agent : null);

/** One scan: every live session, and the ended ones within `recentMs`, newest first. */
export function scan(i: ScanInput): MachineSession[] {
  const since = i.now - i.recentMs;
  const seen = new Set<string>();
  const load = (f: { path: string; agent: AgentKind; mtimeMs: number; size: number }): Parsed => {
    seen.add(f.path);
    let p = i.cache.get(f.path);
    if (!p) {
      p = fresh(f.path, f.agent);
      i.cache.set(f.path, p);
    }
    if (f.mtimeMs !== p.mtimeMs || f.size !== p.offset) {
      try {
        update(p, f.size, f.mtimeMs);
      } catch {
        /* unreadable this time */
      }
    }
    return p;
  };
  for (const f of transcriptFiles(i.home, since)) load(f);
  const parsedNow = () => [...i.cache.values()].filter((p) => seen.has(p.path));
  const byKey = (agent: AgentKind, id: string) => parsedNow().find((p) => p.agent === agent && p.id === id);
  const live = new Map<Parsed, { state: SessionState; headless: boolean; paneId: string | null }>();
  const stat = (path: string, agent: AgentKind) => {
    try {
      const st = statSync(path);
      return st.isFile() ? { path, agent, mtimeMs: st.mtimeMs, size: st.size } : null;
    } catch {
      return null;
    }
  };
  const ls = (dir: string) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const r = roots(i.home);

  // Claude Code's registry names the session of each live process (an old transcript too: it is open).
  const claimedPids = new Set<number>();
  for (const reg of registry(i.home)) {
    if (!i.alive(reg.pid)) continue;
    let p = byKey("claude", reg.sessionId);
    if (!p)
      for (const root of r.claude)
        for (const proj of ls(root)) {
          const f = p ? null : stat(join(root, proj, `${reg.sessionId}.jsonl`), "claude");
          if (f) p = load(f);
        }
    if (!p) continue;
    claimedPids.add(reg.pid);
    const state: SessionState = reg.status === "busy" || (reg.status == null && p.turnOpen) ? "running" : "waiting";
    live.set(p, { state, headless: reg.headless || p.headless, paneId: null });
  }
  // Other claude / codex processes: the newest unclaimed session in the same directory (looked up
  // further back when nothing recent is there: a process open for days).
  const newest = (agent: AgentKind, cwd: string | null) =>
    parsedNow()
      .filter((p) => p.agent === agent && p.cwd != null && p.cwd === cwd && !live.has(p))
      .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""))[0];
  let older: { path: string; agent: AgentKind; mtimeMs: number; size: number }[] | null = null;
  for (const proc of processes(i.exec)) {
    if (claimedPids.has(proc.pid) || !proc.cwd) continue;
    let p = newest(proc.agent, proc.cwd);
    if (!p && proc.agent === "claude") {
      const proj = proc.cwd.replace(/[^A-Za-z0-9]/g, "-");
      const files = r.claude
        .flatMap((root) =>
          ls(join(root, proj))
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => stat(join(root, proj, f), "claude")),
        )
        .filter((f): f is NonNullable<typeof f> => !!f)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (files[0]) {
        load(files[0]);
        p = newest("claude", proc.cwd);
      }
    }
    if (!p && proc.agent === "codex") {
      older ??= transcriptFiles(i.home, i.now - 14 * 86_400_000)
        .filter((f) => f.agent === "codex")
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const f of older) {
        if (load(f).cwd === proc.cwd) break;
      }
      p = newest("codex", proc.cwd);
    }
    if (!p) continue;
    live.set(p, { state: p.turnOpen ? "running" : "waiting", headless: proc.headless || p.headless, paneId: null });
  }
  for (const k of [...i.cache.keys()]) if (!seen.has(k)) i.cache.delete(k);
  const parsed = parsedNow();
  // herdr: the pane's own status is the best word on running vs waiting.
  const out: MachineSession[] = [];
  for (const a of i.herdr ?? []) {
    const kind = herdrKind(a);
    if (!kind) continue;
    const cwd = a.foreground_cwd || a.cwd || null;
    const candidates = [...live.entries()]
      .filter(([p, v]) => p.agent === kind && p.cwd === cwd && v.paneId == null)
      .sort(([x], [y]) => (y.lastAt ?? "").localeCompare(x.lastAt ?? ""));
    const state: SessionState | null =
      a.agent_status === "working" ? "running" : a.agent_status === "unknown" ? null : "waiting";
    const hit = candidates[0];
    if (hit) {
      hit[1].paneId = a.pane_id;
      hit[1].headless = false;
      if (state) hit[1].state = state;
      continue;
    }
    // An agent in a pane without a transcript yet (or one this scan cannot place): list the pane.
    out.push({
      id: `herdr:${a.pane_id}`,
      agent: kind,
      machine: i.machine,
      cwd,
      title: a.terminal_title_stripped ? clean(a.terminal_title_stripped, 120) : null,
      firstPrompt: null,
      state: state ?? "waiting",
      startedAt: null,
      lastActivityAt: new Date(i.now).toISOString(),
      summary: a.terminal_title_stripped ? clean(a.terminal_title_stripped, 120) : "",
      paneId: a.pane_id,
      headless: false,
    });
  }
  for (const p of parsed) {
    const l = live.get(p);
    const lastMs = Math.max(p.lastAt ? Date.parse(p.lastAt) || 0 : 0, p.mtimeMs);
    if (!l && lastMs < since) continue;
    const title = p.agent === "codex" ? (i.codexNames?.get(p.id) ?? p.title) : (p.customTitle ?? p.title);
    const state: SessionState = l ? l.state : p.turnOpen && i.now - p.mtimeMs < ACTIVE_MS ? "running" : "ended";
    out.push({
      id: p.id,
      agent: p.agent,
      machine: i.machine,
      cwd: p.cwd,
      title: title ? clean(title, 120) : null,
      firstPrompt: p.firstPrompt,
      state,
      startedAt: p.startedAt,
      lastActivityAt: new Date(lastMs).toISOString(),
      summary: summaryOf({ title, firstPrompt: p.firstPrompt, lastText: p.lastText }),
      paneId: l?.paneId ?? null,
      headless: l ? l.headless : p.headless,
    });
  }
  const rank = (s: MachineSession) => (s.state === "ended" ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || b.lastActivityAt.localeCompare(a.lastActivityAt)).slice(0, 300);
}

/** The transcript file of a session listed by the last scan. */
export function fileOf(cache: Map<string, Parsed>, id: string): Parsed | null {
  for (const p of cache.values()) if (p.id === id) return p;
  return null;
}
