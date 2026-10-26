/**
 * A turn as it runs, for a live card: the agent's transcript as agents-io's `ProgressView`, which
 * lark-bot draws as Feishu's thinking bubble (each step as it happens) and a process card. The
 * card is sent once a working stretch is long enough and updated (`deliver.update`) while it runs;
 * the final update settles the bubble.
 */
import { createHash } from "node:crypto";
import type { ProgressStep, ProgressView } from "./protocol.ts";
import { redact } from "./redact.ts";
import type { Step, Turn } from "./transcript.ts";

/** A tool's output in the bubble, from its start (lark-bot cuts it to ~1 KB anyway). */
const RESULT_CHARS = 1000;
const TITLE_CHARS = 200;

const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What kind of tool a name is, for the bubble's icon. */
export function toolType(name: string): Extract<ProgressStep, { kind: "tool" }>["type"] {
  const n = name.toLowerCase();
  if (n === "bash" || n === "shell" || n === "exec_command" || n === "local_shell") return "command";
  if (/^(edit|multiedit|write|notebookedit|apply_patch)$/.test(n)) return "file_change";
  if (n === "websearch" || n === "web_search") return "web_search";
  if (n === "task" || n === "agent") return "subagent";
  if (n.startsWith("mcp__")) return "mcp_tool";
  return "tool";
}

/**
 * Ids stay the same from one update to the next (the bubble appends, it never rewrites): a tool by
 * its call id, a block of text by what it says and how many the same came before it.
 */
function stepsOf(steps: Step[], running: boolean): ProgressStep[] {
  const seen = new Map<string, number>();
  const textId = (prefix: string, text: string) => {
    const h = createHash("sha256").update(text).digest("hex").slice(0, 12);
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return `${prefix}${h}${n > 1 ? `-${n}` : ""}`;
  };
  return steps.map((st, i): ProgressStep => {
    if (st.kind === "thinking") {
      const text = redact(st.text.trim()).text;
      return { kind: "reasoning", id: textId("r", st.text), text, done: !running || i < steps.length - 1 };
    }
    if (st.kind === "text") return { kind: "narration", id: textId("n", st.text), text: redact(st.text.trim()).text };
    const subject = redact(oneLine(st.subject)).text;
    const out = st.result === null ? "" : st.result.replace(/\s+$/, "");
    return {
      kind: "tool",
      itemId: st.id || textId("t", `${st.name}\n${st.subject}`),
      type: toolType(st.name),
      title: clip(subject ? `${st.name}: ${subject}` : st.name, TITLE_CHARS),
      status: st.result === null ? (running ? "running" : "completed") : st.error ? "failed" : "completed",
      ...(subject ? { inputSummary: clip(subject, 500) } : {}),
      ...(out ? { resultPreview: redact(clip(out, RESULT_CHARS)).text } : {}),
      ...(st.error ? { isError: true } : {}),
    };
  });
}

export interface ProgressOptions {
  turnId: string;
  status: ProgressView["status"];
  startedAt: number;
  endedAt?: number;
  /** The card's answer once settled (the turn's answer, or a line saying where it is). */
  answer?: string;
  headline?: string;
}

/**
 * The view of a turn. While it runs, what the agent said after its last tool call is narration
 * (it may call another); settled, the steps are the process and `answer` is the card's text.
 */
export function progressOf(turn: Turn | null, o: ProgressOptions): ProgressView {
  const running = o.status === "running" || o.status === "requires_action";
  const raw: Step[] = turn ? [...turn.steps] : [];
  if (running && turn?.answer.trim()) raw.push({ kind: "text", text: turn.answer });
  return {
    turnId: o.turnId,
    status: o.status,
    ...(o.headline ? { headline: o.headline } : {}),
    steps: stepsOf(raw, running),
    answer: running ? "" : (o.answer ?? ""),
    answerFinal: !running,
    startedAt: o.startedAt,
    ...(o.endedAt !== undefined ? { endedAt: o.endedAt } : {}),
  };
}
