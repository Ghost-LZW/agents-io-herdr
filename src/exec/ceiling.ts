/**
 * The ceiling file (docs/exec.md N2, version 2): `exec-ceiling.json` next to the
 * collector's files, written on this machine by its owner — by hand or with `exec ceiling --preset` —
 * never by LB. It is the most exec may do here; LB's calls and grants only narrow it.
 *
 * - Exec is off (sessions go on) with no file; with one that is not this user's alone (0600, not a
 *   symlink, in a directory no one else can write), does not read as version 2, or has a key this
 *   build does not know; with `exec: "off"` in it; and with the `exec off` switch file.
 * - Paths are `~/…` or absolute. `~` is the home of the user the runner runs as: this user's for
 *   `runner: "same"`, the dedicated user's for `runner: "user"` — in the file and in LB's calls alike.
 * - Roots are listed one by one. A home, anything above it, a top-level directory, and (for `same`) a
 *   directory right under the home (`~/repos`, `~/Downloads`) are refused unless the owner wrote them
 *   into `acknowledged`. A root that is, or is inside, a denied place (src/exec/deny.ts) is refused.
 * - On a person's own computer (`same`) the read and write roots are scanned by name: credential-like
 *   names and directories with the `.exec-private` marker keep exec off until each one is in
 *   `acknowledged` (it stays unreadable all the same). The dedicated user's directories are not
 *   readable from here: its shim looks for the marker on each run and denies what it finds (N9).
 * - Two presets: `agent-user` (a dedicated user on an agent machine) and `personal-readonly` (a
 *   person's own computer: delegation; read-only commands only once the owner turns exec on and lists
 *   the roots).
 * - Linux (docs/exec.md, Linux / Box): `runner: "bwrap"` runs each call in bubblewrap, and its preset
 *   is acted on: `box` (a shared node with one directory per person under `peopleRoot`; only tools
 *   installed under `toolsRoot` run, src/exec/box.ts) or `box-install` (the install cell: only the
 *   image's `box-install`). There `~` is the run's `/home/me` inside the sandbox — the person's
 *   directory —, never the collector's home. `seccompBpf` (optional) is the filter every run gets: a
 *   file that is not there makes every run `sandbox_unavailable`. `network: "open"` (no network
 *   namespace of its own) is for `box-install` only; anywhere else the file does not load.
 * - The summary (hello, so LB can show the owner what the machine allows) has the tiers, directories,
 *   network, limits and grants, and the file's sha256 (first 16 hex digits) — not the acknowledged
 *   paths, the user's name or envPass.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, posix } from "node:path";
import { type CommandLists, entryProblem, type Tier } from "./commands.ts";
import { privateAbove, readDenied, type Scan, scanRoots, writeDenied } from "./deny.ts";
import type { ExecArgs } from "./frames.ts";
import type { ExecPaths } from "./paths.ts";

export const CEILING_VERSION = 2;
export const PRESETS = ["agent-user", "personal-readonly", "box", "box-install"] as const;
export type Preset = (typeof PRESETS)[number];
/** `open`: only the install cell (`runner: "bwrap"`, preset `box-install`). */
export type Network = "off" | "proxy" | "open";
/** The presets of `runner: "bwrap"`; with that runner the preset says what runs. */
export const BOX_PRESETS: readonly Preset[] = ["box", "box-install"];
/** Where a bwrap run sees the person's directory (and an install's empty HOME): `~` in its paths. */
export const BOX_HOME = "/home/me";

export interface CeilingFile {
  version: 2;
  /** The preset it was written from; for bwrap, also selects the cell's admission rules. */
  preset: Preset | null;
  /** off: nothing runs (delegation may still be on). */
  exec: "on" | "off";
  /**
   * same: a child of the collector; user: through ssh into a dedicated user's forced command (N9);
   * bwrap: a child of the collector in bubblewrap (Linux, the Box).
   */
  runner: "same" | "user" | "bwrap";
  /** `runner: "user"`: whom it runs as. */
  user: { name: string; home: string } | null;
  commands: CommandLists;
  /** `deny`: more names (any directory) or paths, on top of the built-in lists. */
  read: { roots: string[]; deny: string[] };
  /** Read-only, executable (a toolchain). */
  toolRead: string[];
  write: string[];
  /** Kept across runs (npm, pip); inside a write root. */
  cacheDirs: string[];
  network: Network;
  /** The local filtering proxy (N13): a fixed port on 127.0.0.1. */
  proxy: { port: number; allow: string[]; allowPrivate: { host: string; ip: string }[] } | null;
  /** May run in a turn no one is present in (routines, follow-ups). */
  unattended: boolean;
  /** What a group turn gets: auto becomes grant, or nothing at all. */
  groupTurns: "grant" | "never";
  /** What a grant may add beyond `network` and `write` (only where the runner can sweep: `user`). */
  widenOnGrant: { network: Network; write: string[] };
  limits: { maxSeconds: number; outputBytes: number; concurrent: number; fileBytes: number };
  grants: { maxMinutes: number; window: boolean };
  /** The only variables a run gets from outside; secret-looking names are dropped whatever is written. */
  envPass: string[];
  /** The name git commits under (in the run's empty HOME); no email. */
  gitIdentity: { name: string } | null;
  /** Delegation to the coding agents in herdr (N11). */
  agents: Tier;
  agentWorkspace: string | null;
  agentCommand: string | null;
  /** Besides the owner, whom exec may run for (LB actor ids). */
  others: string[];
  /** Broad roots and scan hits the owner has looked at and accepts. */
  acknowledged: string[];
  /** bwrap: one directory per person (`<peopleRoot>/<actor uuid>`), made by the deployment. */
  peopleRoot: string;
  /** bwrap: the installed tools (`<toolsRoot>/<name>/<version>-<tree12>/`); read-only on the Box. */
  toolsRoot: string;
  /** bwrap: a compiled seccomp filter every run gets (`bwrap --seccomp`); null: none. */
  seccompBpf: string | null;
}

/** The file, its paths made absolute. */
export interface Ceiling {
  file: CeilingFile;
  /** sha256 of the file's bytes, the first 16 hex digits. */
  sha: string;
  /** What `~` means: the runner's home. */
  home: string;
  read: string[];
  tool: string[];
  write: string[];
  cache: string[];
  widen: string[];
  /** `read.deny`: names as written, paths expanded; then the collector's own directory. */
  deny: string[];
  acknowledged: Set<string>;
  /** envPass without the secret-looking names. */
  envPass: string[];
  /** What was dropped or is worth a look (exec doctor). */
  notes: string[];
}

const DEFAULTS: CeilingFile = {
  version: 2,
  preset: null,
  exec: "on",
  runner: "same",
  user: null,
  commands: { default: "grant", auto: [], grant: [], never: [] },
  read: { roots: [], deny: [] },
  toolRead: [],
  write: [],
  cacheDirs: [],
  network: "off",
  proxy: null,
  unattended: false,
  groupTurns: "grant",
  widenOnGrant: { network: "off", write: [] },
  limits: { maxSeconds: 120, outputBytes: 65_536, concurrent: 1, fileBytes: 8 * 1024 * 1024 },
  grants: { maxMinutes: 15, window: false },
  envPass: ["PATH", "LANG", "TERM"],
  gitIdentity: null,
  agents: "never",
  agentWorkspace: null,
  agentCommand: null,
  others: [],
  acknowledged: [],
  peopleRoot: "/srv/people",
  toolsRoot: "/srv/tools",
  seccompBpf: null,
};

/** Names never passed into a run, whatever envPass says (a second filter, by name). */
export const SECRET_ENV =
  /TOKEN|SECRET|PASSW|PASSPHRASE|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE|AUTH|COOKIE|SESSION|SSH_AUTH_SOCK/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const TIERS: readonly string[] = ["auto", "grant", "never"];
const LIST_MAX = 64;
const FILE_MAX = 256 * 1024;

/** `~`, `~/…` or absolute, normalised, no trailing slash; null for anything else. */
export function expand(p: string, home: string): string | null {
  if (!p || p.includes("\0")) return null;
  const abs = p === "~" ? home : p.startsWith("~/") ? `${home}/${p.slice(2)}` : p.startsWith("/") ? p : null;
  if (!abs) return null;
  const n = posix.normalize(abs);
  return n === "/" ? n : n.replace(/\/+$/, "");
}

export const within = (abs: string, root: string) => root === "/" || abs === root || abs.startsWith(`${root}/`);

/**
 * A root that covers a whole area: `/`, a top-level directory, the home or above it, and — on a
 * person's own computer — a directory right under the home.
 */
export function broadRoot(abs: string, home: string, runner: CeilingFile["runner"]): boolean {
  if (abs.split("/").filter(Boolean).length <= 1) return true;
  if (within(home, abs)) return true;
  return runner === "same" && posix.dirname(abs) === home;
}

/** Collects what is wrong with the file, by key. */
class Check {
  problems: string[] = [];
  bad(key: string, why: string): void {
    this.problems.push(`${key}: ${why}`);
  }
  keys(v: unknown, key: string, allowed: readonly string[]): Record<string, unknown> | null {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      this.bad(key, "not an object");
      return null;
    }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) this.bad(key ? `${key}.${k}` : k, "unknown key");
    return v as Record<string, unknown>;
  }
  oneOf<T extends string>(v: unknown, key: string, options: readonly T[], fallback: T): T {
    if (v === undefined) return fallback;
    if (typeof v === "string" && (options as readonly string[]).includes(v)) return v as T;
    this.bad(key, `one of ${options.join(", ")}`);
    return fallback;
  }
  bool(v: unknown, key: string, fallback: boolean): boolean {
    if (v === undefined) return fallback;
    if (typeof v === "boolean") return v;
    this.bad(key, "true or false");
    return fallback;
  }
  int(v: unknown, key: string, min: number, max: number, fallback: number): number {
    if (v === undefined) return fallback;
    if (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max) return v as number;
    this.bad(key, `a whole number from ${min} to ${max}`);
    return fallback;
  }
  text(v: unknown, key: string, max: number, fallback: string | null): string | null {
    if (v === undefined || v === null) return v === null ? null : fallback;
    if (typeof v === "string" && v.length > 0 && v.length <= max && !/[\0\n\r]/.test(v)) return v;
    this.bad(key, `a line of at most ${max} characters`);
    return fallback;
  }
  list(v: unknown, key: string, max = 300): string[] | null {
    if (v === undefined) return null;
    if (!Array.isArray(v) || v.length > LIST_MAX) {
      this.bad(key, `a list of at most ${LIST_MAX}`);
      return null;
    }
    const out: string[] = [];
    for (const [i, x] of v.entries()) {
      if (typeof x === "string" && x.length > 0 && x.length <= max && !/[\0\n\r]/.test(x)) out.push(x);
      else this.bad(`${key}[${i}]`, `a line of at most ${max} characters`);
    }
    return out;
  }
}

const TOP_KEYS = Object.keys(DEFAULTS);

/** The file's text as version 2, defaults filled in for keys left out; or what is wrong with it. */
export function parseCeiling(raw: string): { ok: true; file: CeilingFile } | { ok: false; problems: string[] } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    return { ok: false, problems: [`not JSON (${(e as Error).message.slice(0, 120)})`] };
  }
  const k = new Check();
  const o = k.keys(v, "", TOP_KEYS);
  if (!o) return { ok: false, problems: k.problems };
  if (o.version !== CEILING_VERSION)
    return {
      ok: false,
      problems: [
        o.version === 1
          ? "version 1: write a version 2 file (agents-io-herdr exec ceiling --preset …)"
          : "version: must be 2",
      ],
    };
  const d = DEFAULTS;
  const f: CeilingFile = { ...d, version: 2 };
  f.preset = o.preset === undefined || o.preset === null ? null : k.oneOf(o.preset, "preset", PRESETS, "agent-user");
  f.exec = k.oneOf(o.exec, "exec", ["on", "off"] as const, d.exec);
  f.runner = k.oneOf(o.runner, "runner", ["same", "user", "bwrap"] as const, d.runner);
  if (o.user !== undefined && o.user !== null) {
    const u = k.keys(o.user, "user", ["name", "home"]);
    const name = u && k.text(u.name, "user.name", 32, null);
    const home = u && k.text(u.home, "user.home", 300, null);
    if (name && !/^[a-z_][a-z0-9_-]*$/.test(name)) k.bad("user.name", "a macOS short user name");
    if (home && !home.startsWith("/")) k.bad("user.home", "an absolute path");
    if (name && home) f.user = { name, home: posix.normalize(home) };
    else if (u) k.bad("user", "needs name and home");
  }
  if (o.commands !== undefined) {
    const c = k.keys(o.commands, "commands", ["default", "auto", "grant", "never"]);
    if (c) {
      f.commands = {
        default: k.oneOf(c.default, "commands.default", TIERS as Tier[], d.commands.default),
        auto: k.list(c.auto, "commands.auto", 200) ?? [],
        grant: k.list(c.grant, "commands.grant", 200) ?? [],
        never: k.list(c.never, "commands.never", 200) ?? [],
      };
      for (const t of ["auto", "grant", "never"] as const)
        for (const e of f.commands[t]) {
          const why = entryProblem(e);
          if (why) k.bad(`commands.${t} "${e}"`, why);
        }
    }
  }
  if (o.read !== undefined) {
    const r = k.keys(o.read, "read", ["roots", "deny"]);
    if (r) f.read = { roots: k.list(r.roots, "read.roots") ?? [], deny: k.list(r.deny, "read.deny") ?? [] };
  }
  f.toolRead = k.list(o.toolRead, "toolRead") ?? [];
  f.write = k.list(o.write, "write") ?? [];
  f.cacheDirs = k.list(o.cacheDirs, "cacheDirs") ?? [];
  f.network = k.oneOf(o.network, "network", ["off", "proxy", "open"] as const, d.network);
  if (o.proxy !== undefined && o.proxy !== null) {
    const p = k.keys(o.proxy, "proxy", ["port", "allow", "allowPrivate"]);
    if (p) {
      const allowPrivate: { host: string; ip: string }[] = [];
      if (p.allowPrivate !== undefined) {
        if (!Array.isArray(p.allowPrivate) || p.allowPrivate.length > 16) k.bad("proxy.allowPrivate", "at most 16");
        else
          for (const [i, x] of p.allowPrivate.entries()) {
            const h = k.keys(x, `proxy.allowPrivate[${i}]`, ["host", "ip"]);
            const host = h && k.text(h.host, `proxy.allowPrivate[${i}].host`, 253, null);
            const ip = h && k.text(h.ip, `proxy.allowPrivate[${i}].ip`, 45, null);
            if (host && ip) allowPrivate.push({ host, ip });
            else if (h) k.bad(`proxy.allowPrivate[${i}]`, "needs host and ip (both exact)");
          }
      }
      f.proxy = {
        port: k.int(p.port, "proxy.port", 1024, 65_535, 0),
        allow: k.list(p.allow, "proxy.allow", 253) ?? [],
        allowPrivate,
      };
      if (p.port === undefined) k.bad("proxy.port", "a fixed port is needed");
    }
  }
  f.unattended = k.bool(o.unattended, "unattended", d.unattended);
  f.groupTurns = k.oneOf(o.groupTurns, "groupTurns", ["grant", "never"] as const, d.groupTurns);
  if (o.widenOnGrant !== undefined) {
    const w = k.keys(o.widenOnGrant, "widenOnGrant", ["network", "write"]);
    if (w)
      f.widenOnGrant = {
        network: k.oneOf(w.network, "widenOnGrant.network", ["off", "proxy"] as const, "off"),
        write: k.list(w.write, "widenOnGrant.write") ?? [],
      };
  }
  if (o.limits !== undefined) {
    const l = k.keys(o.limits, "limits", ["maxSeconds", "outputBytes", "concurrent", "fileBytes"]);
    if (l)
      f.limits = {
        maxSeconds: k.int(l.maxSeconds, "limits.maxSeconds", 1, 7200, d.limits.maxSeconds),
        // Two streams of this in one effect frame stay well inside LB's 2 MiB frames.
        outputBytes: k.int(l.outputBytes, "limits.outputBytes", 1024, 524_288, d.limits.outputBytes),
        concurrent: k.int(l.concurrent, "limits.concurrent", 1, 8, d.limits.concurrent),
        fileBytes: k.int(l.fileBytes, "limits.fileBytes", 1, 64 * 1024 * 1024, d.limits.fileBytes),
      };
  }
  if (o.grants !== undefined) {
    const g = k.keys(o.grants, "grants", ["maxMinutes", "window"]);
    if (g)
      f.grants = {
        maxMinutes: k.int(g.maxMinutes, "grants.maxMinutes", 1, 30, d.grants.maxMinutes),
        window: k.bool(g.window, "grants.window", d.grants.window),
      };
  }
  const env = k.list(o.envPass, "envPass", 64);
  if (env) {
    for (const n of env) if (!ENV_NAME.test(n)) k.bad(`envPass "${n}"`, "not a variable name");
    f.envPass = env;
  }
  if (o.gitIdentity !== undefined && o.gitIdentity !== null) {
    const g = k.keys(o.gitIdentity, "gitIdentity", ["name"]);
    const name = g && k.text(g.name, "gitIdentity.name", 100, null);
    f.gitIdentity = name ? { name } : null;
  }
  f.agents = k.oneOf(o.agents, "agents", TIERS as Tier[], d.agents);
  f.agentWorkspace = k.text(o.agentWorkspace, "agentWorkspace", 64, null);
  if (f.agentWorkspace && !/^[A-Za-z0-9._-]+$/.test(f.agentWorkspace))
    k.bad("agentWorkspace", "letters, digits, . _ -");
  f.agentCommand = k.text(o.agentCommand, "agentCommand", 200, null);
  f.others = k.list(o.others, "others", 200) ?? [];
  f.acknowledged = k.list(o.acknowledged, "acknowledged") ?? [];
  const bwrap = f.runner === "bwrap";
  for (const key of ["peopleRoot", "toolsRoot", "seccompBpf"] as const) {
    const v = o[key];
    if (v === undefined || v === null) continue;
    if (!bwrap && v !== d[key]) k.bad(key, 'only for runner "bwrap"');
    else if (typeof v !== "string" || !v.startsWith("/") || v.length > 300 || /[\0\n\r]/.test(v))
      k.bad(key, "an absolute path");
    else if (key === "seccompBpf") f.seccompBpf = posix.normalize(v);
    else f[key] = posix.normalize(v).replace(/\/+$/, "") || "/";
  }
  if (bwrap && !BOX_PRESETS.includes(f.preset as Preset))
    k.bad("preset", 'runner "bwrap" runs what its preset says: "box" or "box-install"');
  if (!bwrap && f.preset && BOX_PRESETS.includes(f.preset)) k.bad("preset", `"${f.preset}" needs runner "bwrap"`);
  if (f.network === "open" && !(bwrap && f.preset === "box-install"))
    k.bad("network", '"open" only on the install cell (runner "bwrap", preset "box-install")');
  if (bwrap && f.network === "proxy") k.bad("network", 'runner "bwrap" has no proxy: "off" (or "open" to install)');
  return k.problems.length ? { ok: false, problems: k.problems } : { ok: true, file: f };
}

/**
 * The file with its paths made absolute and checked against each other; or what is wrong. `own`: the
 * collector's directory (its key, this file, the ledger), never readable or writable from a run
 * wherever it is — the built-in list only has the default one, not a second collector's.
 */
export function resolveCeiling(
  f: CeilingFile,
  o: { raw: string; home: string; own?: string[] },
): { ok: true; ceiling: Ceiling } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  if (f.runner === "user" && !f.user) problems.push('user: runner "user" needs user.name and user.home');
  if (f.runner !== "user" && f.user) problems.push('user: only for runner "user"');
  const bwrap = f.runner === "bwrap";
  if ((f.network === "proxy" || f.widenOnGrant.network === "proxy") && !f.proxy)
    problems.push("proxy: network through the proxy needs proxy.port");
  // bwrap: `~` is the run's /home/me (the person's directory), wherever the collector lives.
  const home = bwrap ? BOX_HOME : f.runner === "user" && f.user ? f.user.home : o.home;
  const paths = (list: string[], key: string) =>
    list.flatMap((p) => {
      const abs = expand(p, home);
      if (!abs) problems.push(`${key} "${p}": not ~/… or an absolute path`);
      return abs ? [abs] : [];
    });
  const acknowledged = new Set(paths(f.acknowledged, "acknowledged"));
  const deny = [...f.read.deny.map((d) => (d.includes("/") ? (expand(d, home) ?? d) : d)), ...(o.own ?? [])];
  const roots = (list: string[], key: string, writable: boolean) => {
    const abs = paths(list, key);
    for (const [i, r] of abs.entries()) {
      const shown = list[i] ?? r;
      // In bwrap the sandbox shows nothing but what is mounted: `~` is the person's directory itself.
      if (!bwrap && broadRoot(r, home, f.runner) && !acknowledged.has(r))
        problems.push(
          `${key} "${shown}": covers a whole area; list what is needed one by one, or add it to acknowledged`,
        );
      const no = readDenied(r, home, deny) ?? (writable ? writeDenied(r, home) : null);
      if (no) problems.push(`${key} "${shown}": never ${writable ? "writable" : "readable"} (${no})`);
    }
    return abs;
  };
  const read = roots(f.read.roots, "read.roots", false);
  const tool = roots(f.toolRead, "toolRead", false);
  const write = roots(f.write, "write", true);
  const cache = roots(f.cacheDirs, "cacheDirs", true);
  const widen = roots(f.widenOnGrant.write, "widenOnGrant.write", true);
  for (const [i, c] of cache.entries())
    if (!write.some((w) => within(c, w))) problems.push(`cacheDirs "${f.cacheDirs[i]}": not inside a write root`);
  if (bwrap) {
    // The collector's own directory (its key, this file, the ledger) is never under what runs see.
    const overlap = (a: string, b: string) => within(a, b) || within(b, a);
    for (const [key, root] of [
      ["peopleRoot", f.peopleRoot],
      ["toolsRoot", f.toolsRoot],
    ] as const) {
      if (root.split("/").filter(Boolean).length < 2)
        problems.push(`${key} "${root}": a directory of its own, not ${root}`);
      for (const own of o.own ?? [])
        if (overlap(root, own)) problems.push(`${key} "${root}": overlaps the collector's own directory ${own}`);
    }
    if (overlap(f.peopleRoot, f.toolsRoot)) problems.push("peopleRoot and toolsRoot: one is inside the other");
  }
  const envPass = f.envPass.filter((n) => !SECRET_ENV.test(n));
  const dropped = f.envPass.filter((n) => SECRET_ENV.test(n));
  if (dropped.length) notes.push(`envPass: never passed, secret-looking: ${dropped.join(", ")}`);
  if (f.exec === "on" && !read.length && !write.length) notes.push("no read or write roots: every run is path_outside");
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    ceiling: {
      file: f,
      sha: createHash("sha256").update(o.raw, "utf8").digest("hex").slice(0, 16),
      home,
      read,
      tool,
      write,
      cache,
      widen,
      deny,
      acknowledged,
      envPass,
      notes,
    },
  };
}

export type CeilingLoad =
  | { ok: true; ceiling: Ceiling }
  | { ok: false; reason: "no_ceiling" | "bad_ceiling"; problems: string[] };

/**
 * Reads the ceiling file. It must be a plain file of this user's (`uid`, default this process's) that
 * no one else can read or write (0600), in a directory no one else can write; `home` is this user's.
 */
export function loadCeiling(path: string, o: { home: string; uid?: number }): CeilingLoad {
  const uid = o.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    return { ok: false, reason: "no_ceiling", problems: [`no ${path}`] };
  }
  const bad = (why: string): CeilingLoad => ({ ok: false, reason: "bad_ceiling", problems: [`${path}: ${why}`] });
  if (st.isSymbolicLink()) return bad("a symlink; it must be the file itself");
  if (!st.isFile()) return bad("not a file");
  if ((st.mode & 0o077) !== 0) return bad("open to others (chmod 600 it)");
  if (uid >= 0 && st.uid !== uid) return bad("belongs to another user");
  if (st.size > FILE_MAX) return bad("larger than 256 KiB");
  const dir = statSync(dirname(path));
  if ((dir.mode & 0o022) !== 0) return bad(`others can write ${dirname(path)}`);
  if (uid >= 0 && dir.uid !== uid) return bad(`${dirname(path)} belongs to another user`);
  const raw = readFileSync(path, "utf8");
  const p = parseCeiling(raw);
  if (!p.ok) return { ok: false, reason: "bad_ceiling", problems: p.problems };
  // The ceiling sits in the collector's directory: as written and as the sandbox sees it.
  const own = [...new Set([dirname(path), realpathSync(dirname(path))])];
  const r = resolveCeiling(p.file, { raw, home: o.home, own });
  return r.ok ? r : { ok: false, reason: "bad_ceiling", problems: r.problems };
}

/** What hello carries: what the machine allows, for LB to show the owner (it is not acted on there). */
export function summary(f: CeilingFile): Record<string, unknown> {
  return {
    version: f.version,
    preset: f.preset,
    exec: f.exec,
    runner: f.runner,
    commands: f.commands,
    read: { roots: f.read.roots, deny: f.read.deny.length },
    toolRead: f.toolRead,
    write: f.write,
    cacheDirs: f.cacheDirs,
    network: f.network,
    proxy: f.proxy && { allow: f.proxy.allow, allowPrivate: f.proxy.allowPrivate.map((h) => h.host) },
    unattended: f.unattended,
    groupTurns: f.groupTurns,
    widenOnGrant: f.widenOnGrant,
    limits: f.limits,
    grants: f.grants,
    agents: f.agents,
    // Only where they mean something: a ceiling of another runner says what it always said.
    ...(f.runner === "bwrap" && {
      peopleRoot: f.peopleRoot,
      toolsRoot: f.toolsRoot,
      seccomp: f.seccompBpf !== null,
    }),
  };
}

/** Caps this build answers beyond `sessions` (transfer.v1 on the Box only, agents.v1 with N11). */
export const BUILT_CAPS: readonly string[] = ["exec.v1", "transfer.v1"];

/**
 * The caps hello says: `sessions`, and what the ceiling turns on that this build answers — exec.v1
 * while exec is on (with transfer.v1 where files move: `runner: "bwrap"`), agents.v1 while delegation
 * is not `never`. Nothing more with `exec off`. `execOnly` (the Box, which collects no sessions):
 * no `sessions` either.
 */
export function capsFor(state: CeilingState, o: { execOnly?: boolean } = {}): string[] {
  const c = state.ceiling;
  const base = o.execOnly ? [] : ["sessions"];
  if (!c) return base;
  const on = [
    ...(state.exec.on ? ["exec.v1"] : []),
    ...(state.exec.on && c.file.runner === "bwrap" ? ["transfer.v1"] : []),
    ...(c.file.agents !== "never" ? ["agents.v1"] : []),
  ];
  return [...base, ...on.filter((x) => BUILT_CAPS.includes(x))];
}

/** Why exec is off here (`exec_off`'s `error.data.reason`), beyond LB's own (`lb_old`, `lb_off`, `not_linked`). */
export type OffReason = "switched_off" | "no_ceiling" | "bad_ceiling" | "ceiling_off" | "unacknowledged";

export interface CeilingState {
  /** The valid ceiling, whether or not exec is on. */
  ceiling: Ceiling | null;
  exec: { on: true } | { on: false; reason: OffReason };
  problems: string[];
  /** The last name scan of the roots (`same` only). */
  scan: Scan | null;
}

/** Scan hits and an unfinished scan, unless acknowledged. */
export function unacknowledged(c: Ceiling, scan: Scan): string[] {
  const out = scan.hits
    .filter((h) => !c.acknowledged.has(h.path))
    .map((h) => `${h.path} (${h.why === "private" ? "marked .exec-private" : h.why})`);
  if (scan.truncated) out.push(`the scan stopped after ${scan.entries} entries: list narrower roots`);
  return out;
}

/** The roots the name scan looks at. */
export const scannedRoots = (c: Ceiling) => [...new Set([...c.read, ...c.write, ...c.widen])];

/**
 * The ceiling as the collector sees it, read again when the file changes (mtime, size, inode) and on
 * every look at the switch file; the name scan again when the file changes or after an hour.
 */
export class CeilingSource {
  readonly paths: ExecPaths;
  #home: string;
  #uid: number | undefined;
  #now: () => number;
  #key = "";
  #load: CeilingLoad = { ok: false, reason: "no_ceiling", problems: [] };
  #scan: { sha: string; at: number; scan: Scan } | null = null;
  #scanEveryMs: number;

  constructor(o: { paths: ExecPaths; home: string; now: () => number; uid?: number; scanEveryMs?: number }) {
    this.paths = o.paths;
    this.#home = o.home;
    this.#uid = o.uid;
    this.#now = o.now;
    this.#scanEveryMs = o.scanEveryMs ?? 3_600_000;
  }

  state(): CeilingState {
    this.#reload();
    const l = this.#load;
    const off = (reason: OffReason, problems: string[], ceiling: Ceiling | null = null): CeilingState => ({
      ceiling,
      exec: { on: false, reason },
      problems,
      scan: this.#scan?.scan ?? null,
    });
    if (existsSync(this.paths.off)) return off("switched_off", ["exec off (agents-io-herdr exec on)"]);
    if (!l.ok) return off(l.reason, l.problems);
    const c = l.ceiling;
    if (c.file.exec === "off") return off("ceiling_off", ['the ceiling says exec: "off"'], c);
    if (c.file.runner === "same") {
      const now = this.#now();
      if (!this.#scan || this.#scan.sha !== c.sha || now - this.#scan.at > this.#scanEveryMs)
        this.#scan = { sha: c.sha, at: now, scan: scanRoots(scannedRoots(c), { home: c.home, extra: c.deny }) };
      const left = unacknowledged(c, this.#scan.scan);
      if (left.length) return off("unacknowledged", left, c);
    }
    return { ceiling: c, exec: { on: true }, problems: [], scan: this.#scan?.scan ?? null };
  }

  #reload(): void {
    let key = "missing";
    try {
      const st = lstatSync(this.paths.ceiling);
      key = `${st.mtimeMs}:${st.size}:${st.ino}:${st.mode}`;
    } catch {
      // No file: no ceiling.
    }
    if (key === this.#key) return;
    this.#key = key;
    this.#load = loadCeiling(this.paths.ceiling, { home: this.#home, uid: this.#uid });
  }
}

/** A request's policy within the ceiling: the run's paths made absolute, and what goes beyond. */
export type Fit =
  | {
      ok: true;
      cwd: string;
      write: string[];
      /** Needs a grant that may widen (network through the proxy, or writes in widenOnGrant.write). */
      widened: string[];
      effective: { network: Network; write: string[]; maxSeconds: number; outputBytes: number };
    }
  | { ok: false; code: "over_ceiling" | "path_outside" | "path_denied" | "bad_request"; message: string };

/**
 * LB's request against the ceiling (narrowing only): network and write within it (or
 * within widenOnGrant, which takes a grant), cwd inside a root, nothing denied, only envPass names.
 * Paths are checked by name here; the runner checks them again with realpath and refuses symlinks.
 */
export function intersect(c: Ceiling, a: ExecArgs, o: { exists?: (p: string) => boolean } = {}): Fit {
  const cwd = expand(a.cwd, c.home);
  if (!cwd) return { ok: false, code: "bad_request", message: "cwd must be ~/… or an absolute path" };
  const write: string[] = [];
  for (const w of a.policy.write) {
    const abs = expand(w, c.home);
    if (!abs) return { ok: false, code: "bad_request", message: `write "${w}" must be ~/… or an absolute path` };
    write.push(abs);
  }
  const widened: string[] = [];
  const isPrivate = (abs: string, root: string) => c.file.runner === "same" && privateAbove(abs, root, o.exists);
  for (const [i, abs] of write.entries()) {
    const shown = a.policy.write[i];
    const no = readDenied(abs, c.home, c.deny) ?? writeDenied(abs, c.home);
    if (no) return { ok: false, code: "path_denied", message: `write "${shown}" is never writable here` };
    const root = c.write.find((r) => within(abs, r)) ?? c.widen.find((r) => within(abs, r));
    if (!root)
      return { ok: false, code: "over_ceiling", message: `write "${shown}" is outside this machine's ceiling` };
    if (isPrivate(abs, root)) return { ok: false, code: "path_denied", message: `write "${shown}" is marked private` };
    if (!c.write.some((r) => within(abs, r))) widened.push(`write ${shown}`);
  }
  const cwdRoot = [...c.read, ...c.write, ...write].find((r) => within(cwd, r));
  if (!cwdRoot) return { ok: false, code: "path_outside", message: "cwd is outside the roots this machine allows" };
  if (readDenied(cwd, c.home, c.deny) || isPrivate(cwd, cwdRoot))
    return { ok: false, code: "path_denied", message: "cwd is never readable here" };
  if (a.policy.network === "open")
    return { ok: false, code: "over_ceiling", message: "the network itself is for the Box's install cell only" };
  if (a.policy.network === "proxy" && c.file.network !== "proxy") {
    if (c.file.widenOnGrant.network !== "proxy")
      return { ok: false, code: "over_ceiling", message: "no network on this machine" };
    widened.push("network proxy");
  }
  const extra = Object.keys(a.env).filter((n) => !c.envPass.includes(n));
  if (extra.length) return { ok: false, code: "over_ceiling", message: `env ${extra.join(", ")} is not passed here` };
  return {
    ok: true,
    cwd,
    write,
    widened,
    effective: {
      network: a.policy.network,
      write: [...a.policy.write].sort(),
      maxSeconds: c.file.limits.maxSeconds,
      outputBytes: c.file.limits.outputBytes,
    },
  };
}

/** The presets `exec ceiling --preset` writes. `agent-user` needs the dedicated user's name. */
export function preset(name: Preset, o: { user?: string } = {}): CeilingFile {
  if (name === "box" || name === "box-install") {
    const box = name === "box";
    return {
      ...DEFAULTS,
      preset: name,
      exec: "on",
      runner: "bwrap",
      // The Box: only an installed tool's entry (src/exec/box.ts), never anything else; the install
      // cell: only the image's box-install.
      commands: { default: "never", auto: box ? [] : ["box-install"], grant: [], never: [] },
      read: { roots: box ? ["~"] : [], deny: [] },
      write: box ? ["~"] : [],
      network: box ? "off" : "open",
      unattended: true,
      groupTurns: "never",
      limits: { maxSeconds: 1800, outputBytes: box ? 262_144 : 524_288, concurrent: 1, fileBytes: 64 * 1024 * 1024 },
      envPass: ["LANG", "TZ"],
      peopleRoot: "/srv/people",
      toolsRoot: "/srv/tools",
      seccompBpf: "/usr/lib/box/seccomp.bpf",
    };
  }
  if (name === "agent-user") {
    if (!o.user) throw new Error("the agent-user preset needs --user <name>");
    return {
      ...DEFAULTS,
      preset: name,
      exec: "on",
      runner: "user",
      user: { name: o.user, home: `/Users/${o.user}` },
      commands: {
        default: "auto",
        auto: [],
        grant: [
          "brew install",
          "brew uninstall",
          "brew upgrade",
          "git push --force*",
          "git push -f",
          "rm -rf",
          "rm -fr",
        ],
        never: [
          "security",
          "op",
          "ssh-keygen",
          "csrutil",
          "diskutil",
          "dscl",
          "defaults write",
          "pfctl",
          "networksetup",
          "systemsetup",
          "pmset",
        ],
      },
      read: { roots: ["~/work"], deny: [] },
      write: ["~/work"],
      cacheDirs: ["~/work/.cache"],
      network: "off",
      unattended: true,
      limits: { maxSeconds: 1800, outputBytes: 262_144, concurrent: 4, fileBytes: 8 * 1024 * 1024 },
      grants: { maxMinutes: 30, window: true },
      agents: "never",
    };
  }
  return {
    ...DEFAULTS,
    preset: name,
    exec: "off",
    runner: "same",
    commands: {
      default: "grant",
      auto: [
        "ls",
        "cat",
        "head",
        "tail",
        "wc",
        "rg",
        "grep",
        "find",
        "stat",
        "file",
        "du",
        "df",
        "uptime",
        "git status",
        "git log",
        "git diff",
        "git show",
        "git branch",
        "git rev-parse",
        "git ls-files",
        "git blame",
        "brew list",
      ],
      grant: [],
      never: ["security", "op", "ssh-keygen", "csrutil", "diskutil", "dscl", "defaults write"],
    },
    read: { roots: [], deny: [] },
    network: "off",
    unattended: false,
    limits: { maxSeconds: 120, outputBytes: 65_536, concurrent: 1, fileBytes: 8 * 1024 * 1024 },
    grants: { maxMinutes: 15, window: true },
    agents: "grant",
    agentWorkspace: "delegated",
    agentCommand: "claude",
  };
}
