/**
 * The project's own agents-io daemon: one lark-bot channel for the project's Feishu app, no
 * agents, no console, an empty local binding table (the bridge pushes the real one). Its config is
 * generated from ours and holds no secret: the app id and secret are `env:` references, and
 * `agents-io-herdr daemon` reads them (keychain / env) and hands them to `aio serve` in its
 * environment only.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { aioCliPath, type Config } from "./config.ts";
import type { AppCredentials } from "./secrets.ts";
import { writePrivate } from "./store.ts";

/** Variables the generated config names; set only in the daemon's own environment. */
export const APP_ID_VAR = "AGENTS_IO_HERDR_LARK_APP_ID";
export const APP_SECRET_VAR = "AGENTS_IO_HERDR_LARK_APP_SECRET";

export function aioConfig(c: Config): Record<string, unknown> {
  return {
    dataDir: c.paths.aioDataDir,
    socketPath: c.paths.socket,
    // A dedicated daemon: no web console (its default port would clash with another daemon),
    // no external MCP endpoint, no output tools, no local rules — only the host's table routes.
    console: { enabled: false },
    outputTools: false,
    bindings: [],
    policy: { owners: [], strangers: "drop" },
    channels: [
      {
        type: "lark-bot",
        account: c.account,
        config: {
          appId: `env:${APP_ID_VAR}`,
          appSecret: `env:${APP_SECRET_VAR}`,
          domain: c.feishu.domain,
          // The bridge reads replies itself: no history fetches, no reaction events, no name lookups.
          historyOnMention: false,
          reactions: false,
          resolveSenderNames: false,
          locale: c.locale,
        },
      },
      // More channels as configured (their `env:` values come from `secrets`, in the daemon's environment).
      ...c.extraChannels,
    ],
  };
}

/** Writes the generated daemon config (0600) and returns its path. */
export function writeAioConfig(c: Config): string {
  mkdirSync(c.paths.aioDataDir, { recursive: true, mode: 0o700 });
  writePrivate(c.paths.aioConfigFile, `${JSON.stringify(aioConfig(c), null, 2)}\n`);
  return c.paths.aioConfigFile;
}

export class DaemonError extends Error {}

/** The daemon CLI, checked: it must exist (an agents-io checkout after `pnpm build`). */
export function checkedAioCli(c: Config): string {
  const cli = aioCliPath(c);
  if (!cli)
    throw new DaemonError('no agents-io daemon configured: set "aioRepo" (an agents-io checkout) in the config');
  if (!existsSync(cli))
    throw new DaemonError(`${cli} does not exist: run \`pnpm install && pnpm build\` in the agents-io checkout`);
  return cli;
}

/**
 * Runs `aio serve` in the foreground with the generated config and the credentials in its
 * environment; forwards SIGINT/SIGTERM and exits with the daemon's code.
 */
export function runDaemon(
  c: Config,
  creds: AppCredentials,
  log: (s: string) => void,
  secrets: Record<string, string> = {},
): Promise<number> {
  const cli = checkedAioCli(c);
  const file = writeAioConfig(c);
  log(`aio serve --config ${file}`);
  const child = spawn(process.execPath, [cli, "serve", "--config", file], {
    cwd: c.paths.aioDataDir,
    env: { ...process.env, ...secrets, [APP_ID_VAR]: creds.appId, [APP_SECRET_VAR]: creds.appSecret },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGTERM", forward("SIGTERM"));
  return new Promise((resolve) => {
    child.on("error", (e) => {
      log(`aio serve did not start: ${e.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 + 15 : 1)));
  });
}
