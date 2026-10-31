/** The session collector: fake transcripts, a fake herdr, fake processes; paging, redaction, the link. */
import { generateKeyPairSync, verify } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { answer, keepNodeKey, LbLink, loadNodeKey, newNodeKey, runCollector, sessionsPaths } from "../src/collector.ts";
import type { HerdrAgent } from "../src/herdr.ts";
import { PAGE_MAX, readPage } from "../src/sessionread.ts";
import { type Parsed, scan } from "../src/sessions.ts";
import type { Exec } from "../src/system.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-23T12:00:00Z");
/** Made up, and put together at run time so no scanner takes the source for a leak. */
const SECRET = ["sk-ant-api03", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("-");

function home() {
  const h = mkdtempSync(join(tmpdir(), "aio-herdr-sessions-"));
  dirs.push(h);
  return h;
}

const jl = (lines: unknown[]) => `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;

function claudeFile(h: string, project: string, id: string, lines: unknown[], mtime = NOW) {
  const dir = join(h, ".config", "claude", "projects", project);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${id}.jsonl`);
  writeFileSync(f, jl(lines));
  utimesSync(f, mtime / 1000, mtime / 1000);
  return f;
}

function codexFile(h: string, id: string, lines: unknown[], mtime = NOW) {
  const dir = join(h, ".codex", "sessions", "2026", "10", "23");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `rollout-2026-10-23T10-00-00-${id}.jsonl`);
  writeFileSync(f, jl(lines));
  utimesSync(f, mtime / 1000, mtime / 1000);
  return f;
}

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";
const C3 = "33333333-3333-4333-8333-333333333333";
const X1 = "01a166f7-424b-73c1-9325-5ffc7aff8dba";

const user = (text: string, ts: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  sessionId: "",
  cwd: "/repos/a",
  timestamp: ts,
  entrypoint: "cli",
  message: { role: "user", content: text },
  ...extra,
});
const assistant = (content: unknown[], ts: string, stop: string | null = "end_turn") => ({
  type: "assistant",
  cwd: "/repos/a",
  timestamp: ts,
  message: { role: "assistant", content, stop_reason: stop },
});

function fakeExec(o: { ps?: string; lsof?: string }): Exec {
  return (cmd) => {
    if (cmd === "ps") return { code: 0, stdout: o.ps ?? "", stderr: "" };
    if (cmd === "lsof") return { code: 0, stdout: o.lsof ?? "", stderr: "" };
    return null;
  };
}

function fixture() {
  const h = home();
  // The TUI main line: registered by Claude Code, busy, in herdr pane w6:p1.
  claudeFile(h, "-repos-a", C1, [
    { ...user("<command-name>/clear</command-name>", "2026-10-23T09:00:00Z"), sessionId: C1 },
    { ...user("整理助手系统的现状", "2026-10-23T09:00:01Z"), sessionId: C1 },
    { type: "ai-title", sessionId: C1, aiTitle: "助手系统现状梳理" },
    assistant([{ type: "text", text: `好的，key=${SECRET}` }], "2026-10-23T09:00:05Z"),
    { type: "system", subtype: "turn_duration", timestamp: "2026-10-23T09:00:06Z" },
    { ...user("继续", "2026-10-23T11:59:00Z"), sessionId: C1 },
    assistant([{ type: "tool_use", name: "Bash", input: { command: "ls" } }], "2026-10-23T11:59:10Z", null),
  ]);
  mkdirSync(join(h, ".config", "claude", "sessions"), { recursive: true });
  writeFileSync(
    join(h, ".config", "claude", "sessions", "40329.json"),
    JSON.stringify({ pid: 40329, sessionId: C1, cwd: "/repos/a", status: "busy", kind: "interactive" }),
  );
  // A headless run that ended an hour ago.
  claudeFile(
    h,
    "-tmp-x",
    C2,
    [
      { ...user("Run ls and report", "2026-10-23T10:59:00Z", { entrypoint: "sdk-cli", cwd: "/tmp/x" }), sessionId: C2 },
      assistant([{ type: "text", text: "Done." }], "2026-10-23T10:59:05Z"),
    ],
    NOW - 3_600_000,
  );
  // Ended long ago: left out.
  claudeFile(h, "-old", C3, [{ ...user("old", "2026-10-20T10:00:00Z"), sessionId: C3 }], NOW - 4 * 86_400_000);
  // A Codex TUI waiting in herdr pane w4:p1 (no registry: found by its process' directory).
  codexFile(h, X1, [
    {
      type: "session_meta",
      timestamp: "2026-10-23T10:00:00Z",
      payload: { id: X1, cwd: "/repos/ledger", originator: "codex_cli_rs", source: "cli" },
    },
    {
      type: "event_msg",
      timestamp: "2026-10-23T10:00:01Z",
      payload: { type: "user_message", message: "读取会话并修正格式" },
    },
    { type: "event_msg", timestamp: "2026-10-23T10:00:02Z", payload: { type: "task_started" } },
    {
      type: "response_item",
      timestamp: "2026-10-23T10:00:03Z",
      payload: {
        type: "function_call",
        name: "exec",
        arguments: `{"cmd":"curl -H 'Authorization: Bearer ${"a".repeat(30)}'"}`,
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-10-23T10:05:00Z",
      payload: { type: "task_complete", last_agent_message: "格式已修正" },
    },
  ]);
  const herdr: HerdrAgent[] = [
    { pane_id: "w6:p1", terminal_id: "t1", agent: "claude", agent_status: "working", cwd: "/repos/a", focused: true },
    {
      pane_id: "w4:p1",
      terminal_id: "t2",
      agent: "codex",
      agent_status: "blocked",
      cwd: "/repos/ledger",
      focused: false,
    },
    {
      pane_id: "w9:p2",
      terminal_id: "t3",
      agent: "claude",
      agent_status: "idle",
      cwd: "/repos/new",
      terminal_title_stripped: "新开的",
      focused: false,
    },
  ];
  const exec = fakeExec({
    ps: "40329 claude --dangerously-skip-permissions\n73011 /opt/bin/codex\n11923 /opt/bin/codex app-server daemon\n",
    lsof: "p40329\nn/repos/a\np73011\nn/repos/ledger\n",
  });
  return { h, herdr, exec };
}

const run = (h: string, herdr: HerdrAgent[] | null, exec: Exec, cache = new Map<string, Parsed>(), now = NOW) =>
  scan({
    home: h,
    machine: "host-a",
    now,
    herdr,
    exec,
    alive: (pid) => pid === 40329 || pid === 73011,
    recentMs: 86_400_000,
    cache,
  });

describe("collect", () => {
  it("lists running, waiting and recently ended sessions with pane, state, times and a redacted summary", () => {
    const { h, herdr, exec } = fixture();
    const list = run(h, herdr, exec);
    const byId = Object.fromEntries(list.map((s) => [s.id, s]));
    expect(Object.keys(byId).sort()).toEqual([X1, C1, C2, "herdr:w9:p2"].sort());
    expect(byId[C1]).toMatchObject({
      agent: "claude",
      machine: "host-a",
      cwd: "/repos/a",
      title: "助手系统现状梳理",
      firstPrompt: "整理助手系统的现状",
      state: "running",
      paneId: "w6:p1",
      headless: false,
      startedAt: "2026-10-23T09:00:00Z",
    });
    expect(byId[C1]?.summary).toContain("助手系统现状梳理");
    expect(byId[X1]).toMatchObject({ agent: "codex", state: "waiting", paneId: "w4:p1", cwd: "/repos/ledger" });
    expect(byId[X1]?.summary).toBe("读取会话并修正格式 → 最近：格式已修正");
    expect(byId[C2]).toMatchObject({ state: "ended", headless: true, paneId: null, cwd: "/tmp/x" });
    expect(byId["herdr:w9:p2"]).toMatchObject({ state: "waiting", title: "新开的", paneId: "w9:p2" });
    // Live first.
    expect(list.at(-1)?.state).toBe("ended");
    expect(JSON.stringify(list)).not.toContain(SECRET);
  });

  it("hides LB tokens and plain passwords in titles, first prompts and summaries", () => {
    const h = home();
    const lbp = "lbp_Q9w8e7r6t5y4u3";
    claudeFile(h, "-repos-a", C1, [
      { ...user(`配一下 LB_TOKEN=${lbp}，password=hunterpass`, "2026-10-23T11:00:00Z"), sessionId: C1 },
      { type: "custom-title", sessionId: C1, customTitle: "token=plaintokenword 的轮换" },
      assistant([{ type: "text", text: "好了，agk_z1x2c3v4b5n6 已写进去" }], "2026-10-23T11:00:05Z"),
    ]);
    const list = run(h, null, fakeExec({}));
    const s = list.find((x) => x.id === C1);
    expect(s?.firstPrompt).toContain("[REDACTED]");
    const all = JSON.stringify(list);
    for (const secret of [lbp, "hunterpass", "plaintokenword", "agk_z1x2c3v4b5n6"]) expect(all).not.toContain(secret);
  });

  it("without herdr and processes: the registry still finds the main line; a moving headless transcript runs", () => {
    const { h } = fixture();
    const list = run(h, null, fakeExec({}));
    expect(list.find((s) => s.id === C1)).toMatchObject({ state: "running", paneId: null });
    expect(list.find((s) => s.id === X1)?.state).toBe("ended");
  });

  it("a live session whose transcript is older than the window is still listed (open for days)", () => {
    const h = home();
    const OLD = "44444444-4444-4444-8444-444444444444";
    const OLD2 = "55555555-5555-4555-8555-555555555555";
    claudeFile(
      h,
      "-Users-someone-Projects-sample-app",
      OLD,
      [
        {
          ...user("跑 sample-app", "2026-10-18T15:41:00Z", {
            cwd: "/Users/someone/Projects/sample-app",
            entrypoint: "sdk-ts",
          }),
          sessionId: OLD,
        },
      ],
      NOW - 5 * 86_400_000,
    );
    claudeFile(
      h,
      "-Users-someone-Projects-other",
      OLD2,
      [{ ...user("另一个", "2026-10-18T15:41:00Z", { cwd: "/Users/someone/Projects/other" }), sessionId: OLD2 }],
      NOW - 5 * 86_400_000,
    );
    mkdirSync(join(h, ".claude", "sessions"), { recursive: true });
    writeFileSync(
      join(h, ".claude", "sessions", "27509.json"),
      JSON.stringify({
        pid: 27509,
        sessionId: OLD,
        cwd: "/Users/someone/Projects/sample-app",
        status: "idle",
        kind: "sdk",
      }),
    );
    const exec = fakeExec({
      ps: "27509 /x/claude --output-format stream-json\n30000 claude\n",
      lsof: "p27509\nn/Users/someone/Projects/sample-app\np30000\nn/Users/someone/Projects/other\n",
    });
    const list = scan({
      home: h,
      machine: "host-b",
      now: NOW,
      herdr: null,
      exec,
      alive: (pid) => pid === 27509 || pid === 30000,
      recentMs: 86_400_000,
      cache: new Map(),
    });
    expect(list.map((s) => [s.id, s.state, s.headless])).toEqual(
      expect.arrayContaining([
        [OLD, "waiting", true],
        // Its last line is a prompt with no answer yet: a turn under way.
        [OLD2, "running", false],
      ]),
    );
    expect(list).toHaveLength(2);
  });

  it("reads only what is new on the next scan", () => {
    const { h, herdr, exec } = fixture();
    const cache = new Map<string, Parsed>();
    run(h, herdr, exec, cache);
    const f = join(h, ".config", "claude", "projects", "-repos-a", `${C1}.jsonl`);
    const before = [...cache.values()].find((p) => p.id === C1)?.offset ?? 0;
    appendFileSync(f, jl([assistant([{ type: "text", text: "全部完成" }], "2026-10-23T12:00:30Z")]));
    const list = run(h, herdr, exec, cache, NOW + 60_000);
    const p = [...cache.values()].find((x) => x.id === C1);
    expect(p?.offset).toBeGreaterThan(before);
    expect(list.find((s) => s.id === C1)?.summary).toContain("全部完成");
  });
});

describe("read", () => {
  it("pages a transcript: last page by default, offsets, a cap, secrets hidden", () => {
    const { h } = fixture();
    const f = join(h, ".config", "claude", "projects", "-repos-a", `${C1}.jsonl`);
    const last = readPage(f, "claude", { limit: 2 });
    expect(last.total).toBe(5);
    expect(last.offset).toBe(3);
    expect(last.next).toBeNull();
    expect(last.prev).toBe(1);
    expect(last.entries.map((e) => e.role)).toEqual(["user", "tool"]);
    const first = readPage(f, "claude", { offset: 0, limit: 2 });
    expect(first.entries.map((e) => e.n)).toEqual([0, 1]);
    expect(first.next).toBe(2);
    const all = readPage(f, "claude", { offset: 0, limit: 10_000 });
    expect(all.entries.length).toBeLessThanOrEqual(PAGE_MAX);
    expect(JSON.stringify(all)).not.toContain(SECRET);
    expect(all.redacted).toBeGreaterThan(0);
    const x = readPage(
      join(h, ".codex", "sessions", "2026", "10", "23", `rollout-2026-10-23T10-00-00-${X1}.jsonl`),
      "codex",
      { offset: 0 },
    );
    expect(x.entries.map((e) => e.role)).toEqual(["user", "tool"]);
    expect(x.entries[1]?.text).toContain("[REDACTED]");
    expect(x.entries[1]?.text).not.toContain("a".repeat(30));
  });

  it("answers LB's session.read only, and nothing while switched off", () => {
    const { h, herdr, exec } = fixture();
    const cache = new Map<string, Parsed>();
    run(h, herdr, exec, cache);
    const ok = answer("session.read", { id: C1, limit: 1 }, cache, false);
    expect(ok.ok).toBe(true);
    expect((ok as { data: { entries: unknown[]; cwd: string } }).data.entries).toHaveLength(1);
    expect(answer("agent.prompt", { id: C1 }, cache, false)).toMatchObject({
      ok: false,
      error: { code: "unsupported" },
    });
    expect(answer("session.read", { id: C1 }, cache, true)).toMatchObject({ ok: false, error: { code: "paused" } });
    expect(answer("session.read", { id: "nope" }, cache, false)).toMatchObject({
      ok: false,
      error: { code: "session_gone" },
    });
  });
});

describe("link", () => {
  it("signs LB's challenge with the node key, sends the latest list after the welcome, answers calls", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const sent: Record<string, unknown>[] = [];
    const handlers: Record<string, (ev: { data?: unknown; code?: number }) => void> = {};
    const ws = {
      readyState: 1,
      send: (s: string) => sent.push(JSON.parse(s)),
      close: () => undefined,
      addEventListener: (t: string, f: (ev: { data?: unknown; code?: number }) => void) => {
        handlers[t] = f;
      },
    };
    let url = "";
    const link = new LbLink({
      url: "https://lb.example",
      nodeId: "node-1",
      key: privateKey,
      machine: "host-a",
      log: () => undefined,
      onCall: (op) =>
        op === "session.read"
          ? { ok: true, data: { entries: [] } }
          : { ok: false, error: { code: "unsupported", message: "" } },
      connect: (u) => {
        url = u;
        return ws;
      },
    });
    link.send({ t: "sessions", sessions: [{ id: "a" }] });
    link.start();
    expect(url).toBe("wss://lb.example/api/nodes/connect");
    handlers.message?.({ data: JSON.stringify({ t: "challenge", nonce: "bm9uY2U=" }) });
    const hello = sent[0] as { t: string; node: string; sig: string; caps: string[] };
    expect(hello).toMatchObject({ t: "hello", node: "node-1", caps: ["sessions"] });
    expect(verify(null, Buffer.from("lb-node:bm9uY2U="), publicKey, Buffer.from(hello.sig, "base64"))).toBe(true);
    handlers.message?.({ data: JSON.stringify({ t: "welcome" }) });
    expect(sent[1]).toEqual({ t: "sessions", sessions: [{ id: "a" }] });
    handlers.message?.({ data: JSON.stringify({ t: "call", id: "c1", op: "session.read", args: { id: "a" } }) });
    expect(sent[2]).toEqual({ t: "result", id: "c1", ok: true, data: { entries: [] } });
    // It never sends panes or notices (an old LB would act on those).
    expect(sent.some((f) => f.t === "panes" || f.t === "notice")).toBe(false);
    link.stop();
  });
});

describe("node key", () => {
  it("reads a 0600 key file, refuses one others can read, never says the key", () => {
    const h = home();
    const k = newNodeKey();
    const file = join(h, "node-key.pem");
    expect(keepNodeKey(k, { file }, fakeExec({}))).toEqual({ ok: true });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const r = loadNodeKey({ lbUrl: "https://lb.example", nodeId: "n", keyFile: file }, fakeExec({}));
    expect("key" in r && r.key.asymmetricKeyType).toBe("ed25519");
    chmodSync(file, 0o644);
    const open = loadNodeKey({ lbUrl: "https://lb.example", nodeId: "n", keyFile: file }, fakeExec({}));
    expect(open).toEqual({ reason: `${file} is open to others (chmod 600 it)` });
    const missing = loadNodeKey({ lbUrl: "https://lb.example", nodeId: "n", keyFile: join(h, "nope") }, fakeExec({}));
    expect("reason" in missing && missing.reason).toContain("no key file");
    expect(JSON.stringify([open, missing])).not.toContain(k.privateKey);
  });

  it("still reads a keychain item (how a desktop machine was paired), the key on stdout only", () => {
    const k = newNodeKey();
    const calls: string[][] = [];
    const exec: Exec = (cmd, args) => {
      calls.push([cmd, ...args]);
      return cmd === "security" ? { code: 0, stdout: `${k.privateKey}\n`, stderr: "" } : null;
    };
    const r = loadNodeKey(
      { lbUrl: "https://lb.example", nodeId: "n", keychainService: "example.lb-node", keychainAccount: "a" },
      exec,
    );
    expect("key" in r).toBe(true);
    expect(calls).toEqual([["security", "find-generic-password", "-s", "example.lb-node", "-a", "a", "-w"]]);
    const locked = loadNodeKey(
      { lbUrl: "https://lb.example", nodeId: "n", keychainService: "s", keychainAccount: "a" },
      () => ({ code: 36, stdout: "", stderr: "" }),
    );
    expect("reason" in locked && locked.reason).toContain("locked");
  });
});

describe("runCollector", () => {
  it("stops when the process that started it is gone (ssh dropped), keeps going under launchd", async () => {
    const h = home();
    const paths = sessionsPaths({}, h);
    const c = { machine: "host-b", recentHours: 24, intervalSec: 10, report: null };
    const logs: string[] = [];
    let ppid = 4242;
    let passes = 0;
    const deps = {
      home: h,
      env: {},
      exec: fakeExec({}),
      now: () => NOW,
      log: (s: string) => logs.push(s),
      herdr: async () => null,
      parent: () => ppid,
      sleep: async () => {
        passes++;
        if (passes === 2) ppid = 1;
      },
    };
    expect(await runCollector(c, paths, deps)).toBe(0);
    expect(passes).toBe(2);
    expect(logs.join("\n")).toContain("is gone");
    expect(existsSync(paths.spool)).toBe(true);
    // Under launchd the parent is pid 1 from the start: it never stops on its own.
    let n = 0;
    const launchd = runCollector(c, paths, {
      ...deps,
      parent: () => 1,
      sleep: async () => {
        if (++n === 5) throw new Error("still running");
      },
    });
    await expect(launchd).rejects.toThrow("still running");
  });

  it("an older collector stops once a newer one has taken collector.pid", async () => {
    const h = home();
    const paths = sessionsPaths({}, h);
    const logs: string[] = [];
    let passes = 0;
    const done = await runCollector({ machine: "host-b", recentHours: 24, intervalSec: 10, report: null }, paths, {
      home: h,
      env: {},
      exec: fakeExec({}),
      now: () => NOW,
      log: (s: string) => logs.push(s),
      herdr: async () => null,
      parent: () => 1,
      pid: 111,
      sleep: async () => {
        if (++passes === 3) writeFileSync(paths.pid, "222\n");
      },
    });
    expect(done).toBe(0);
    expect(passes).toBe(3);
    expect(logs.join("\n")).toContain("a newer collector has started");
  });
});
