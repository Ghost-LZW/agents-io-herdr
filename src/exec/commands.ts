/**
 * Which tier a command is in under the ceiling (docs/exec.md N2): `auto` runs, `grant`
 * needs the owner's grant, `never` is refused. The lists only decide whether to ask; what a command
 * can touch is the sandbox's business. So the matching leans one way: when in doubt, ask.
 *
 * - An entry is a program and the start of its arguments (`git status` is `git status …`); `*` only
 *   at the very end (`diskutil erase*`). The program is argv[0]'s name; a path outside the usual bin
 *   directories (`./git`) matches no `auto` entry.
 * - `auto` entries match the arguments as a prefix; `grant` and `never` entries as a subsequence, so
 *   `git -C x push origin --force` is still `git push --force`. The longest match wins, a tie asks.
 * - `never` wins over everything: sudo, su, doas and launchctl, open, osascript (they reach past the
 *   sandbox through launchd) always, and the ceiling's own. Inside a shell script, after a launcher
 *   (`env X=1`, `xargs`, `sh -c`) or after find's `-exec`, each command found is checked too, as well
 *   as shell text can be read without a shell; `grep open` stays a grep.
 * - What cannot be seen through needs a grant: `shell: true`, a shell or launcher (`bash x.sh`,
 *   `env X=1 cmd`, `xargs`), inline code (`python3 -c`, `node -e`, awk).
 * - An `auto` entry with an argument that runs something or writes (`git --ext-diff`, `find -exec`,
 *   `rg --pre`, `sort -o`) needs a grant: the auto list is for reading.
 * - From a group turn: `auto` becomes `grant`, or `never` with `groupTurns: "never"`.
 */
import { globRe } from "./deny.ts";
import type { Where } from "./frames.ts";

export type Tier = "auto" | "grant" | "never";

export interface CommandLists {
  default: Tier;
  auto: readonly string[];
  grant: readonly string[];
  never: readonly string[];
}

export interface Match {
  tier: Tier;
  /** Why, for the refusal's message and the owner's card: `default`, an entry, `shell`, `group`… */
  why: string;
}

/** Never, whatever the ceiling says. */
export const BUILTIN_NEVER: readonly string[] = ["sudo", "su", "doas", "launchctl", "open", "osascript"];

/** argv[0] in one of these is the program it names; anywhere else it is a file of unknown making. */
const BIN_DIRS = new Set(["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/opt/homebrew/bin"]);

/** Shells and launchers: what they run is in their arguments, out of the lists' sight. */
const LAUNCHERS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "env",
  "xargs",
  "nohup",
  "nice",
  "time",
  "timeout",
  "gtimeout",
  "command",
  "builtin",
  "exec",
  "eval",
  "stdbuf",
  "caffeinate",
  "arch",
  "script",
  "watch",
  "parallel",
  "sandbox-exec",
  "chroot",
  "taskpolicy",
  "setsid",
  "flock",
  "awk",
  "gawk",
  "mawk",
  "nawk",
]);

/** Interpreters and the flags that hand them code inline. */
const INLINE: readonly [RegExp, RegExp][] = [
  [/^python[0-9.]*$/, /^-c/],
  [/^(?:node|bun|deno)$/, /^(?:-e|-p|--eval|--print|eval)$/],
  [/^(?:perl|ruby)$/, /^-[eE]/],
  [/^php$/, /^-r/],
  [/^lua$/, /^-e/],
];

/** Arguments that make a reading command run something or write: per program, then for any. */
const DANGEROUS: Record<string, RegExp> = {
  git: /^(?:-c|-O.*|--open-files-in-pager(?:=.*)?|--git-dir(?:=.*)?|--work-tree(?:=.*)?|--exec-path(?:=.*)?)$/,
  find: /^-(?:exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/,
  rg: /^--pre(?:-glob)?(?:=.*)?$/,
  sort: /^(?:-o.*|--compress-program(?:=.*)?)$/,
  tar: /^(?:-I.*|--checkpoint-action(?:=.*)?|--rsh-command(?:=.*)?)$/,
  rsync: /^(?:-e.*|--rsh(?:=.*)?|--rsync-path(?:=.*)?)$/,
};
const DANGEROUS_ANY =
  /^--(?:exec|pre|output|to-command|use-compress-program|compress-program|upload-pack|receive-pack|config-env|ext-diff|textconv)(?:=|$)/;

interface Entry {
  text: string;
  words: string[];
}

const entry = (text: string): Entry => ({ text, words: text.trim().split(/\s+/) });

/** One word against an entry word: literal, or a prefix when the entry word ends in `*`. */
function wordIs(word: string, pattern: string): boolean {
  return pattern.endsWith("*") ? word.startsWith(pattern.slice(0, -1)) : word === pattern;
}

/** The program a word names: its last path part, and whether the path (if any) is a usual bin directory. */
export function programOf(word: string): { name: string; known: boolean } {
  const slash = word.lastIndexOf("/");
  if (slash < 0) return { name: word, known: true };
  return { name: word.slice(slash + 1), known: BIN_DIRS.has(word.slice(0, slash) || "/") };
}

const programIs = (word: string, pattern: string) => globRe(pattern).test(programOf(word).name);

/** argv starts with the entry (program by name, then the arguments in order). */
function prefixMatch(argv: readonly string[], e: Entry): boolean {
  const [p, ...rest] = e.words;
  if (!p || !argv[0] || !programIs(argv[0], p)) return false;
  return rest.every((w, i) => argv[i + 1] !== undefined && wordIs(argv[i + 1] as string, w));
}

/** The command's program is the entry's, and the entry's arguments follow it, in order. */
function subsequenceMatch(words: readonly string[], e: Entry): boolean {
  const [p, ...rest] = e.words;
  if (!p || !words[0] || !programIs(words[0], p)) return false;
  let k = 0;
  for (let j = 1; j < words.length && k < rest.length; j++) if (wordIs(words[j] as string, rest[k] as string)) k++;
  return k === rest.length;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Where a new command starts in shell text: `;` `&` `|` `(` `)` a newline, backquotes, `$(`, find's -exec. */
const COMMAND_BREAK = /(?:[;&|()\n`]|\$\(|\s-(?:exec|execdir|ok|okdir)\s|\b(?:then|do|else|elif)\b)+/;

/**
 * The commands inside one, as well as they can be told apart: the arguments read as shell text, cut
 * where a command starts, leading `X=1` and launchers (with their options) stepped over.
 */
function commandsIn(argv: readonly string[]): string[][] {
  const out: string[][] = [];
  for (const part of argv.join(" ").split(COMMAND_BREAK)) {
    const words = part
      .split(/\s+/)
      .map((w) => w.replace(/^['"]+|['"]+$/g, ""))
      .filter(Boolean);
    for (;;) {
      while (words[0] && ASSIGNMENT.test(words[0])) words.shift();
      if (!words[0] || !LAUNCHERS.has(programOf(words[0]).name)) break;
      words.shift();
      while (words[0] && (words[0].startsWith("-") || ASSIGNMENT.test(words[0]) || /^\d+[smhd]?$/.test(words[0])))
        words.shift();
    }
    if (words.length) out.push(words);
  }
  return out;
}

/** Why the command cannot be seen through, or null. */
function opaque(argv: readonly string[], shell: boolean): string | null {
  if (shell) return "shell";
  const { name } = programOf(argv[0] ?? "");
  if (LAUNCHERS.has(name)) return `launcher ${name}`;
  for (const [prog, flag] of INLINE)
    if (prog.test(name) && argv.slice(1).some((a) => flag.test(a))) return `inline code (${name})`;
  return null;
}

/** An argument that runs something or writes, or null. */
function dangerous(argv: readonly string[]): string | null {
  const per = DANGEROUS[programOf(argv[0] ?? "").name];
  return argv.slice(1).find((a) => per?.test(a) || DANGEROUS_ANY.test(a)) ?? null;
}

export function matchCommand(
  lists: CommandLists,
  cmd: { argv: readonly string[]; shell: boolean },
  o: { where?: Where; groupTurns?: "grant" | "never" } = {},
): Match {
  const argv = cmd.argv;
  const why = opaque(argv, cmd.shell);
  const risky = dangerous(argv);
  // never: the command itself, or (what cannot be seen through, after -exec and the like) any command inside.
  const commands = why || risky ? commandsIn(argv) : [argv];
  const never = [...BUILTIN_NEVER, ...lists.never].map(entry).find((e) => commands.some((c) => subsequenceMatch(c, e)));
  if (never) return { tier: "never", why: never.text };
  if (o.where === "group" && o.groupTurns === "never") return { tier: "never", why: "group" };
  let m: Match;
  if (why) m = { tier: "grant", why };
  else {
    const known = programOf(argv[0] ?? "").known;
    const autos = known ? lists.auto.map(entry).filter((e) => prefixMatch(argv, e)) : [];
    const grants = lists.grant.map(entry).filter((e) => subsequenceMatch(argv, e));
    const best = (es: Entry[]) =>
      es.reduce<Entry | null>((b, e) => (!b || e.words.length > b.words.length ? e : b), null);
    const a = best(autos);
    const g = best(grants);
    if (g && (!a || g.words.length >= a.words.length)) m = { tier: "grant", why: g.text };
    else if (a) m = risky ? { tier: "grant", why: `${a.text} ${risky}` } : { tier: "auto", why: a.text };
    else m = { tier: lists.default, why: "default" };
  }
  if (m.tier === "auto" && o.where === "group") return { tier: "grant", why: "group" };
  return m;
}

/** An entry as the ceiling may write it, or why not. */
export function entryProblem(text: string): string | null {
  const t = text.trim();
  if (!t || t.length > 200) return "empty or longer than 200 characters";
  const words = t.split(/\s+/);
  if (words.length > 8) return "more than 8 words";
  const star = t.indexOf("*");
  if (star >= 0 && star !== t.length - 1) return "`*` only at the very end";
  return null;
}
