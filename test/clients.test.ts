/** The herdr socket client, the agents-io host client and the Feishu REST client, against fakes. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AioClient, AioError } from "../src/aio.ts";
import { FeishuApi, FeishuError, userIdType } from "../src/feishu.ts";
import { HerdrError, herdrClient, listAgents, promptAgent, readAgent, sendKeys } from "../src/herdr.ts";
import { agent, FakeAio, FakeHerdr, fakeFeishu, inbound, tempDir, until } from "./fakes.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("herdr client", () => {
  it("lists, reads recent unwrapped output, prompts and presses keys over the socket", async () => {
    const tmp = tempDir();
    const fake = new FakeHerdr(join(tmp.dir, "herdr.sock"));
    await fake.start();
    cleanups.push(tmp.done, () => fake.stop());
    fake.agents = [agent("blocked")];
    fake.screens.set("w1:p1", "line a\nline b");
    const h = herdrClient(fake.socket);
    expect(await listAgents(h)).toEqual([agent("blocked")]);
    expect(await readAgent(h, "w1:p1", 80)).toBe("line a\nline b");
    await promptAgent(h, "w1:p1", "hi");
    await sendKeys(h, "w1:p1", ["esc"]);
    expect(fake.calls).toEqual([
      ["agent.list", {}],
      ["agent.read", { target: "w1:p1", source: "recent_unwrapped", lines: 80 }],
      ["agent.prompt", { target: "w1:p1", text: "hi" }],
      ["agent.send_keys", { target: "w1:p1", keys: ["esc"] }],
    ]);
  });

  it("turns herdr's errors and an absent socket into HerdrError codes", async () => {
    const tmp = tempDir();
    const fake = new FakeHerdr(join(tmp.dir, "herdr.sock"));
    await fake.start();
    cleanups.push(tmp.done, () => fake.stop());
    fake.errors.set("agent.prompt", "agent_blocked");
    await expect(promptAgent(herdrClient(fake.socket), "w1:p1", "x")).rejects.toMatchObject({ code: "agent_blocked" });
    const gone = herdrClient(join(tmp.dir, "nothing.sock"));
    const e = await listAgents(gone).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HerdrError);
    expect((e as HerdrError).code).toBe("ENOENT");
  });
});

describe("agents-io host client", () => {
  it("says hello with the token next to the socket, acks pushes, and refuses requests while offline", async () => {
    const tmp = tempDir();
    const aio = new FakeAio(join(tmp.dir, "run", "aio.sock"));
    await aio.start();
    cleanups.push(tmp.done, () => aio.stop());
    const got: string[] = [];
    const states: string[] = [];
    const c = new AioClient({
      socket: aio.socket,
      name: "test-host",
      consumer: "c1",
      retryMs: 20,
      onInbound: async (item) => {
        got.push(item.channelRef);
        return item.channelRef.endsWith("om_test_keep");
      },
      onState: (s) => states.push(s),
    });
    await expect(c.request("bindings.get")).rejects.toMatchObject({ code: "offline" });
    c.start();
    cleanups.push(() => c.stop());
    expect(await c.waitOnline(2000)).toBe(true);
    expect(c.hello).toMatchObject({ name: "test-host", host: true });
    expect(await aio.push(inbound({ id: "om_test_keep", text: "x" }))).toMatchObject({
      ok: true,
      value: { accepted: true },
    });
    expect(await aio.push(inbound({ id: "om_test_retry", text: "x" }))).toMatchObject({
      ok: true,
      value: { accepted: false },
    });
    expect(got).toEqual(["channel:lark-bot/om_test_keep", "channel:lark-bot/om_test_retry"]);
    // Errors carry the daemon's code.
    const e = await c.request("run.start", { runId: "r" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AioError);
    expect((e as AioError).code).toBe("unsupported");
    // A dropped connection comes back by itself.
    aio.dropAll();
    await until(() => states.filter((s) => s === "online").length >= 2);
  });

  it("reads a new token after the daemon restarts with one", async () => {
    const tmp = tempDir();
    const aio = new FakeAio(join(tmp.dir, "run", "aio.sock"));
    await aio.start();
    cleanups.push(tmp.done, () => aio.stop());
    writeFileSync(`${aio.socket}.token`, "stale-token-000000000000\n");
    const c = new AioClient({ socket: aio.socket, name: "t", consumer: "c", retryMs: 20 });
    c.start();
    cleanups.push(() => c.stop());
    expect(await c.waitOnline(150)).toBe(false);
    writeFileSync(`${aio.socket}.token`, `${aio.token}\n`);
    expect(await c.waitOnline(2000)).toBe(true);
  });

  it("gives up at once without reconnect when nobody listens", async () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const sock = join(tmp.dir, "aio.sock");
    writeFileSync(`${sock}.token`, "x\n");
    const c = new AioClient({ socket: sock, name: "t", reconnect: false });
    c.start();
    expect(await c.waitOnline(2000)).toBe(false);
    c.stop();
  });
});

describe("Feishu REST", () => {
  it("gets a tenant token once and creates the group with the owner", async () => {
    const f = fakeFeishu();
    let now = 0;
    const api = new FeishuApi({
      appId: "app-test-id",
      appSecret: "app-test-secret",
      domain: "lark",
      fetch: f.fetch,
      now: () => now,
    });
    expect(await api.createChat({ name: "my-mac terminal", ownerId: "ou_test_owner" })).toEqual({
      chatId: "oc_test_workbench",
    });
    now += 60_000;
    await api.createChat({ name: "again", ownerId: "on_test_owner" });
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
      "https://open.larksuite.com/open-apis/im/v1/chats?user_id_type=open_id&set_bot_manager=true",
      "https://open.larksuite.com/open-apis/im/v1/chats?user_id_type=union_id&set_bot_manager=true",
    ]);
    now += 7200_000;
    await api.token();
    expect(f.calls).toHaveLength(4);
  });

  it("reports Feishu's code and message, never the credentials", async () => {
    const f = fakeFeishu({ code: 232025, msg: "Bot ability is not activated" });
    const api = new FeishuApi({ appId: "app-test-id", appSecret: "app-test-secret", domain: "feishu", fetch: f.fetch });
    const e = await api.createChat({ name: "x", ownerId: "on_test_owner" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FeishuError);
    expect((e as FeishuError).code).toBe(232025);
    expect((e as Error).message).toContain("Bot ability is not activated");
    expect((e as Error).message).not.toContain("app-test-secret");
    expect(userIdType("on_x")).toBe("union_id");
    expect(userIdType("ou_x")).toBe("open_id");
    expect(userIdType("abc123")).toBe("user_id");
  });
});
