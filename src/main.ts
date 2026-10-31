/** `agents-io-herdr`: the command line. */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AioClient } from "./aio.ts";
import { Bridge, CHANNEL, CONSUMER, HOST_NAME } from "./bridge.ts";
import {
  aioCliPath,
  type Config,
  ConfigError,
  configPath,
  type Env,
  loadConfig,
  starterConfig,
  tildify,
} from "./config.ts";
import { DaemonError, runDaemon, writeAioConfig } from "./daemon.ts";
import { execCommand, shimCommand } from "./execcli.ts";
import { FeishuApi } from "./feishu.ts";
import { herdrClient } from "./herdr.ts";
import { strings } from "./i18n.ts";
import { DAEMON_LABEL, HOST_LABEL, install, jobState, stableNode, uninstall } from "./launchd.ts";
import type { DeliverResult, HostHelloResult, ReplyRoute } from "./protocol.ts";
import { hideSecrets } from "./redact.ts";
import {
  appCredentials,
  CredentialError,
  lookup,
  namedSecrets,
  realSecretSource,
  type SecretSource,
} from "./secrets.ts";
import { sessionsCommand } from "./sessionscli.ts";
import { clearSetup, newCode, readSetup, SETUP_TTL_MS, Store, writePrivate, writeSetup } from "./store.ts";
import { type Exec, idleMs, machineName, realExec } from "./system.ts";
import { transcriptSource } from "./transcript.ts";

export const HELP = `agents-io-herdr — Feishu/Lark notices and replies for coding agents in herdr

  agents-io-herdr init [--aio-repo <dir>] [--machine <name>]   write a starter config (0600)
  agents-io-herdr setup [--wait]    print a one-time code; DM it to the bot to become its owner
  agents-io-herdr install           run the daemon and the bridge as launchd agents (macOS)
  agents-io-herdr uninstall         stop and remove them
  agents-io-herdr status            what runs, who owns it, where notices go, recent logs
  agents-io-herdr pause | resume    stop / resume all notices and replies (a switch file)
  agents-io-herdr test              send a test message to the workbench (or the owner's DM)
  agents-io-herdr run               the bridge in the foreground (what launchd runs)
  agents-io-herdr daemon            the project's agents-io daemon in the foreground
  agents-io-herdr sessions …        this machine's Claude Code / Codex sessions for LB (sessions help)
  agents-io-herdr exec …            what LB may run on this machine: ceiling, switch, log, doctor (exec help)

config: $AGENTS_IO_HERDR_CONFIG or ~/.config/agents-io-herdr/config.json (see config.example.json)
`;

export interface Io {
  env: Env;
  home: string;
  platform: NodeJS.Platform;
  out: (s: string) => void;
  err: (s: string) => void;
  exec: Exec;
  secrets: SecretSource;
  fetch: typeof fetch;
  now: () => number;
  /** This package's directory (real path). */
  pkgDir: string;
  /** All of stdin (a pipe; "" from a terminal, which would echo what is typed). */
  stdin: () => Promise<string>;
}

export function realIo(): Io {
  // A reader that stops early (`| head`) is not an error worth a stack trace.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "EPIPE") throw e;
    });
  }
  return {
    env: process.env,
    home: process.env.HOME || homedir(),
    platform: process.platform,
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    exec: realExec,
    secrets: realSecretSource(process.env),
    fetch: globalThis.fetch,
    now: Date.now,
    pkgDir: dirname(dirname(realpathSync(fileURLToPath(import.meta.url)))),
    stdin: async () => {
      if (process.stdin.isTTY) return "";
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of process.stdin as AsyncIterable<Buffer>) {
        chunks.push(c);
        size += c.length;
        if (size > 64 * 1024) break;
      }
      return Buffer.concat(chunks).toString("utf8");
    },
  };
}

export class CliError extends Error {
  code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

const stamp = (io: Io) => new Date(io.now()).toISOString();
const logger = (io: Io) => (s: string) => io.err(`${stamp(io)} ${s}\n`);

export async function main(argv: string[], io: Io = realIo()): Promise<number> {
  try {
    return await command(argv, io);
  } catch (e) {
    if (e instanceof CliError || e instanceof ConfigError || e instanceof CredentialError || e instanceof DaemonError) {
      io.err(`agents-io-herdr: ${e.message}\n`);
      return e instanceof CliError ? e.code : e instanceof ConfigError ? 2 : 1;
    }
    throw e;
  }
}

async function command(argv: string[], io: Io): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    io.out(HELP);
    return sub ? 0 : 2;
  }
  if (sub === "sessions") return await sessionsCommand(rest, io);
  if (sub === "exec") return await execCommand(rest, io);
  // sshd's forced command for the dedicated exec user: frames on stdout, nothing else.
  if (sub === "exec-shim") return await shimCommand(io);
  const { values } = parseArgs({
    args: rest,
    options: {
      "aio-repo": { type: "string" },
      machine: { type: "string" },
      wait: { type: "boolean" },
      force: { type: "boolean" },
    },
    strict: true,
  });
  if (sub === "init") return init(io, values["aio-repo"], values.machine, values.force === true);
  const c = loadConfig(io.env, io.home, io.platform);
  switch (sub) {
    case "run":
      return await run(io, c);
    case "daemon":
      return await runDaemon(c, appCredentials(c, io.secrets), logger(io), namedSecrets(c, io.secrets));
    case "setup":
      return await setup(io, c, values.wait === true);
    case "pause":
      mkdirSync(c.paths.configDir, { recursive: true, mode: 0o700 });
      writePrivate(c.paths.pauseFile, `${stamp(io)}\n`);
      io.out("Paused: no notices, nothing typed into agents (agents-io-herdr resume).\n");
      return 0;
    case "resume":
      rmSync(c.paths.pauseFile, { force: true });
      io.out("Resumed.\n");
      return 0;
    case "test":
      return await test(io, c);
    case "status":
      return await status(io, c);
    case "install":
      return installCmd(io, c);
    case "uninstall":
      if (io.platform !== "darwin") throw new CliError("uninstall is for macOS launchd");
      uninstall({ home: io.home, exec: io.exec });
      io.out("Stopped and removed both launchd agents (config, state and keychain items are kept).\n");
      return 0;
    default:
      throw new CliError(`unknown command ${sub} (agents-io-herdr help)`, 2);
  }
}

function init(io: Io, aioRepo: string | undefined, machine: string | undefined, force: boolean): number {
  const file = configPath(io.env, io.home);
  if (existsSync(file) && !force) throw new CliError(`${tildify(file, io.home)} exists (--force to overwrite)`);
  const cfg = starterConfig({ ...(aioRepo ? { aioRepo } : {}), ...(machine ? { machine } : {}) });
  writePrivate(file, `${JSON.stringify(cfg, null, 2)}\n`);
  io.out(
    `Wrote ${tildify(file, io.home)} (0600). Next: put the app credentials in the keychain (README), then install.\n`,
  );
  return 0;
}

// ---- run: the bridge ----------------------------------------------------------------------------

async function run(io: Io, c: Config): Promise<number> {
  const log = logger(io);
  const store = new Store(c.paths.stateFile);
  const machine = machineName(c.machine, io.exec, io.platform);
  let feishu: FeishuApi | null = null;
  try {
    const creds = appCredentials(c, io.secrets);
    feishu = new FeishuApi({ ...creds, domain: c.feishu.domain, fetch: io.fetch });
  } catch (e) {
    log(`no app credentials, so no automatic workbench: ${(e as Error).message}`);
  }
  let bridge: Bridge | null = null;
  const aio = new AioClient({
    socket: c.paths.socket,
    name: HOST_NAME,
    consumer: CONSUMER,
    onInbound: (item) => (bridge ? bridge.onInbound(item) : Promise.resolve(false)),
    onReady: async () => {
      await bridge?.pushBindings(true);
    },
    onState: (s, detail) => log(`daemon: ${s}${detail ? ` (${detail})` : ""}`),
    log,
  });
  hideSecrets(c.redact);
  bridge = new Bridge({
    config: c,
    machine,
    herdr: herdrClient(c.herdrSocket),
    aio,
    feishu,
    store,
    transcripts: transcriptSource({ home: io.home, ...(io.env.CODEX_HOME ? { codexHome: io.env.CODEX_HOME } : {}) }),
    now: io.now,
    idleMs: () => idleMs(io.exec, io.platform),
    log,
  });
  const owner = store.state.owner ? "owner bound" : "no owner yet (agents-io-herdr setup)";
  log(`agents-io-herdr: ${machine}; ${owner}; daemon socket ${tildify(c.paths.socket, io.home)}`);
  aio.start();
  let stop = false;
  const quit = () => {
    stop = true;
    aio.stop();
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  while (!stop) {
    try {
      await bridge.tick();
    } catch (e) {
      log(`tick: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await bridge.settled();
  return 0;
}

// ---- setup: the owner-binding code ------------------------------------------------------------

async function setup(io: Io, c: Config, wait: boolean): Promise<number> {
  const before = Store.read(c.paths.stateFile);
  const code = newCode();
  writeSetup(c.paths.setupFile, code, io.now());
  const minutes = SETUP_TTL_MS / 60_000;
  io.out(
    [
      `Send this code to the bot in a direct message within ${minutes} minutes:`,
      "",
      `    ${code}`,
      "",
      "Whoever sends it becomes this machine's owner: the only person notices go to and the only one who",
      "can answer agents. The bridge then creates the workbench group (you and the bot) and says hello.",
      before.owner ? "(An owner is bound already; a new code replaces them when someone else sends it.)" : "",
      "",
    ]
      .filter((l, i, a) => l || a[i - 1])
      .join("\n"),
  );
  if (!wait) {
    io.out("The bridge must be running (agents-io-herdr install, or run). Add --wait to wait here.\n");
    return 0;
  }
  const until = io.now() + SETUP_TTL_MS;
  while (io.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = Store.read(c.paths.stateFile);
    if (s.owner && s.owner.boundAt !== before.owner?.boundAt) {
      io.out(
        `Owner bound. ${s.workbench ? "Workbench group ready." : s.workbenchError ? `No workbench yet: ${s.workbenchError}` : ""}\n`,
      );
      return 0;
    }
    if (!readSetup(c.paths.setupFile)) {
      io.out("The code is no longer valid (expired or too many wrong tries). Run setup again.\n");
      return 1;
    }
  }
  clearSetup(c.paths.setupFile);
  io.out("Timed out; the code is no longer valid.\n");
  return 1;
}

// ---- test, status -------------------------------------------------------------------------------

async function oneShot(c: Config): Promise<AioClient> {
  const client = new AioClient({ socket: c.paths.socket, name: `${HOST_NAME}-cli`, reconnect: false });
  client.start();
  if (!(await client.waitOnline(5000))) {
    client.stop();
    throw new CliError(`the daemon is not answering on ${c.paths.socket}`);
  }
  return client;
}

async function test(io: Io, c: Config): Promise<number> {
  const st = Store.read(c.paths.stateFile);
  const chat = st.workbench?.chatId ?? st.owner?.dmChat;
  if (!chat) throw new CliError("no owner yet: agents-io-herdr setup");
  const machine = machineName(c.machine, io.exec, io.platform);
  const client = await oneShot(c);
  try {
    const route: ReplyRoute = { channel: CHANNEL, account: c.account, conversationId: chat };
    const r = await client.request<DeliverResult>(
      "deliver",
      { operationId: `herdr:test:${io.now()}`, route, message: { text: strings(c.locale).testMessage(machine) } },
      60_000,
    );
    if (r.status !== "delivered") throw new CliError(`not delivered: ${r.status}${r.error ? ` (${r.error})` : ""}`);
    io.out(`Sent to the ${st.workbench ? "workbench" : "owner's DM"}.\n`);
    return 0;
  } finally {
    client.stop();
  }
}

function tail(path: string, n: number): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trimEnd().split("\n").slice(-n);
}

async function status(io: Io, c: Config): Promise<number> {
  const out = (s: string) => io.out(`${s}\n`);
  const st = Store.read(c.paths.stateFile);
  out(`machine:    ${machineName(c.machine, io.exec, io.platform)}`);
  out(
    `config:     ${tildify(c.paths.configFile, io.home)}${existsSync(c.paths.configFile) ? "" : " (missing: defaults)"}`,
  );
  out(`data:       ${tildify(c.paths.dataDir, io.home)}`);
  if (io.platform === "darwin") {
    out(`daemon job: ${jobState(DAEMON_LABEL, io.exec)}`);
    out(`bridge job: ${jobState(HOST_LABEL, io.exec)}`);
  }
  out(`sending:    ${existsSync(c.paths.pauseFile) ? "paused (agents-io-herdr resume)" : "on"}`);
  out(
    `owner:      ${st.owner ? "bound" : "none (agents-io-herdr setup)"}${readSetup(c.paths.setupFile) ? "; a setup code is waiting" : ""}`,
  );
  out(
    `notices to: ${st.workbench ? `workbench (${st.workbench.via})` : st.owner?.dmChat ? "the owner's DM" : "nowhere yet"}${st.workbenchError ? `; workbench error: ${st.workbenchError}` : ""}`,
  );
  out(`threads:    ${st.threads.filter((t) => t.closedAt === null).length} open`);
  const cli = aioCliPath(c);
  out(
    `aio CLI:    ${cli ? `${tildify(cli, io.home)}${existsSync(cli) ? "" : " (missing: pnpm build in the agents-io checkout)"}` : "not configured (aioRepo)"}`,
  );
  for (const [name, refs] of [
    ["app id", c.feishu.appId],
    ["app secret", c.feishu.appSecret],
  ] as const) {
    const r = lookup(refs, io.secrets);
    out(`${name}:${" ".repeat(10 - name.length)} ${r.ok ? `found (${r.from})` : `not found: ${r.reason}`}`);
  }
  try {
    const client = await oneShot(c);
    const h = client.hello as HostHelloResult;
    out(`daemon:     answering; host table ${h.bindings.version ?? "none"}${h.bindings.active ? "" : " (inactive)"}`);
    client.stop();
  } catch (e) {
    out(`daemon:     ${(e as Error).message}`);
  }
  for (const name of ["daemon.log", "bridge.log"]) {
    const lines = tail(join(c.paths.logDir, name), 8);
    if (lines.length)
      out(`\n${tildify(join(c.paths.logDir, name), io.home)}:\n${lines.map((l) => `  ${l}`).join("\n")}`);
  }
  return 0;
}

// ---- install ----------------------------------------------------------------------------------

function installCmd(io: Io, c: Config): number {
  if (io.platform !== "darwin")
    throw new CliError(
      "install writes launchd agents (macOS); elsewhere run `daemon` and `run` under your own supervisor",
    );
  if (!existsSync(c.paths.configFile)) throw new CliError("no config yet: agents-io-herdr init");
  const cli = aioCliPath(c);
  if (!cli || !existsSync(cli))
    throw new CliError(`the agents-io daemon CLI is missing (${cli ?? 'set "aioRepo"'}): build agents-io first`);
  // launchd jobs see neither the shell's environment nor 1Password: the credentials must be in the keychain.
  const launchd: SecretSource = { env: {}, keychain: io.secrets.keychain };
  for (const [name, refs] of [
    ["app id", c.feishu.appId],
    ["app secret", c.feishu.appSecret],
  ] as const) {
    const r = lookup(refs, launchd);
    if (!r.ok)
      throw new CliError(
        `the Feishu ${name} is not readable without your shell (${r.reason}); put it in the keychain (README)`,
      );
  }
  writeAioConfig(c);
  const env: Record<string, string> = {};
  for (const k of ["AGENTS_IO_HERDR_CONFIG", "AGENTS_IO_HERDR_DATA", "HERDR_SOCKET_PATH"]) {
    const v = io.env[k];
    if (v) env[k] = v;
  }
  const paths = install(c, {
    home: io.home,
    node: stableNode(process.execPath),
    bin: join(io.pkgDir, "bin", "agents-io-herdr"),
    env,
    exec: io.exec,
  });
  for (const p of paths) io.out(`loaded ${tildify(p, io.home)}\n`);
  io.out(`logs in ${tildify(c.paths.logDir, io.home)}\n`);
  if (!Store.read(c.paths.stateFile).owner) io.out("Next: agents-io-herdr setup\n");
  return 0;
}
