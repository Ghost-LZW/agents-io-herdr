/** Turns from synthetic Claude Code and Codex transcripts, and how a notice pages them. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { strings } from "../src/i18n.ts";
import { progressOf } from "../src/live.ts";
import { noticeMessages, pages, processPages } from "../src/notice.ts";
import { startupAnswer } from "../src/spawn.ts";
import { claudeTurn, codexTurn, subjectOf, transcriptSource } from "../src/transcript.ts";
import { tempDir } from "./fakes.ts";
import { agent } from "./fixtures.ts";

const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
const user = (content: unknown, o: Record<string, unknown> = {}) => ({
  type: "user",
  message: { role: "user", content },
  ...o,
});
const assistant = (...content: unknown[]) => ({ type: "assistant", message: { role: "assistant", content } });

const CLAUDE = [
  user("an older question"),
  assistant({ type: "text", text: "an older answer" }),
  user("fix the parser"),
  assistant({ type: "thinking", thinking: "The tests first." }, { type: "text", text: "Running the tests." }),
  assistant({ type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test", description: "tests" } }),
  user([{ type: "tool_result", tool_use_id: "tu1", content: "2 failed", is_error: true }]),
  assistant({ type: "tool_use", id: "tu2", name: "Grep", input: { pattern: "parse\\(", path: "src" } }),
  user([{ type: "tool_result", tool_use_id: "tu2", content: [{ type: "text", text: "src/parse.ts:3" }] }]),
  assistant({ type: "text", text: "Fixed it." }, { type: "text", text: "All tests pass." }),
  user("<local-command-stdout>Set model</local-command-stdout>"),
  user("caveat", { isMeta: true }),
];

describe("claudeTurn", () => {
  it("reads the last answered turn: prompt, steps with results, the answer after the last tool", () => {
    const t = claudeTurn(jsonl(CLAUDE), false);
    expect(t).toEqual({
      prompt: "fix the parser",
      steps: [
        { kind: "thinking", text: "The tests first." },
        { kind: "text", text: "Running the tests." },
        { kind: "tool", id: "tu1", name: "Bash", subject: "npm test", result: "2 failed", error: true },
        { kind: "tool", id: "tu2", name: "Grep", subject: "parse\\( (src)", result: "src/parse.ts:3", error: false },
      ],
      answer: "Fixed it.\n\nAll tests pass.",
      truncated: false,
    });
  });

  it("skips a prompt not yet answered, and a half-written last line", () => {
    const text = `${jsonl([...CLAUDE, user("next question")])}{"type":"assist`;
    expect(claudeTurn(text, false)?.prompt).toBe("fix the parser");
  });

  it("a turn that began before the tail has no prompt and says so", () => {
    const t = claudeTurn(jsonl(CLAUDE.slice(4, 9)), true);
    expect(t).toMatchObject({ prompt: "", truncated: true, answer: "Fixed it.\n\nAll tests pass." });
    expect(claudeTurn(jsonl(CLAUDE.slice(4, 9)), false)).toBeNull();
  });
});

describe("codexTurn", () => {
  const item = (payload: unknown) => ({ type: "response_item", payload });
  const rows = [
    item({ type: "message", role: "user", content: [{ type: "input_text", text: "old" }] }),
    { type: "event_msg", payload: { type: "task_started" } },
    item({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>x" }] }),
    item({ type: "message", role: "user", content: [{ type: "input_text", text: "add a flag" }] }),
    item({ type: "reasoning", summary: [{ type: "summary_text", text: "Where flags live." }] }),
    item({ type: "function_call", name: "shell", call_id: "c1", arguments: '{"command":["rg","flag"]}' }),
    item({ type: "function_call_output", call_id: "c1", output: '{"output":"src/cli.ts","metadata":{}}' }),
    item({
      type: "custom_tool_call",
      name: "apply_patch",
      call_id: "c2",
      input: "*** Begin Patch\n*** Update File: a",
    }),
    item({ type: "custom_tool_call_output", call_id: "c2", output: "Done" }),
    item({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Added --flag." }] }),
  ];

  it("reads the turn since the last task start", () => {
    expect(codexTurn(jsonl(rows), false)).toEqual({
      prompt: "add a flag",
      steps: [
        { kind: "thinking", text: "Where flags live." },
        { kind: "tool", id: "c1", name: "shell", subject: "rg flag", result: "src/cli.ts", error: false },
        { kind: "tool", id: "c2", name: "apply_patch", subject: "*** Begin Patch", result: "Done", error: false },
      ],
      answer: "Added --flag.",
      truncated: false,
    });
  });
});

describe("subjectOf", () => {
  it("picks the command, the file, the pattern", () => {
    expect(subjectOf({ file_path: "/a/b.ts", old_string: "x" })).toBe("/a/b.ts");
    expect(subjectOf({ url: "https://example.com", prompt: "read" })).toBe("https://example.com");
    expect(subjectOf("raw")).toBe("raw");
    expect(subjectOf(null)).toBe("");
  });
});

describe("transcriptSource", () => {
  let tmp: ReturnType<typeof tempDir> | null = null;
  afterEach(() => tmp?.done());

  it("finds a Claude session by herdr's id, and nothing for an unsafe id or no session", async () => {
    tmp = tempDir();
    const id = "0b5c2a9e-1111-2222-3333-444455556666";
    const dir = join(tmp.dir, ".claude", "projects", "-home-dev-ledger");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), jsonl(CLAUDE));
    const src = transcriptSource({ home: tmp.dir });
    const session = (value: string) => ({ source: "herdr:claude", agent: "claude", kind: "id", value });
    const a = agent("done", { agent: "claude", agent_session: session(id) });
    expect((await src.turn(a))?.answer).toBe("Fixed it.\n\nAll tests pass.");
    expect(await src.turn({ ...a, agent_session: session("../../etc/passwd") })).toBeNull();
    expect(await src.turn({ ...a, agent_session: null })).toBeNull();
  });
});

describe("pages", () => {
  it("keeps short text whole and cuts long text under the limit, closing and reopening a code block", () => {
    expect(pages("short", 100)).toEqual(["short"]);
    const text = ["intro", "```", ...Array.from({ length: 50 }, (_, i) => `code line ${i}`), "```", "outro"].join("\n");
    const out = pages(text, 200);
    expect(out.length).toBeGreaterThan(1);
    for (const p of out) {
      expect(Buffer.byteLength(p)).toBeLessThanOrEqual(200);
      expect((p.match(/^```/gm) ?? []).length % 2).toBe(0);
    }
    expect(out.join("\n")).toContain("code line 49");
  });

  it("cuts a line longer than a page", () => {
    const out = pages("x".repeat(1000), 200);
    expect(out.join("")).toBe("x".repeat(1000));
    for (const p of out) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(200);
  });
});

describe("noticeMessages", () => {
  const s = strings("en");
  const view = {
    machine: "my-mac",
    screen: "❯ 1. Yes",
    timeZone: "UTC",
    s,
    topic: true,
    threadId: "abc123",
    options: [{ key: "1", label: "Yes" }],
  };
  const turn = {
    prompt: "fix it",
    steps: [{ kind: "tool" as const, id: "1", name: "Bash", subject: "ls", result: "a\nb", error: false }],
    answer: "Done, token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 removed.",
    truncated: false,
  };

  it("a finished turn: one card with the answer and the process folded", () => {
    const [m, ...more] = noticeMessages({ kind: "done", agent: agent("done"), turnMs: 60_000 }, { ...view, turn });
    expect(more).toEqual([]);
    expect(m?.text).toContain("Asked: fix it");
    expect(m?.text).toContain("Done, token");
    expect(m?.text).not.toContain("abcdefghijklmnop");
    expect(m?.sections?.map((x) => x.kind)).toEqual(["body", "details", "footer"]);
    expect(m?.actions).toBeUndefined();
  });

  it("a dialog: the screen and the buttons, and the process so far", () => {
    const [m] = noticeMessages({ kind: "blocked", agent: agent("blocked") }, { ...view, turn });
    expect(m?.text).toContain("❯ 1. Yes");
    expect(m?.actions?.[0]).toMatchObject({ label: "1 Yes" });
    expect(m?.sections?.[1]?.text).toContain("🔧 **Bash** `ls`");
  });

  it("without a transcript: the screen card as before", () => {
    const [m, ...more] = noticeMessages({ kind: "done", agent: agent("done"), turnMs: 1000 }, { ...view, turn: null });
    expect(more).toEqual([]);
    expect(m?.sections?.map((x) => x.kind)).toEqual(["footer"]);
  });

  it("too many steps: the oldest give way and a line says how many", () => {
    const steps = Array.from({ length: 200 }, (_, i) => ({
      kind: "text" as const,
      text: `step ${i} ${"w".repeat(400)}`,
    }));
    const out = processPages(steps, s, 3);
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out[0]).toMatch(/^_\(the first \d+ steps are left out/);
    expect(out.at(-1)).toContain("step 199");
  });
});

describe("progressOf", () => {
  const turn = {
    prompt: "p",
    steps: [
      { kind: "thinking" as const, text: "Hmm." },
      { kind: "tool" as const, id: "c1", name: "Edit", subject: "/a/b.ts", result: "ok", error: false },
      { kind: "tool" as const, id: "c2", name: "Bash", subject: "npm test", result: null, error: false },
    ],
    answer: "So far so good.",
    truncated: false,
  };

  it("while running: the text after the last tool is narration, an open tool runs, ids are stable", () => {
    const a = progressOf(turn, { turnId: "x", status: "running", startedAt: 1 });
    expect(a).toMatchObject({ status: "running", answer: "", answerFinal: false });
    expect(a.steps.map((s) => s.kind)).toEqual(["reasoning", "tool", "tool", "narration"]);
    expect(a.steps[1]).toMatchObject({ type: "file_change", title: "Edit: /a/b.ts", status: "completed" });
    expect(a.steps[2]).toMatchObject({ type: "command", status: "running" });
    const b = progressOf(
      { ...turn, steps: [...turn.steps, { kind: "text", text: "more" }] },
      { turnId: "x", status: "running", startedAt: 1 },
    );
    expect(
      b.steps[0]?.kind === "reasoning" && a.steps[0]?.kind === "reasoning" && b.steps[0].id === a.steps[0].id,
    ).toBe(true);
  });

  it("settled: the answer is the card's text, every tool settles", () => {
    const p = progressOf(turn, { turnId: "x", status: "completed", startedAt: 1, endedAt: 2, answer: "Done." });
    expect(p).toMatchObject({ status: "completed", answer: "Done.", answerFinal: true, endedAt: 2 });
    expect(p.steps.map((s) => s.kind)).toEqual(["reasoning", "tool", "tool"]);
    expect(p.steps[2]).toMatchObject({ status: "completed" });
  });

  it("redacts what it shows", () => {
    const p = progressOf(
      {
        ...turn,
        steps: [
          {
            kind: "tool",
            id: "c",
            name: "Bash",
            subject: "curl -H 'Authorization: Bearer abcdefghijklmnop1234'",
            result: null,
            error: false,
          },
        ],
      },
      { turnId: "x", status: "running", startedAt: 1 },
    );
    expect(JSON.stringify(p)).not.toContain("abcdefghijklmnop1234");
  });
});

describe("startupAnswer", () => {
  const trust = [
    " Accessing workspace:",
    " /tmp/x",
    " Quick safety check: Is this a project you created or one you trust?",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    " Enter to confirm · Esc to cancel",
  ].join("\n");

  it("answers a trust question by moving to its yes", () => {
    expect(startupAnswer(trust)).toEqual(["down", "enter"]);
    expect(startupAnswer(trust.replace("❯ No", "  No").replace("  Yes", "❯ Yes"))).toEqual(["enter"]);
  });

  it("picks a numbered yes by its number, and the bypass mode question", () => {
    const bypass = "WARNING: Claude Code running in Bypass Permissions mode\n❯ 1. No, exit\n  2. Yes, I accept";
    expect(startupAnswer(bypass)).toEqual(["2"]);
  });

  it("leaves any other dialog alone", () => {
    expect(startupAnswer("Do you want to proceed?\n❯ 1. Yes\n  2. No")).toBeNull();
    expect(startupAnswer("Quick safety check: do you trust this folder?\n(no options)")).toBeNull();
  });
});
