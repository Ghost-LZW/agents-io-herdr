/**
 * The ceiling file v2 (docs/exec.md N2; acceptance case 5): who may write it, unknown and removed
 * keys, roots listed one by one (broad ones only when acknowledged), the deny lists, the name scan
 * and the `.exec-private` marker, the request's policy against it, the command tiers (dangerous
 * arguments and group turns ask), the summary hello carries, and reading it again when it changes.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Ceiling,
  CeilingSource,
  capsFor,
  intersect,
  loadCeiling,
  parseCeiling,
  preset,
  resolveCeiling,
  summary,
} from "../src/exec/ceiling.ts";
import { type CommandLists, matchCommand } from "../src/exec/commands.ts";
import { readDenied, scanRoots, writeDenied } from "../src/exec/deny.ts";
import type { ExecArgs } from "../src/exec/frames.ts";
import { execPaths } from "../src/exec/paths.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp() {
  const d = mkdtempSync(join(tmpdir(), "aio-herdr-ceil-"));
  dirs.push(d);
  const home = join(d, "home");
  const conf = join(home, ".config", "agents-io-herdr");
  mkdirSync(conf, { recursive: true, mode: 0o700 });
  return { d, home, conf, paths: execPaths(conf) };
}

function write(path: string, v: unknown, mode = 0o600) {
  writeFileSync(path, typeof v === "string" ? v : `${JSON.stringify(v, null, 2)}\n`, { mode });
  chmodSync(path, mode);
}

/** A ceiling for a person's own computer with the given changes, resolved against `home`. */
function ceiling(home: string, over: Record<string, unknown> = {}): Ceiling {
  const raw = JSON.stringify({ version: 2, runner: "same", ...over });
  const p = parseCeiling(raw);
  if (!p.ok) throw new Error(p.problems.join("; "));
  const r = resolveCeiling(p.file, { raw, home });
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.ceiling;
}

const problems = (home: string, over: Record<string, unknown>) => {
  const raw = JSON.stringify({ version: 2, ...over });
  const p = parseCeiling(raw);
  if (!p.ok) return p.problems;
  const r = resolveCeiling(p.file, { raw, home });
  return r.ok ? [] : r.problems;
};

const args = (over: Partial<ExecArgs> = {}): ExecArgs => ({
  argv: ["git", "status"],
  cwd: "~/repos/app",
  shell: false,
  stdin: null,
  env: {},
  policy: { network: "off", write: [] },
  ...over,
});

describe("loading the ceiling file", () => {
  it("wants this user's plain 0600 file in a directory no one else writes; none means no_ceiling", () => {
    const t = temp();
    const load = (uid?: number) => loadCeiling(t.paths.ceiling, { home: t.home, uid });
    expect(load()).toMatchObject({ ok: false, reason: "no_ceiling" });
    write(t.paths.ceiling, preset("personal-readonly"));
    expect(load()).toMatchObject({ ok: true });
    chmodSync(t.paths.ceiling, 0o644);
    expect(load()).toMatchObject({
      ok: false,
      reason: "bad_ceiling",
      problems: [expect.stringContaining("chmod 600")],
    });
    chmodSync(t.paths.ceiling, 0o600);
    expect(load((process.getuid?.() ?? 0) + 1)).toMatchObject({
      ok: false,
      problems: [expect.stringContaining("another user")],
    });
    chmodSync(t.conf, 0o777);
    expect(load()).toMatchObject({ ok: false, problems: [expect.stringContaining("others can write")] });
    chmodSync(t.conf, 0o700);
    const real = join(t.d, "elsewhere.json");
    write(real, preset("personal-readonly"));
    rmSync(t.paths.ceiling);
    symlinkSync(real, t.paths.ceiling);
    expect(load()).toMatchObject({ ok: false, problems: [expect.stringContaining("symlink")] });
  });

  it("refuses what does not read: not JSON, version 1, unknown keys, and the keys v2 removed (I-5)", () => {
    const t = temp();
    write(t.paths.ceiling, "{ not json");
    expect(loadCeiling(t.paths.ceiling, { home: t.home })).toMatchObject({ ok: false, reason: "bad_ceiling" });
    expect(parseCeiling(JSON.stringify({ version: 1, network: true }))).toEqual({
      ok: false,
      problems: [expect.stringContaining("version 1")],
    });
    const bad = (over: Record<string, unknown>) => {
      const p = parseCeiling(JSON.stringify({ version: 2, ...over }));
      return p.ok ? [] : p.problems;
    };
    expect(bad({ sudo: "grant" })).toEqual(["sudo: unknown key"]);
    expect(bad({ network: true })).toEqual(["network: one of off, proxy, open"]);
    expect(bad({ gitIdentity: { name: "A", email: "a@example.com" } })).toEqual(["gitIdentity.email: unknown key"]);
    expect(bad({ limits: { maxSeconds: 0, outputs: 1 } })).toEqual([
      "limits.outputs: unknown key",
      "limits.maxSeconds: a whole number from 1 to 7200",
    ]);
    expect(bad({ commands: { auto: ["git *status"] } })).toEqual([
      'commands.auto "git *status": `*` only at the very end',
    ]);
    expect(bad({ grants: { maxMinutes: 60 } })).toEqual(["grants.maxMinutes: a whole number from 1 to 30"]);
    // Keys left out are the narrow defaults.
    const p = parseCeiling(JSON.stringify({ version: 2 }));
    expect(p.ok && p.file).toMatchObject({
      exec: "on",
      runner: "same",
      commands: { default: "grant" },
      network: "off",
      write: [],
      unattended: false,
      agents: "never",
    });
  });

  it("the two presets load; agent-user runs as the named user, personal-readonly starts with exec off", () => {
    const t = temp();
    write(t.paths.ceiling, preset("agent-user", { user: "agent" }));
    const a = loadCeiling(t.paths.ceiling, { home: t.home });
    expect(a.ok && a.ceiling).toMatchObject({
      home: "/Users/agent",
      read: ["/Users/agent/work"],
      write: ["/Users/agent/work"],
      cache: ["/Users/agent/work/.cache"],
      file: { exec: "on", runner: "user", network: "off", unattended: true, agents: "never" },
    });
    expect(() => preset("agent-user")).toThrow(/--user/);
    write(t.paths.ceiling, preset("personal-readonly"));
    const b = loadCeiling(t.paths.ceiling, { home: t.home });
    expect(b.ok && b.ceiling.file).toMatchObject({
      exec: "off",
      runner: "same",
      agents: "grant",
      agentWorkspace: "delegated",
      agentCommand: "claude",
      read: { roots: [] },
    });
    // Neither preset names a machine or a person: the only user in them is the one given, no address.
    const text = JSON.stringify([preset("agent-user", { user: "agent" }), preset("personal-readonly")]);
    expect(new Set(text.match(/\/Users\/[^/"]+/g))).toEqual(new Set(["/Users/agent"]));
    expect(text).not.toMatch(/@/);
  });

  it("roots one by one: home, above it, a top-level directory and ~/repos-like ones need acknowledging", () => {
    const { home } = temp();
    for (const root of ["~", "~/repos", "~/Downloads", "/", "/Users", home.split("/").slice(0, 2).join("/")])
      expect(problems(home, { read: { roots: [root] } }), root).toEqual([
        expect.stringContaining("covers a whole area"),
      ]);
    expect(problems(home, { read: { roots: ["~/repos"] }, acknowledged: ["~/repos"] })).toEqual([]);
    expect(problems(home, { read: { roots: ["~/repos/app", "~/.local/share/x"] } })).toEqual([]);
    expect(problems(home, { write: ["~/Downloads"] })).toEqual([expect.stringContaining("covers a whole area")]);
    // A dedicated user's ~/work is its own; its home is still too much.
    const user = { runner: "user", user: { name: "agent", home: "/Users/agent" } };
    expect(problems(home, { ...user, read: { roots: ["~/work"] } })).toEqual([]);
    expect(problems(home, { ...user, read: { roots: ["~"] } })).toEqual([expect.stringContaining("whole area")]);
  });

  it("refuses roots in denied places, write roots in never-writable ones, caches outside the write roots", () => {
    const { home } = temp();
    expect(problems(home, { read: { roots: ["~/.config/gh"] } })).toEqual([
      expect.stringContaining("never readable (~/.config/gh)"),
    ]);
    expect(problems(home, { read: { roots: ["~/repos/app/.env.local"] } })).toEqual([
      expect.stringContaining("(.env*)"),
    ]);
    expect(problems(home, { write: ["~/repos/app/.git"] })).toEqual([expect.stringContaining("never writable")]);
    expect(problems(home, { write: ["~/Library/LaunchAgents/x"] })).toEqual([
      expect.stringContaining("never writable"),
    ]);
    expect(problems(home, { write: ["~/repos/app"], cacheDirs: ["~/repos/cache"] })).toEqual([
      expect.stringContaining("not inside a write root"),
    ]);
    expect(problems(home, { network: "proxy" })).toEqual([expect.stringContaining("proxy.port")]);
    expect(problems(home, { runner: "user" })).toEqual([expect.stringContaining("needs user.name")]);
    // envPass: a secret-looking name is dropped, not an error.
    const c = ceiling(home, { envPass: ["PATH", "GH_TOKEN", "SSH_AUTH_SOCK", "LANG"] });
    expect(c.envPass).toEqual(["PATH", "LANG"]);
    expect(c.notes.join()).toContain("GH_TOKEN, SSH_AUTH_SOCK");
  });
});

describe("deny lists", () => {
  it("names in any directory, places under the runner's home, the ceiling's own additions; case ignored", () => {
    const home = "/Users/x";
    expect(readDenied("/Users/x/repos/infra/terraform.tfstate.backup", home)).toBe("*.tfstate*");
    expect(readDenied("/Users/x/repos/infra/.terraform/providers", home)).toBe(".terraform");
    expect(readDenied("/Users/x/repos/k8s/prod.KUBECONFIG", home)).toBe("*kubeconfig*");
    expect(readDenied("/Users/x/repos/app/secrets/db.yaml", home)).toBe("secrets*");
    expect(readDenied("/Users/x/repos/app/vault.age", home)).toBe("*.age");
    expect(readDenied("/Users/x/.config/gcloud/creds.db", home)).toBe("~/.config/gcloud");
    expect(readDenied("/Users/x/.config/some-tool/token.json", home)).toBe("~/.config/*/token*");
    expect(readDenied("/Users/x/.cargo/credentials.toml", home)).toBe("~/.cargo/credentials*");
    expect(readDenied("/Users/x/repos/app/src/main.ts", home)).toBeNull();
    expect(readDenied("/Users/x/repos/app/notes/plan.md", home, ["/Users/x/repos/app/notes"])).toBe(
      "/Users/x/repos/app/notes",
    );
    expect(readDenied("/Users/x/repos/app/x.ledger", home, ["*.ledger"])).toBe("*.ledger");
    expect(writeDenied("/Users/x/repos/app/.git/hooks/pre-commit", home)).not.toBeNull();
    expect(writeDenied("/Users/x/repos/app/CLAUDE.md", home)).not.toBeNull();
    expect(writeDenied("/Users/x/.zshenv", home)).toBe("~/.zshenv");
    expect(writeDenied("/Users/x/repos/app/.git/objects/ab", home)).toBeNull();
  });

  it("the name scan finds credentials and marked directories, never goes into node_modules, symlinks or hits", () => {
    const { d, home } = temp();
    const root = join(home, "repos", "app");
    for (const p of ["src", "infra/.terraform", "node_modules/pkg", "data/inbox"])
      mkdirSync(join(root, p), { recursive: true });
    for (const f of ["src/main.ts", ".env", "infra/terraform.tfstate", "infra/.terraform/x", "node_modules/pkg/.env"])
      writeFileSync(join(root, f), "x");
    writeFileSync(join(root, "data", ".exec-private"), "");
    writeFileSync(join(root, "data", "inbox", "statement.csv"), "x");
    mkdirSync(join(d, "outside"));
    writeFileSync(join(d, "outside", "id_rsa"), "x");
    symlinkSync(join(d, "outside"), join(root, "link"));
    const s = scanRoots([root], { home });
    expect(s.hits.map((h) => [h.path.slice(root.length + 1), h.why]).sort()).toEqual([
      [".env", ".env*"],
      ["data", "private"],
      ["infra/.terraform", ".terraform"],
      ["infra/terraform.tfstate", "*.tfstate*"],
    ]);
    expect(s.truncated).toBe(false);
    expect(scanRoots([root], { home, maxEntries: 3 }).truncated).toBe(true);
    expect(scanRoots([root], { home, skip: [join(root, "data")] }).hits.map((h) => h.why)).not.toContain("private");
  });

  it("a second collector's directory (not the default one) is as unreadable as the default", () => {
    const { home } = temp();
    const second = join(home, ".config", "agents-io-herdr-staging");
    mkdirSync(join(home, "repos"), { recursive: true });
    mkdirSync(second, { mode: 0o700 });
    chmodSync(second, 0o700);
    const p = execPaths(second);
    write(p.ceiling, { version: 2, read: { roots: [second] } });
    expect(loadCeiling(p.ceiling, { home })).toMatchObject({
      ok: false,
      problems: [expect.stringContaining("never readable")],
    });
    write(p.ceiling, { version: 2, read: { roots: ["~/.config"] }, acknowledged: ["~/.config"] });
    const l = loadCeiling(p.ceiling, { home });
    if (!l.ok) throw new Error(l.problems.join("; "));
    expect(l.ceiling.deny).toContain(second);
    expect(intersect(l.ceiling, args({ cwd: "~/.config/agents-io-herdr-staging/exec" }))).toMatchObject({
      ok: false,
      code: "path_denied",
    });
    expect(scanRoots(l.ceiling.read, { home, extra: l.ceiling.deny }).hits).toContainEqual({
      path: second,
      why: second,
    });
  });
});

describe("a request against the ceiling", () => {
  it("takes what fits and says what is in effect; refuses wider writes and network, and cwd outside (I-5)", () => {
    const { home } = temp();
    const c = ceiling(home, {
      read: { roots: ["~/repos/app", "~/repos/lib"] },
      write: ["~/repos/app/build"],
      limits: { maxSeconds: 300, outputBytes: 4096 },
    });
    const ok = intersect(
      c,
      args({ policy: { network: "off", write: ["~/repos/app/build/out", "~/repos/app/build"] } }),
    );
    expect(ok).toEqual({
      ok: true,
      cwd: `${home}/repos/app`,
      write: [`${home}/repos/app/build/out`, `${home}/repos/app/build`],
      widened: [],
      effective: {
        network: "off",
        write: ["~/repos/app/build", "~/repos/app/build/out"],
        maxSeconds: 300,
        outputBytes: 4096,
      },
    });
    expect(intersect(c, args({ policy: { network: "off", write: ["~/repos/lib"] } }))).toMatchObject({
      ok: false,
      code: "over_ceiling",
    });
    expect(intersect(c, args({ policy: { network: "proxy", write: [] } }))).toMatchObject({ code: "over_ceiling" });
    expect(intersect(c, args({ cwd: "~/repos/other" }))).toMatchObject({ code: "path_outside" });
    expect(intersect(c, args({ cwd: "~/repos/app/../../.ssh" }))).toMatchObject({ code: "path_outside" });
    expect(intersect(c, args({ cwd: "repos/app" }))).toMatchObject({ code: "bad_request" });
    expect(intersect(c, args({ cwd: "~/repos/app/.env.d" }))).toMatchObject({ code: "path_denied" });
    expect(intersect(c, args({ policy: { network: "off", write: ["~/repos/app/build/.git"] } }))).toMatchObject({
      code: "path_denied",
    });
    expect(intersect(c, args({ env: { TERM: "dumb", LC_ALL: "C" } }))).toMatchObject({
      code: "over_ceiling",
      message: "env LC_ALL is not passed here",
    });
  });

  it("widenOnGrant: beyond the ceiling but inside it, the run is marked as widening (it needs a grant)", () => {
    const { home } = temp();
    const c = ceiling(home, {
      read: { roots: ["~/repos/app"] },
      network: "off",
      proxy: { port: 18_080, allow: ["registry.npmjs.org"] },
      widenOnGrant: { network: "proxy", write: ["~/repos/app"] },
    });
    expect(intersect(c, args({ policy: { network: "proxy", write: ["~/repos/app/dist"] } }))).toMatchObject({
      ok: true,
      widened: ["write ~/repos/app/dist", "network proxy"],
    });
  });

  it("a directory marked .exec-private is never readable or writable, whole (I-5)", () => {
    const { home } = temp();
    const root = join(home, "repos", "app");
    mkdirSync(join(root, "data", "inbox"), { recursive: true });
    writeFileSync(join(root, "data", ".exec-private"), "");
    const c = ceiling(home, { read: { roots: ["~/repos/app"] }, write: ["~/repos/app"] });
    expect(intersect(c, args({ cwd: "~/repos/app/data/inbox" }))).toMatchObject({ code: "path_denied" });
    expect(intersect(c, args({ policy: { network: "off", write: ["~/repos/app/data"] } }))).toMatchObject({
      code: "path_denied",
    });
    expect(intersect(c, args())).toMatchObject({ ok: true });
  });
});

describe("command tiers", () => {
  const personal: CommandLists = {
    default: "grant",
    auto: ["ls", "cat", "rg", "find", "sort", "git status", "git log", "git diff"],
    grant: [],
    never: ["security", "defaults write"],
  };
  const agent: CommandLists = {
    default: "auto",
    auto: [],
    grant: ["git push --force*", "rm -rf", "diskutil erase*"],
    never: ["security"],
  };
  const tier = (l: CommandLists, argv: string[], o: Parameters<typeof matchCommand>[2] = {}, shell = false) =>
    matchCommand(l, { argv, shell }, o);

  it("auto by prefix, grant by subsequence, the longest entry wins, the default otherwise", () => {
    expect(tier(personal, ["git", "status", "--short"])).toEqual({ tier: "auto", why: "git status" });
    expect(tier(personal, ["git", "push"])).toEqual({ tier: "grant", why: "default" });
    expect(tier(personal, ["/usr/bin/git", "log", "-3"])).toEqual({ tier: "auto", why: "git log" });
    // A path outside the usual bin directories is not the program it is named after.
    expect(tier(personal, ["./git", "status"])).toEqual({ tier: "grant", why: "default" });
    expect(tier(agent, ["git", "-C", "x", "push", "origin", "--force-with-lease"]).tier).toBe("grant");
    expect(tier(agent, ["diskutil", "eraseDisk", "x"])).toEqual({ tier: "grant", why: "diskutil erase*" });
    expect(tier(agent, ["python3", "build.py"])).toEqual({ tier: "auto", why: "default" });
  });

  it("never wins: the built-in ones and the ceiling's, also inside a shell or after a launcher", () => {
    expect(tier(agent, ["sudo", "ls"])).toEqual({ tier: "never", why: "sudo" });
    expect(tier(agent, ["/usr/bin/open", "-a", "Terminal"])).toEqual({ tier: "never", why: "open" });
    expect(tier(agent, ["launchctl", "kickstart", "gui/501/x"]).tier).toBe("never");
    expect(tier(personal, ["defaults", "-currentHost", "write", "x"]).tier).toBe("never");
    expect(tier(agent, ["env", "A=1", "sudo", "id"])).toEqual({ tier: "never", why: "sudo" });
    expect(tier(agent, ["/bin/sh", "-c", "cd x && security find-generic-password -s y"], {}, true).tier).toBe("never");
    expect(tier(agent, ["xargs", "-n", "1", "osascript"]).tier).toBe("never");
    expect(tier(agent, ["find", ".", "-exec", "security", "dump-keychain", ";"]).tier).toBe("never");
    // A word that only reads like a never program is not one.
    expect(tier(agent, ["sh", "-c", "grep -r 'open' ."], {}, true)).toEqual({ tier: "grant", why: "shell" });
    expect(tier(personal, ["rg", "sudo", "docs"])).toEqual({ tier: "auto", why: "rg" });
  });

  it("what cannot be seen through asks: shell, launchers, inline code — even where the default is auto", () => {
    expect(tier(agent, ["bash", "-c", "ls"], {}, true)).toEqual({ tier: "grant", why: "shell" });
    expect(tier(agent, ["bash", "deploy.sh"])).toEqual({ tier: "grant", why: "launcher bash" });
    expect(tier(agent, ["env", "X=1", "ls"])).toEqual({ tier: "grant", why: "launcher env" });
    expect(tier(agent, ["python3.12", "-c", "print(1)"])).toEqual({ tier: "grant", why: "inline code (python3.12)" });
    expect(tier(agent, ["node", "-e", "1"]).tier).toBe("grant");
    expect(tier(agent, ["awk", "{print}", "f"]).tier).toBe("grant");
  });

  it("dangerous arguments take an auto entry to grant (I-5)", () => {
    expect(tier(personal, ["git", "diff", "--ext-diff"])).toEqual({ tier: "grant", why: "git diff --ext-diff" });
    expect(tier(personal, ["git", "-c", "core.pager=x", "log"]).tier).toBe("grant");
    expect(tier(personal, ["git", "log", "--output=/tmp/x"]).tier).toBe("grant");
    expect(tier(personal, ["find", ".", "-name", "*.ts", "-delete"]).tier).toBe("grant");
    expect(tier(personal, ["rg", "--pre", "./x", "pat"]).tier).toBe("grant");
    expect(tier(personal, ["sort", "-o", "out", "in"]).tier).toBe("grant");
    expect(tier(personal, ["find", ".", "-name", "*.ts"]).tier).toBe("auto");
  });

  it("a group turn asks for what would run on its own, or gets nothing with groupTurns never", () => {
    expect(tier(personal, ["ls"], { where: "group", groupTurns: "grant" })).toEqual({ tier: "grant", why: "group" });
    expect(tier(agent, ["make"], { where: "group", groupTurns: "grant" })).toEqual({ tier: "grant", why: "group" });
    expect(tier(personal, ["ls"], { where: "group", groupTurns: "never" })).toEqual({ tier: "never", why: "group" });
    expect(tier(personal, ["ls"], { where: "dm", groupTurns: "never" }).tier).toBe("auto");
  });
});

describe("the ceiling in hello, and read again when it changes", () => {
  it("summary: tiers, directories, network, limits, grants — not the acknowledged paths, user or envPass", () => {
    const f = preset("agent-user", { user: "agent" });
    f.acknowledged = ["~/work/.env"];
    const s = summary(f);
    expect(s).toMatchObject({ version: 2, preset: "agent-user", runner: "user", network: "off", agents: "never" });
    expect(JSON.stringify(s)).not.toMatch(/acknowledged|\.env|agent"|envPass|PATH/);
    const t = temp();
    const raw = `${JSON.stringify(f)}\n`;
    write(t.paths.ceiling, raw);
    const l = loadCeiling(t.paths.ceiling, { home: t.home });
    expect(l.ok && l.ceiling.sha).toBe(createHash("sha256").update(raw).digest("hex").slice(0, 16));
  });

  it("exec off by switch, by the file, by unacknowledged names; on once acknowledged; caps follow", () => {
    const t = temp();
    let now = 1_000;
    const src = new CeilingSource({ paths: t.paths, home: t.home, now: () => now });
    expect(src.state()).toMatchObject({ ceiling: null, exec: { on: false, reason: "no_ceiling" } });
    expect(capsFor(src.state())).toEqual(["sessions"]);
    const app = join(t.home, "repos", "app");
    mkdirSync(join(app, "k8s"), { recursive: true });
    writeFileSync(join(app, "k8s", "kubeconfig"), "x");
    const f = { version: 2, read: { roots: ["~/repos/app"] } };
    write(t.paths.ceiling, f);
    expect(src.state()).toMatchObject({
      exec: { on: false, reason: "unacknowledged" },
      problems: [`${app}/k8s/kubeconfig (*kubeconfig*)`],
    });
    expect(capsFor(src.state())).toEqual(["sessions"]);
    write(t.paths.ceiling, { ...f, acknowledged: ["~/repos/app/k8s/kubeconfig"] });
    now += 1;
    expect(src.state()).toMatchObject({ exec: { on: true }, problems: [] });
    expect(capsFor(src.state())).toEqual(["sessions", "exec.v1"]);
    // Still unreadable once acknowledged.
    const c = src.state().ceiling as Ceiling;
    expect(intersect(c, args({ cwd: "~/repos/app/k8s/kubeconfig" }))).toMatchObject({ code: "path_denied" });
    writeFileSync(t.paths.off, "");
    expect(src.state()).toMatchObject({ ceiling: null, exec: { on: false, reason: "switched_off" } });
    expect(capsFor(src.state())).toEqual(["sessions"]);
    rmSync(t.paths.off);
    write(t.paths.ceiling, { ...f, acknowledged: ["~/repos/app/k8s/kubeconfig"], exec: "off", agents: "grant" });
    expect(src.state()).toMatchObject({ exec: { on: false, reason: "ceiling_off" } });
    // Delegation is not in this build yet: sessions only.
    expect(capsFor(src.state())).toEqual(["sessions"]);
    chmodSync(t.paths.ceiling, 0o640);
    expect(src.state()).toMatchObject({ ceiling: null, exec: { on: false, reason: "bad_ceiling" } });
  });
});
