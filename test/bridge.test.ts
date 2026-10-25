/**
 * The bridge end to end, against a fake agents-io daemon (host protocol on a temp unix socket), a
 * fake herdr socket server and a fake Feishu Open API. No real Feishu, herdr or daemon.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AioClient } from "../src/aio.ts";
import { Bridge, CONSUMER, HOST_NAME } from "../src/bridge.ts";
import type { Config } from "../src/config.ts";
import { FeishuApi } from "../src/feishu.ts";
import { herdrClient } from "../src/herdr.ts";
import { Store, writeSetup } from "../src/store.ts";
import {
  ACCOUNT,
  agent,
  DM,
  FakeAio,
  FakeHerdr,
  fakeFeishu,
  inbound,
  OWNER,
  STRANGER,
  tempDir,
  testConfig,
  until,
  WORKBENCH,
} from "./fakes.ts";

const DIALOG = [
  "⏺ Bash(rm -rf build)",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. No, and tell Codex what to do differently (esc)",
].join("\n");

interface World {
  cfg: Config;
  aio: FakeAio;
  herdr: FakeHerdr;
  client: AioClient;
  bridge: Bridge;
  store: Store;
  feishu: ReturnType<typeof fakeFeishu>;
  logs: string[];
  clock: { now: number };
  done: () => Promise<void>;
}

async function world(
  o: { chat?: Parameters<typeof fakeFeishu>[0]; config?: Record<string, unknown> } = {},
): Promise<World> {
  const tmp = tempDir();
  const cfg = testConfig(tmp.dir, { herdrSocket: join(tmp.dir, "h.sock"), ...o.config });
  const aio = new FakeAio(cfg.paths.socket);
  await aio.start();
  const herdr = new FakeHerdr(cfg.herdrSocket);
  await herdr.start();
  const feishu = fakeFeishu(o.chat);
  const logs: string[] = [];
  const clock = { now: Date.parse("2026-10-21T12:00:00Z") };
  const store = new Store(cfg.paths.stateFile);
  let bridge: Bridge | null = null;
  const client = new AioClient({
    socket: cfg.paths.socket,
    name: HOST_NAME,
    consumer: CONSUMER,
    retryMs: 20,
    onInbound: (item) => (bridge as Bridge).onInbound(item),
    onReady: async () => {
      await bridge?.pushBindings(true);
    },
  });
  bridge = new Bridge({
    config: cfg,
    machine: "my-mac",
    herdr: herdrClient(herdr.socket),
    aio: client,
    feishu: new FeishuApi({
      appId: "app-test-id",
      appSecret: "app-test-secret",
      domain: "feishu",
      fetch: feishu.fetch,
    }),
    store,
    now: () => clock.now,
    idleMs: () => null,
    log: (s) => logs.push(s),
  });
  client.start();
  expect(await client.waitOnline(3000)).toBe(true);
  await until(() => aio.tables.length > 0);
  return {
    cfg,
    aio,
    herdr,
    client,
    bridge,
    store,
    feishu,
    logs,
    clock,
    done: async () => {
      client.stop();
      await aio.stop();
      await herdr.stop();
      tmp.done();
    },
  };
}

/** Pushes one inbound item and waits until the bridge has handled it. */
async function send(w: World, m: Parameters<typeof inbound>[0]) {
  const item = inbound(m);
  const r = await w.aio.push(item);
  expect(r).toMatchObject({ ok: true, value: { accepted: true } });
  await w.bridge.settled();
  return item;
}

async function bind(w: World): Promise<void> {
  writeSetup(w.cfg.paths.setupFile, "1234-5678", w.clock.now);
  await w.bridge.tick();
  await send(w, { from: OWNER, chat: DM, kind: "dm", text: "1234 5678" });
}

/** Ticks every 2 s for `seconds`, with the pane in `status`. */
async function run(w: World, seconds: number, status?: string): Promise<void> {
  if (status) w.herdr.agents = w.herdr.agents.map((a) => ({ ...a, agent_status: status }));
  for (let t = 0; t < seconds; t += 2) {
    w.clock.now += 2000;
    await w.bridge.tick();
  }
}

/** A blocked dialog in pane w1:p1, announced. */
async function blockedNotice(w: World) {
  w.herdr.agents = [agent("working")];
  w.herdr.screens.set("w1:p1", DIALOG);
  await w.bridge.tick();
  await run(w, 64, "blocked");
}

let w: World;
afterEach(async () => {
  await w?.done();
});

describe("binding table", () => {
  beforeEach(async () => {
    w = await world();
  });

  it("routes only buttons before setup, and keeps the table while the host is away", () => {
    const t = w.aio.lastTable;
    expect(t?.bindings.map((b) => b.id)).toEqual(["herdr:buttons"]);
    expect(t?.bindings[0]?.match).toEqual({ channel: "lark-bot", account: ACCOUNT, actionPrefix: "herdr:" });
    expect(t?.bindings.every((b) => b.on === "host")).toBe(true);
    expect(t?.onHostDown).toBe("keep");
    expect(t?.identities).toEqual([]);
    const hello = w.aio.frames.find((f) => f.type === "host.hello");
    expect(hello).toMatchObject({ v: 1, name: HOST_NAME, consumer: CONSUMER, takeover: true, token: w.aio.token });
  });

  it("opens DMs to the host while a setup code waits, and only then", async () => {
    writeSetup(w.cfg.paths.setupFile, "1234-5678", w.clock.now);
    await w.bridge.tick();
    expect(w.aio.lastTable?.bindings.map((b) => b.id)).toEqual(["herdr:buttons", "herdr:setup-dm"]);
    w.clock.now += 16 * 60_000;
    await w.bridge.tick();
    expect(w.aio.lastTable?.bindings.map((b) => b.id)).toEqual(["herdr:buttons"]);
    expect(existsSync(w.cfg.paths.setupFile)).toBe(false);
  });

  it("pushes the same table again after the daemon comes back", async () => {
    const n = w.aio.tables.length;
    w.aio.dropAll();
    await until(() => w.aio.tables.length > n);
    expect(w.aio.lastTable?.version).toBe(w.aio.tables[n - 1]?.version);
  });
});

describe("setup: binding the owner and the workbench", () => {
  it("binds whoever DMs the code, creates the group with the app's token and says hello", async () => {
    w = await world();
    await bind(w);
    const st = w.store.state;
    expect(st.owner).toMatchObject({ id: OWNER, dmChat: DM });
    expect(st.workbench).toMatchObject({ chatId: WORKBENCH, via: "created" });
    expect(existsSync(w.cfg.paths.setupFile)).toBe(false);
    // Feishu: a tenant token, then im/v1/chats with the owner, by union_id.
    expect(w.feishu.calls.map((c) => c.url.replace("https://open.feishu.cn/open-apis", ""))).toEqual([
      "/auth/v3/tenant_access_token/internal",
      expect.stringMatching(/^\/im\/v1\/chats\?user_id_type=union_id&set_bot_manager=true&uuid=[0-9a-f]{32}$/),
    ]);
    expect(w.feishu.calls[0]?.body).toEqual({ app_id: "app-test-id", app_secret: "app-test-secret" });
    expect(w.feishu.calls[1]?.auth).toBe("Bearer t-test-token");
    expect(w.feishu.calls[1]?.body).toMatchObject({
      name: "my-mac terminal",
      owner_id: OWNER,
      user_id_list: [OWNER],
      chat_mode: "group",
      chat_type: "private",
    });
    // The DM hears it worked; the group gets a hello.
    const said = w.aio.delivered.map((d) => [d.route.conversationId, d.message.text.split(".")[0]]);
    expect(said).toEqual([
      [DM, "Done: you own this machine now"],
      [WORKBENCH, "This is the workbench of my-mac"],
      [DM, 'Created the workbench group "my-mac terminal"'],
    ]);
    // Now the owner's DM, the workbench and the owner's @s reach the host; the owner has a principal.
    const t = w.aio.lastTable;
    expect(t?.bindings.map((b) => b.id)).toEqual([
      "herdr:buttons",
      "herdr:owner-dm",
      "herdr:workbench",
      "herdr:owner-mention",
    ]);
    expect(t?.bindings.find((b) => b.id === "herdr:owner-dm")?.match).toMatchObject({
      conversationKind: "dm",
      senders: [OWNER],
    });
    expect(t?.bindings.find((b) => b.id === "herdr:workbench")?.match).toMatchObject({ conversation: WORKBENCH });
    expect(t?.identities).toEqual([
      { channel: "lark-bot", channelUserId: OWNER, principal: "owner", labels: ["owner"] },
    ]);
  });

  it("refuses a wrong code, counts it, and does not answer other DMs", async () => {
    w = await world();
    writeSetup(w.cfg.paths.setupFile, "1234-5678", w.clock.now);
    await w.bridge.tick();
    await send(w, { from: STRANGER, chat: "oc_test_other_dm", kind: "dm", text: "0000-0000" });
    expect(w.aio.delivered.map((d) => d.message.text)).toEqual(["That code is wrong; 4 tries left."]);
    await send(w, { from: STRANGER, chat: "oc_test_other_dm", kind: "dm", text: "hello?" });
    expect(w.aio.delivered).toHaveLength(1);
    expect(w.store.state.owner).toBeNull();
    for (let i = 0; i < 4; i++)
      await send(w, { from: STRANGER, chat: "oc_test_other_dm", kind: "dm", text: "1111 1111" });
    expect(existsSync(w.cfg.paths.setupFile)).toBe(false);
    expect(w.aio.lastTable?.bindings.map((b) => b.id)).toEqual(["herdr:buttons"]);
  });

  it("falls back to the DM when the group cannot be created; an @ in a group makes that group the workbench", async () => {
    w = await world({ chat: { code: 99991672, msg: "Access denied" } });
    await bind(w);
    expect(w.store.state.workbench).toBeNull();
    expect(w.store.state.workbenchError).toContain("99991672");
    expect(w.aio.delivered.at(-1)?.message.text).toMatch(/^Could not create the workbench group \(99991672/);
    // Notices go to the DM meanwhile.
    await blockedNotice(w);
    const n = w.aio.delivered.at(-1);
    expect(n?.route).toEqual({ channel: "lark-bot", account: ACCOUNT, conversationId: DM });
    expect(n?.message.sections?.[0]?.text).toBe("w1:p1 · reply to this message to talk to it");
    // The owner names a group.
    await send(w, { from: OWNER, chat: "oc_test_group", kind: "group", text: "@_user_1 /workbench" });
    expect(w.store.state.workbench).toMatchObject({ chatId: "oc_test_group", via: "mention" });
    expect(w.aio.delivered.at(-1)).toMatchObject({
      route: { conversationId: "oc_test_group" },
      message: { text: expect.stringMatching(/^Done: this group is the workbench/) },
    });
    expect(w.aio.lastTable?.bindings.find((b) => b.id === "herdr:workbench")?.match.conversation).toBe("oc_test_group");
  });
});

describe("notices and answers", () => {
  beforeEach(async () => {
    w = await world();
    await bind(w);
  });

  it("opens a topic per pane: the first notice is its root with the dialog's buttons, later ones reply in it", async () => {
    const from = w.aio.delivered.length;
    await blockedNotice(w);
    const [first] = w.aio.since(from);
    expect(first?.route).toEqual({ channel: "lark-bot", account: ACCOUNT, conversationId: WORKBENCH });
    expect(first?.message.text).toContain("**my-mac · ledger · Codex is waiting for you**");
    expect(first?.message.text).toContain("❯ 1. Yes");
    const t = w.store.state.threads[0];
    expect(t).toMatchObject({ paneId: "w1:p1", terminalId: "term_1", chatId: WORKBENCH, workbench: true });
    expect(first?.message.actions).toEqual([
      { id: `herdr:key:${t?.id}:1`, label: "1 Yes" },
      { id: `herdr:key:${t?.id}:2`, label: "2 No, and tell Code…" },
      { id: `herdr:key:${t?.id}:esc`, label: "Esc cancel" },
    ]);
    // Back to work, then a long turn finishes: into the same topic.
    await run(w, 4, "working");
    await run(w, 200, "working");
    await run(w, 34, "done");
    const last = w.aio.delivered.at(-1);
    expect(last?.message.text).toMatch(/^\*\*my-mac · ledger · Codex finished\*\* \(this turn: 5 min\)/);
    expect(last?.route).toMatchObject({ conversationId: WORKBENCH, replyToMessageId: t?.rootMessageId });
    expect(last?.route.threadId).toBeTruthy();
    expect(w.store.thread(t?.id ?? "")?.threadId).toMatch(/^omt_test_/);
    expect(w.store.state.threads).toHaveLength(1);
  });

  it("types the owner's reply in the topic into that pane, once, and marks the message done", async () => {
    await blockedNotice(w);
    await run(w, 2, "idle");
    const t = w.store.state.threads[0];
    const item = await send(w, {
      chat: WORKBENCH,
      kind: "thread",
      threadId: "omt_test_topic",
      rootMessageId: t?.rootMessageId,
      text: "run the tests again",
    });
    expect(w.herdr.actions).toEqual([["agent.prompt", { target: "w1:p1", text: "run the tests again" }]]);
    // "Sent" is a reaction on the owner's message, not another message.
    const n = w.aio.delivered.length;
    expect(w.feishu.reacted()).toEqual([[item.envelope.id, "DONE"]]);
    expect(w.feishu.calls.at(-1)?.auth).toBe("Bearer t-test-token");
    // The daemon delivers at least once: the same message again types nothing.
    const again = await w.aio.push(item);
    expect(again).toMatchObject({ ok: true, value: { accepted: true } });
    await w.bridge.settled();
    expect(w.herdr.actions).toHaveLength(1);
    expect(w.feishu.reacted()).toHaveLength(1);
    expect(w.aio.delivered).toHaveLength(n);
  });

  it("says it in words when the app may not react", async () => {
    w.feishu.reactions.code = 99991672;
    await blockedNotice(w);
    await run(w, 2, "idle");
    const t = w.store.state.threads[0];
    const topic = {
      chat: WORKBENCH,
      kind: "thread" as const,
      threadId: "omt_test_topic",
      rootMessageId: t?.rootMessageId,
    };
    const item = await send(w, { ...topic, text: "go on" });
    expect(w.aio.delivered.at(-1)).toMatchObject({
      route: { conversationId: WORKBENCH, threadId: "omt_test_topic", replyToMessageId: item.envelope.id },
      message: { text: "Sent." },
    });
    // It does not ask again until a restart.
    await send(w, { ...topic, text: "and lint" });
    expect(w.feishu.reacted()).toHaveLength(1);
    expect(w.aio.delivered.at(-1)?.message.text).toBe("Sent.");
    expect(w.logs.filter((l) => l.startsWith("reactions refused"))).toHaveLength(1);
  });

  it("finds the pane by the topic id alone, and by a reply to its own answer", async () => {
    await blockedNotice(w);
    await run(w, 2, "idle");
    const t = w.store.state.threads[0];
    // Pressing a key makes the topic; the answer comes back with its thread id.
    await send(w, { chat: WORKBENCH, action: { actionId: `herdr:key:${t?.id}:1`, messageId: t?.rootMessageId ?? "" } });
    const topic = w.store.thread(t?.id ?? "")?.threadId;
    expect(topic).toBeTruthy();
    const goOn = await send(w, { chat: WORKBENCH, kind: "thread", threadId: topic ?? undefined, text: "go on" });
    expect(w.feishu.reacted()).toEqual([[goOn.envelope.id, "DONE"]]);
    const answerId = [...w.store.state.messages].reverse().find(([, tid]) => tid === t?.id)?.[0];
    expect(answerId).toBe(goOn.envelope.id);
    await send(w, {
      chat: WORKBENCH,
      kind: "group",
      parentMessageId: answerId,
      rootMessageId: answerId,
      text: "and lint",
    });
    expect(w.herdr.actions.filter(([m]) => m === "agent.prompt").map(([, p]) => p.text)).toEqual(["go on", "and lint"]);
  });

  it("does not type into a waiting dialog: it says so and offers the buttons again", async () => {
    await blockedNotice(w);
    const t = w.store.state.threads[0];
    await send(w, {
      chat: WORKBENCH,
      kind: "thread",
      threadId: "omt_test_topic",
      rootMessageId: t?.rootMessageId,
      text: "yes",
    });
    expect(w.herdr.actions).toEqual([]);
    const said = w.aio.delivered.at(-1);
    expect(said?.message.text).toBe("It is waiting for a choice; not sent. Pick one:");
    expect(said?.message.actions?.map((a) => a.id)).toEqual([
      `herdr:key:${t?.id}:1`,
      `herdr:key:${t?.id}:2`,
      `herdr:key:${t?.id}:esc`,
    ]);
    // herdr refusing the prompt (a dialog opened in between) ends the same way.
    w.herdr.agents = [agent("idle")];
    w.herdr.errors.set("agent.prompt", "agent_blocked");
    await send(w, {
      chat: WORKBENCH,
      kind: "thread",
      threadId: "omt_test_topic",
      rootMessageId: t?.rootMessageId,
      text: "yes",
    });
    expect(w.aio.delivered.at(-1)?.message.text).toBe("It is waiting for a choice; not sent. Pick one:");
  });

  it("presses a dialog's key for the owner, in the same terminal only", async () => {
    await blockedNotice(w);
    const t = w.store.state.threads[0];
    await send(w, { chat: WORKBENCH, action: { actionId: `herdr:key:${t?.id}:1`, messageId: t?.rootMessageId ?? "" } });
    expect(w.herdr.actions).toEqual([["agent.send_keys", { target: "w1:p1", keys: ["1"] }]]);
    expect(w.aio.delivered.at(-1)).toMatchObject({
      route: { conversationId: WORKBENCH, threadId: "topic", replyToMessageId: t?.rootMessageId },
      message: { text: "Pressed 1." },
    });
    await send(w, {
      chat: WORKBENCH,
      action: { actionId: `herdr:key:${t?.id}:esc`, messageId: t?.rootMessageId ?? "" },
    });
    expect(w.herdr.actions.at(-1)).toEqual(["agent.send_keys", { target: "w1:p1", keys: ["esc"] }]);
    // A card forwarded to another chat presses nothing; neither does a made-up key.
    await send(w, {
      chat: "oc_test_elsewhere",
      action: { actionId: `herdr:key:${t?.id}:1`, messageId: "om_test_fwd" },
    });
    await send(w, {
      chat: WORKBENCH,
      action: { actionId: `herdr:key:${t?.id}:ctrl-c`, messageId: t?.rootMessageId ?? "" },
    });
    expect(w.herdr.actions).toHaveLength(2);
    // The program in the pane changed: not the same agent any more.
    w.herdr.agents = [agent("blocked", { terminal_id: "term_9" })];
    await send(w, { chat: WORKBENCH, action: { actionId: `herdr:key:${t?.id}:1`, messageId: t?.rootMessageId ?? "" } });
    expect(w.herdr.actions).toHaveLength(2);
    expect(w.aio.delivered.at(-1)?.message.text).toBe("This agent is gone; not sent.");
  });

  it("lets nobody but the owner drive, and never answers another bot", async () => {
    await blockedNotice(w);
    const t = w.store.state.threads[0];
    const n = w.aio.delivered.length;
    await send(w, {
      from: STRANGER,
      chat: WORKBENCH,
      action: { actionId: `herdr:key:${t?.id}:1`, messageId: t?.rootMessageId ?? "" },
    });
    await send(w, {
      from: STRANGER,
      chat: WORKBENCH,
      kind: "thread",
      threadId: "omt_test_topic",
      rootMessageId: t?.rootMessageId,
      text: "rm -rf /",
    });
    expect(w.herdr.actions).toEqual([]);
    expect(w.aio.since(n).map((d) => d.message.text)).toEqual([
      "Only this machine's owner can answer this agent.",
      "Only this machine's owner can answer this agent.",
    ]);
    // An owner id without platform evidence is not the owner either.
    await send(w, {
      from: OWNER,
      evidence: "none",
      chat: WORKBENCH,
      kind: "thread",
      threadId: "omt_test_topic",
      rootMessageId: t?.rootMessageId,
      text: "x",
    });
    expect(w.herdr.actions).toEqual([]);
    const m = w.aio.delivered.length;
    await send(w, {
      from: "on_test_bot",
      isBot: true,
      chat: WORKBENCH,
      kind: "thread",
      threadId: "omt_test_topic",
      rootMessageId: t?.rootMessageId,
      text: "x",
    });
    expect(w.aio.delivered).toHaveLength(m);
  });

  it("closes a pane's topic when the agent ends", async () => {
    await blockedNotice(w);
    const t = w.store.state.threads[0];
    w.herdr.agents = [];
    await run(w, 2);
    expect(w.store.thread(t?.id ?? "")?.closedAt).not.toBeNull();
    expect(w.aio.delivered.at(-1)).toMatchObject({
      route: { conversationId: WORKBENCH, replyToMessageId: t?.rootMessageId },
      message: { text: "This agent has ended." },
    });
    await send(w, {
      chat: WORKBENCH,
      kind: "thread",
      threadId: "omt_test_topic",
      rootMessageId: t?.rootMessageId,
      text: "hello?",
    });
    expect(w.aio.delivered.at(-1)?.message.text).toBe("This agent is gone; not sent.");
    expect(w.herdr.actions).toEqual([]);
    // A new agent in the same pane gets a new topic.
    w.herdr.agents = [agent("working", { terminal_id: "term_2" })];
    w.herdr.screens.set("w1:p1", DIALOG);
    await run(w, 2);
    await run(w, 64, "blocked");
    expect(w.store.state.threads.filter((x) => x.closedAt === null)).toHaveLength(1);
    expect(w.aio.delivered.at(-1)?.route).toEqual({ channel: "lark-bot", account: ACCOUNT, conversationId: WORKBENCH });
  });

  it("answers status, help, pause and resume", async () => {
    w.herdr.agents = [
      agent("working"),
      agent("idle", {
        pane_id: "w1:p2",
        terminal_id: "term_2",
        agent: "claude",
        cwd: "/home/dev/projects/api",
        foreground_cwd: null,
      }),
    ];
    await w.bridge.tick();
    w.clock.now += 5 * 60_000;
    await send(w, { chat: DM, kind: "dm", text: "/status" });
    const card = w.aio.delivered.at(-1);
    expect(card?.route).toMatchObject({ conversationId: DM });
    expect(card?.message.text).toBe(
      [
        "**my-mac · 2 agents**",
        "- ledger · Codex · working · 5 min · fix the parser",
        "- api · Claude · idle · 5 min · fix the parser",
      ].join("\n"),
    );
    expect(card?.message.sections?.[0]?.text).toBe("sending · quiet hours 23:00-08:00 · notices go to the workbench");
    await send(w, { chat: WORKBENCH, kind: "group", text: "/help" });
    expect(w.aio.delivered.at(-1)?.message.text).toMatch(/^\*\*my-mac · what I do\*\*/);
    await send(w, { chat: DM, kind: "dm", text: "what is going on" });
    expect(w.aio.delivered.at(-1)?.message.text).toMatch(/^\*\*my-mac · what I do\*\*/);
    // Only `/` commands: the bare word, in any language, is not one.
    for (const text of ["status", "状态", "ls", "列表", "看 p1"]) {
      await send(w, { chat: DM, kind: "dm", text });
      expect(w.aio.delivered.at(-1)?.message.text).toMatch(/^\*\*my-mac · what I do\*\*/);
    }
    // Pause: nothing is sent, nothing typed.
    await send(w, { chat: DM, kind: "dm", text: "/pause" });
    expect(existsSync(w.cfg.paths.pauseFile)).toBe(true);
    const n = w.aio.delivered.length;
    await blockedNotice(w);
    expect(w.aio.delivered).toHaveLength(n);
    await send(w, { chat: DM, kind: "dm", text: "/resume" });
    expect(existsSync(w.cfg.paths.pauseFile)).toBe(false);
    expect(w.aio.delivered.at(-1)?.message.text).toBe("Resumed.");
  });

  it("retries a notice the daemon could not take, with the same operation id", async () => {
    w.client.stop();
    await blockedNotice(w);
    const n = w.aio.delivered.length;
    expect(w.logs.some((l) => /not sent \(try 1\)/.test(l))).toBe(true);
    w.client.start();
    expect(await w.client.waitOnline(3000)).toBe(true);
    await run(w, 12);
    expect(w.aio.delivered.length).toBe(n + 1);
    expect(w.aio.delivered.at(-1)?.message.text).toContain("is waiting for you");
  });

  it("sends to the DM when the workbench refuses a notice", async () => {
    w.aio.refuse = (d) => (d.route.conversationId === WORKBENCH ? "bot not in chat" : null);
    await blockedNotice(w);
    const [wb, dm] = w.aio.delivered.slice(-2);
    expect(wb?.route.conversationId).toBe(WORKBENCH);
    expect(dm?.route).toEqual({ channel: "lark-bot", account: ACCOUNT, conversationId: DM });
    expect(w.store.state.threads[0]).toMatchObject({ chatId: DM, workbench: false });
  });
});

describe("in the DM, without a workbench", () => {
  it("a quote-reply to a notice talks to its agent", async () => {
    w = await world({ config: { workbench: { create: false } } });
    await bind(w);
    expect(w.aio.delivered.at(-1)?.message.text).toMatch(/workbench\.create is false/);
    await blockedNotice(w);
    await run(w, 2, "idle");
    const notice = w.store.state.threads[0]?.rootMessageId;
    const item = await send(w, {
      chat: DM,
      kind: "dm",
      parentMessageId: notice,
      rootMessageId: notice,
      text: "continue",
    });
    expect(w.herdr.actions).toEqual([["agent.prompt", { target: "w1:p1", text: "continue" }]]);
    expect(w.feishu.reacted()).toEqual([[item.envelope.id, "DONE"]]);
    // A quote-reply to that message reaches the same agent.
    await send(w, { chat: DM, kind: "dm", parentMessageId: item.envelope.id, text: "and lint" });
    expect(w.herdr.actions.at(-1)).toEqual(["agent.prompt", { target: "w1:p1", text: "and lint" }]);
  });
});

describe("looking at and driving any pane", () => {
  const SHELL = agent("unknown", {
    pane_id: "w1:p3",
    terminal_id: "term_3",
    agent: null,
    cwd: "/home/dev/scratch",
    foreground_cwd: "/home/dev/scratch",
    terminal_title_stripped: "zsh",
    tab_id: "w1:t3",
  });
  const CODEX = agent("idle", { tab_id: "w1:t1" });

  beforeEach(async () => {
    w = await world();
    await bind(w);
    w.herdr.agents = [CODEX, SHELL];
    w.herdr.tabs = [
      { tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "ledger" },
      { tab_id: "w1:t3", workspace_id: "w1", number: 3, label: "tail" },
    ];
    w.herdr.screens.set("w1:p1", "⏺ All tests pass.");
    w.herdr.screens.set("w1:p3", "$ make\nok");
  });

  it("lists every pane, plain terminals too, with a view button each", async () => {
    await send(w, { chat: DM, kind: "dm", text: "/ls" });
    const card = w.aio.delivered.at(-1);
    expect(card?.message.text).toBe(
      [
        "**my-mac · 2 panes**",
        "- p1 · ledger · Codex · idle · fix the parser",
        "- p3 · tail · scratch · terminal · zsh",
      ].join("\n"),
    );
    expect(card?.message.actions).toEqual([
      { id: "herdr:view:term_1", label: "View p1" },
      { id: "herdr:view:term_3", label: "View p3" },
    ]);
  });

  it("shows a pane's screen by any of its names, and a reply to the card talks to that pane", async () => {
    for (const ref of ["p3", "w1:p3", "tail", "scratch"]) {
      await send(w, { chat: DM, kind: "dm", text: `/view ${ref}` });
      expect(w.aio.delivered.at(-1)?.message.text).toBe(
        "**my-mac · p3 · scratch · terminal**\nzsh\n```\n$ make\nok\n```",
      );
    }
    const card = w.aio.delivered.at(-1);
    expect(card?.message.actions).toEqual([{ id: "herdr:view:term_3", label: "Refresh" }]);
    const cardId = w.store.state.views.at(-1)?.messageId;
    const n = w.aio.delivered.length;
    const make = await send(w, {
      chat: DM,
      kind: "dm",
      parentMessageId: cardId,
      rootMessageId: cardId,
      text: "make test",
    });
    expect(w.herdr.actions).toEqual([
      ["pane.send_text", { pane_id: "w1:p3", text: "make test" }],
      ["pane.send_keys", { pane_id: "w1:p3", keys: ["enter"] }],
    ]);
    expect(w.feishu.reacted()).toEqual([[make.envelope.id, "DONE"]]);
    expect(w.aio.delivered).toHaveLength(n);
    // A reply to that message reaches the same pane; `/keys` there presses keys.
    await send(w, {
      chat: DM,
      kind: "dm",
      parentMessageId: make.envelope.id,
      rootMessageId: make.envelope.id,
      text: "/keys ctrl+c",
    });
    expect(w.herdr.actions.at(-1)).toEqual(["pane.send_keys", { pane_id: "w1:p3", keys: ["ctrl+c"] }]);
    // Another program in that pane now: the old card reaches nothing.
    w.herdr.agents = [CODEX, { ...SHELL, terminal_id: "term_9" }];
    await send(w, { chat: DM, kind: "dm", parentMessageId: cardId, rootMessageId: cardId, text: "rm -rf /" });
    expect(w.herdr.actions).toHaveLength(3);
    expect(w.aio.delivered.at(-1)?.message.text).toMatch(/^p3 runs something else now/);
  });

  it("sends text to an agent as a prompt, presses keys, and refuses bad keys before typing", async () => {
    const n = w.aio.delivered.length;
    const sent = await send(w, { chat: WORKBENCH, kind: "group", text: "/send ledger run the tests" });
    expect(w.herdr.actions).toEqual([["agent.prompt", { target: "w1:p1", text: "run the tests" }]]);
    const keys = await send(w, { chat: DM, kind: "dm", text: "/keys p1 esc up enter" });
    expect(w.herdr.actions.at(-1)).toEqual(["pane.send_keys", { pane_id: "w1:p1", keys: ["esc", "up", "enter"] }]);
    expect(w.feishu.reacted()).toEqual([
      [sent.envelope.id, "DONE"],
      [keys.envelope.id, "DONE"],
    ]);
    expect(w.aio.delivered).toHaveLength(n);
    await send(w, { chat: DM, kind: "dm", text: "/keys p1 esc launch-missiles" });
    expect(w.aio.delivered.at(-1)?.message.text).toMatch(/^Unknown key, nothing pressed/);
    await send(w, { chat: DM, kind: "dm", text: "/view nowhere" });
    expect(w.aio.delivered.at(-1)?.message.text).toBe('No pane called "nowhere". Send /ls to see them.');
    await send(w, { chat: DM, kind: "dm", text: "/send p1" });
    expect(w.aio.delivered.at(-1)?.message.text).toMatch(/^Usage:/);
  });

  it("shows a waiting dialog instead of typing into it, with buttons that press its keys", async () => {
    w.herdr.agents = [{ ...CODEX, agent_status: "blocked" }, SHELL];
    w.herdr.screens.set("w1:p1", DIALOG);
    await send(w, { chat: DM, kind: "dm", text: "/send p1 yes" });
    expect(w.herdr.actions).toEqual([]);
    const card = w.aio.delivered.at(-1);
    expect(card?.message.text).toMatch(/^It is waiting for a choice; not sent\./);
    expect(card?.message.actions?.map((a) => a.id)).toEqual([
      "herdr:pk:term_1:1",
      "herdr:pk:term_1:2",
      "herdr:pk:term_1:esc",
      "herdr:view:term_1",
    ]);
    await send(w, { chat: DM, action: { actionId: "herdr:pk:term_1:1", messageId: "om_test_card" } });
    expect(w.herdr.actions).toEqual([["pane.send_keys", { pane_id: "w1:p1", keys: ["1"] }]]);
    // The refresh button shows the screen again.
    await send(w, { chat: DM, action: { actionId: "herdr:view:term_1", messageId: "om_test_card" } });
    expect(w.aio.delivered.at(-1)?.message.text).toContain("❯ 1. Yes");
  });

  it("in a pane's topic, /view shows its screen and plain text still goes to the agent", async () => {
    w.herdr.agents = [agent("working", { tab_id: "w1:t1" }), SHELL];
    w.herdr.screens.set("w1:p1", DIALOG);
    await w.bridge.tick();
    await run(w, 64, "blocked");
    await run(w, 2, "idle");
    const t = w.store.state.threads[0];
    const topic = {
      chat: WORKBENCH,
      kind: "thread" as const,
      threadId: "omt_test_topic",
      rootMessageId: t?.rootMessageId,
    };
    await send(w, { ...topic, text: "/view 5" });
    const card = w.aio.delivered.at(-1);
    expect(card?.route).toMatchObject({ conversationId: WORKBENCH, threadId: "omt_test_topic" });
    expect(card?.message.text).toContain("❯ 1. Yes");
    expect(card?.message.sections?.[0]?.text).toMatch(/^Reply in this topic/);
    await send(w, { ...topic, text: "/keys esc" });
    expect(w.herdr.actions).toEqual([["pane.send_keys", { pane_id: "w1:p1", keys: ["esc"] }]]);
    await send(w, { ...topic, text: "view the logs please" });
    expect(w.herdr.actions.at(-1)).toEqual(["agent.prompt", { target: "w1:p1", text: "view the logs please" }]);
    await send(w, { ...topic, text: "/compact" });
    expect(w.herdr.actions.at(-1)).toEqual(["agent.prompt", { target: "w1:p1", text: "/compact" }]);
  });

  it("shows nothing outside the DM and the workbench, and to nobody but the owner", async () => {
    await send(w, { chat: "oc_test_group", kind: "group", text: "@_user_1 /view p3" });
    expect(w.aio.delivered.at(-1)?.message.text).toBe(
      "Screens and pane control only work in the DM and the workbench.",
    );
    const n = w.aio.delivered.length;
    await send(w, { from: STRANGER, chat: WORKBENCH, kind: "group", text: "/view p3" });
    expect(w.aio.delivered).toHaveLength(n);
    await send(w, { from: STRANGER, chat: WORKBENCH, action: { actionId: "herdr:view:term_3", messageId: "om_x" } });
    expect(w.aio.delivered.at(-1)?.message.text).toBe("Only this machine's owner can answer this agent.");
    await send(w, { chat: "oc_test_group", action: { actionId: "herdr:pk:term_3:1", messageId: "om_x" } });
    expect(w.herdr.actions).toEqual([]);
  });
});
