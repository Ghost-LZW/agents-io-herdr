/** Config, credentials, the generated daemon config, launchd plists and the command line. */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, resolveConfig } from "../src/config.ts";
import { APP_ID_VAR, APP_SECRET_VAR, aioConfig, writeAioConfig } from "../src/daemon.ts";
import { jobs, plist } from "../src/launchd.ts";
import { type Io, main } from "../src/main.ts";
import { appCredentials, lookup, type SecretSource } from "../src/secrets.ts";
import { hashCode, readSetup } from "../src/store.ts";
import type { ExecResult } from "../src/system.ts";
import { tempDir, testConfig } from "./fakes.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const keychain =
  (items: Record<string, string>): SecretSource["keychain"] =>
  (service) =>
    items[service] !== undefined
      ? { ok: true, value: items[service] as string }
      : { ok: false, reason: "item not found" };

function io(dir: string, opts: Partial<Io> & { keychainItems?: Record<string, string> } = {}) {
  const { env: extraEnv, keychainItems, ...o } = opts;
  const out: string[] = [];
  const err: string[] = [];
  const execs: string[][] = [];
  const env = {
    AGENTS_IO_HERDR_CONFIG: join(dir, "cfg", "config.json"),
    AGENTS_IO_HERDR_DATA: join(dir, "d"),
    ...extraEnv,
  };
  const value: Io = {
    env,
    home: join(dir, "home"),
    platform: "linux",
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    exec: (cmd, args): ExecResult | null => {
      execs.push([cmd, ...args]);
      if (cmd === "id") return { code: 0, stdout: "501\n", stderr: "" };
      if (cmd === "scutil") return { code: 0, stdout: "my-mac\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    secrets: { env, keychain: keychain(keychainItems ?? {}) },
    fetch: globalThis.fetch,
    now: () => Date.parse("2026-10-21T12:00:00Z"),
    pkgDir: "/opt/agents-io-herdr",
    ...o,
  };
  return { io: value, out: () => out.join(""), err: () => err.join(""), execs };
}

describe("config", () => {
  it("has defaults for everything, and derives the paths", () => {
    const c = resolveConfig(
      {},
      { env: {}, home: "/home/dev", file: "/home/dev/.config/agents-io-herdr/config.json", platform: "darwin" },
    );
    expect(c.locale).toBe("zh");
    expect(c.account).toBe("herdr");
    expect(c.feishu.appSecret).toEqual(["env:AGENTS_IO_HERDR_APP_SECRET", "keychain:agents-io-herdr.app-secret"]);
    expect(c.rules).toMatchObject({
      blockedAfterMs: 60_000,
      doneMinTurnMs: 120_000,
      doneSettleMs: 30_000,
      presentIdleMs: 180_000,
      quietBlocked: false,
    });
    expect(c.paths).toMatchObject({
      dataDir: "/home/dev/.local/share/agents-io-herdr",
      socket: "/home/dev/.local/share/agents-io-herdr/aio/run/aio.sock",
      pauseFile: "/home/dev/.config/agents-io-herdr/paused",
      logDir: "/home/dev/Library/Logs/agents-io-herdr",
    });
    expect(c.herdrSocket).toBe("/home/dev/.config/herdr/herdr.sock");
  });

  it("takes rules in seconds, quiet hours, a lark domain, and refuses a secret written in the file", () => {
    const ctx = { env: {}, home: "/home/dev", file: "/home/dev/c/config.json", platform: "linux" as const };
    const c = resolveConfig(
      {
        feishu: { domain: "lark" },
        notify: { blockedAfterSec: 30, quiet: "off", quietBlocked: true },
        aioRepo: "~/src/agents-io",
      },
      ctx,
    );
    expect(c.locale).toBe("en");
    expect(c.rules).toMatchObject({ blockedAfterMs: 30_000, quiet: null, quietBlocked: true });
    expect(c.aioRepo).toBe("/home/dev/src/agents-io");
    expect(() => resolveConfig({ feishu: { appSecret: "s3cret-value" } }, ctx)).toThrow(/does not belong in a file/);
    expect(() => resolveConfig({ account: "a:b" }, ctx)).toThrow(ConfigError);
    expect(() => resolveConfig({ timeZone: "Mars/Base" }, ctx)).toThrow(/not a time zone/);
  });

  it("refuses a config file others can write", () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const file = join(tmp.dir, "config.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o666);
    expect(() => loadConfig({ AGENTS_IO_HERDR_CONFIG: file }, tmp.dir)).toThrow(/chmod 600/);
  });
});

describe("credentials", () => {
  it("tries env, then the keychain, and names what failed without values", () => {
    const c = testConfig("/tmp/x");
    const src: SecretSource = {
      env: { AGENTS_IO_HERDR_APP_ID: "app-from-env" },
      keychain: keychain({ "agents-io-herdr.app-secret": "s-from-keychain" }),
    };
    expect(appCredentials(c, src)).toEqual({ appId: "app-from-env", appSecret: "s-from-keychain" });
    const r = lookup(["env:NOPE", "keychain:nope"], { env: {}, keychain: keychain({}) });
    expect(r).toEqual({ ok: false, reason: "env:NOPE: not set; keychain:nope: item not found" });
    expect(() => appCredentials(c, { env: {}, keychain: keychain({}) })).toThrow(/app id not found/);
  });
});

describe("the project's daemon", () => {
  it("is one lark-bot channel with env references, no console, no agents, no local rules", () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const c = testConfig(tmp.dir, { account: "term" });
    const a = aioConfig(c) as Record<string, unknown>;
    expect(a).toMatchObject({
      dataDir: c.paths.aioDataDir,
      socketPath: c.paths.socket,
      console: { enabled: false },
      bindings: [],
      outputTools: false,
      channels: [
        {
          type: "lark-bot",
          account: "term",
          config: {
            appId: `env:${APP_ID_VAR}`,
            appSecret: `env:${APP_SECRET_VAR}`,
            domain: "feishu",
            historyOnMention: false,
            reactions: false,
          },
        },
      ],
    });
    expect(a.agents).toBeUndefined();
    const file = writeAioConfig(c);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toMatch(/secret-value|app-test/);
  });

  it("takes more channels as written, and their secrets only by name", () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const extra = { type: "module", module: "~/x", account: "me", config: { token: "env:SIDE_TOKEN" } };
    const c = testConfig(tmp.dir, { channels: [extra], secrets: { SIDE_TOKEN: "keychain:side-token" } });
    expect((aioConfig(c) as { channels: unknown[] }).channels.at(-1)).toEqual(extra);
    expect(c.secrets).toEqual({ SIDE_TOKEN: ["keychain:side-token"] });
    expect(() => testConfig(tmp.dir, { secrets: { SIDE_TOKEN: "the-token-itself" } })).toThrow(
      /a secret does not belong in a file/,
    );
    expect(() => testConfig(tmp.dir, { secrets: { lower: "env:X" } })).toThrow(/UPPER_CASE/);
  });

  it("reads spawn rules with defaults, and wants their channel, account and owner", () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const c = testConfig(tmp.dir, { spawn: [{ channel: "side", account: "me", owner: "u1", skills: ["~/s"] }] });
    expect(c.spawn[0]).toMatchObject({
      id: "ai",
      kind: "claude",
      args: [],
      workspace: "ai",
      env: {},
      preamble: "",
      dirPerAgent: true,
    });
    expect(c.spawn[0]?.skills[0]).not.toMatch(/^~/);
    expect(() => testConfig(tmp.dir, { spawn: [{ channel: "side", account: "me" }] })).toThrow(
      /spawn\[0\]\.owner is required/,
    );
  });
});

describe("launchd", () => {
  it("runs the daemon and the bridge with this Node, logs to files, holds no secret", () => {
    const c = testConfig("/tmp/x", {});
    const [daemon, bridge] = jobs(c, { node: "/usr/local/bin/node", bin: "/opt/agents-io-herdr/bin/agents-io-herdr" });
    expect(daemon?.args).toEqual(["/usr/local/bin/node", "/opt/agents-io-herdr/bin/agents-io-herdr", "daemon"]);
    expect(bridge?.args.at(-1)).toBe("run");
    const p = plist(bridge as NonNullable<typeof bridge>, {
      home: "/home/dev",
      env: { AGENTS_IO_HERDR_CONFIG: "/home/dev/c.json" },
    });
    expect(p).toContain("<key>Label</key><string>io.agents-io-herdr.bridge</string>");
    expect(p).toContain("<key>KeepAlive</key><true/>");
    expect(p).toContain("<key>AGENTS_IO_HERDR_CONFIG</key><string>/home/dev/c.json</string>");
    expect(p).toMatch(/<key>StandardErrorPath<\/key><string>[^<]*bridge\.log<\/string>/);
    expect(p).not.toMatch(/SECRET|APP_ID/);
  });
});

describe("command line", () => {
  it("prints help, writes a private starter config, refuses to overwrite it", async () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const h = io(tmp.dir);
    expect(await main([], h.io)).toBe(2);
    expect(h.out()).toContain("agents-io-herdr setup");
    expect(await main(["init", "--aio-repo", "~/src/agents-io", "--machine", "my-mac"], h.io)).toBe(0);
    const file = join(tmp.dir, "cfg", "config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ machine: "my-mac", aioRepo: "~/src/agents-io" });
    expect(await main(["init"], h.io)).toBe(1);
    expect(h.err()).toContain("--force");
    expect(await main(["frobnicate"], h.io)).toBe(2);
  });

  it("setup writes a one-time code the bridge can check, pause and resume flip the switch", async () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const h = io(tmp.dir);
    expect(await main(["setup"], h.io)).toBe(0);
    const code = /^\s+(\d{4}-\d{4})$/m.exec(h.out())?.[1] ?? "";
    const f = readSetup(join(tmp.dir, "d", "setup.json"));
    expect(f?.codeHash).toBe(hashCode(code));
    expect(f?.expiresAt).toBe(Date.parse("2026-10-21T12:15:00Z"));
    expect(await main(["pause"], h.io)).toBe(0);
    expect(existsSync(join(tmp.dir, "cfg", "paused"))).toBe(true);
    expect(await main(["resume"], h.io)).toBe(0);
    expect(existsSync(join(tmp.dir, "cfg", "paused"))).toBe(false);
  });

  it("install wants macOS, a built agents-io and credentials in the keychain (not only in the shell)", async () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const repo = join(tmp.dir, "agents-io");
    mkdirSync(join(repo, "packages", "daemon", "dist"), { recursive: true });
    writeFileSync(join(repo, "packages", "daemon", "dist", "cli.js"), "");
    const linux = io(tmp.dir);
    await main(["init", "--aio-repo", repo], linux.io);
    expect(await main(["install"], linux.io)).toBe(1);
    expect(linux.err()).toContain("macOS");
    const shellOnly = io(tmp.dir, {
      platform: "darwin",
      env: { AGENTS_IO_HERDR_APP_ID: "app-x", AGENTS_IO_HERDR_APP_SECRET: "s-x" },
    });
    expect(await main(["install"], shellOnly.io)).toBe(1);
    expect(shellOnly.err()).toContain("keychain");
    const ok = io(tmp.dir, {
      platform: "darwin",
      keychainItems: { "agents-io-herdr.app-id": "app-x", "agents-io-herdr.app-secret": "s-x" },
    });
    expect(await main(["install"], ok.io)).toBe(0);
    const plists = ok.execs.filter((e) => e[0] === "launchctl" && e[1] === "bootstrap").map((e) => e[3]);
    expect(plists).toEqual([
      join(tmp.dir, "home", "Library", "LaunchAgents", "io.agents-io-herdr.daemon.plist"),
      join(tmp.dir, "home", "Library", "LaunchAgents", "io.agents-io-herdr.bridge.plist"),
    ]);
    const daemonPlist = readFileSync(plists[0] as string, "utf8");
    expect(daemonPlist).toContain("/opt/agents-io-herdr/bin/agents-io-herdr");
    expect(daemonPlist).not.toContain("s-x");
    expect(ok.out()).toContain("Next: agents-io-herdr setup");
  });
});
