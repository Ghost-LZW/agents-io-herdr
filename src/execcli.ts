/**
 * `agents-io-herdr exec …`: what LB may run on this machine (docs/exec.md N12). Everything here
 * acts on local files only — the ceiling, the `exec.off` switch, the effect ledger — and never asks LB.
 * The running collector reads them again on its next pass and says hello anew when the caps change.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { execOnly, loadSessionsConfig, sessionsPaths } from "./collector.ts";
import { BwrapRunner } from "./exec/bwrap.ts";
import {
  type Ceiling,
  CeilingSource,
  capsFor,
  loadCeiling,
  PRESETS,
  type Preset,
  preset,
  scannedRoots,
  unacknowledged,
  within,
} from "./exec/ceiling.ts";
import { scanRoots } from "./exec/deny.ts";
import { type EffectEntry, EffectLedger } from "./exec/effects.ts";
import { readNodeRecord } from "./exec/generation.ts";
import { GrantsUsed } from "./exec/grants.ts";
import { type ExecPaths, execPaths } from "./exec/paths.ts";
import { runProbe } from "./exec/probe.ts";
import { buildProfile, ProfileError, SANDBOX_EXEC } from "./exec/sandbox.ts";
import { realInterlock, shim } from "./exec/shim.ts";
import type { Io } from "./main.ts";
import { writePrivate } from "./store.ts";

export const EXEC_HELP = `agents-io-herdr exec — what LB (the paired server) may run on this machine (docs/exec.md)

  agents-io-herdr exec status                  the switch, the ceiling, the caps hello says, the node, the ledger
  agents-io-herdr exec ceiling --preset agent-user --user <name> | --preset personal-readonly|box|box-install [--force]
      write the ceiling file (0600) from a preset; edit it by hand after — it never comes from LB
  agents-io-herdr exec log [--limit N] [--json] [<effect id>]   what ran here (one id: with its redacted output)
  agents-io-herdr exec off | on                refuse every exec call at once / take them again (a switch file)
  agents-io-herdr exec doctor                  check the ceiling, the sandbox, the runner's user, launchd jobs, the roots
  agents-io-herdr exec probe [--launchd]       try the sandbox profile for real in a directory of its own under /tmp
      (S1–S7; --launchd also loads a job of its own, tries to start it from inside, unloads it)
`;

/** Where Homebrew's node@24 is on an agent machine: the dedicated user's forced command runs it. */
export const NODE24 = "/opt/homebrew/opt/node@24/bin/node";
/**
 * The code a dedicated user runs (read-only for it): a link of its own per user, so setting up
 * a staging user from a newer checkout moves only staging's shim, never the production user's.
 */
export const sharedCode = (user: string) => `/Users/Shared/agents-io-herdr/current-${user}`;

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/**
 * What a copy of this project runs — package.json, bin/ and src/ — as the sha256 of each file's path
 * and bytes in order (first 16 hex digits); null when there is no copy there. Two copies with the same
 * sha run the same code whatever commit or directory they came from.
 */
export function codeSha(dir: string): string | null {
  const h = createHash("sha256");
  const file = (rel: string) => {
    const bytes = readFileSync(join(dir, rel));
    h.update(`${rel}\0${bytes.length}\0`).update(bytes);
  };
  const tree = (rel: string) => {
    const names = readdirSync(join(dir, rel), { withFileTypes: true });
    for (const d of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = `${rel}/${d.name}`;
      if (d.isDirectory()) tree(p);
      else if (d.isFile()) file(p);
    }
  };
  try {
    file("package.json");
    tree("bin");
    tree("src");
  } catch {
    return null;
  }
  return h.digest("hex").slice(0, 16);
}

const realOf = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

function describeCeiling(c: Ceiling): string {
  const f = c.file;
  const runner = f.runner === "user" ? `user ${f.user?.name}` : f.runner === "bwrap" ? "bwrap" : "same user";
  return `preset ${f.preset ?? "none"}, sha ${c.sha}, exec ${f.exec}, runner ${runner}, network ${f.network}, agents ${f.agents}`;
}

function effectLine(e: EffectEntry): string {
  const took = e.endedAt !== null ? ` ${((e.endedAt - e.startedAt) / 1000).toFixed(1)} s` : "";
  const end = e.state === "done" || e.exit !== null ? ` exit ${e.exit}` : "";
  const sig = e.signal ? ` ${e.signal}` : "";
  const hidden = e.redacted.stdout + e.redacted.stderr;
  const lb = e.state !== "running" && e.ackedAt === null ? ", not yet with LB" : "";
  return (
    `${iso(e.startedAt)}  ${e.effect_id}  ${e.op}  ${e.state}${end}${sig}${took}` +
    `  out ${e.bytes.stdout} B, err ${e.bytes.stderr} B${hidden ? `, ${hidden} hidden` : ""}${e.truncated ? ", cut" : ""}` +
    `${e.grant ? `  grant ${e.grant}` : ""}${e.reason ? `  (${e.reason})` : ""}${lb}`
  );
}

function ledgerOf(p: ExecPaths, io: Io): EffectLedger {
  const l = new EffectLedger(p.effects, io.now);
  l.load();
  return l;
}

export function execCommand(argv: string[], io: Io): number | Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      preset: { type: "string" },
      user: { type: "string" },
      force: { type: "boolean" },
      json: { type: "boolean" },
      limit: { type: "string" },
      launchd: { type: "boolean" },
    },
    strict: true,
  });
  const [sub, ...rest] = positionals;
  const dir = sessionsPaths(io.env, io.home).dir;
  const p = execPaths(dir);
  switch (sub) {
    case "status":
      return status(p, io);
    case "ceiling": {
      const name = values.preset;
      if (!name || !(PRESETS as readonly string[]).includes(name) || (name === "agent-user" && !values.user)) {
        io.err(
          "usage: agents-io-herdr exec ceiling --preset agent-user --user <name> | --preset personal-readonly|box|box-install [--force]\n",
        );
        return 2;
      }
      if (existsSync(p.ceiling) && !values.force) {
        io.err(`${p.ceiling} exists; --force to replace it\n`);
        return 1;
      }
      const f = preset(name as Preset, { user: values.user });
      writePrivate(p.ceiling, `${JSON.stringify(f, null, 2)}\n`);
      const l = loadCeiling(p.ceiling, { home: io.home });
      io.out(`Wrote ${p.ceiling} (${name}).\n`);
      if (!l.ok) io.out(`It does not load yet:\n${l.problems.map((x) => `  - ${x}\n`).join("")}`);
      if (name === "agent-user")
        io.out(
          `Commands run as ${values.user} through its forced command (scripts/exec-user-setup.sh); no network.\n` +
            "Then: agents-io-herdr exec doctor.\n",
        );
      else if (name === "box" || name === "box-install")
        io.out(`Commands run in bubblewrap (${name}); every call preflights the sandbox.\n`);
      else
        io.out(
          'exec is "off": only delegation (agents: "grant", every prompt asks you). To let read-only commands run,\n' +
            'list each project in read.roots (not ~/repos or ~/Downloads), set exec to "on", then agents-io-herdr exec doctor.\n',
        );
      return 0;
    }
    case "log": {
      const l = ledgerOf(p, io);
      const id = rest[0];
      if (id) {
        const e = l.get(id);
        if (!e) {
          io.err(`no effect ${id} in ${p.effects}\n`);
          return 1;
        }
        if (values.json) io.out(`${JSON.stringify(e, null, 2)}\n`);
        else {
          io.out(`${effectLine(e)}\n`);
          if (e.outputExpired) io.out("(the output was cleared an hour after LB had it)\n");
          else {
            io.out(`--- stdout (redacted) ---\n${e.stdout}${e.stdout.endsWith("\n") || !e.stdout ? "" : "\n"}`);
            io.out(`--- stderr (redacted) ---\n${e.stderr}${e.stderr.endsWith("\n") || !e.stderr ? "" : "\n"}`);
          }
        }
        return 0;
      }
      const n = values.limit != null ? Number(values.limit) : 20;
      if (!Number.isSafeInteger(n) || n < 1) {
        io.err("--limit wants a whole number\n");
        return 2;
      }
      const list = l.entries().slice(-n);
      if (values.json) io.out(`${JSON.stringify(list, null, 2)}\n`);
      else if (!list.length) io.out("Nothing has run here.\n");
      else for (const e of list) io.out(`${effectLine(e)}\n`);
      return 0;
    }
    case "off":
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(p.off, `${new Date(io.now()).toISOString()}\n`, { mode: 0o600 });
      io.out(
        "Exec off: every exec call is refused, and the collector says hello with sessions only on its next pass\n" +
          "(agents-io-herdr exec on).\n",
      );
      return 0;
    case "on": {
      rmSync(p.off, { force: true });
      const st = new CeilingSource({ paths: p, home: io.home, now: io.now }).state();
      io.out(
        st.exec.on
          ? "Exec on, within the ceiling.\n"
          : `The switch is on, but exec stays off: ${st.exec.reason}\n${st.problems.map((x) => `  - ${x}\n`).join("")}`,
      );
      return 0;
    }
    case "doctor":
      return doctor(p, io);
    case "probe":
      return probe(io, values.launchd === true);
    default:
      io.out(EXEC_HELP);
      return sub === "help" ? 0 : 2;
  }
}

function status(p: ExecPaths, io: Io): number {
  const st = new CeilingSource({ paths: p, home: io.home, now: io.now }).state();
  const only = execOnly(loadSessionsConfig(sessionsPaths(io.env, io.home), "node"), io.env);
  const lines = [
    `exec: ${st.exec.on ? "on" : `off (${st.exec.reason})`} — this machine's side; LB's welcome decides the rest`,
    `switch: ${existsSync(p.off) ? "off (agents-io-herdr exec on)" : "on"}`,
    `ceiling: ${p.ceiling}${st.ceiling ? ` (${describeCeiling(st.ceiling)})` : existsSync(p.ceiling) ? "" : " — none"}`,
    ...st.problems.map((x) => `  - ${x}`),
    `caps: ${capsFor(st, { execOnly: only }).join(", ")}`,
  ];
  const node = readNodeRecord(p.node);
  lines.push(
    node
      ? `node: ${node.node} (owner ${node.owner ?? "not told yet"}, generation ${node.generation || "not told yet"})`
      : "node: not paired (agents-io-herdr sessions pair)",
  );
  if (existsSync(p.retired)) lines.push("retired: LB named another owner; pair this machine again");
  const all = ledgerOf(p, io).entries();
  const running = all.filter((e) => e.state === "running").length;
  const waiting = all.filter((e) => e.state !== "running" && e.ackedAt === null).length;
  lines.push(`effects: ${running} running, ${waiting} not yet with LB, ${all.length} kept (${p.effects})`);
  lines.push(`once grants used (24 h): ${new GrantsUsed(p.grantsUsed, io.now).size}`);
  if (existsSync(p.sweep))
    try {
      const w = JSON.parse(readFileSync(p.sweep, "utf8")) as { at: number; killed: number; comms: string[] };
      lines.push(
        `last sweep: ${iso(w.at)}, ${w.killed} process(es) left over${w.killed ? ` (${w.comms.join(", ")})` : ""}`,
      );
    } catch {
      // A sweep file that does not read: nothing to show.
    }
  io.out(`${lines.join("\n")}\n`);
  return 0;
}

type Level = "ok" | "warn" | "FAIL" | "skip";

/** Each check on its own line; exit 1 when any failed. */
async function doctor(p: ExecPaths, io: Io): Promise<number> {
  const out: [Level, string][] = [];
  const say = (l: Level, s: string) => out.push([l, s]);
  if (existsSync(p.off)) say("warn", "switch: exec off (agents-io-herdr exec on)");
  const l = loadCeiling(p.ceiling, { home: io.home });
  const c = l.ok ? l.ceiling : null;
  if (!l.ok) for (const x of l.problems) say("FAIL", `ceiling: ${x}`);
  else {
    say("ok", `ceiling: ${describeCeiling(l.ceiling)}`);
    for (const x of l.ceiling.notes) say("warn", `ceiling: ${x}`);
  }
  const node = readNodeRecord(p.node);
  if (!node) say("warn", "node: not paired (agents-io-herdr sessions pair)");
  else say("ok", `node: ${node.node}, generation ${node.generation || "not told yet"}`);
  if (existsSync(p.retired)) say("FAIL", "node: retired (LB named another owner); pair this machine again");
  await sandbox(c, io, say);
  if (c?.file.runner === "user") dedicatedUser(c, p, io, say);
  if (c) launchd(c, io, say);
  if (c?.file.runner === "same") {
    const scan = scanRoots(scannedRoots(c), { home: c.home, extra: c.deny });
    const left = unacknowledged(c, scan);
    for (const x of left) say("FAIL", `roots: ${x} — exec stays off until it is in acknowledged`);
    const known = scan.hits.filter((h) => c.acknowledged.has(h.path)).length;
    if (known) say("ok", `roots: ${known} acknowledged name(s) found; they stay unreadable`);
    if (!left.length) say("ok", `roots: ${scan.entries} entries looked at by name; nothing unacknowledged`);
  } else if (c?.file.runner === "bwrap")
    say("skip", "roots: the person's directory and installed tree are checked for each call; no name scan in bwrap");
  else if (c)
    say(
      "skip",
      `roots: ${c.file.user?.name}'s directories are not readable from here; its shim looks for .exec-private in them on each run`,
    );
  for (const [level, s] of out) io.out(`${level.padEnd(5)} ${s}\n`);
  return out.some(([level]) => level === "FAIL") ? 1 : 0;
}

/** The profile a run would get from this ceiling (src/exec/sandbox.ts) runs `/usr/bin/true` (the preflight). */
async function sandbox(c: Ceiling | null, io: Io, say: (l: Level, s: string) => void): Promise<void> {
  if (c?.file.runner === "bwrap") {
    const runner = new BwrapRunner({ now: io.now, log: () => undefined });
    const p = await runner.prepareBox(
      {
        effectId: "eff_doctor",
        deadline: io.now() + 10_000,
        outputBytes: 1024,
        stdin: null,
        transfer: null,
        helper: false,
        ensure: [],
        reset: [],
        sandbox: {
          network: "off",
          cwd: "/",
          argv: ["/bin/true"],
          mounts: [
            { kind: "tmpfs", dst: "/home/me" },
            { kind: "tmpfs", dst: "/tmp" },
          ],
          env: { PATH: "/usr/bin", HOME: "/home/me", LANG: "C.UTF-8", TZ: "UTC" },
        },
      },
      { seccomp: c.file.seccompBpf },
    );
    if (p.ok) {
      p.prepared.discard();
      say("ok", "sandbox: bwrap runs /bin/true; each call preflights again with its own mounts and network");
    } else say("FAIL", `sandbox: ${p.code}: ${p.message}`);
    return;
  }
  if (io.platform !== "darwin") {
    say("FAIL", "sandbox: only macOS has sandbox-exec; nothing runs here");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "aih-doctor-"));
  try {
    let text: string;
    try {
      text = buildProfile({
        home: c?.home ?? io.home,
        read: c ? [...c.read, ...c.tool] : [],
        write: c ? [...c.write, ...c.cache] : [],
        own: [dir],
        deny: c?.deny ?? [],
        private: [],
        noWrite: [],
        network: c?.file.network === "proxy" ? "proxy" : "off",
        proxyPort: c?.file.proxy?.port ?? null,
      });
    } catch (e) {
      if (!(e instanceof ProfileError)) throw e;
      say("FAIL", `sandbox: no profile for this ceiling: ${e.message}`);
      return;
    }
    const file = join(dir, "profile.sb");
    writeFileSync(file, text, { mode: 0o600 });
    const r = io.exec(SANDBOX_EXEC, ["-f", file, "/usr/bin/true"], 10_000);
    if (r?.code === 0)
      say(
        "ok",
        `sandbox: ${SANDBOX_EXEC} runs ${c ? "this ceiling's" : "a"} deny-default profile (exec probe tries it for real)`,
      );
    else say("FAIL", `sandbox: the profile did not run /usr/bin/true (${r ? `exit ${r.code}` : "no sandbox-exec"})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** `exec probe`: the S checks of src/exec/probe.ts, as this user, under /tmp. */
async function probe(io: Io, launchd: boolean): Promise<number> {
  if (io.platform !== "darwin") {
    io.err("exec probe: only macOS has sandbox-exec\n");
    return 1;
  }
  const base = mkdtempSync("/tmp/aih-probe-");
  const results = await runProbe({ base, sandboxExec: SANDBOX_EXEC, exec: io.exec, launchd });
  for (const x of results)
    io.out(`${x.ok ? "ok  " : "FAIL"} ${x.id.padEnd(4)} ${x.what}${x.detail ? ` (${x.detail})` : ""}\n`);
  const failed = results.filter((x) => !x.ok).length;
  io.out(`${results.length} checks, ${failed} failed${launchd ? "" : " (S6 without a launchd job: --launchd)"}\n`);
  return failed ? 1 : 0;
}

/**
 * `agents-io-herdr exec-shim`: the dedicated user's forced command (src/exec/shim.ts). stdout carries
 * frames only.
 */
export async function shimCommand(io: Io): Promise<number> {
  const me = userInfo();
  const n = await shim({
    command: io.env.SSH_ORIGINAL_COMMAND,
    stdin: process.stdin,
    out: (b) => process.stdout.write(b),
    err: io.err,
    now: io.now,
    uid: me.uid,
    home: me.homedir,
    pid: process.pid,
    exec: io.exec,
    interlock: () => realInterlock(me.uid, me.homedir),
  });
  process.stdin.destroy();
  return n;
}

/** The dedicated user (docs/exec.md N9): its home root's, this home closed to it, node@24, the key, the code, no tokens in argv. */
function dedicatedUser(c: Ceiling, p: ExecPaths, io: Io, say: (l: Level, s: string) => void): void {
  const u = c.file.user;
  if (!u) return;
  const st = (path: string) => {
    try {
      return statSync(path);
    } catch {
      return null;
    }
  };
  const home = st(u.home);
  if (!home) say("FAIL", `user: no ${u.home} (scripts/exec-user-setup.sh --user ${u.name})`);
  else if (home.uid !== 0 || (home.mode & 0o777) !== 0o755)
    say("FAIL", `user: ${u.home} must be root's, 755 (it is uid ${home.uid}, ${(home.mode & 0o777).toString(8)})`);
  else say("ok", `user: ${u.home} is root's, 755 (${u.name} cannot write start-up files there)`);
  const work = st(join(u.home, "work"));
  if (!work || work.uid === 0) say("FAIL", `user: ${u.home}/work must exist and be ${u.name}'s`);
  const mine = st(io.home);
  if (mine && (mine.mode & 0o077) !== 0)
    say("FAIL", `user: ${io.home} is open to other users (chmod 700 it): ${u.name} could read it`);
  else if (mine) say("ok", `user: ${io.home} is closed to other users`);
  say(
    existsSync(NODE24) ? "ok" : "FAIL",
    `user: the forced command's node ${NODE24}${existsSync(NODE24) ? "" : " is missing"}`,
  );
  const key = join(p.dir, `${u.name}_ed25519`);
  const k = st(key);
  if (!k) say("FAIL", `user: no runner key ${key}`);
  else if ((k.mode & 0o077) !== 0) say("FAIL", `user: ${key} is open to others (chmod 600 it)`);
  else say("ok", `user: runner key ${key}`);
  // The shim and the collector talk a wire format of their own (src/exec/wire.ts): the shim must run
  // what this collector runs, not the commit unpacked before the last update.
  const code = sharedCode(u.name);
  const shared = codeSha(code);
  const ours = codeSha(io.pkgDir);
  if (!shared) say("FAIL", `user: the code ${u.name} runs, ${code}, is missing`);
  else if (shared !== ours)
    say(
      "FAIL",
      `user: the code ${u.name} runs (${realOf(code)}) is not this collector's (${io.pkgDir}): unpack it again (step 6 of scripts/exec-user-setup.sh)`,
    );
  else say("ok", `user: ${u.name} runs this collector's code (${realOf(code)}, ${shared})`);
  // Other users can read every process's arguments: count (never show) what looks like a token in ours.
  const me = io.env.USER || io.exec("id", ["-un"], 5000)?.stdout.trim();
  const ps = io.exec("ps", ["-axo", "user=,args="], 10_000);
  if (!ps || ps.code !== 0 || !me) say("warn", "user: could not list this user's processes");
  else {
    const n = ps.stdout
      .split("\n")
      .filter((line) => line.split(/\s+/)[0] === me)
      .filter((line) => /--token\b|--password\b|authorization:|bearer\s|:\/\/[^\s/:@]+:[^\s/@]+@/i.test(line)).length;
    if (n)
      say(
        "FAIL",
        `user: ${n} of ${me}'s processes have what looks like a token in their arguments (${u.name} can read them)`,
      );
    else say("ok", `user: no token-like arguments in ${me}'s processes`);
  }
}

/**
 * launchd: `kickstart` without -k starts an on-demand job outside the sandbox (docs/exec.md, launchd). The jobs
 * that run or read something inside a write root are the way out; inside a read root, worth knowing.
 */
function launchd(c: Ceiling, io: Io, say: (l: Level, s: string) => void): void {
  if (io.platform !== "darwin") return;
  const uid =
    c.file.runner === "user" && c.file.user
      ? io.exec("id", ["-u", c.file.user.name], 5000)?.stdout.trim()
      : io.exec("id", ["-u"], 5000)?.stdout.trim();
  const domain = `${c.file.runner === "user" ? "user" : "gui"}/${uid ?? "?"}`;
  const r = uid ? io.exec("launchctl", ["print", domain], 15_000) : null;
  if (!r || r.code !== 0) say("warn", `launchd: could not print ${domain}`);
  else {
    const block = r.stdout.split(/\n\tservices = \{\n/)[1]?.split("\n\t}")[0] ?? "";
    const idle = block.split("\n").filter((line) => /^\s*(?:0|-)\s+\S+\s+\S+\s*$/.test(line)).length;
    say("ok", `launchd: ${idle} job(s) in ${domain} not running (launchctl, open and osascript are never run)`);
  }
  const dirs = [join(io.home, "Library", "LaunchAgents"), "/Library/LaunchAgents"];
  for (const d of dirs) {
    let files: string[];
    try {
      files = readdirSync(d).filter((f) => f.endsWith(".plist"));
    } catch {
      continue;
    }
    for (const f of files) {
      const j = io.exec("plutil", ["-convert", "json", "-o", "-", join(d, f)], 5000);
      if (!j || j.code !== 0) continue;
      let job: { Label?: unknown; Program?: unknown; ProgramArguments?: unknown; WorkingDirectory?: unknown };
      try {
        job = JSON.parse(j.stdout) as typeof job;
      } catch {
        continue;
      }
      const words = [
        job.Program,
        job.WorkingDirectory,
        ...(Array.isArray(job.ProgramArguments) ? job.ProgramArguments : []),
      ]
        .filter((w): w is string => typeof w === "string")
        .map((w) => (w.startsWith("~/") ? join(c.home, w.slice(2)) : w));
      const label = typeof job.Label === "string" ? job.Label : f;
      if (words.some((w) => [...c.write, ...c.widen].some((root) => within(w, root))))
        say("FAIL", `launchd: ${label} runs something inside a write root: a run could change it and start it`);
      else if (words.some((w) => c.read.some((root) => within(w, root))))
        say("warn", `launchd: ${label} runs or reads something inside a read root`);
    }
  }
}
