/** `agents-io-herdr sessions …`: the session collector's commands (docs/sessions.md). */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  Collector,
  type KeyStore,
  keepNodeKey,
  loadSessionsConfig,
  newNodeKey,
  pairingCode,
  runCollector,
  SESSIONS_LABEL,
  type SessionsConfig,
  sessionsPaths,
} from "./collector.ts";
import { paired } from "./exec/generation.ts";
import { execPaths } from "./exec/paths.ts";
import { jobState, plist, plistPath, stableNode, uid } from "./launchd.ts";
import type { Io } from "./main.ts";
import { readPage } from "./sessionread.ts";
import { fileOf } from "./sessions.ts";
import { writePrivate } from "./store.ts";
import { machineName } from "./system.ts";

export const SESSIONS_HELP = `agents-io-herdr sessions — this machine's Claude Code / Codex sessions, for LB

  agents-io-herdr sessions [--json]            list running, waiting and recently ended sessions
  agents-io-herdr sessions read <id> [--offset N] [--limit N]   one page of a transcript (redacted)
  agents-io-herdr sessions init [--machine <name>] [--lb-url <url> --node <id> (--key-file <path> | --key-service <s> --key-account <a>)]
  agents-io-herdr sessions pair --lb-url <url> [--machine <name>] [--token-stdin] [--key-store file|keychain] [--key-file <path>]
      new node key; the personal token from LB_TOKEN or, with --token-stdin, the first line of stdin;
      the key goes to a 0600 file (default ~/.config/agents-io-herdr/node-key.pem) or the login keychain;
      LB asks the owner
  agents-io-herdr sessions install [--via-ssh] [--label-suffix <s>] | uninstall [--label-suffix <s>]
      the collector as a launchd agent (${SESSIONS_LABEL});
      --via-ssh: launchd runs \`ssh 127.0.0.1\` with the key local_ed25519 next to sessions.json and sshd starts
      the collector (macOS Local Network privacy refuses LAN addresses to a node launchd starts; docs/sessions.md);
      --label-suffix: a second collector (${SESSIONS_LABEL}.<s>, a staging one) with its own directory,
      AGENTS_IO_HERDR_SESSIONS_DIR, which the job is given
  agents-io-herdr sessions off | on            stop / resume collecting and reporting (a switch file)
  agents-io-herdr sessions status [--label-suffix <s>]
  agents-io-herdr sessions collect             the collector in the foreground (what launchd runs)
`;

const KEY_SERVICE = "io.agents-io-herdr.node";
const KEY_ACCOUNT = "node";
export const KEY_FILE = "node-key.pem";
/** The key a launchd job logs in to this machine with (`install --via-ssh`). */
export const LOCAL_KEY = "local_ed25519";

/**
 * The authorized_keys options for that key: from this machine only, the collector only (the command
 * the client asks for is ignored), and nothing else ssh offers. `exec` keeps sshd the collector's
 * parent, so the collector stops when the connection drops.
 */
export function sshOptions(collect: string[], home: string, env: Record<string, string> = {}): string {
  const path = [
    join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const vars = [`PATH=${path.join(":")}`, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
  const command = `exec env ${vars.join(" ")} ${collect.join(" ")}`;
  return `from="127.0.0.1,::1",command="${command}",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc`;
}

/** A second collector's suffix: `io.agents-io-herdr.sessions.<suffix>`. */
const SUFFIX = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** A directory that goes into a plist and an authorized_keys command="…" as it is. */
const PLAIN_PATH = /^\/[A-Za-z0-9._/-]+$/;

const where = (r: SessionsConfig["report"]) =>
  !r ? "" : r.keyFile ? `key file ${r.keyFile}` : `keychain ${r.keychainService ?? "?"}`;

export async function sessionsCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      offset: { type: "string" },
      limit: { type: "string" },
      machine: { type: "string" },
      "lb-url": { type: "string" },
      node: { type: "string" },
      "key-service": { type: "string" },
      "key-account": { type: "string" },
      "key-file": { type: "string" },
      "key-store": { type: "string" },
      "token-stdin": { type: "boolean" },
      "via-ssh": { type: "boolean" },
      "label-suffix": { type: "string" },
    },
    strict: true,
  });
  const [sub, ...rest] = positionals;
  const paths = sessionsPaths(io.env, io.home);
  const c = loadSessionsConfig(paths, machineName(null, io.exec, io.platform));
  const log = (s: string) => io.err(`${new Date(io.now()).toISOString()} ${s}\n`);
  const deps = { home: io.home, env: io.env, exec: io.exec, now: io.now, log };
  const suffix = values["label-suffix"];
  if (suffix !== undefined && !SUFFIX.test(suffix)) {
    io.err("--label-suffix wants lower-case letters, digits and -, at most 32\n");
    return 2;
  }
  const label = suffix ? `${SESSIONS_LABEL}.${suffix}` : SESSIONS_LABEL;
  switch (sub) {
    case undefined:
    case "list": {
      const col = new Collector(c, paths, deps);
      const list = await col.once();
      if (values.json) io.out(`${JSON.stringify(col.frame(list), null, 2)}\n`);
      else {
        if (col.off) io.out("Sessions are switched off (agents-io-herdr sessions on).\n");
        for (const s of list)
          io.out(
            `${s.state.padEnd(7)} ${s.agent.padEnd(6)} ${s.lastActivityAt.slice(0, 16)} ${s.paneId ? `[${s.paneId}] ` : ""}${s.headless ? "(headless) " : ""}${s.cwd ?? ""}\n          ${s.id}  ${s.summary}\n`,
          );
      }
      return 0;
    }
    case "read": {
      const id = rest[0];
      if (!id) {
        io.err("usage: agents-io-herdr sessions read <id> [--offset N] [--limit N]\n");
        return 2;
      }
      const col = new Collector({ ...c, recentHours: 24 * 30 }, paths, deps);
      await col.once();
      const p = fileOf(col.cache, id);
      if (!p) {
        io.err(`no session ${id} on this machine in the last 30 days\n`);
        return 1;
      }
      const page = readPage(p.path, p.agent, {
        offset: values.offset != null ? Number(values.offset) : null,
        limit: values.limit != null ? Number(values.limit) : null,
      });
      io.out(`${JSON.stringify(page, null, 2)}\n`);
      return 0;
    }
    case "init": {
      const next: SessionsConfig = {
        ...c,
        machine: values.machine ?? c.machine,
        report:
          values["lb-url"] && values.node
            ? values["key-file"]
              ? { lbUrl: values["lb-url"], nodeId: values.node, keyFile: resolve(values["key-file"]) }
              : {
                  lbUrl: values["lb-url"],
                  nodeId: values.node,
                  keychainService: values["key-service"] ?? KEY_SERVICE,
                  keychainAccount: values["key-account"] ?? KEY_ACCOUNT,
                }
            : c.report,
      };
      mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
      writePrivate(paths.config, `${JSON.stringify(next, null, 2)}\n`);
      io.out(
        `Wrote ${paths.config} (machine ${next.machine}; ${next.report ? `reports to ${next.report.lbUrl}` : "local only"}).\n`,
      );
      return 0;
    }
    case "pair": {
      const url = values["lb-url"];
      // Never an argument (`ps` shows those): the environment, or stdin (`… | ssh host agents-io-herdr sessions pair --token-stdin`).
      const token = values["token-stdin"]
        ? ((await io.stdin()).split(/\r?\n/)[0] ?? "").trim()
        : (io.env.LB_TOKEN ?? "").trim();
      const kind = values["key-store"] ?? "file";
      if (!url || !token || (kind !== "file" && kind !== "keychain")) {
        io.err(
          "usage: LB_TOKEN=<your personal token> agents-io-herdr sessions pair --lb-url <url> [--machine <name>] [--key-store file|keychain] [--key-file <path>]\n" +
            "       <token on stdin> | agents-io-herdr sessions pair --token-stdin --lb-url <url> …\n",
        );
        return 2;
      }
      const store: KeyStore =
        kind === "file"
          ? { file: resolve(values["key-file"] ?? join(paths.dir, KEY_FILE)) }
          : {
              keychainService: values["key-service"] ?? KEY_SERVICE,
              keychainAccount: values["key-account"] ?? KEY_ACCOUNT,
            };
      const machine = values.machine ?? c.machine;
      const k = newNodeKey();
      const r = await io.fetch(`${url.replace(/\/$/, "")}/api/nodes`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          name: machine,
          publicKey: k.publicKey,
          platform: io.platform,
          version: "agents-io-herdr",
          caps: ["sessions"],
        }),
      });
      if (r.status !== 201 && r.status !== 200) {
        io.err(`LB refused the pairing (${r.status})\n`);
        return 1;
      }
      // LB answers the node itself, flat (`CreatedNode`: id, code, status, owner, askedIn, …).
      const node = (await r.json()) as {
        id?: string;
        code?: string;
        askedIn?: string | null;
        owner?: { id?: unknown } | null;
      };
      const nodeId = node.id;
      if (!nodeId) {
        io.err("LB answered without a node id\n");
        return 1;
      }
      // The code is worked out here from the key; LB's must be the same, or the card is not this pairing.
      const code = pairingCode(k.publicKey);
      if (node.code !== code) {
        io.err(`LB shows pairing code ${node.code ?? "(none)"}, this machine ${code}: do not confirm the card.\n`);
        return 1;
      }
      mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
      const kept = keepNodeKey(k, store, io.exec);
      if (!kept.ok) {
        io.err(`${kept.reason}\n`);
        return 1;
      }
      const next: SessionsConfig = {
        ...c,
        machine,
        report: { lbUrl: url, nodeId, ...("file" in store ? { keyFile: store.file } : store) },
      };
      writePrivate(paths.config, `${JSON.stringify(next, null, 2)}\n`);
      // Whose node this is, as LB says; a welcome naming someone else retires it (docs/exec.md N4).
      paired(execPaths(paths.dir), nodeId, typeof node.owner?.id === "string" ? node.owner.id : null);
      const card =
        node.askedIn === "workbench"
          ? "the card in the workbench group"
          : node.askedIn === "dm"
            ? "the card in the chat with the agent"
            : "the nodes page on the web";
      io.out(
        `Paired as ${nodeId} (${where(next.report)}). Pairing code ${code}: confirm ${card} only if it shows the same code.\n`,
      );
      return 0;
    }
    case "off":
      mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
      writeFileSync(paths.off, `${new Date(io.now()).toISOString()}\n`);
      rmSync(paths.spool, { force: true });
      io.out("Sessions off: nothing listed or read; LB gets an empty list (agents-io-herdr sessions on).\n");
      return 0;
    case "on":
      rmSync(paths.off, { force: true });
      io.out("Sessions on.\n");
      return 0;
    case "install": {
      // The job reads the directory this command was given, not the default one; a second collector
      // must not share the first one's (its node, key, ledger and switch files are there).
      const own: Record<string, string> = io.env.AGENTS_IO_HERDR_SESSIONS_DIR
        ? { AGENTS_IO_HERDR_SESSIONS_DIR: paths.dir }
        : {};
      if (
        suffix &&
        (!io.env.AGENTS_IO_HERDR_SESSIONS_DIR || resolve(paths.dir) === resolve(sessionsPaths({}, io.home).dir))
      ) {
        io.err(
          "--label-suffix is a second collector: give it a directory of its own (AGENTS_IO_HERDR_SESSIONS_DIR=<dir>)\n",
        );
        return 2;
      }
      if (io.env.AGENTS_IO_HERDR_SESSIONS_DIR && !PLAIN_PATH.test(paths.dir)) {
        io.err("AGENTS_IO_HERDR_SESSIONS_DIR: an absolute path of letters, digits and . _ - / only\n");
        return 2;
      }
      const bin = join(io.pkgDir, "bin", "agents-io-herdr");
      const collect = [stableNode(process.execPath), bin, "sessions", "collect"];
      let args = collect;
      if (values["via-ssh"]) {
        const key = join(paths.dir, LOCAL_KEY);
        const known = join(paths.dir, "known_hosts_local");
        const user = io.env.USER || io.exec("id", ["-un"], 5000)?.stdout.trim();
        if (!existsSync(key) || !existsSync(known) || !user) {
          io.err(`--via-ssh needs ${key} (its own key, ssh-keygen -t ed25519) and ${known} (127.0.0.1's host key)\n`);
          return 1;
        }
        args = [
          "/usr/bin/ssh",
          "-T",
          "-i",
          key,
          ...["-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes"],
          ...["-o", `UserKnownHostsFile=${known}`, "-o", "LogLevel=ERROR"],
          ...["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3"],
          `${user}@127.0.0.1`,
        ];
        io.out(
          `In ~/.ssh/authorized_keys the key must only run the collector, only from this machine:\n  ${sshOptions(collect, io.home, own)} <${key}.pub>\n`,
        );
      }
      const job = { label, args, log: paths.log };
      const domain = `gui/${uid(io.exec)}`;
      const file = plistPath(io.home, label);
      mkdirSync(dirname(file), { recursive: true });
      mkdirSync(dirname(paths.log), { recursive: true });
      if (existsSync(file)) io.exec("launchctl", ["bootout", `${domain}/${label}`], 15_000);
      writeFileSync(file, plist(job, { home: io.home, env: own }));
      let r = io.exec("launchctl", ["bootstrap", domain, file], 15_000);
      for (let i = 0; i < 5 && r?.code !== 0; i++) {
        io.exec("sleep", ["1"], 5000);
        r = io.exec("launchctl", ["bootstrap", domain, file], 15_000);
      }
      if (r?.code !== 0) {
        io.err(`launchctl bootstrap failed: ${(r?.stderr ?? "").trim().slice(0, 200)}\n`);
        return 1;
      }
      io.out(`Installed ${file}\n`);
      return 0;
    }
    case "uninstall":
      io.exec("launchctl", ["bootout", `gui/${uid(io.exec)}/${label}`], 15_000);
      rmSync(plistPath(io.home, label), { force: true });
      io.out(`Uninstalled the collector (${label}).\n`);
      return 0;
    case "status":
      io.out(
        `collector: ${jobState(label, io.exec)}${suffix ? ` (${label})` : ""}\nmachine: ${c.machine}\nswitch: ${existsSync(paths.off) ? "off" : "on"}\nreport: ${c.report ? `${c.report.lbUrl} as node ${c.report.nodeId} (${where(c.report)})` : "local only"}\nlatest: ${paths.spool}\n`,
      );
      return 0;
    case "collect": {
      // launchd stops the job with SIGTERM: what exec runs stops first (docs/exec.md N7).
      const stop = new AbortController();
      const quit = () => stop.abort();
      process.once("SIGTERM", quit);
      process.once("SIGINT", quit);
      try {
        return await runCollector(c, paths, { ...deps, signal: stop.signal });
      } finally {
        process.off("SIGTERM", quit);
        process.off("SIGINT", quit);
      }
    }
    default:
      io.out(SESSIONS_HELP);
      return sub === "help" ? 0 : 2;
  }
}
