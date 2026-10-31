/** Config, credentials, the generated daemon config, launchd plists and the command line. */

import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadNodeKey, pairingCode } from "../src/collector.ts";
import { ConfigError, loadConfig, resolveConfig } from "../src/config.ts";
import { APP_ID_VAR, APP_SECRET_VAR, aioConfig, writeAioConfig } from "../src/daemon.ts";
import { EffectLedger } from "../src/exec/effects.ts";
import { writeNodeRecord } from "../src/exec/generation.ts";
import { execPaths } from "../src/exec/paths.ts";
import { codeSha } from "../src/execcli.ts";
import { jobs, plist, stableNode } from "../src/launchd.ts";
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
  const inputs: string[] = [];
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
    exec: (cmd, args, _t, input): ExecResult | null => {
      execs.push([cmd, ...args]);
      if (input !== undefined) inputs.push(input);
      if (cmd === "id") return { code: 0, stdout: "501\n", stderr: "" };
      if (cmd === "scutil") return { code: 0, stdout: "my-mac\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    secrets: { env, keychain: keychain(keychainItems ?? {}) },
    fetch: globalThis.fetch,
    now: () => Date.parse("2026-10-21T12:00:00Z"),
    pkgDir: "/opt/agents-io-herdr",
    stdin: async () => "",
    ...o,
  };
  return { io: value, out: () => out.join(""), err: () => err.join(""), execs, inputs };
}

describe("config", () => {
  it("has defaults for everything, and derives the paths", () => {
    const c = resolveConfig(
      {},
      { env: {}, home: "/home/dev", file: "/home/dev/.config/agents-io-herdr/config.json", platform: "darwin" },
    );
    expect(c.locale).toBe("zh");
    expect(c.redact).toBe(true);
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

  it("passes externalMcp to the daemon as written; spawn mcp tokens are references only", () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const ext = { listen: "127.0.0.1:7465", clients: { ai: { tokenFile: "~/x/ai.token", scopes: ["send:side:*"] } } };
    const c = testConfig(tmp.dir, { externalMcp: ext });
    expect((aioConfig(c) as { externalMcp: unknown }).externalMcp).toEqual(ext);
    expect(() =>
      testConfig(tmp.dir, {
        spawn: [{ channel: "s", account: "a", owner: "o", mcp: { x: { url: "http://h", token: "literal" } } }],
      }),
    ).toThrow(/env:NAME/);
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
    const h = testConfig(tmp.dir, {
      spawn: [
        {
          channel: "side",
          account: "me",
          owner: "u1",
          before: ["a b", ["c", "d"], { run: "e", timeoutSec: 5, required: true }],
        },
      ],
    });
    expect(h.spawn[0]?.before).toEqual([
      { run: ["/bin/sh", "-c", "a b"], timeoutMs: 60_000, required: false },
      { run: ["c", "d"], timeoutMs: 60_000, required: false },
      { run: ["/bin/sh", "-c", "e"], timeoutMs: 5000, required: true },
    ]);
    expect(() =>
      testConfig(tmp.dir, { spawn: [{ channel: "s", account: "a", owner: "o", before: [{ run: [] }] }] }),
    ).toThrow(/before\[0\]\.run/);
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

describe("launchd node", () => {
  it("runs Homebrew's node through the formula's opt link, which survives brew upgrade", () => {
    const has = (p: string) => p === "/opt/homebrew/opt/node@24/bin/node";
    expect(stableNode("/opt/homebrew/Cellar/node@24/24.22.0/bin/node", has)).toBe("/opt/homebrew/opt/node@24/bin/node");
    // No opt link: the path as it is; other installs untouched.
    expect(stableNode("/opt/homebrew/Cellar/node/25.1.0/bin/node", has)).toBe(
      "/opt/homebrew/Cellar/node/25.1.0/bin/node",
    );
    expect(stableNode("/Users/me/.nvm/versions/node/v24.16.0/bin/node", has)).toBe(
      "/Users/me/.nvm/versions/node/v24.16.0/bin/node",
    );
  });
});

describe("sessions pair", () => {
  const lb = (answer: (key: string) => Record<string, unknown>) => {
    const sent: Record<string, unknown>[] = [];
    const auth: string[] = [];
    const f = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      auth.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify(answer(String(body.publicKey))), { status: 201 });
    }) as typeof fetch;
    return { f, sent, auth };
  };
  const NODE = "9b3c0f8e-0000-4000-8000-000000000001";
  const ok = (key: string) => ({ id: NODE, code: pairingCode(key), askedIn: "dm" });
  /** The raw public key (base64) of a PEM private key. */
  const publicOf = (pem: string) => {
    const spki = createPublicKey(createPrivateKey(pem)).export({ format: "der", type: "spki" });
    return spki.subarray(spki.length - 32).toString("base64");
  };

  it("keeps the key in a 0600 file by default (no keychain, no key in any argument), shows LB's code", async () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const { f, sent, auth } = lb(ok);
    const dir = join(tmp.dir, "s");
    const h = io(tmp.dir, { fetch: f, env: { LB_TOKEN: "t", AGENTS_IO_HERDR_SESSIONS_DIR: dir } });
    expect(await main(["sessions", "pair", "--lb-url", "https://lb.example", "--machine", "host-b"], h.io)).toBe(0);
    expect(auth).toEqual(["Bearer t"]);
    const code = pairingCode(String(sent[0]?.publicKey));
    expect(code).toMatch(/^\d{6}$/);
    expect(h.out()).toContain(`Pairing code ${code}`);
    expect(h.out()).toContain("the card in the chat with the agent");
    expect(h.out()).not.toContain("—");
    const keyFile = join(dir, "node-key.pem");
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const pem = readFileSync(keyFile, "utf8");
    expect(publicOf(pem)).toBe(sent[0]?.publicKey);
    expect(h.execs.some((e) => e[0] === "security")).toBe(false);
    const der = createPrivateKey(pem).export({ format: "der", type: "pkcs8" }).toString("base64");
    expect(h.execs.flat().some((a) => a.includes(der) || a.includes("PRIVATE KEY"))).toBe(false);
    expect(h.out() + h.err()).not.toContain(der);
    const cfg = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
    expect(cfg).toMatchObject({ machine: "host-b", report: { nodeId: NODE, keyFile } });
    expect(cfg.report.keychainService).toBeUndefined();
    // The collector reads it back.
    expect("key" in loadNodeKey(cfg.report, h.io.exec)).toBe(true);
  });

  it("takes the token from the first line of stdin with --token-stdin, and a key file where asked", async () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const { f, auth } = lb(ok);
    const keyFile = join(tmp.dir, "elsewhere", "k.pem");
    const h = io(tmp.dir, {
      fetch: f,
      env: { AGENTS_IO_HERDR_SESSIONS_DIR: join(tmp.dir, "s") },
      stdin: async () => "lbp_from_stdin\nignored\n",
    });
    const args = ["sessions", "pair", "--token-stdin", "--lb-url", "https://lb.example", "--key-file", keyFile];
    expect(await main(args, h.io)).toBe(0);
    expect(auth).toEqual(["Bearer lbp_from_stdin"]);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(h.out()).toContain(`key file ${keyFile}`);
    // No token at all: usage, nothing sent.
    const none = io(tmp.dir, { fetch: f, env: { AGENTS_IO_HERDR_SESSIONS_DIR: join(tmp.dir, "s2") } });
    expect(await main(["sessions", "pair", "--token-stdin", "--lb-url", "https://lb.example"], none.io)).toBe(2);
    expect(auth).toHaveLength(1);
  });

  it("keeps the key in the keychain on request, through security -i on stdin, never in its arguments", async () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const { f } = lb(ok);
    const dir = join(tmp.dir, "s");
    const h = io(tmp.dir, { fetch: f, env: { LB_TOKEN: "t", AGENTS_IO_HERDR_SESSIONS_DIR: dir } });
    const args = ["sessions", "pair", "--lb-url", "https://lb.example", "--key-store", "keychain"];
    expect(await main(args, h.io)).toBe(0);
    expect(h.execs.filter((e) => e[0] === "security")).toEqual([["security", "-i"]]);
    expect(h.inputs).toHaveLength(1);
    expect(h.inputs[0]).toMatch(/^add-generic-password -U -s io\.agents-io-herdr\.node -a node -w \S+\n$/);
    expect(existsSync(join(dir, "node-key.pem"))).toBe(false);
    const cfg = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
    expect(cfg.report).toMatchObject({ keychainService: "io.agents-io-herdr.node", keychainAccount: "node" });
    expect(cfg.report.keyFile).toBeUndefined();
    // A locked keychain: the pairing fails, points at the key file, and nothing is kept.
    const locked = io(tmp.dir, {
      fetch: f,
      env: { LB_TOKEN: "t", AGENTS_IO_HERDR_SESSIONS_DIR: join(tmp.dir, "s3") },
      exec: (cmd) =>
        cmd === "security" ? { code: 36, stdout: "", stderr: "locked" } : { code: 0, stdout: "", stderr: "" },
    });
    expect(await main(args, locked.io)).toBe(1);
    expect(locked.err()).toContain("key file");
    expect(existsSync(join(tmp.dir, "s3", "sessions.json"))).toBe(false);
  });

  it("writes node.json with the owner LB names, no generation yet, and clears a retired mark (exec N4)", async () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const owner = "9b3c0f8e-0000-4000-8000-0000000000b1";
    const { f } = lb((key) => ({ ...ok(key), owner: { id: owner, kind: "human" } }));
    const dir = join(tmp.dir, "s");
    mkdirSync(join(dir, "exec"), { recursive: true });
    writeFileSync(join(dir, "exec", "retired"), "{}\n");
    const h = io(tmp.dir, { fetch: f, env: { LB_TOKEN: "t", AGENTS_IO_HERDR_SESSIONS_DIR: dir } });
    expect(await main(["sessions", "pair", "--lb-url", "https://lb.example"], h.io)).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "node.json"), "utf8"))).toEqual({ node: NODE, owner, generation: 0 });
    expect(statSync(join(dir, "node.json")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, "exec", "retired"))).toBe(false);
    // An LB that does not say the owner: the first welcome is trusted.
    const older = lb(ok);
    const h2 = io(tmp.dir, {
      fetch: older.f,
      env: { LB_TOKEN: "t", AGENTS_IO_HERDR_SESSIONS_DIR: join(tmp.dir, "s2") },
    });
    expect(await main(["sessions", "pair", "--lb-url", "https://lb.example"], h2.io)).toBe(0);
    expect(JSON.parse(readFileSync(join(tmp.dir, "s2", "node.json"), "utf8"))).toMatchObject({ owner: null });
  });

  it("keeps nothing when LB's code is not this key's", async () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const { f } = lb(() => ({ id: "9b3c0f8e-0000-4000-8000-000000000001", code: "000000", askedIn: null }));
    const h = io(tmp.dir, { fetch: f, env: { LB_TOKEN: "t", AGENTS_IO_HERDR_SESSIONS_DIR: join(tmp.dir, "s") } });
    expect(await main(["sessions", "pair", "--lb-url", "https://lb.example"], h.io)).toBe(1);
    expect(h.err()).toContain("do not confirm");
    expect(h.execs.some((e) => e[0] === "security")).toBe(false);
    expect(existsSync(join(tmp.dir, "s", "sessions.json"))).toBe(false);
    expect(existsSync(join(tmp.dir, "s", "node-key.pem"))).toBe(false);
  });
});

describe("sessions install --via-ssh", () => {
  it("runs ssh to 127.0.0.1 with the local key and names the authorized_keys options; wants the key first", async () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const dir = join(tmp.dir, "s");
    const h = io(tmp.dir, { platform: "darwin", env: { USER: "someone", AGENTS_IO_HERDR_SESSIONS_DIR: dir } });
    expect(await main(["sessions", "install", "--via-ssh"], h.io)).toBe(1);
    expect(h.err()).toContain("local_ed25519");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "local_ed25519"), "x", { mode: 0o600 });
    writeFileSync(join(dir, "known_hosts_local"), "x");
    expect(await main(["sessions", "install", "--via-ssh"], h.io)).toBe(0);
    const file = join(tmp.dir, "home", "Library", "LaunchAgents", "io.agents-io-herdr.sessions.plist");
    const xml = readFileSync(file, "utf8");
    expect(xml).toContain("<string>/usr/bin/ssh</string>");
    expect(xml).toContain(`<string>${join(dir, "local_ed25519")}</string>`);
    expect(xml).toContain("<string>someone@127.0.0.1</string>");
    expect(xml).not.toContain("<string>collect</string>");
    expect(h.out()).toMatch(
      /from="127\.0\.0\.1,::1",command="exec env PATH=\S+ AGENTS_IO_HERDR_SESSIONS_DIR=\S+ \S+node \/opt\/agents-io-herdr\/bin\/agents-io-herdr sessions collect",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc/,
    );
    // The collector sshd starts is told the directory it was installed with, as the plain job is.
    expect(h.out()).toContain(` AGENTS_IO_HERDR_SESSIONS_DIR=${dir} `);
    expect(xml).toContain(`<key>AGENTS_IO_HERDR_SESSIONS_DIR</key><string>${dir}</string>`);
  });

  it("--label-suffix: a second collector with its own label and directory, which the job is given (exec N12)", async () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const agents = join(tmp.dir, "home", "Library", "LaunchAgents");
    const main1 = join(agents, "io.agents-io-herdr.sessions.plist");
    const staging = join(agents, "io.agents-io-herdr.sessions.staging.plist");
    // Without a directory of its own it would share the first collector's node, key and ledger.
    const bare = io(tmp.dir, { platform: "darwin", env: { USER: "someone" } });
    expect(await main(["sessions", "install", "--label-suffix", "staging"], bare.io)).toBe(2);
    expect(bare.err()).toContain("AGENTS_IO_HERDR_SESSIONS_DIR");
    const same = io(tmp.dir, {
      platform: "darwin",
      env: { USER: "someone", AGENTS_IO_HERDR_SESSIONS_DIR: join(tmp.dir, "home", ".config", "agents-io-herdr/") },
    });
    expect(await main(["sessions", "install", "--label-suffix", "staging"], same.io)).toBe(2);
    expect(await main(["sessions", "install", "--label-suffix", "Staging!"], same.io)).toBe(2);
    const spaced = io(tmp.dir, {
      platform: "darwin",
      env: { USER: "someone", AGENTS_IO_HERDR_SESSIONS_DIR: "/tmp/a b" },
    });
    expect(await main(["sessions", "install", "--label-suffix", "staging"], spaced.io)).toBe(2);
    expect(existsSync(staging)).toBe(false);

    const dir = join(tmp.dir, "staging");
    const h = io(tmp.dir, { platform: "darwin", env: { USER: "someone", AGENTS_IO_HERDR_SESSIONS_DIR: dir } });
    expect(await main(["sessions", "install", "--label-suffix", "staging"], h.io)).toBe(0);
    const xml = readFileSync(staging, "utf8");
    expect(xml).toContain("<key>Label</key><string>io.agents-io-herdr.sessions.staging</string>");
    expect(xml).toContain(`<key>AGENTS_IO_HERDR_SESSIONS_DIR</key><string>${dir}</string>`);
    expect(xml).toContain(`<string>${join(dir, "logs", "sessions.log")}</string>`);
    expect(existsSync(main1)).toBe(false);
    expect(h.execs).toContainEqual(["launchctl", "bootstrap", "gui/501", staging]);

    const s = io(tmp.dir, { env: { AGENTS_IO_HERDR_SESSIONS_DIR: dir } });
    expect(await main(["sessions", "status", "--label-suffix", "staging"], s.io)).toBe(0);
    expect(s.execs).toContainEqual(["launchctl", "print", "gui/501/io.agents-io-herdr.sessions.staging"]);
    const u = io(tmp.dir, { env: { AGENTS_IO_HERDR_SESSIONS_DIR: dir } });
    expect(await main(["sessions", "uninstall", "--label-suffix", "staging"], u.io)).toBe(0);
    expect(u.execs).toContainEqual(["launchctl", "bootout", "gui/501/io.agents-io-herdr.sessions.staging"]);
    expect(existsSync(staging)).toBe(false);
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

describe("exec commands", () => {
  const T = Date.parse("2026-10-21T12:00:00Z");
  const setup = () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const p = execPaths(join(tmp.dir, "home", ".config", "agents-io-herdr"));
    mkdirSync(join(tmp.dir, "home", ".config", "agents-io-herdr"), { recursive: true, mode: 0o700 });
    return { tmp, p };
  };

  it("ceiling --preset writes a private file once; status says what this machine allows and why not", async () => {
    const { tmp, p } = setup();
    const h = io(tmp.dir);
    expect(await main(["exec"], h.io)).toBe(2);
    expect(h.out()).toContain("exec ceiling --preset");
    expect(await main(["exec", "ceiling", "--preset", "agent-user"], h.io)).toBe(2);
    expect(await main(["exec", "ceiling", "--preset", "personal-readonly"], h.io)).toBe(0);
    expect(statSync(p.ceiling).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(p.ceiling, "utf8"))).toMatchObject({ version: 2, exec: "off", agents: "grant" });
    expect(h.out()).toContain("list each project in read.roots");
    expect(await main(["exec", "ceiling", "--preset", "personal-readonly"], h.io)).toBe(1);
    expect(h.err()).toContain("--force");
    writeNodeRecord(p.node, { node: "node-1", owner: "owner-1", generation: 4 });
    const s = io(tmp.dir);
    expect(await main(["exec", "status"], s.io)).toBe(0);
    expect(s.out()).toContain("exec: off (ceiling_off)");
    expect(s.out()).toContain("preset personal-readonly");
    expect(s.out()).toContain("caps: sessions\n");
    expect(s.out()).toContain("node: node-1 (owner owner-1, generation 4)");
    expect(s.out()).toContain("effects: 0 running, 0 not yet with LB, 0 kept");
    const a = io(tmp.dir);
    expect(await main(["exec", "ceiling", "--preset", "agent-user", "--user", "agent", "--force"], a.io)).toBe(0);
    expect(JSON.parse(readFileSync(p.ceiling, "utf8"))).toMatchObject({
      runner: "user",
      user: { name: "agent", home: "/Users/agent" },
    });
    expect(a.out()).toContain("Commands run as agent");
  });

  it.each(["box", "box-install"])("writes a private %s ceiling and reports the exec-only caps", async (name) => {
    const { tmp, p } = setup();
    const h = io(tmp.dir, { env: { AGENTS_IO_HERDR_EXEC_ONLY: "1" } });
    expect(await main(["exec", "ceiling", "--preset", name], h.io)).toBe(0);
    expect(h.out()).toContain(`Commands run in bubblewrap (${name})`);
    expect(JSON.parse(readFileSync(p.ceiling, "utf8"))).toMatchObject({
      preset: name,
      runner: "bwrap",
      exec: "on",
      seccompBpf: "/usr/lib/box/seccomp.bpf",
    });
    expect(statSync(p.ceiling).mode & 0o777).toBe(0o600);
    const st = io(tmp.dir, { env: { AGENTS_IO_HERDR_EXEC_ONLY: "1" } });
    expect(await main(["exec", "status"], st.io)).toBe(0);
    expect(st.out()).toContain("runner bwrap");
    expect(st.out()).toContain("caps: exec.v1, transfer.v1\n");
  });

  it("off refuses every call at once, on takes them again (and says why exec may still be off)", async () => {
    const { tmp, p } = setup();
    const h = io(tmp.dir);
    expect(await main(["exec", "off"], h.io)).toBe(0);
    expect(existsSync(p.off)).toBe(true);
    const s = io(tmp.dir);
    await main(["exec", "status"], s.io);
    expect(s.out()).toContain("exec: off (switched_off)");
    expect(s.out()).toContain("switch: off");
    const on = io(tmp.dir);
    expect(await main(["exec", "on"], on.io)).toBe(0);
    expect(existsSync(p.off)).toBe(false);
    expect(on.out()).toContain("exec stays off: no_ceiling");
  });

  it("log lists what ran (metadata), one effect with its redacted output, or JSON", async () => {
    const { tmp, p } = setup();
    let now = T;
    const l = new EffectLedger(p.effects, () => now);
    const claim = { op: "exec.v1", argsHash: "a".repeat(64), generation: 3, deadline: T + 60_000, grant: null };
    l.claim({ ...claim, effect_id: "eff_one" });
    now += 3200;
    l.finish("eff_one", {
      state: "done",
      exit: 0,
      signal: null,
      stdout: "token=[REDACTED]\n",
      stderr: "",
      redacted: { stdout: 1, stderr: 0 },
      truncated: false,
      bytes: { stdout: 20, stderr: 0 },
      reason: null,
    });
    l.claim({ ...claim, effect_id: "eff_two", grant: "gr_1" });
    const h = io(tmp.dir);
    expect(await main(["exec", "log"], h.io)).toBe(0);
    expect(h.out()).toBe(
      "2026-10-21 12:00:00  eff_one  exec.v1  done exit 0 3.2 s  out 20 B, err 0 B, 1 hidden, not yet with LB\n" +
        "2026-10-21 12:00:03  eff_two  exec.v1  running  out 0 B, err 0 B  grant gr_1\n",
    );
    const one = io(tmp.dir);
    expect(await main(["exec", "log", "eff_one"], one.io)).toBe(0);
    expect(one.out()).toContain("--- stdout (redacted) ---\ntoken=[REDACTED]\n--- stderr (redacted) ---\n");
    const j = io(tmp.dir);
    expect(await main(["exec", "log", "--json", "--limit", "1"], j.io)).toBe(0);
    expect(JSON.parse(j.out())).toMatchObject([{ effect_id: "eff_two", state: "running" }]);
    expect(await main(["exec", "log", "eff_nope"], io(tmp.dir).io)).toBe(1);
  });

  it("doctor: the ceiling, the sandbox, names in the roots until acknowledged; exit 1 on a failure", async () => {
    const { tmp, p } = setup();
    const none = io(tmp.dir);
    expect(await main(["exec", "doctor"], none.io)).toBe(1);
    expect(none.out()).toContain("FAIL  ceiling: no ");
    expect(none.out()).toContain("FAIL  sandbox: only macOS");
    const app = join(tmp.dir, "home", "repos", "app");
    mkdirSync(join(app, "deploy"), { recursive: true });
    writeFileSync(join(app, "deploy", "prod.kubeconfig"), "x");
    const ceiling = { version: 2, read: { roots: ["~/repos/app"] }, envPass: ["PATH", "GH_TOKEN"] };
    writeFileSync(p.ceiling, JSON.stringify(ceiling), { mode: 0o600 });
    const mac = io(tmp.dir, { platform: "darwin" });
    expect(await main(["exec", "doctor"], mac.io)).toBe(1);
    expect(mac.out()).toContain("ok    ceiling: preset none");
    expect(mac.out()).toContain("warn  ceiling: envPass: never passed, secret-looking: GH_TOKEN");
    expect(mac.out()).toContain("ok    sandbox: /usr/bin/sandbox-exec runs this ceiling's deny-default profile");
    expect(mac.out()).toContain(`FAIL  roots: ${app}/deploy/prod.kubeconfig (*kubeconfig*)`);
    // The preflight is the real v3 profile of this ceiling (written to a file, gone afterwards).
    const pre = mac.execs.find((e) => e[0] === "/usr/bin/sandbox-exec");
    expect(pre?.slice(1, 2)).toEqual(["-f"]);
    expect(pre?.slice(3)).toEqual(["/usr/bin/true"]);
    expect(existsSync(pre?.[2] ?? "")).toBe(false);
    writeFileSync(p.ceiling, JSON.stringify({ ...ceiling, acknowledged: ["~/repos/app/deploy/prod.kubeconfig"] }), {
      mode: 0o600,
    });
    const ok = io(tmp.dir, { platform: "darwin" });
    expect(await main(["exec", "doctor"], ok.io)).toBe(0);
    expect(ok.out()).toContain("ok    roots: 1 acknowledged name(s) found; they stay unreadable");
  });

  it("doctor's shim check: two copies run the same code when package.json, bin/ and src/ are the same", () => {
    const tmp = tempDir();
    cleanups.push(tmp.done);
    const copy = (name: string, shim: string) => {
      const d = join(tmp.dir, name);
      mkdirSync(join(d, "bin"), { recursive: true });
      mkdirSync(join(d, "src", "exec"), { recursive: true });
      writeFileSync(join(d, "package.json"), '{"type":"module"}\n');
      writeFileSync(join(d, "bin", "agents-io-herdr"), "#!/usr/bin/env node\n");
      writeFileSync(join(d, "src", "main.ts"), "export {};\n");
      writeFileSync(join(d, "src", "exec", "shim.ts"), shim);
      return d;
    };
    const a = copy("a", "export const v = 1;\n");
    const b = copy("b", "export const v = 1;\n");
    mkdirSync(join(b, "test"));
    writeFileSync(join(b, "test", "x.test.ts"), "not run by the shim\n");
    expect(codeSha(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(codeSha(b)).toBe(codeSha(a));
    expect(codeSha(copy("c", "export const v = 2;\n"))).not.toBe(codeSha(a));
    // The same bytes under another name are other code.
    const d = copy("d", "export const v = 1;\n");
    renameSync(join(d, "src", "main.ts"), join(d, "src", "main2.ts"));
    expect(codeSha(d)).not.toBe(codeSha(a));
    expect(codeSha(join(tmp.dir, "none"))).toBeNull();
  });

  it("doctor on a dedicated user's ceiling counts token-like arguments of this user's processes, never shows them", async () => {
    const { tmp, p } = setup();
    writeFileSync(
      p.ceiling,
      JSON.stringify({ version: 2, runner: "user", user: { name: "nobody-here", home: join(tmp.dir, "users", "x") } }),
      { mode: 0o600 },
    );
    const h = io(tmp.dir, {
      platform: "darwin",
      env: { USER: "me" },
      exec: (cmd) =>
        cmd === "ps"
          ? { code: 0, stdout: "me node app --token s3cr3tvalue\nme zsh\nroot x --token zz\n", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
    });
    expect(await main(["exec", "doctor"], h.io)).toBe(1);
    expect(h.out()).toContain(`FAIL  user: no ${join(tmp.dir, "users", "x")}`);
    expect(h.out()).toContain("FAIL  user: 1 of me's processes have what looks like a token in their arguments");
    expect(h.out()).toContain("skip  roots: nobody-here's directories are not readable from here");
    // Its own code link: another dedicated user's (staging's) is not this one's.
    expect(h.out()).toContain(
      "FAIL  user: the code nobody-here runs, /Users/Shared/agents-io-herdr/current-nobody-here, is missing",
    );
    expect(h.out()).not.toContain("s3cr3tvalue");
  });
});
