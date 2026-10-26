/**
 * The local configuration (`~/.config/agents-io-herdr/config.json`, or `$AGENTS_IO_HERDR_CONFIG`)
 * and the paths derived from it. Nothing here is a secret: the Feishu app credentials are named by
 * reference (`env:NAME`, `keychain:SERVICE`) and read at runtime (secrets.ts).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DEFAULT_RULES, type WatchRules } from "./watch.ts";

export type Locale = "zh" | "en";
export type Domain = "feishu" | "lark";

/** Where a credential comes from, tried in order: `env:NAME`, `keychain:SERVICE`, or (app id only) the value. */
export type SecretRef = string;

export interface Config {
  /** The machine's name in messages; null: the host name. */
  machine: string | null;
  locale: Locale;
  timeZone: string;
  feishu: { domain: Domain; appId: SecretRef[]; appSecret: SecretRef[] };
  /** An agents-io checkout, built (`pnpm build`): its daemon CLI runs the bot. */
  aioRepo: string | null;
  /** The daemon CLI itself (default `<aioRepo>/packages/daemon/dist/cli.js`). */
  aioCli: string | null;
  /** The lark-bot account name inside the project's daemon. */
  account: string;
  herdrSocket: string;
  workbench: { create: boolean; name: string | null };
  /**
   * A live card for a long turn: sent once it has worked for `afterMs`, its process (the thinking
   * bubble) updated every `everyMs` until it ends; null: off.
   */
  live: { afterMs: number; everyMs: number } | null;
  rules: WatchRules;
  paths: Paths;
}

export interface Paths {
  configFile: string;
  configDir: string;
  dataDir: string;
  /** The bridge's state: owner, workbench, topics (0600). */
  stateFile: string;
  /** A pending owner-binding code, written by `setup`, taken by the running bridge. */
  setupFile: string;
  /** Present: nothing is sent and nothing is typed into herdr. */
  pauseFile: string;
  /** The daemon's own data directory and generated config. */
  aioDataDir: string;
  aioConfigFile: string;
  socket: string;
  logDir: string;
}

export type Env = Record<string, string | undefined>;

export class ConfigError extends Error {}

export const DEFAULT_APP_ID: SecretRef[] = ["env:AGENTS_IO_HERDR_APP_ID", "keychain:agents-io-herdr.app-id"];
export const DEFAULT_APP_SECRET: SecretRef[] = [
  "env:AGENTS_IO_HERDR_APP_SECRET",
  "keychain:agents-io-herdr.app-secret",
];

export const expandHome = (p: string, home: string) =>
  p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;

export const tildify = (p: string, home: string) =>
  home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p;

export function configPath(env: Env, home: string): string {
  return env.AGENTS_IO_HERDR_CONFIG
    ? resolve(expandHome(env.AGENTS_IO_HERDR_CONFIG, home))
    : join(home, ".config", "agents-io-herdr", "config.json");
}

/** `HH:MM-HH:MM` → minutes after midnight; "off" → null. */
export function parseQuiet(spec: string | null | undefined): WatchRules["quiet"] {
  if (spec === undefined || spec === null) return DEFAULT_RULES.quiet;
  if (spec === "off") return null;
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec);
  if (!m)
    throw new ConfigError(`notify.quiet must look like "23:00-08:00" or be "off" (it is ${JSON.stringify(spec)})`);
  const [h1, m1, h2, m2] = m.slice(1).map(Number) as [number, number, number, number];
  if (h1 > 23 || h2 > 23 || m1 > 59 || m2 > 59) throw new ConfigError(`notify.quiet has an impossible time: ${spec}`);
  return { start: h1 * 60 + m1, end: h2 * 60 + m2 };
}

type Raw = Record<string, unknown>;

const obj = (v: unknown, where: string): Raw => {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ConfigError(`${where} must be an object`);
  return v as Raw;
};

const str = (v: unknown, where: string): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ConfigError(`${where} must be a string`);
  return v;
};

const bool = (v: unknown, where: string, dflt: boolean): boolean => {
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "boolean") throw new ConfigError(`${where} must be true or false`);
  return v;
};

const seconds = (v: unknown, where: string, dfltMs: number): number => {
  if (v === undefined || v === null) return dfltMs;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    throw new ConfigError(`${where} must be a number of seconds`);
  return Math.round(v * 1000);
};

function refs(v: unknown, where: string, dflt: SecretRef[], literalOk: boolean): SecretRef[] {
  if (v === undefined || v === null) return dflt;
  const list = Array.isArray(v) ? v : [v];
  if (!list.length) throw new ConfigError(`${where} is empty`);
  return list.map((x, i) => {
    if (typeof x !== "string" || !x) throw new ConfigError(`${where}[${i}] must be a non-empty string`);
    const ref = /^(env|keychain):./.test(x);
    if (!ref && !literalOk) {
      throw new ConfigError(`${where} must be "env:NAME" or "keychain:SERVICE" (a secret does not belong in a file)`);
    }
    return x;
  });
}

const ACCOUNT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function defaultDataDir(env: Env, home: string): string {
  return env.AGENTS_IO_HERDR_DATA
    ? resolve(expandHome(env.AGENTS_IO_HERDR_DATA, home))
    : join(home, ".local", "share", "agents-io-herdr");
}

/** Reads and checks the config file; a missing file means all defaults. */
export function loadConfig(env: Env, home: string, platform: NodeJS.Platform = process.platform): Config {
  const file = configPath(env, home);
  let raw: Raw = {};
  if (existsSync(file)) {
    const st = statSync(file);
    if (st.mode & 0o022) throw new ConfigError(`${tildify(file, home)} is writable by others; chmod 600 it`);
    try {
      raw = obj(JSON.parse(readFileSync(file, "utf8")), "the config");
    } catch (e) {
      if (e instanceof ConfigError) throw e;
      throw new ConfigError(`${tildify(file, home)} is not valid JSON: ${(e as Error).message}`);
    }
  }
  return resolveConfig(raw, { env, home, file, platform });
}

export function resolveConfig(
  raw: Raw,
  ctx: { env: Env; home: string; file: string; platform: NodeJS.Platform },
): Config {
  const { env, home, file } = ctx;
  const base = dirname(file);
  const path = (p: string) => {
    const e = expandHome(p, home);
    return isAbsolute(e) ? e : resolve(base, e);
  };
  const feishu = obj(raw.feishu, "feishu");
  const domain = str(feishu.domain, "feishu.domain") ?? "feishu";
  if (domain !== "feishu" && domain !== "lark") throw new ConfigError('feishu.domain must be "feishu" or "lark"');
  const locale = str(raw.locale, "locale") ?? (domain === "feishu" ? "zh" : "en");
  if (locale !== "zh" && locale !== "en") throw new ConfigError('locale must be "zh" or "en"');
  const account = str(raw.account, "account") ?? "herdr";
  if (!ACCOUNT.test(account))
    throw new ConfigError("account: letters, digits, . _ - (at most 64), starting with a letter or digit");
  const notify = obj(raw.notify, "notify");
  const rules: WatchRules = {
    blockedAfterMs: seconds(notify.blockedAfterSec, "notify.blockedAfterSec", DEFAULT_RULES.blockedAfterMs),
    doneMinTurnMs: seconds(notify.doneMinTurnSec, "notify.doneMinTurnSec", DEFAULT_RULES.doneMinTurnMs),
    doneSettleMs: seconds(notify.doneSettleSec, "notify.doneSettleSec", DEFAULT_RULES.doneSettleMs),
    presentIdleMs: seconds(notify.presentIdleSec, "notify.presentIdleSec", DEFAULT_RULES.presentIdleMs),
    quiet: parseQuiet(str(notify.quiet, "notify.quiet")),
    quietBlocked: bool(notify.quietBlocked, "notify.quietBlocked", DEFAULT_RULES.quietBlocked),
  };
  const workbench = obj(raw.workbench, "workbench");
  const live = bool(notify.live, "notify.live", true)
    ? {
        afterMs: seconds(notify.liveAfterSec, "notify.liveAfterSec", 60_000),
        everyMs: Math.max(2000, seconds(notify.liveEverySec, "notify.liveEverySec", 5000)),
      }
    : null;
  const dataDir = str(raw.dataDir, "dataDir");
  const data = dataDir ? path(dataDir) : defaultDataDir(env, home);
  const aioData = join(data, "aio");
  const configDir = dirname(file);
  const aioRepo = str(raw.aioRepo, "aioRepo");
  const aioCli = str(raw.aioCli, "aioCli");
  const herdrSocket = str(raw.herdrSocket, "herdrSocket");
  const timeZone = str(raw.timeZone, "timeZone") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new ConfigError(`timeZone ${JSON.stringify(timeZone)} is not a time zone`);
  }
  return {
    machine: str(raw.machine, "machine"),
    locale,
    timeZone,
    feishu: {
      domain,
      appId: refs(feishu.appId, "feishu.appId", DEFAULT_APP_ID, true),
      appSecret: refs(feishu.appSecret, "feishu.appSecret", DEFAULT_APP_SECRET, false),
    },
    aioRepo: aioRepo ? path(aioRepo) : null,
    aioCli: aioCli ? path(aioCli) : null,
    account,
    herdrSocket: herdrSocket
      ? path(herdrSocket)
      : env.HERDR_SOCKET_PATH || join(home, ".config", "herdr", "herdr.sock"),
    workbench: {
      create: bool(workbench.create, "workbench.create", true),
      name: str(workbench.name, "workbench.name"),
    },
    live,
    rules,
    paths: {
      configFile: file,
      configDir,
      dataDir: data,
      stateFile: join(data, "state.json"),
      setupFile: join(data, "setup.json"),
      pauseFile: join(configDir, "paused"),
      aioDataDir: aioData,
      aioConfigFile: join(data, "aio.config.json"),
      socket: join(aioData, "run", "aio.sock"),
      logDir: ctx.platform === "darwin" ? join(home, "Library", "Logs", "agents-io-herdr") : join(data, "logs"),
    },
  };
}

/** The daemon CLI to run: `aioCli`, else the built CLI in `aioRepo`. */
export function aioCliPath(c: Config): string | null {
  if (c.aioCli) return c.aioCli;
  return c.aioRepo ? join(c.aioRepo, "packages", "daemon", "dist", "cli.js") : null;
}

/** What `init` writes: the defaults spelled out, nothing secret. */
export function starterConfig(o: { aioRepo?: string; machine?: string }): Record<string, unknown> {
  return {
    machine: o.machine ?? null,
    aioRepo: o.aioRepo ?? "~/src/agents-io",
    feishu: { domain: "feishu", appId: DEFAULT_APP_ID, appSecret: DEFAULT_APP_SECRET },
    notify: { quiet: "23:00-08:00", quietBlocked: false },
    workbench: { create: true, name: null },
  };
}
