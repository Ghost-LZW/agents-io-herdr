/**
 * The sandbox profile v3 (docs/exec.md N8, hardening and launchd). Everywhere: what the generated text holds
 * and in which order (denies after allows: the last matching rule decides), and the paths it refuses.
 * On macOS with AIH_SANDBOX_TESTS=1 only — they start real sandboxed processes, one launchd job of
 * their own (loaded and unloaded again) and listeners, all under /tmp: the probe's S checks, runs
 * through the same-user runner with the real sandbox, and the shim's deny of a marked directory.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runProbe } from "../src/exec/probe.ts";
import { SameUserRunner } from "../src/exec/run.ts";
import {
  buildProfile,
  gitHooksPaths,
  NEVER_EXEC,
  ProfileError,
  type ProfileInput,
  preflight,
  SANDBOX_EXEC,
  sbString,
} from "../src/exec/sandbox.ts";
import { shim } from "../src/exec/shim.ts";
import { CH_END, CH_STDOUT, FrameReader } from "../src/exec/wire.ts";
import { realExec } from "../src/system.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix = "/tmp/aih-sb-") {
  const d = realpathSync(mkdtempSync(prefix));
  dirs.push(d);
  return d;
}

const input = (over: Partial<ProfileInput> = {}): ProfileInput => ({
  home: "/Users/someone",
  read: ["/Users/someone/repos/app"],
  write: ["/Users/someone/repos/app/build"],
  own: ["/private/tmp/run/home", "/private/tmp/run/tmp"],
  deny: [],
  private: [],
  noWrite: [],
  network: "off",
  proxyPort: null,
  ...over,
});

describe("profile v3", () => {
  it("deny by default; process info only about itself; sysctl from a list; no mach; the fcntls", () => {
    const p = buildProfile(input());
    const lines = p.split("\n");
    expect(lines.slice(0, 2)).toEqual(["(version 1)", "(deny default)"]);
    // The explicit deny comes before the narrow allow (hardening #5).
    expect(p.indexOf("(deny process-info*)")).toBeLessThan(p.indexOf("(allow process-info* (target self))"));
    expect(p).not.toContain("same-sandbox)\n(allow process-info");
    expect(p).toContain("(allow signal (target same-sandbox))");
    expect(p).toContain('(sysctl-name "hw.ncpu")');
    expect(p).toContain('(sysctl-name-prefix "kern.proc.pid.")');
    expect(p).not.toMatch(/\(allow sysctl-read\)/);
    expect(p).toContain("(deny system-fcntl (fcntl-command 80 110))");
    expect(p).toContain('(deny mach-lookup (xpc-service-name-prefix ""))');
    expect(p).not.toMatch(/allow mach-lookup|allow job-creation|allow network/);
  });

  it("Homebrew's programs only, not etc or var; the roots and the run's own directories", () => {
    const p = buildProfile(input());
    for (const d of ["bin", "opt", "Cellar", "lib", "Frameworks"])
      expect(p).toContain(`(subpath "/opt/homebrew/${d}")`);
    expect(p).not.toContain('"/opt/homebrew"');
    expect(p).not.toContain("/opt/homebrew/etc");
    expect(p).not.toContain("/opt/homebrew/var");
    const reads = p.slice(p.indexOf("(allow file-read*"), p.indexOf("(allow file-write*"));
    for (const d of ["/Users/someone/repos/app", "/Users/someone/repos/app/build", "/private/tmp/run/tmp"])
      expect(reads).toContain(`(subpath "${d}")`);
    const writes = p.slice(p.indexOf("(allow file-write*"), p.indexOf("(allow file-write-data"));
    expect(writes).toContain('(subpath "/Users/someone/repos/app/build")');
    expect(writes).toContain('(subpath "/private/tmp/run/home")');
    expect(writes).not.toContain('(subpath "/Users/someone/repos/app")');
  });

  it("denies come last: deny lists, .git itself, start-up files, launchctl/open/osascript and writable directories never execute", () => {
    const p = buildProfile(
      input({
        deny: ["*.secret", "/Users/someone/repos/app/vault"],
        private: ["/Users/someone/repos/app/keep"],
        noWrite: ["/Users/someone/hooks"],
      }),
    );
    const lastAllow = p.lastIndexOf("(allow ");
    for (const d of ["(deny file-read* file-write*", "(deny file-write*", "(deny process-exec"])
      expect(p.indexOf(d)).toBeGreaterThan(lastAllow);
    expect(p).toContain(String.raw`(regex #"^/Users/someone/\.[sS][sS][hH](/|$)")`);
    expect(p).toContain(String.raw`(regex #"/\.[eE][nN][vV][^/]*(/|$)")`);
    expect(p).toContain(String.raw`(regex #"/[^/]*\.[sS][eE][cC][rR][eE][tT](/|$)")`);
    expect(p).toContain(
      '(regex #"^/[uU][sS][eE][rR][sS]/[sS][oO][mM][eE][oO][nN][eE]/[rR][eE][pP][oO][sS]/[aA][pP][pP]/[vV][aA][uU][lL][tT](/|$)")',
    );
    expect(p).toContain('(subpath "/Users/someone/repos/app/keep")');
    expect(p).toContain(String.raw`(regex #"/\.[gG][iI][tT]$")`);
    expect(p).toContain(
      String.raw`(regex #"/\.[gG][iI][tT]/[wW][oO][rR][kK][tT][rR][eE][eE][sS]/[^/]+/[cC][oO][nN][fF][iI][gG]$")`,
    );
    expect(p).toContain(
      '(regex #"^/Users/someone/[lL][iI][bB][rR][aA][rR][yY]/[lL][aA][uU][nN][cC][hH][aA][gG][eE][nN][tT][sS](/|$)")',
    );
    expect(p).toContain('(subpath "/Users/someone/hooks")');
    const exec = p.slice(p.indexOf("(deny process-exec"));
    for (const x of NEVER_EXEC) expect(exec).toContain(`(literal "${x}")`);
    for (const d of ["/Users/someone/repos/app/build", "/private/tmp/run/tmp", "/private/tmp", "/private/var/folders"])
      expect(exec).toContain(`(subpath "${d}")`);
    expect(exec).not.toContain('(subpath "/Users/someone/repos/app")\n');
  });

  it("network: off is nothing; proxy is only the proxy's port", () => {
    expect(buildProfile(input())).not.toContain("network-outbound");
    const p = buildProfile(input({ network: "proxy", proxyPort: 18080 }));
    expect(p).toContain('(allow network-outbound (remote ip "localhost:18080"))');
    expect(p).not.toContain("system-socket");
    expect(() => buildProfile(input({ network: "proxy", proxyPort: null }))).toThrow(ProfileError);
  });

  it("paths that would need escaping are refused, not escaped", () => {
    expect(sbString("/a/b c")).toBe('"/a/b c"');
    for (const bad of ['/a/"b', "/a\\b", "/a\nb", "relative"]) expect(() => sbString(bad)).toThrow(ProfileError);
    expect(() => buildProfile(input({ read: ['/x/"y'] }))).toThrow(ProfileError);
    expect(() => buildProfile(input({ home: '/Users/"x' }))).toThrow(ProfileError);
  });

  it("git's core.hooksPath, from the user's and the repository's config, never by running git", () => {
    const d = temp();
    const home = join(d, "home");
    const repo = join(d, "roots", "app");
    mkdirSync(join(home, ".config", "git"), { recursive: true });
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = x\n[core]\n\thooksPath = ~/githooks\n");
    writeFileSync(join(home, ".config", "git", "config"), "[core]\n  hookspath = /etc/hooks ; a comment\n");
    writeFileSync(
      join(repo, ".git", "config"),
      '[core]\n\tbare = false\n\thooksPath = ".husky/_"\n[alias]\n\thooksPath = no\n',
    );
    const got = gitHooksPaths(home, join(repo, "src"), (dir) => dir === repo);
    expect(got.sort()).toEqual([join(home, "githooks"), join(repo, ".husky/_"), "/etc/hooks"].sort());
  });

  it("preflight: null when /usr/bin/true ran, else why", async () => {
    expect(await preflight("/p.sb", { spawn: async () => ({ code: 0 }) })).toBeNull();
    expect(await preflight("/p.sb", { spawn: async () => ({ code: 65 }) })).toContain("exit 65");
    expect(await preflight("/p.sb", { spawn: async () => ({ code: null }) })).toContain("could not be started");
  });
});

const real = process.platform === "darwin" && process.env.AIH_SANDBOX_TESTS === "1";

describe.runIf(real)("the real sandbox (macOS, AIH_SANDBOX_TESTS=1)", () => {
  it("the probe: S1–S7, S6 with a launchd job of its own", { timeout: 120_000 }, async () => {
    const base = join(temp(), "probe");
    // This user stands in for the owner: S7 counts its processes on their own.
    const ownerUid = process.getuid?.() ?? null;
    const results = await runProbe({ base, sandboxExec: SANDBOX_EXEC, exec: realExec, launchd: true, ownerUid });
    const failed = results.filter((r) => !r.ok);
    expect(failed).toEqual([]);
    const ids = new Set(results.map((r) => r.id));
    for (const id of ["S1", "S1b", "S2", "S2b", "S2c", "S3", "S3b", "S4", "S5", "S6", "S7"]) expect(ids).toContain(id);
    // Started from inside: nothing; from outside, the same job does start (the control).
    expect(results.find((r) => r.what.startsWith("launchd: kickstart"))?.detail).toBe("from outside it does");
    if (results.some((r) => r.id === "S7" && !r.detail?.startsWith("skipped")))
      expect(results.find((r) => r.what.startsWith("the owner's processes"))?.detail).toMatch(
        /^0 readable inside, \d+ outside, of [1-9]/,
      );
  });

  it("a run through the same-user runner: its own HOME, decoys unreadable, writes only in its write root", async () => {
    const d = temp();
    const home = join(d, "home");
    const app = join(home, "repos", "app");
    mkdirSync(join(app, "build"), { recursive: true });
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_ed25519"), "decoy\n");
    writeFileSync(join(app, "f.txt"), "token=abcdefghijklmnopq\n");
    const runner = new SameUserRunner({ now: Date.now, log: () => undefined, exec: realExec, base: join(d, "runs") });
    const plan = (argv: string[], effectId: string) => ({
      effectId,
      argv,
      cwd: app,
      env: { PATH: "/usr/bin:/bin", TERM: "dumb" },
      path: "/usr/bin:/bin",
      stdin: null,
      deadline: Date.now() + 20_000,
      outputBytes: 4096,
      profile: {
        home,
        read: [app],
        write: [join(app, "build")],
        deny: [],
        private: [],
        noWrite: [],
        network: "off" as const,
        proxyPort: null,
      },
      roots: { read: [app], write: [join(app, "build")] },
      home: null,
    });
    const go = async (argv: string[], id: string) => {
      const p = await runner.prepare(plan(argv, id));
      if (!p.ok) throw new Error(p.message);
      return p.prepared.start().done;
    };
    const ok = await go(
      [
        "/bin/sh",
        "-c",
        `cat f.txt; echo "$HOME"; touch build/out && echo wrote; cat ${home}/.ssh/id_ed25519 || echo nope; touch x || echo ro`,
      ],
      "eff_real1",
    );
    expect(ok.state).toBe("done");
    expect(ok.stdout).toContain("token=[REDACTED]");
    // HOME is the run's own directory: the effect id and a suffix of its own.
    expect(ok.stdout).toContain(`${join(realpathSync(join(d, "runs")), "eff_real1.")}`);
    expect(ok.stdout).toMatch(/\/eff_real1\.[0-9a-f]{8}\/home\n/);
    expect(ok.stdout).toContain("wrote\nnope\nro\n");
    // launchctl never starts.
    const lc = await go(["/bin/launchctl", "list"], "eff_real2");
    expect(lc).toMatchObject({ state: "done", exit: 71 });
    // A profile that cannot be written is refused before anything is claimed.
    const bad = await runner.prepare({
      ...plan(["/usr/bin/true"], "eff_real3"),
      cwd: app,
      profile: { ...plan([], "x").profile, read: ['/x/"y'] },
    });
    expect(bad).toMatchObject({ ok: false, code: "sandbox_unavailable" });
  });

  it("the dedicated user's shim: a directory marked .exec-private under its roots is unreadable in the run", async () => {
    const d = temp();
    const home = join(d, "agent");
    const work = join(home, "work");
    mkdirSync(join(work, "app"), { recursive: true });
    mkdirSync(join(work, "keep"), { recursive: true });
    mkdirSync(join(home, "exec"), { recursive: true });
    writeFileSync(join(work, "app", "f.txt"), "open\n");
    writeFileSync(join(work, "keep", "f.txt"), "kept\n");
    writeFileSync(join(work, "keep", ".exec-private"), "");
    const tmp = join(home, "exec", "eff_priv1", "tmp");
    const profile = buildProfile({ ...input({ home, read: [work], write: [], own: [tmp] }) });
    const spec = {
      effect: "eff_priv1",
      argv: ["/bin/sh", "-c", "cat app/f.txt; cat keep/f.txt || echo nope; ls keep || echo nolist"],
      cwd: work,
      env: { PATH: "/usr/bin:/bin", TERM: "dumb" },
      home: work,
      tmp,
      profile,
      roots: { read: [work], write: [] },
      stdinBytes: 0,
      deadline: Date.now() + 20_000,
      outputBytes: 4096,
    };
    const stdin = new PassThrough();
    const out: Buffer[] = [];
    stdin.write(`${JSON.stringify(spec)}\n`);
    const code = await shim({
      command: "run",
      stdin,
      out: (b) => out.push(b),
      err: () => undefined,
      now: Date.now,
      uid: process.getuid?.() ?? 501,
      home,
      pid: process.pid,
      exec: realExec,
      interlock: () => null,
      graceMs: 300,
    });
    stdin.end();
    expect(code).toBe(0);
    const frames = new FrameReader(4096).push(Buffer.concat(out));
    const text = Buffer.concat(frames.filter((f) => f.ch === CH_STDOUT).map((f) => f.data)).toString();
    expect(JSON.parse(frames.find((f) => f.ch === CH_END)?.data.toString() ?? "null")).toMatchObject({ state: "done" });
    expect(text).toBe("open\nnope\nnolist\n");
  });
});
