/**
 * What is never readable or writable from inside the sandbox, whatever the ceiling file says
 * (docs/exec.md N2). The ceiling may
 * add to these lists (`read.deny`), never take from them. Home entries are relative to the home of
 * the user the runner runs as; names count in any directory. Matching ignores case (APFS does).
 *
 * These lists are the second line: the sandbox profile (N8) only lets in what the ceiling lists, and
 * these are denied inside that. They also back the path checks before a run (`path_denied`) and the
 * name scan `exec doctor` makes of the read roots.
 */
import { type Dirent, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Under the runner's home: never readable. `*` matches within one name. */
export const DENY_HOME: readonly string[] = [
  // Keys and credentials.
  ".ssh",
  "Library/Keychains",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".pgpass",
  ".cargo/credentials*",
  ".m2/settings*.xml",
  ".config/gcloud",
  ".config/gh",
  ".config/hub",
  ".config/glab",
  ".config/op",
  ".config/1Password",
  "Library/Group Containers/*1password*",
  ".cloudflared",
  ".config/cloudflare",
  ".config/*/token*",
  ".config/*/*-token",
  ".config/*/*password*",
  ".config/*/*_ed25519*",
  ".emulator_console_auth_token",
  // Proxies (subscription addresses and keys).
  ".config/clash",
  ".config/clash.meta",
  ".config/mihomo",
  ".config/clash-verge",
  "Library/Application Support/com.west2online.ClashX",
  // Shell and REPL history.
  ".zsh_history",
  ".zsh_sessions",
  ".bash_history",
  ".bash_sessions",
  ".local/share/fish",
  ".python_history",
  ".node_repl_history",
  ".psql_history",
  ".mysql_history",
  ".sqlite_history",
  ".lesshst",
  ".viminfo",
  // Other tools that keep tokens (the LB command line, notes, bots, agent switchers).
  ".config/lb",
  ".config/lb-offsite",
  ".config/daily-report",
  ".config/memos",
  ".config/agents-io-herdr",
  ".botmux/bots.json",
  ".feishu-cli",
  ".cc-switch",
  // Coding agents' logins.
  ".claude.json",
  ".claude*/.credentials*",
  ".codex/auth*",
  ".gemini",
  ".happy",
  ".opencode",
  ".config/opencode",
  // Browsers.
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Firefox",
  "Library/Application Support/librewolf",
  "Library/Safari",
  "Library/Cookies",
  "Library/Containers/com.apple.Safari",
];

/** In any directory: never readable. */
export const DENY_NAMES: readonly string[] = [
  ".env*",
  "*.tfvars",
  "*.tfvars.json",
  "*.tfstate*",
  ".terraform",
  "*kubeconfig*",
  ".kube*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.age",
  "*.sops.*",
  "secrets*",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  ".netrc",
  ".pgpass",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "application_default_credentials*.json",
];

/** A directory holding a file of this name is never readable, all of it (the owner's marker). */
export const PRIVATE_MARK = ".exec-private";

/**
 * Never writable, even inside a write root: what git, Claude Code, Codex, direnv and editors run or
 * take as instructions outside the sandbox. `.git` itself too, so it cannot be renamed away.
 */
export const NO_WRITE: readonly RegExp[] = [
  /\/\.git$/i,
  /\/\.git\/(?:hooks|info)(?:\/|$)/i,
  /\/\.git\/config$/i,
  /\/\.git\/modules\/.*\/(?:config$|hooks(?:\/|$))/i,
  /\/\.git\/worktrees\/[^/]+\/config$/i,
  /\/(?:\.husky|\.githooks|\.claude|\.codex|\.cursor|\.vscode)(?:\/|$)/i,
  /\/(?:\.pre-commit-config\.yaml|CLAUDE\.md|CLAUDE\.local\.md|\.mcp\.json|AGENTS\.md|\.envrc)$/i,
];

/** Under the runner's home: never writable (shell start-up files, launchd agents, git's own config). */
export const NO_WRITE_HOME: readonly string[] = [
  "Library/LaunchAgents",
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".zlogout",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".profile",
  ".config/fish",
  ".gitconfig",
  ".config/git",
];

/** Directories the name scan does not go into (big, and nothing of the owner's is kept there by name). */
const SCAN_SKIP = new Set(["node_modules", ".git"]);

const globCache = new Map<string, RegExp>();
/** `*` within one name; case ignored. */
export function globRe(g: string): RegExp {
  let re = globCache.get(g);
  if (!re) {
    re = new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`, "i");
    globCache.set(g, re);
  }
  return re;
}

/**
 * The path is the pattern's path or inside it (both absolute; the pattern's names may hold `*`).
 * `low` is the path in lower case, for the quick test on the pattern's part before any `*`.
 */
function under(abs: string, low: string, pattern: string): boolean {
  const star = pattern.indexOf("*");
  if (!low.startsWith((star < 0 ? pattern : pattern.slice(0, star)).toLowerCase())) return false;
  const p = pattern.split("/");
  const a = abs.split("/");
  if (a.length < p.length) return false;
  return p.every((seg, i) => globRe(seg).test(a[i] ?? ""));
}

const nameDenied = (name: string, extra: readonly string[]) =>
  DENY_NAMES.find((g) => globRe(g).test(name)) ?? extra.find((g) => !g.includes("/") && globRe(g).test(name));

/** The home or `read.deny` place an absolute path is at or inside, or null (names aside). */
function placeDenied(abs: string, home: string, extra: readonly string[]): string | null {
  const low = abs.toLowerCase();
  if (low.startsWith(`${home.toLowerCase()}/`))
    for (const p of DENY_HOME) if (under(abs, low, `${home}/${p}`)) return `~/${p}`;
  for (const p of extra) if (p.includes("/") && under(abs, low, p)) return p;
  return null;
}

/**
 * Why an absolute path may not be read, or null. `extra` is the ceiling's `read.deny`: an entry with
 * a `/` is a path (already expanded), one without a name in any directory.
 */
export function readDenied(abs: string, home: string, extra: readonly string[] = []): string | null {
  const place = placeDenied(abs, home, extra);
  if (place) return place;
  for (const seg of abs.split("/")) {
    const g = seg ? nameDenied(seg, extra) : undefined;
    if (g) return g;
  }
  return null;
}

/** Why an absolute path may not be written (beyond `readDenied`), or null. */
export function writeDenied(abs: string, home: string): string | null {
  const low = abs.toLowerCase();
  for (const p of NO_WRITE_HOME) if (under(abs, low, `${home}/${p}`)) return `~/${p}`;
  const re = NO_WRITE.find((r) => r.test(abs));
  return re ? String(re) : null;
}

/**
 * The directory from `abs` up to `root` (both absolute, `abs` inside `root`) that holds the private
 * marker, or null. `exists` is for tests.
 */
export function privateAbove(abs: string, root: string, exists: (p: string) => boolean = lexists): string | null {
  let dir = abs;
  for (;;) {
    if (exists(join(dir, PRIVATE_MARK))) return dir;
    if (dir === root || dir.length <= root.length) return null;
    dir = dir.slice(0, dir.lastIndexOf("/")) || "/";
  }
}

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export interface ScanHit {
  path: string;
  /** `private`: a directory with the marker; otherwise the deny entry the name matched. */
  why: string;
}

export interface Scan {
  hits: ScanHit[];
  /** Entries looked at. */
  entries: number;
  /** Stopped at the limit: what was not looked at is unknown. */
  truncated: boolean;
}

/**
 * Names only, never contents: every file or directory under the roots whose name or place is on the
 * deny lists, and every directory with the private marker. Symlinks are not followed; node_modules
 * and .git are not gone into; a hit is not gone into either, nor are the `skip` directories.
 */
export function scanRoots(
  roots: readonly string[],
  o: { home: string; extra?: readonly string[]; maxEntries?: number; skip?: readonly string[] },
): Scan {
  const max = o.maxEntries ?? 50_000;
  const extra = o.extra ?? [];
  const skip = new Set(o.skip ?? []);
  const hits: ScanHit[] = [];
  let entries = 0;
  let truncated = false;
  const walk = (dir: string): void => {
    let list: Dirent[];
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (list.some((d) => d.name === PRIVATE_MARK)) {
      hits.push({ path: dir, why: "private" });
      return;
    }
    for (const d of list) {
      if (truncated) return;
      if (++entries > max) {
        truncated = true;
        return;
      }
      const p = join(dir, d.name);
      // The directories above were looked at already: this name, and the places.
      const why = nameDenied(d.name, extra) ?? placeDenied(p, o.home, extra);
      if (why) hits.push({ path: p, why });
      else if (d.isDirectory() && !d.isSymbolicLink() && !SCAN_SKIP.has(d.name) && !skip.has(p)) walk(p);
    }
  };
  for (const r of roots) {
    const why = readDenied(r, o.home, extra);
    if (why) hits.push({ path: r, why });
    else walk(r);
  }
  return { hits, entries: Math.min(entries, max), truncated };
}
