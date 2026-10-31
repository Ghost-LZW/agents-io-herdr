/**
 * The seatbelt profile a run gets (docs/exec.md N8, hardening and launchd): deny by default,
 * then only what the run needs. The dedicated user's runs get the same profile with its own paths.
 *
 * - Read: the system (/usr, /bin, /sbin, /System, /private/etc, the timezone data, the developer
 *   tools), only Homebrew's program directories (`bin`, `opt`, `Cellar`… — not `etc` or `var`, where
 *   configuration and data live), the ceiling's read roots and toolRead, the write roots, and the
 *   run's own directories (HOME and TMPDIR). Metadata (stat) everywhere, contents nowhere else.
 * - Write: the run's write roots (LB's request within the ceiling), cacheDirs, the run's own
 *   directories, /dev/null.
 * - Never, whatever was allowed above (denies come last and win): the deny lists of src/exec/deny.ts
 *   (names in any directory, places under the runner's home, `read.deny`), directories marked
 *   `.exec-private`; writing `.git` itself (so it cannot be renamed, removed or made), its hooks, info
 *   and config (also in modules and worktrees), the agents' and editors' instruction files, shell
 *   start-up files, `~/.gitconfig`, and wherever git's `core.hooksPath` points.
 * - Processes: `launchctl`, `open` and `osascript` never start (a plain `launchctl kickstart` starts
 *   an on-demand launchd job outside the sandbox; docs/exec.md, launchd), nor does any file in a writable or
 *   temporary directory (a copy of launchctl, a script just written). Signals only within this
 *   sandbox; process information only about itself (an explicit deny first: with `same-sandbox`
 *   alone other processes' arguments and environment stay readable, hardening #5); sysctl reads only from
 *   a list (Codex's); no mach services at all (and a catch-all deny of XPC names); the two fcntls
 *   that change a file through a read-only descriptor are denied.
 * - Network: `off`, nothing; `proxy`, only TCP to the local proxy's fixed port (N13).
 *
 * Every run first runs `/usr/bin/true` under its profile (`preflight`): a profile that does not
 * compile makes sandbox-exec exit 65, which a command's own 65 cannot be told from. Not zero: the
 * run is refused (`sandbox_unavailable`), never run without it.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DENY_HOME, DENY_NAMES, NO_WRITE_HOME } from "./deny.ts";

/** Only this path, never one found in PATH. */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Never started from inside the sandbox (docs/exec.md, launchd). */
export const NEVER_EXEC: readonly string[] = ["/bin/launchctl", "/usr/bin/open", "/usr/bin/osascript"];

/** The system a run reads: whole directories. */
const SYSTEM_DIRS: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/private/etc",
  "/private/var/db/timezone",
  "/Library/Developer/CommandLineTools",
  "/Applications/Xcode.app",
];

/** Single files. */
const SYSTEM_FILES: readonly string[] = [
  "/",
  "/Library/Preferences/com.apple.dt.Xcode.plist",
  "/dev/null",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/dtracehelper",
];

/** Homebrew's programs, not its configuration (`etc`) or data (`var`): hardening #4. */
export const HOMEBREW = "/opt/homebrew";
export const HOMEBREW_READ: readonly string[] = [
  "bin",
  "sbin",
  "opt",
  "Cellar",
  "lib",
  "libexec",
  "share",
  "include",
  "Frameworks",
];

/** Temporary directories: nothing in them is started. */
const TEMP_DIRS: readonly string[] = ["/private/tmp", "/private/var/tmp", "/private/var/folders"];

/** sysctl names a run may read (Codex's `seatbelt_base_policy.sbpl`), exact. */
const SYSCTL_NAMES: readonly string[] = [
  "hw.activecpu",
  "hw.busfrequency_compat",
  "hw.byteorder",
  "hw.cacheconfig",
  "hw.cachelinesize_compat",
  "hw.cpufamily",
  "hw.cpufrequency",
  "hw.cpufrequency_compat",
  "hw.cputype",
  "hw.l1dcachesize_compat",
  "hw.l1icachesize_compat",
  "hw.l2cachesize_compat",
  "hw.l3cachesize_compat",
  "hw.logicalcpu",
  "hw.logicalcpu_max",
  "hw.machine",
  "hw.memsize",
  "hw.model",
  "hw.ncpu",
  "hw.nperflevels",
  "hw.packages",
  "hw.pagesize",
  "hw.pagesize_compat",
  "hw.physicalcpu",
  "hw.physicalcpu_max",
  "hw.tbfrequency_compat",
  "hw.vectorunit",
  "kern.argmax",
  "kern.hostname",
  "kern.maxfilesperproc",
  "kern.maxproc",
  "kern.osproductversion",
  "kern.osrelease",
  "kern.ostype",
  "kern.osvariant_status",
  "kern.osversion",
  "kern.secure_kernel",
  "kern.sysv.semmns",
  "kern.usrstack64",
  "kern.version",
  "machdep.cpu.brand_string",
  "sysctl.proc_cputype",
  "vm.loadavg",
];

/** …and by prefix. */
const SYSCTL_PREFIXES: readonly string[] = [
  "hw.optional.arm.",
  "hw.optional.armv8_",
  "hw.perflevel",
  "kern.proc.pgrp.",
  "kern.proc.pid.",
  "net.routetable.",
];

/**
 * Never writable in any directory, as seatbelt regexes (names matched in any case, as APFS does):
 * `.git` itself, so it cannot be renamed away and back (hardening #1), and what git, the coding agents,
 * direnv and editors take as code or instructions outside the sandbox.
 */
const NO_WRITE_PATTERNS: readonly string[] = [
  `/${ci(".git")}$`,
  `/${ci(".git")}/(${ci("hooks")}|${ci("info")})(/|$)`,
  `/${ci(".git")}/${ci("config")}$`,
  `/${ci(".git")}/${ci("modules")}/.*/(${ci("config")}$|${ci("hooks")}(/|$))`,
  `/${ci(".git")}/${ci("worktrees")}/[^/]+/${ci("config")}$`,
  `/(${[".husky", ".githooks", ".claude", ".codex", ".cursor", ".vscode"].map(ci).join("|")})(/|$)`,
  `/(${[".pre-commit-config.yaml", "CLAUDE.md", "CLAUDE.local.md", ".mcp.json", "AGENTS.md", ".envrc"].map(ci).join("|")})$`,
];

export class ProfileError extends Error {}

/** A path inside a seatbelt string: absolute, and nothing that would need escaping. */
export function sbString(p: string): string {
  if (!p.startsWith("/") || /["\\\p{Cc}]/u.test(p))
    throw new ProfileError(`cannot put ${JSON.stringify(p)} in a profile`);
  return `"${p}"`;
}

/** A letter in either case: seatbelt regexes have no flag for it. */
function ci(s: string): string {
  return s.replace(/[A-Za-z]|[.+?^${}()|[\]\\]/g, (c) =>
    /[A-Za-z]/.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : `\\${c}`,
  );
}

/** A deny-list glob (`*` within one name) as a regex, case ignored. */
function globRe(g: string): string {
  return g
    .split("*")
    .map((part) => ci(part))
    .join("[^/]*");
}

/** An absolute path as the start of a regex, exact (the home is as the system wrote it). */
function pathRe(p: string): string {
  if (/["\\\p{Cc}]/u.test(p)) throw new ProfileError(`cannot put ${JSON.stringify(p)} in a profile`);
  return p.replace(/[.+?^${}()|[\]\\*]/g, (c) => `\\${c}`);
}

const re = (r: string) => `(regex #"${r}")`;
const subpath = (p: string) => `(subpath ${sbString(p)})`;
const literal = (p: string) => `(literal ${sbString(p)})`;

export interface ProfileInput {
  /** The home of the user the run runs as: the deny lists' `~`. */
  home: string;
  /** Read roots and toolRead (real paths). */
  read: string[];
  /** Where the run may write: its write roots and cacheDirs (real paths). */
  write: string[];
  /** The run's own directories (HOME, TMPDIR): read and written, nothing started from them. */
  own: string[];
  /** The ceiling's `read.deny`: names (no `/`) or absolute paths, `*` within a name. */
  deny: string[];
  /** Directories marked `.exec-private`. */
  private: string[];
  /** More places never written (where git's core.hooksPath points). */
  noWrite: string[];
  network: "off" | "proxy";
  /** The local proxy's fixed port, for `network: "proxy"`. */
  proxyPort: number | null;
}

/** The profile text. Throws ProfileError for a path that cannot be written into it. */
export function buildProfile(p: ProfileInput): string {
  if (p.network === "proxy" && !(Number.isSafeInteger(p.proxyPort) && (p.proxyPort as number) > 0))
    throw new ProfileError("network through the proxy needs its port");
  const home = p.home.replace(/\/+$/, "");
  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal (target same-sandbox))",
    // Explicitly first: `(target same-sandbox)` alone leaves other processes' argv and env readable.
    "(deny process-info*)",
    "(allow process-info* (target self))",
    `(allow sysctl-read\n  ${[...SYSCTL_NAMES.map((n) => `(sysctl-name "${n}")`), ...SYSCTL_PREFIXES.map((n) => `(sysctl-name-prefix "${n}")`)].join("\n  ")})`,
    "(allow file-read-metadata)",
    `(allow file-read*\n  ${[
      ...SYSTEM_FILES.map(literal),
      ...SYSTEM_DIRS.map(subpath),
      ...HOMEBREW_READ.map((d) => subpath(`${HOMEBREW}/${d}`)),
      ...[...p.read, ...p.write, ...p.own].map(subpath),
    ].join("\n  ")})`,
  ];
  const writable = [...p.write, ...p.own];
  if (writable.length) lines.push(`(allow file-write*\n  ${writable.map(subpath).join("\n  ")})`);
  lines.push(
    '(allow file-write-data (literal "/dev/null") (literal "/dev/dtracehelper"))',
    '(allow file-ioctl (literal "/dev/dtracehelper"))',
  );
  if (p.network === "proxy") lines.push(`(allow network-outbound (remote ip "localhost:${p.proxyPort}"))`);
  // Denies last: the last rule that matches decides.
  const unreadable = [
    ...DENY_HOME.map((d) => re(`^${pathRe(home)}/${d.split("/").map(globRe).join("/")}(/|$)`)),
    ...DENY_NAMES.map((n) => re(`/${globRe(n)}(/|$)`)),
    ...p.deny.map((d) =>
      d.includes("/")
        ? re(
            `^${d
              .split("/")
              .map((seg, i) => (i === 0 ? "" : globRe(seg)))
              .join("/")}(/|$)`,
          )
        : re(`/${globRe(d)}(/|$)`),
    ),
    ...p.private.map(subpath),
  ];
  lines.push(`(deny file-read* file-write*\n  ${unreadable.join("\n  ")})`);
  const unwritable = [
    ...NO_WRITE_PATTERNS.map(re),
    ...NO_WRITE_HOME.map((d) => re(`^${pathRe(home)}/${d.split("/").map(globRe).join("/")}(/|$)`)),
    ...p.noWrite.map(subpath),
  ];
  lines.push(`(deny file-write*\n  ${unwritable.join("\n  ")})`);
  lines.push(
    `(deny process-exec\n  ${[...NEVER_EXEC.map(literal), ...[...writable, ...TEMP_DIRS].map(subpath)].join("\n  ")})`,
    "(deny system-fcntl (fcntl-command 80 110))",
    '(deny mach-lookup (xpc-service-name-prefix ""))',
  );
  return `${lines.join("\n")}\n`;
}

/**
 * The rule the dedicated user's shim adds at the end of the collector's profile for the directories
 * it found marked `.exec-private` (the collector cannot read there): the last rule, so it wins.
 * Throws ProfileError for a path that cannot be written into it.
 */
export function privateRule(dirs: readonly string[]): string {
  return dirs.length ? `(deny file-read* file-write*\n  ${dirs.map(subpath).join("\n  ")})\n` : "";
}

/** What `preflight` runs programs with; tests and the shim pass their own. */
export type Spawner = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number | null }>;

export const realSpawner: Spawner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "ignore", env: { PATH: "/usr/bin:/bin" }, timeout: timeoutMs });
    p.on("error", () => resolve({ code: null }));
    p.on("close", (code) => resolve({ code }));
  });

/** `/usr/bin/true` under the profile file: null when it ran, else why not (`sandbox_unavailable`). */
export async function preflight(
  profileFile: string,
  o: { sandboxExec?: string; spawn?: Spawner } = {},
): Promise<string | null> {
  const r = await (o.spawn ?? realSpawner)(o.sandboxExec ?? SANDBOX_EXEC, ["-f", profileFile, "/usr/bin/true"], 10_000);
  if (r.code === 0) return null;
  return r.code === null
    ? "sandbox-exec could not be started"
    : `the profile did not run /usr/bin/true (exit ${r.code})`;
}

/**
 * Where git's `core.hooksPath` points, from the config files git reads outside the sandbox: the
 * user's (`~/.gitconfig`, `~/.config/git/config`) and the repository's around `cwd`. Read as text,
 * never by running git there; best effort (no includes).
 */
export function gitHooksPaths(home: string, cwd: string, stop: (dir: string) => boolean): string[] {
  // [file, the repository a relative value is relative to (null: the user's own files)]
  const files: [string, string | null][] = [
    [join(home, ".gitconfig"), null],
    [join(home, ".config", "git", "config"), null],
  ];
  for (let dir = cwd; ; dir = dirname(dir)) {
    files.push([join(dir, ".git", "config"), dir]);
    if (stop(dir) || dir === dirname(dir)) break;
  }
  const out = new Set<string>();
  for (const [f, repo] of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    let core = false;
    for (const line of text.split("\n")) {
      const section = /^\s*\[\s*([A-Za-z0-9.-]+)/.exec(line);
      if (section) core = section[1]?.toLowerCase() === "core";
      const m = core ? /^\s*hookspath\s*=\s*"?([^"#;]+?)"?\s*(?:[#;].*)?$/i.exec(line) : null;
      const v = m?.[1]?.trim();
      if (!v) continue;
      // A relative value is relative to wherever git runs: the repository at hand covers the case that matters.
      const base = repo ?? cwd;
      const abs = v.startsWith("~/") ? join(home, v.slice(2)) : v.startsWith("/") ? v : join(base, v);
      out.add(abs.replace(/\/+$/, ""));
    }
  }
  return [...out];
}
