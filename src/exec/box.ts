/**
 * The Box (docs/exec.md, Linux / Box): what a call to a `runner: "bwrap"` node may do, checked before
 * anything is claimed, and the sandbox each one gets (src/exec/bwrap.ts runs it). Two presets:
 *
 * - `box`, one node for everyone: one directory per person, `<peopleRoot>/<actor uuid>/`, made by
 *   the deployment (never here: `not_found` when it is missing). A call names the person
 *   (`args.box.person`, which must be the person the turn serves, `origin.person`) and the tool
 *   (`args.box.tool`: name, version, git tree id, directory). Only that person's directory is
 *   mounted, as `/home/me`, and only that tool's version, read-only, as `/opt/tool`; no network.
 *   argv[0] is a bare entry name of the tool, run as `/opt/tool/bin/<entry>`; anything else never
 *   runs. The installed version's `.box-tool.json` must name the same tree (`tool_mismatch`).
 * - `box-install`, the install cell: no one's directory; argv is `["box-install", <step>]` and runs
 *   the image's own program (`/usr/lib/box/box-install`), never one found in PATH; what it installs
 *   comes in `args.box.install`. `install` and `lock` reach the network (`network: "open"`, only
 *   here), `smoke` and `commit` do not.
 * - Files move only in the sandbox too: `upload.v1` through the image's `box-put` (into the person's
 *   directory, or the install cell's `.incoming/`), `download.v1` through `box-get` (the person's
 *   directory, read-only). The collector never resolves a path inside anyone's directory itself.
 * - Paths LB sends are relative (`inbox/a.csv`): no leading `/` or `~`, no empty part, `.`, `..` or
 *   NUL, at most 512 bytes. A tool's argument that starts with `~` or has `=~` is refused
 *   (`use_relative_path`): `~` means nothing to the program it is handed to.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BOX_HOME, type Ceiling } from "./ceiling.ts";
import { type CallAnswer, type CallFrame, parseExecArgs, refuse, STDIN_MAX } from "./frames.ts";
import { DEADLINE_SLACK_MS } from "./grants.ts";

/**
 * Where the image puts this package's three helpers (src/exec/box/): `box-install`, `box-put`,
 * `box-get`. They run as `/usr/bin/python3 -I -S <helper>` inside the sandbox; /usr is in every
 * sandbox read-only, so they are there as they are on the image.
 */
export const BOX_LIB = "/usr/lib/box";
/** The interpreter the helpers run under; never one found in PATH. */
export const PYTHON = "/usr/bin/python3";
/** Where a run sees its tool (the version it asked for), read-only; the install cell's staging dir, writable. */
export const TOOL_DIR = "/opt/tool";
/** Where the install cell sees the tools volume for `commit`. */
export const TOOLS_DIR = "/srv/tools";
/** Where `install` sees the tar and `lock` its requirements, read-only. */
export const TAR_FILE = "/run/box/tool.tar";
export const REQUIREMENTS_FILE = "/run/box/requirements.in";
/** The largest file a download carries (the chat attachment limit). */
export const DOWNLOAD_MAX = 20 * 1024 * 1024;
/** A path LB sends, at most this many bytes. */
export const PATH_MAX = 512;
export const STEPS = ["install", "smoke", "commit", "lock"] as const;
export type Step = (typeof STEPS)[number];
/** The install cell's own directories under toolsRoot: uploads, and half-made versions. */
export const INCOMING = ".incoming";
export const STAGING = ".staging";
/** What every tmpfs gets at most (bwrap --size). */
export const TMPFS_BYTES = 512 * 1024 * 1024;

/**
 * The helpers' exit codes (src/exec/box/*: the same numbers) as an effect's `reason`; 0 is done, any
 * other unknown one `failed`. A transfer ends `failed` with one; a `box-install` step `done` with it
 * beside its exit code.
 */
export const HELPER_EXITS: Readonly<Record<number, string>> = {
  1: "error",
  2: "bad_request",
  3: "not_found",
  4: "exists",
  5: "path_denied",
  6: "too_large",
  7: "mismatch",
  8: "tree_mismatch",
  9: "smoke_failed",
  10: "install_failed",
  11: "bad_manifest",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const TREE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** An entry's name: what argv[0] says on the Box. */
const ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL_FILE_MAX = 64 * 1024;

/** Why a relative path LB sent does not pass (both sides check it), or null. */
export function pathProblem(p: unknown): string | null {
  if (typeof p !== "string" || !p) return "a path is needed";
  if (p.includes("\0")) return "a NUL in the path";
  if (Buffer.byteLength(p, "utf8") > PATH_MAX) return `longer than ${PATH_MAX} bytes`;
  if (p.startsWith("/") || p.startsWith("~")) return "a path relative to the person's directory, not / or ~";
  for (const part of p.split("/")) {
    if (!part) return "an empty part (// or a trailing /)";
    if (part === "." || part === "..") return `a "${part}" in the path`;
  }
  return null;
}

/** The first argument that names a path through `~`, or null. */
export function tildeArg(args: readonly string[]): string | null {
  return args.find((a) => a.startsWith("~") || a.includes("=~")) ?? null;
}

export interface ToolRef {
  name: string;
  version: string;
  tree: string;
  /** `<name>/<version>-<tree, first 12>`, under toolsRoot. */
  dir: string;
}

export interface InstallRef {
  step: Step;
  name: string;
  version: string;
  tree: string;
  tarSha256: string;
}

export const toolDirOf = (name: string, version: string, tree: string) => `${name}/${version}-${tree.slice(0, 12)}`;
export const stagingOf = (i: { name: string; version: string; tree: string }) =>
  `${i.name}-${i.version}-${i.tree.slice(0, 12)}`;

/** What `.box-tool.json` says of an installed version (box-install's `commit` writes it). */
export interface ToolFile {
  name: string;
  version: string;
  tree: string;
  tarSha256: string;
  entries: Record<string, string>;
  personDir: "rw" | "ro";
  installedAt: string;
}

/** A bind (read-only or not) or an empty tmpfs, at `dst` inside the sandbox. */
export type Mount = { kind: "ro" | "rw"; src: string; dst: string } | { kind: "tmpfs"; dst: string };

/** Everything a sandbox is, but the seccomp filter (the runner's, from the ceiling). */
export interface SandboxSpec {
  /** off: a network namespace of its own (loopback only); open: the node's (the install cell only). */
  network: "off" | "open";
  mounts: Mount[];
  /** The whole environment (bwrap --clearenv first). */
  env: Record<string, string>;
  /** Inside the sandbox. */
  cwd: string;
  /** Inside the sandbox, argv[0] absolute. */
  argv: string[];
}

export type Transfer =
  | { kind: "upload"; path: string; size: number; sha256: string }
  | { kind: "download"; path: string; max: number };

/** One admitted call as the bwrap runner takes it. */
export interface BoxJob {
  effectId: string;
  sandbox: SandboxSpec;
  stdin: string | null;
  /** A transfer: the helper's stdin is the upload's chunks, or its stdout the download's. */
  transfer: Transfer | null;
  /** The image's helpers (exit codes as HELPER_EXITS) or a tool's own exit code. */
  helper: boolean;
  /** On this machine's clock. */
  deadline: number;
  outputBytes: number;
  /** lock returns a requirements file, including its hashes, verbatim. */
  rawStdout?: boolean;
  /** Directories (outside the sandbox, on the tools volume) made if missing before the preflight. */
  ensure: string[];
  /** …and emptied once the effect is claimed, just before the run (install's staging directory). */
  reset: string[];
}

export interface BoxAdmission {
  job: Omit<BoxJob, "effectId" | "deadline">;
  /** The call's deadline on LB's clock, cut to the ceiling's longest run. */
  deadline: number;
  effective: { network: "off" | "proxy" | "open"; write: string[]; maxSeconds: number; outputBytes: number };
}

export interface BoxContext {
  ceiling: Ceiling;
  /** The owner LB named; null until then: nothing is admitted. */
  owner: string | null;
  lbNow: number;
  /** The collector's environment (LANG, TZ for runs). */
  env: Record<string, string | undefined>;
  /** Where the helpers are on this machine (default BOX_LIB); a test's checkout elsewhere is mounted there. */
  lib?: string;
}

type Admit = { ok: true; admission: BoxAdmission } | { ok: false; answer: CallAnswer };
const no = (a: CallAnswer): Admit => ({ ok: false, answer: a });

/** A directory that is one, not a symlink. */
function isDir(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

/** The installed version's `.box-tool.json`, or why it does not read. */
export function readToolFile(path: string): ToolFile | string {
  if (!isFile(path)) return "not installed";
  let v: unknown;
  try {
    const raw = readFileSync(path);
    if (raw.length > TOOL_FILE_MAX) return ".box-tool.json is too large";
    v = JSON.parse(raw.toString("utf8"));
  } catch {
    return ".box-tool.json does not read";
  }
  const t = v as Partial<ToolFile> | null;
  if (!t || typeof t !== "object") return ".box-tool.json does not read";
  const entries = t.entries;
  if (
    typeof t.name !== "string" ||
    typeof t.version !== "string" ||
    typeof t.tree !== "string" ||
    !entries ||
    typeof entries !== "object" ||
    Array.isArray(entries) ||
    (t.personDir !== "rw" && t.personDir !== "ro")
  )
    return ".box-tool.json lacks name, version, tree, entries or personDir";
  return t as ToolFile;
}

/** LANG and TZ for a run: the collector's, LB's within envPass, or C.UTF-8 and UTC. */
function baseEnv(c: Ceiling, requested: Record<string, string>, outer: Record<string, string | undefined>) {
  const pick = (n: string) => (c.envPass.includes(n) ? (requested[n] ?? outer[n]) : undefined);
  return { LANG: pick("LANG") || "C.UTF-8", TZ: pick("TZ") || "UTC" };
}

const helperArgv = (lib: string, helper: string, args: string[]) => [
  PYTHON,
  "-I",
  "-S",
  `${lib === BOX_LIB ? BOX_LIB : HELPER_MOUNT}/${helper}`,
  ...args,
];
/** Where the helpers are mounted when this machine keeps them elsewhere than BOX_LIB (tests). */
export const HELPER_MOUNT = "/run/box-lib";
const helperMount = (lib: string): Mount[] => (lib === BOX_LIB ? [] : [{ kind: "ro", src: lib, dst: HELPER_MOUNT }]);

function deadlineOf(
  call: CallFrame,
  ctx: BoxContext,
): { ok: true; deadline: number } | { ok: false; answer: CallAnswer } {
  const f = ctx.ceiling.file;
  const d = call.deadline as number;
  if (d <= ctx.lbNow) return { ok: false, answer: refuse("deadline_passed", "the deadline has passed") };
  if (d > ctx.lbNow + f.limits.maxSeconds * 1000 + DEADLINE_SLACK_MS)
    return {
      ok: false,
      answer: refuse("deadline_too_far", `this machine runs a command for at most ${f.limits.maxSeconds} s`),
    };
  return { ok: true, deadline: Math.min(d, ctx.lbNow + f.limits.maxSeconds * 1000) };
}

/** Who the call is for, where its turn is: the same for every op. */
function turnProblem(call: CallFrame, ctx: BoxContext): CallAnswer | null {
  const origin = call.origin;
  const f = ctx.ceiling.file;
  if (!origin || call.deadline === null) return refuse("bad_request", "an exec call needs its origin and deadline");
  if (!ctx.owner) return refuse("not_owner", "this node has no owner from LB yet");
  if (origin.where !== "dm") return refuse("never", "nothing runs here for a group turn");
  if (f.preset === "box-install" && origin.person !== ctx.owner)
    return refuse("not_owner", "the install cell takes calls from its owner only");
  if (!origin.attended && !f.unattended) return refuse("unattended", "not in an unattended turn");
  return null;
}

type BoxArg = { person: string; tool: ToolRef | null } | { staging: true } | { install: InstallRef };

/** `args.box` as LB sent it, or why it does not read. */
function parseBox(v: unknown): BoxArg | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "args.box is needed on the Box";
  const b = v as Record<string, unknown>;
  const keys = Object.keys(b).sort().join(",");
  if (keys === "staging") return b.staging === true ? { staging: true } : "box.staging must be true";
  if (keys === "install") {
    const i = b.install as Record<string, unknown> | null;
    if (!i || typeof i !== "object" || Array.isArray(i)) return "box.install must be an object";
    if (Object.keys(i).sort().join(",") !== "name,step,tarSha256,tree,version")
      return "box.install has step, name, version, tree and tarSha256, nothing else";
    if (!(STEPS as readonly unknown[]).includes(i.step)) return `box.install.step is one of ${STEPS.join(", ")}`;
    if (typeof i.name !== "string" || !NAME.test(i.name)) return "box.install.name: lower-case letters, digits, . _ -";
    if (typeof i.version !== "string" || !VERSION.test(i.version)) return "box.install.version: no / or spaces";
    if (typeof i.tree !== "string" || !TREE.test(i.tree)) return "box.install.tree: 40 or 64 hex digits";
    if (typeof i.tarSha256 !== "string" || !SHA256.test(i.tarSha256)) return "box.install.tarSha256: 64 hex digits";
    return {
      install: { step: i.step as Step, name: i.name, version: i.version, tree: i.tree, tarSha256: i.tarSha256 },
    };
  }
  if (keys !== "person" && keys !== "person,tool") return "args.box is {person, tool?}, {staging: true} or {install}";
  if (typeof b.person !== "string" || !UUID.test(b.person)) return "box.person: an actor uuid";
  if (b.tool === undefined) return { person: b.person, tool: null };
  const t = b.tool as Record<string, unknown> | null;
  if (!t || typeof t !== "object" || Array.isArray(t) || Object.keys(t).sort().join(",") !== "dir,name,tree,version")
    return "box.tool has name, version, tree and dir, nothing else";
  if (typeof t.name !== "string" || !NAME.test(t.name)) return "box.tool.name: lower-case letters, digits, . _ -";
  if (typeof t.version !== "string" || !VERSION.test(t.version)) return "box.tool.version: no / or spaces";
  if (typeof t.tree !== "string" || !TREE.test(t.tree)) return "box.tool.tree: 40 or 64 hex digits";
  if (t.dir !== toolDirOf(t.name, t.version, t.tree))
    return `box.tool.dir must be ${toolDirOf(t.name, t.version, t.tree)}`;
  return { person: b.person, tool: { name: t.name, version: t.version, tree: t.tree, dir: t.dir } };
}

/** The person's directory, checked: the call's person is the turn's, and the deployment made the directory. */
function personDir(
  person: string,
  call: CallFrame,
  ctx: BoxContext,
): { ok: true; dir: string } | { ok: false; answer: CallAnswer } {
  if (person !== call.origin?.person)
    return { ok: false, answer: refuse("not_owner", "box.person is not the person this turn is for") };
  const dir = join(ctx.ceiling.file.peopleRoot, person);
  if (!isDir(dir)) return { ok: false, answer: refuse("not_found", "this person has no directory on the Box yet") };
  return { ok: true, dir };
}

/**
 * exec.v1, upload.v1 or download.v1 on a `runner: "bwrap"` node (cancel.v1 is the executor's).
 * Checked in this order: the call reads, whose it is and where (owner, group, unattended), the
 * deadline, the box argument, what it asks for (network, writes, env, argv), the person's directory,
 * the installed tool.
 */
export function admitBox(call: CallFrame, ctx: BoxContext): Admit {
  const c = ctx.ceiling;
  const f = c.file;
  const lib = ctx.lib ?? BOX_LIB;
  const install = f.preset === "box-install";
  const turn = turnProblem(call, ctx);
  if (turn) return no(turn);
  const box = parseBox(call.args.box);
  if (typeof box === "string") return no(refuse("bad_request", box));
  const dl = deadlineOf(call, ctx);
  if (!dl.ok) return no(dl.answer);
  const limits = { maxSeconds: f.limits.maxSeconds, outputBytes: f.limits.outputBytes };
  const tmp: Mount = { kind: "tmpfs", dst: "/tmp" };
  if (call.op === "upload.v1" || call.op === "download.v1") {
    const upload = call.op === "upload.v1";
    const a = call.args;
    const want = upload ? "box,path,sha256,size" : "box,path";
    if (Object.keys(a).sort().join(",") !== want)
      return no(refuse("bad_request", `${call.op} takes ${want.split(",").join(", ")}, nothing else`));
    const bad = pathProblem(a.path);
    if (bad) return no(refuse("bad_request", `path: ${bad}`));
    const path = a.path as string;
    let dir: string;
    if ("staging" in box) {
      if (!install || !upload) return no(refuse("bad_request", "box.staging is for an upload to the install cell"));
      dir = join(f.toolsRoot, INCOMING);
    } else if ("person" in box) {
      if (install) return no(refuse("bad_request", "the install cell has no one's directory"));
      if (box.tool) return no(refuse("bad_request", "a transfer names the person only"));
      const p = personDir(box.person, call, ctx);
      if (!p.ok) return no(p.answer);
      dir = p.dir;
    } else return no(refuse("bad_request", "a transfer names box.person (or box.staging)"));
    let transfer: Transfer;
    let argv: string[];
    if (upload) {
      const { size, sha256 } = a;
      if (!Number.isSafeInteger(size) || (size as number) < 0) return no(refuse("bad_request", "size: bytes"));
      if (typeof sha256 !== "string" || !SHA256.test(sha256)) return no(refuse("bad_request", "sha256: 64 hex digits"));
      const staging = "staging" in box;
      const max = staging ? f.limits.fileBytes : Math.min(DOWNLOAD_MAX, f.limits.fileBytes);
      if ((size as number) > max) return no(refuse("too_large", `a file here is at most ${max} bytes`));
      if (staging && path !== `${sha256}.tar` && path !== `${sha256}.requirements.in`)
        return no(refuse("bad_request", "staging path is <sha256>.tar or <sha256>.requirements.in"));
      transfer = { kind: "upload", path, size: size as number, sha256 };
      argv = helperArgv(lib, "box-put", [
        ...(staging ? ["--content-addressed"] : []),
        "--root",
        BOX_HOME,
        path,
        String(size),
        sha256,
      ]);
    } else {
      const max = Math.min(DOWNLOAD_MAX, f.limits.fileBytes);
      transfer = { kind: "download", path, max };
      argv = helperArgv(lib, "box-get", ["--root", BOX_HOME, "--max", String(max), path]);
    }
    return {
      ok: true,
      admission: {
        deadline: dl.deadline,
        effective: { network: "off", write: upload ? ["~"] : [], ...limits },
        job: {
          sandbox: {
            network: "off",
            mounts: [{ kind: upload ? "rw" : "ro", src: dir, dst: BOX_HOME }, tmp, ...helperMount(lib)],
            env: { PATH: "/usr/bin", HOME: BOX_HOME, ...baseEnv(c, {}, ctx.env) },
            cwd: BOX_HOME,
            argv,
          },
          stdin: null,
          transfer,
          helper: true,
          outputBytes: f.limits.outputBytes,
          ensure: "staging" in box ? [dir] : [],
          reset: [],
        },
      },
    };
  }
  if (call.op !== "exec.v1") return no(refuse("unsupported", "this node does not do that"));
  const args = parseExecArgs(call.args);
  if (!args) return no(refuse("bad_request", "exec.v1 needs argv, cwd and policy"));
  if (args.stdin !== null && Buffer.byteLength(args.stdin, "utf8") > STDIN_MAX)
    return no(refuse("too_large", "stdin is larger than 64 KiB"));
  if (Object.keys(args.env).length) return no(refuse("over_ceiling", "Box calls take env {}"));
  if (args.shell) return no(refuse("never", "no shell on the Box: an installed tool's entry, or nothing"));
  const effective = { network: args.policy.network, write: [...args.policy.write].sort(), ...limits };
  if ("install" in box) {
    if (!install) return no(refuse("bad_request", "box.install is for the install cell"));
    const i = box.install;
    if (args.argv[0] !== "box-install") return no(refuse("never", "only box-install runs here"));
    if (args.argv.length !== 2 || args.argv[1] !== i.step)
      return no(refuse("bad_request", `argv is ["box-install", "${i.step}"]; the rest goes in box.install`));
    if (args.cwd !== "/") return no(refuse("bad_request", 'install cwd is "/"'));
    if (args.stdin !== null) return no(refuse("bad_request", "box-install takes no stdin"));
    if (args.policy.write.length)
      return no(refuse("over_ceiling", "box-install writes where its step says, nothing asked"));
    const online = i.step === "install" || i.step === "lock";
    if (args.policy.network === "proxy") return no(refuse("over_ceiling", "no proxy here"));
    if (!online && args.policy.network === "open")
      return no(refuse("over_ceiling", `${i.step} never reaches the network`));
    if (online && args.policy.network !== "open")
      return no(refuse("bad_request", `${i.step} fetches packages: policy.network "open"`));
    if (online && f.network !== "open") return no(refuse("over_ceiling", "this node has no network"));
    const incoming = join(f.toolsRoot, INCOMING);
    const staging = join(f.toolsRoot, STAGING, stagingOf(i));
    const ref = ["--name", i.name, "--version", i.version, "--tree", i.tree, "--tar-sha256", i.tarSha256];
    const home: Mount = { kind: "tmpfs", dst: BOX_HOME };
    let mounts: Mount[];
    let argv: string[];
    let ensure: string[] = [];
    let reset: string[] = [];
    if (i.step === "install") {
      const tar = join(incoming, `${i.tarSha256}.tar`);
      if (!isFile(tar)) return no(refuse("not_found", `no ${INCOMING}/${i.tarSha256}.tar: upload it first`));
      mounts = [
        { kind: "rw", src: staging, dst: TOOL_DIR },
        { kind: "ro", src: tar, dst: TAR_FILE },
      ];
      argv = helperArgv(lib, "box-install", ["install", ...ref, "--tool", TOOL_DIR, "--tar", TAR_FILE]);
      ensure = [staging];
      reset = [staging];
    } else if (i.step === "smoke") {
      if (!isDir(staging)) return no(refuse("not_found", "nothing installed to try: install first"));
      mounts = [{ kind: "ro", src: staging, dst: TOOL_DIR }];
      argv = helperArgv(lib, "box-install", ["smoke", ...ref, "--tool", TOOL_DIR]);
    } else if (i.step === "commit") {
      mounts = [{ kind: "rw", src: f.toolsRoot, dst: TOOLS_DIR }];
      argv = helperArgv(lib, "box-install", ["commit", ...ref, "--tools", TOOLS_DIR]);
    } else {
      const input = join(incoming, `${i.tarSha256}.requirements.in`);
      if (!isFile(input))
        return no(refuse("not_found", `no ${INCOMING}/${i.tarSha256}.requirements.in: upload it first`));
      mounts = [{ kind: "ro", src: input, dst: REQUIREMENTS_FILE }];
      argv = helperArgv(lib, "box-install", ["lock", ...ref, "--input", REQUIREMENTS_FILE]);
    }
    return {
      ok: true,
      admission: {
        deadline: dl.deadline,
        effective,
        job: {
          sandbox: {
            network: online ? "open" : "off",
            mounts: [...mounts, home, tmp, ...helperMount(lib)],
            env: { PATH: "/usr/local/bin:/usr/bin", HOME: BOX_HOME, ...baseEnv(c, args.env, ctx.env) },
            cwd: "/",
            argv,
          },
          stdin: null,
          transfer: null,
          helper: true,
          outputBytes: f.limits.outputBytes,
          rawStdout: i.step === "lock",
          ensure,
          reset,
        },
      },
    };
  }
  if (install) return no(refuse("bad_request", "the install cell runs box-install only (box.install)"));
  if ("staging" in box || !box.tool) return no(refuse("bad_request", "box.tool names what to run"));
  const tool = box.tool;
  if (args.policy.network !== "off") return no(refuse("over_ceiling", "nothing on the Box reaches the network"));
  const w = args.policy.write;
  if (w.length > 1 || (w.length === 1 && w[0] !== "~"))
    return no(refuse("over_ceiling", 'policy.write is ["~"] (the person\'s directory) or []'));
  const cwd = args.cwd === "~" ? "" : args.cwd.startsWith("~/") ? args.cwd.slice(2) : null;
  const cwdBad = cwd === null ? 'cwd is "~" or "~/<relative path>"' : args.cwd === "~" ? null : pathProblem(cwd);
  if (cwdBad) return no(refuse("bad_request", `cwd: ${cwdBad}`));
  const entry = args.argv[0] as string;
  if (!ENTRY.test(entry)) return no(refuse("never", "argv[0] is the name of an installed tool's entry"));
  const tilde = tildeArg(args.argv.slice(1));
  if (tilde !== null)
    return no(refuse("use_relative_path", `"${tilde.slice(0, 80)}": name files relative to the person's directory`));
  const p = personDir(box.person, call, ctx);
  if (!p.ok) return no(p.answer);
  const at = join(f.toolsRoot, tool.dir);
  if (!isDir(join(f.toolsRoot, tool.name)) || !isDir(at))
    return no(refuse("tool_mismatch", `${tool.name} ${tool.version} is not installed here`));
  const t = readToolFile(join(at, ".box-tool.json"));
  if (typeof t === "string") return no(refuse("tool_mismatch", `${tool.name} ${tool.version}: ${t}`));
  if (t.name !== tool.name || t.version !== tool.version || t.tree !== tool.tree)
    return no(
      refuse("tool_mismatch", `${tool.name} ${tool.version} here is another tree (${String(t.tree).slice(0, 12)})`),
    );
  if (!Object.hasOwn(t.entries, entry)) return no(refuse("never", `${entry} is not an entry of ${tool.name}`));
  if (w.length && t.personDir !== "rw")
    return no(refuse("over_ceiling", `${tool.name} only reads the person's directory`));
  if (!isFile(join(at, "bin", entry)))
    return no(refuse("tool_mismatch", `${tool.name} ${tool.version} has no bin/${entry}`));
  return {
    ok: true,
    admission: {
      deadline: dl.deadline,
      effective,
      job: {
        sandbox: {
          network: "off",
          mounts: [
            { kind: w.length ? "rw" : "ro", src: p.dir, dst: BOX_HOME },
            { kind: "ro", src: at, dst: TOOL_DIR },
            tmp,
          ],
          env: { PATH: `${TOOL_DIR}/bin:/usr/bin`, HOME: BOX_HOME, ...baseEnv(c, args.env, ctx.env) },
          cwd: cwd ? `${BOX_HOME}/${cwd}` : BOX_HOME,
          argv: [`${TOOL_DIR}/bin/${entry}`, ...args.argv.slice(1)],
        },
        stdin: args.stdin,
        transfer: null,
        helper: false,
        outputBytes: f.limits.outputBytes,
        ensure: [],
        reset: [],
      },
    },
  };
}
