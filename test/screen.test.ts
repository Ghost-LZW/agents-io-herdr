import { describe, expect, it } from "vitest";
import { strings } from "../src/i18n.ts";
import { buttons, noticeMessage, statusMessage } from "../src/notice.ts";
import { panesMessage } from "../src/panes.ts";
import { hideSecrets, REDACTED, redact } from "../src/redact.ts";
import { cutSidePanel, optionsOf, summaryOf, tailOf } from "../src/screen.ts";
import { paneButtons, screenText } from "../src/terminal-controls.ts";
import { agent } from "./fixtures.ts";

describe("screen", () => {
  // Pads to 60 display columns, as a terminal lays it out (CJK characters take two).
  const panel = (left: string, right = "") => {
    const width = [...left].reduce((n, ch) => n + (/[一-鿿　-〿＀-｠]/.test(ch) ? 2 : 1), 0);
    return `${left}${" ".repeat(60 - width)}│ ${right}`;
  };

  it("cuts a side panel, the input box and the footer, and hides secrets", () => {
    const text = [
      panel("⏺ Done: the migration is live.", "No changes"),
      panel("  token=sk-ant-abcdefghijklmnopqrstuvwxyz0123", "✕"),
      panel(""),
      panel("✻ Worked for 3m · done 1:19 AM"),
      "─".repeat(80),
      "❯ ",
      "─".repeat(80),
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    const t = tailOf(text);
    expect(t).toContain("the migration is live");
    expect(t).not.toContain("No changes");
    expect(t).not.toContain("bypass");
    expect(t).not.toContain("❯");
    expect(t).not.toContain("abcdefghijklmnop");
  });

  it("measures wide characters when finding the panel column", () => {
    const lines = [
      `${"中".repeat(25)}${" ".repeat(10)}│ x`,
      `${"a".repeat(50)}${" ".repeat(10)}│ y`,
      `${" ".repeat(60)}│ z`,
    ];
    expect(cutSidePanel(lines).map((l) => l.trimEnd())).toEqual(["中".repeat(25), "a".repeat(50), ""]);
  });

  it("keeps tables that draw bars in different columns", () => {
    const lines = ["| a │ b |", "x".repeat(70), `${"y".repeat(45)}│ q`, "plain"];
    expect(cutSidePanel(lines)).toEqual(lines);
  });

  it("keeps a permission dialog's options and drops Codex's prompt line", () => {
    const text = [
      "• Ran pnpm test",
      "",
      "Allow command `rm -rf build`?",
      "❯ 1. Yes",
      "  2. No, and tell Codex what to do differently",
      "",
      "› Ask Codex to do anything",
      "",
      "  model-x high · ~/projects/ledger",
    ].join("\n");
    const t = tailOf(text);
    expect(t).toContain("❯ 1. Yes");
    expect(t).toContain("2. No");
    expect(t).not.toContain("Ask Codex");
    expect(t).not.toContain("model-x");
  });

  it("keeps the last lines and drops a common indent", () => {
    const text = Array.from({ length: 30 }, (_, i) => `    line ${i}`).join("\n");
    expect(tailOf(text, 3)).toBe("line 27\nline 28\nline 29");
  });
});

describe("dialog choices", () => {
  it("finds Claude Code's and Codex's numbered choices, not without a dialog", () => {
    const claude = [
      "Bash command",
      "  rm -rf build",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, and don't ask again",
      "  3. No, and tell Claude what to do differently (esc)",
    ].join("\n");
    expect(optionsOf(claude)).toEqual([
      { key: "1", label: "Yes" },
      { key: "2", label: "Yes, and don't ask again" },
      { key: "3", label: "No, and tell Claude what to do differently" },
    ]);
    const codex = ["Allow command?", "› 1. Yes, proceed (y)", "  2. No (esc)"].join("\n");
    expect(tailOf(codex)).toContain("› 1. Yes, proceed");
    expect(optionsOf(tailOf(codex)).map((o) => o.key)).toEqual(["1", "2"]);
    expect(optionsOf("done.\n1. only one")).toEqual([]);
  });

  it("takes the last run of choices, not a numbered list above it", () => {
    const text = ["Plan:", "1. read", "2. write", "", "Continue?", "❯ 1. Yes", "  2. No"].join("\n");
    expect(optionsOf(text)).toEqual([
      { key: "1", label: "Yes" },
      { key: "2", label: "No" },
    ]);
  });
});

describe("what a finished turn says", () => {
  it("leads with the recap and the head of the last message, not tool calls or its tail", () => {
    const screen = [
      "⏺ Bash(pnpm test)",
      "  ⎿  ok",
      "",
      "⏺ Deployed. One thing for you: approve the new device in the admin page.",
      "",
      ...Array.from({ length: 30 }, (_, i) => `  detail ${i}`),
      "",
      "✻ Cogitated for 3m · done 2:24 PM",
      "",
      "※ recap: the service is up; waiting for your approval.",
    ].join("\n");
    const s = summaryOf(screen, 5);
    expect(s.split("\n").slice(0, 3)).toEqual([
      "※ recap: the service is up; waiting for your approval.",
      "",
      "⏺ Deployed. One thing for you: approve the new device in the admin page.",
    ]);
    expect(s).not.toContain("Bash(");
    expect(s).not.toContain("detail 29");
    expect(s.endsWith("…")).toBe(true);
  });

  it("finds Codex's last message, not its step lines", () => {
    const s = summaryOf(["• Ran pnpm test", "  └ ok", "", "• Two questions:", "  1. tabs", "  2. spaces"].join("\n"));
    expect(s).toBe("• Two questions:\n  1. tabs\n  2. spaces");
  });
});

describe("redact", () => {
  it("hides tokens and keeps the recognisable prefix", () => {
    const cases: [string, string][] = [
      ["Authorization: Bearer abcdefghijklmnop1234", `Bearer ${REDACTED}`],
      ["Authorization: token 0123456789abcdef0123", `token ${REDACTED}`],
      ["tskey-auth-" + "kAbCdEf12345-" + "Z".repeat(16), `tskey-auth-${REDACTED}`],
      [`sk-ant-api03-${"a1".repeat(20)}`, `sk-ant-${REDACTED}`],
      [`ghp_${"A1b2".repeat(9)}`, `ghp_${REDACTED}`],
      [`npm_${"Q".repeat(30)}`, `npm_${REDACTED}`],
      ["AKIA" + "ABCDEFGHIJKLMNOP", `AKIA${REDACTED}`],
      ["AppSecret=Zx9vB2nM4kL7qW1e", `AppSecret=${REDACTED}`],
      ['"client_secret": "s3cr3t-value-123"', `"client_secret": "${REDACTED}`],
      ["DATABASE_PASSWORD=hunter2hunter2", `DATABASE_PASSWORD=${REDACTED}`],
      ["postgresql://app:pa55w0rd@db.example:5432/app", `postgresql://app:${REDACTED}@db.example`],
      ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop", REDACTED],
      ["author: Jane Doe <jane.doe@example.com>", "<…@example.com>"],
    ];
    for (const [input, expected] of cases) {
      const r = redact(input);
      expect(r.text, input).toContain(expected);
      expect(r.count, input).toBeGreaterThan(0);
    }
  });

  it("with secret hiding off (notify.redact: false), only email addresses change", () => {
    hideSecrets(false);
    try {
      const t = `token=abc123def456ghi ghp_${"A1b2".repeat(9)} dev@example.com`;
      expect(redact(t).text).toBe(`token=abc123def456ghi ghp_${"A1b2".repeat(9)} …@example.com`);
    } finally {
      hideSecrets(true);
    }
  });

  it("hides PEM private keys whole", () => {
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA\n-----END OPENSSH PRIVATE KEY-----";
    const r = redact(`key:\n${pem}\nafter`);
    expect(r.text).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA");
    expect(r.text).toContain(`-----BEGIN OPENSSH PRIVATE KEY----- ${REDACTED} -----END OPENSSH PRIVATE KEY-----`);
    expect(r.text).toContain("after");
  });

  it("leaves names, placeholders and prose alone", () => {
    const keep = [
      "token `readonly`, role auditor",
      "token: readonly",
      "automountServiceAccountToken=false",
      "postgresql://app_<name>:<password>@db.example:5432/x",
      'curl -H "Authorization: Bearer $API_TOKEN"',
      "API_TOKEN_FILE=/srv/app/tokens/agent.token",
    ];
    for (const s of keep) expect(redact(s), s).toEqual({ text: s, count: 0 });
  });
});

describe("notice cards", () => {
  const s = strings("en");
  const base = { machine: "my-mac", timeZone: "UTC", s, topic: true, threadId: "a1b2c3d4e5f6", options: [] };

  it("says which machine, place and agent, with wrapping screen text and terminal-bound controls", () => {
    const m = noticeMessage(
      { kind: "blocked", agent: agent("blocked") },
      {
        ...base,
        screen: "Allow?\n❯ 1. Yes\n  2. No",
        options: [
          { key: "1", label: "Yes" },
          { key: "2", label: "No" },
        ],
      },
    );
    expect(m.text).toBe(
      "**my-mac · ledger · Codex is waiting for you**\nfix the parser\n\nAllow?\n❯ 1\\. Yes\n  2\\. No",
    );
    expect(m.sections).toEqual([{ kind: "footer", text: "w1:p1 · reply in this topic to talk to it" }]);
    expect(m.actions?.map((a) => a.id)).toEqual([
      ...["1", "2", "up", "down", "left", "right", "enter", "tab", "esc"].map((k) => `herdr:pk:term_1:${k}`),
      "herdr:view:term_1",
      "herdr:process:term_1:0",
    ]);
    const done = noticeMessage({ kind: "done", agent: agent("done"), turnMs: 754_000 }, { ...base, screen: "" });
    expect(done.text.split("\n")[0]).toBe("**my-mac · ledger · Codex finished** (this turn: 13 min)");
    expect(done.actions).toBeUndefined();
  });

  it("never shows the full path, and escapes fences in the screen", () => {
    const m = noticeMessage(
      { kind: "done", agent: agent("done"), turnMs: 200_000 },
      { ...base, screen: "```js\nx\n```" },
    );
    expect(m.text).not.toContain("/home/dev");
    expect(m.text.match(/```/g)?.length).toBe(2);
  });

  it("lists an overnight batch with times in the configured zone", () => {
    const zh = strings("zh");
    const night = noticeMessage(
      {
        kind: "overnight",
        items: [{ agent: agent("done"), turnMs: 3_900_000, endedAt: Date.parse("2026-10-19T19:12:00Z") }],
      },
      { ...base, s: zh, timeZone: "Asia/Shanghai", screen: null },
    );
    expect(night.text).toBe("**my-mac · 夜里做完的**\n- ledger · Codex · fix the parser（1 小时 5 分钟，03:12 做完）");
  });

  it("escapes screen markup and bounds bytes without a code block", () => {
    const text = screenText("<at id=all> **bold** [link](url) `code` token=sk-ant-abcdefghijklmnopqrstuvwxyz0123");
    expect(text).toContain("&lt;at id=all&gt;");
    expect(text).toContain("\\*\\*bold\\*\\*");
    expect(text).not.toContain("sk-ant-");
    expect(Buffer.byteLength(screenText("&中文\n".repeat(2000)))).toBeLessThan(16_010);
    expect(paneButtons("term_1", [], s)?.map((a) => a.label)).toEqual([
      "↑",
      "↓",
      "←",
      "→",
      "Enter",
      "Tab",
      "Esc cancel",
    ]);
  });

  it("clips button labels", () => {
    const b = buttons("a1b2c3d4e5f6", [{ key: "1", label: "Yes, and don't ask again for this command" }], s);
    expect(b?.[0]?.label.length).toBeLessThanOrEqual(20);
  });

  it("lists every agent in a status card, waiting ones first", () => {
    const m = statusMessage({
      machine: "my-mac",
      panes: [
        agent("working", {
          pane_id: "w1:p2",
          terminal_id: "term_2",
          agent: "claude",
          cwd: "/home/dev/projects/api",
          foreground_cwd: null,
        }),
        agent("blocked"),
        { ...agent("idle", { pane_id: "w1:p3" }), agent: null },
      ],
      tabs: [],
      error: null,
      views: [
        { key: "w1:p1|term_1", status: "blocked", since: 0, sinceStart: false, workingSince: null },
        { key: "w1:p2|term_2", status: "working", since: 0, sinceStart: true, workingSince: null },
      ],
      now: 12 * 60_000,
      s,
      paused: false,
      quiet: "23:00-08:00",
      workbench: true,
    });
    expect(m.text).toBe(
      [
        "**my-mac · 2 agents**",
        "- w1:p1 · ledger · Codex · waiting for you · 12 min · fix the parser",
        "- w1:p2 · api · Claude · working · ≥12 min · fix the parser",
      ].join("\n"),
    );
    expect(m.sections?.[0]?.text).toBe("sending · quiet hours 23:00-08:00 · notices go to the workbench");
  });

  it.each(["en", "zh"] as const)(
    "matches full ls pane ids and window names even without a short-id collision (%s)",
    (locale) => {
      const s = strings(locale);
      const panes = [
        agent("working", { pane_id: "w1:p2", tab_id: "w1:t1" }),
        agent("idle", { pane_id: "w1:p3", tab_id: "w1:t2", agent: "claude" }),
        agent("unknown", { pane_id: "w2:p2", agent: null }),
      ];
      const tabs = [
        { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "parser" },
        { tab_id: "w1:t2", workspace_id: "w1", number: 2, label: "review" },
      ];
      const status = statusMessage({
        machine: "my-mac",
        panes,
        tabs,
        error: null,
        views: [],
        now: 0,
        s,
        paused: false,
        quiet: null,
        workbench: true,
      });
      const ls = panesMessage({ machine: "my-mac", panes, tabs, s });
      for (const prefix of ["- w1:p2 · parser · ledger ·", "- w1:p3 · review · ledger ·"]) {
        expect(status.text.split("\n").some((line) => line.startsWith(prefix))).toBe(true);
        expect(ls.text.split("\n").some((line) => line.startsWith(prefix))).toBe(true);
      }
      expect(status.text).not.toContain("w2:p2");
    },
  );

  it("uses pane ids when status has no window name and hides secrets in names just like ls", () => {
    const panes = [agent("working", { tab_id: "w1:t1" })];
    for (const [label, expected] of [
      [undefined, ""],
      ["   ", ""],
      ["token=abc123def456ghi", `token=${REDACTED}`],
    ]) {
      const tabs = label === undefined ? [] : [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label }];
      const status = statusMessage({
        machine: "my-mac",
        panes,
        tabs,
        error: null,
        views: [],
        now: 0,
        s,
        paused: false,
        quiet: null,
        workbench: true,
      });
      const ls = panesMessage({ machine: "my-mac", panes, tabs, s });
      const prefix = `- w1:p1${expected ? ` · ${expected}` : ""} · ledger ·`;
      expect(status.text.split("\n")[1]?.startsWith(prefix)).toBe(true);
      expect(ls.text.split("\n")[1]?.startsWith(prefix)).toBe(true);
      expect(status.text).not.toContain("abc123def456ghi");
      expect(ls.text).not.toContain("abc123def456ghi");
    }
  });
});
