/**
 * Probe v3 (docs/exec.md N8, checks S1–S8): the profile this build generates,
 * tried for real on this machine, as this user — `agents-io-herdr exec probe`, the dedicated user's
 * `exec-shim probe` (scripts/exec-sandbox-probe.sh --user), and the macOS-only tests. Everything
 * happens in a directory of its own (a fake home with decoys where the real secrets would be, a git
 * repository, listeners of its own); exit codes only, nothing read is printed; the directory and
 * listeners go at the end. With `launchd`, S6 also loads one on-demand launchd job of its own (its
 * program touches a file in that directory), tries to start it from inside the sandbox, and unloads
 * it again.
 *
 * - S1 read: the decoys (~/.ssh, gh, mihomo, shell history, git credentials, npmrc, kubeconfig,
 *   tfstate, .env, a directory marked .exec-private) and `ls ~` fail; the roots and the run's own
 *   directories read. S1b: /opt/homebrew/etc fails, /opt/homebrew/bin reads.
 * - S2 write: git hooks and config, .husky, .claude, CLAUDE.md, .mcp.json, AGENTS.md, .envrc, outside
 *   the roots fail; a plain file in a root and the run's TMPDIR are written. S2b: `.git` cannot be
 *   renamed, removed or made; modules' and worktrees' config neither. S2c: with the home itself
 *   writable, shell start-up files, LaunchAgents and ~/.gitconfig still are not.
 * - S3: no DNS, no unix socket outside, no TCP to this machine; S3b: through the proxy, only its port.
 * - S4: a profile that does not compile fails the preflight; HOME and TMPDIR are the run's.
 * - S5: git, found outside (xcrun's stub as the real program), runs and commits.
 * - S6: launchctl, open, osascript and a program copied into a writable directory do not start; with
 *   `launchd`, the job kickstarted from inside does not start, and (the control) from outside it does.
 * - S7: no other process's arguments are readable (python's sysctl KERN_PROCARGS2), 0 of them; for
 *   the dedicated user, the owner's processes counted on their own (outside the sandbox it can read
 *   them: why `exec doctor` counts token-like arguments).
 * - S8 (the dedicated user only, `userChecks`): the owner's home unreadable, the shared code and its
 *   own home unwritable, the login shell /bin/sh, launchd's manager uid its own.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { Exec } from "../system.ts";
import { resolveCommand } from "./run.ts";
import { buildProfile, HOMEBREW, type ProfileInput, preflight } from "./sandbox.ts";

export interface Check {
  id: string;
  what: string;
  ok: boolean;
  detail?: string;
}

const PYTHONS = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"];

/** How many of the given pids' KERN_PROCARGS2 this process can read (exit code, at most 250). */
const PROCARGS = `
import ctypes, sys
libc = ctypes.CDLL(None)
n = 0
for line in open(sys.argv[1]):
    pid = int(line)
    mib = (ctypes.c_int * 3)(1, 49, pid)
    size = ctypes.c_size_t(65536)
    buf = ctypes.create_string_buffer(65536)
    if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) == 0:
        n += 1
sys.exit(min(n, 250))
`;

function listen(server: Server, at: string | number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    if (typeof at === "string") server.listen(at, () => resolve(0));
    else
      server.listen(at, "127.0.0.1", () => {
        const a = server.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      });
  });
}

export interface ProbeOptions {
  /** A directory of the probe's own (made, and removed at the end). */
  base: string;
  sandboxExec: string;
  exec?: Exec;
  /** S6 with a launchd job of its own. */
  launchd?: boolean;
  /** The node that runs the network checks (default: this one). */
  node?: string;
  /** The owner's uid, when the probe runs as the dedicated user: S7 counts the owner's processes too. */
  ownerUid?: number | null;
}

export async function runProbe(o: ProbeOptions): Promise<Check[]> {
  mkdirSync(o.base, { recursive: true, mode: 0o700 });
  const B = realpathSync(o.base);
  const H = join(B, "home");
  const W = join(H, "work");
  const repo = join(W, "repo");
  const R = join(B, "ro");
  const O = join(B, "outside");
  const runHome = join(B, "run", "home");
  const runTmp = join(B, "run", "tmp");
  const servers: Server[] = [];
  let job: { domain: string; label: string } | null = null;
  const results: Check[] = [];
  const add = (id: string, what: string, ok: boolean, detail?: string) =>
    results.push({ id, what, ok, ...(detail ? { detail } : {}) });
  try {
    const decoys = [
      ".ssh/id_ed25519",
      ".config/gh/hosts.yml",
      ".config/mihomo/config.yaml",
      ".zsh_history",
      ".git-credentials",
      ".npmrc",
      ".kube/config",
    ];
    for (const f of decoys) {
      mkdirSync(dirname(join(H, f)), { recursive: true });
      writeFileSync(join(H, f), "decoy\n");
    }
    for (const d of [repo, R, O, runHome, runTmp, join(W, "private"), join(W, "empty", ".git")])
      mkdirSync(d, { recursive: true, mode: 0o700 });
    for (const [f, text] of [
      [join(R, "f.txt"), "r\n"],
      [join(O, "f.txt"), "o\n"],
      [join(repo, "f.txt"), "w\n"],
      [join(repo, ".env"), "decoy\n"],
      [join(repo, "prod.kubeconfig"), "decoy\n"],
      [join(repo, "terraform.tfstate"), "decoy\n"],
      [join(W, "private", ".exec-private"), ""],
      [join(W, "private", "notes.txt"), "decoy\n"],
      [join(runTmp, "t.txt"), "t\n"],
    ] as const)
      writeFileSync(f, text);
    spawnSync("/usr/bin/git", ["init", "-q", repo], { stdio: "ignore", env: { PATH: "/usr/bin:/bin", HOME: runHome } });
    for (const d of [join(repo, ".git", "modules", "m"), join(repo, ".git", "worktrees", "w")])
      mkdirSync(d, { recursive: true });
    const node = realpathSync(o.node ?? process.execPath);
    const python = PYTHONS.find((p) => existsSync(p)) ?? null;
    const tools = [dirname(dirname(node)), ...(python ? [dirname(dirname(realpathSync(python)))] : [])].filter(
      (t) => !t.startsWith(`${HOMEBREW}/`),
    );
    const base: ProfileInput = {
      home: H,
      read: [R, ...tools],
      write: [W],
      own: [runHome, runTmp],
      deny: [],
      private: [join(W, "private")],
      noWrite: [],
      network: "off",
      proxyPort: null,
    };
    const profile = (name: string, p: Partial<ProfileInput> = {}) => {
      const f = join(B, `${name}.sb`);
      writeFileSync(f, buildProfile({ ...base, ...p }));
      return f;
    };
    const P = profile("v3");
    const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: runHome, TMPDIR: `${runTmp}/`, TERM: "dumb" };
    const sb = (prof: string | null, argv: string[], cwd = repo) => {
      const [cmd, ...args] = prof ? [o.sandboxExec, "-f", prof, "--", ...argv] : argv;
      const r = spawnSync(cmd as string, args, { cwd, env, timeout: 20_000, stdio: ["ignore", "ignore", "pipe"] });
      return { code: r.status, err: (r.stderr?.toString() ?? "").trim().split("\n")[0]?.slice(0, 120) ?? "" };
    };
    const denied = (id: string, what: string, argv: string[], prof = P, cwd?: string) => {
      const r = sb(prof, argv, cwd);
      add(id, `${what}: denied`, r.code !== 0, r.code === 0 ? "it worked" : undefined);
    };
    const allowed = (id: string, what: string, argv: string[], prof = P, cwd?: string) => {
      const r = sb(prof, argv, cwd);
      add(id, `${what}: allowed`, r.code === 0, r.code === 0 ? undefined : `exit ${r.code}: ${r.err}`);
    };

    // S1, S1b
    for (const f of decoys) denied("S1", `read ~/${f}`, ["/bin/cat", join(H, f)]);
    denied("S1", "ls ~", ["/bin/ls", H]);
    for (const f of [".env", "prod.kubeconfig", "terraform.tfstate"])
      denied("S1", `read ${f} in a root`, ["/bin/cat", join(repo, f)]);
    denied("S1", "read a directory marked .exec-private", ["/bin/cat", join(W, "private", "notes.txt")]);
    denied("S1", "read outside the roots", ["/bin/cat", join(O, "f.txt")]);
    allowed("S1", "read a read root", ["/bin/cat", join(R, "f.txt")]);
    allowed("S1", "read a write root", ["/bin/cat", join(repo, "f.txt")]);
    allowed("S1", "read the run's TMPDIR", ["/bin/cat", join(runTmp, "t.txt")]);
    if (existsSync(`${HOMEBREW}/etc`)) denied("S1b", "list /opt/homebrew/etc", ["/bin/ls", `${HOMEBREW}/etc`]);
    if (existsSync(`${HOMEBREW}/bin`)) allowed("S1b", "list /opt/homebrew/bin", ["/bin/ls", `${HOMEBREW}/bin`]);

    // S2, S2b, S2c
    for (const f of [
      ".git/hooks/pre-commit",
      ".git/config",
      ".git/info/exclude",
      ".claude/settings.json",
      "CLAUDE.md",
      ".mcp.json",
      "AGENTS.md",
      ".envrc",
    ]) {
      mkdirSync(dirname(join(repo, f)), { recursive: true });
      denied("S2", `write ${f}`, ["/usr/bin/touch", join(repo, f)]);
    }
    denied("S2", "make .husky/", ["/bin/mkdir", join(repo, ".husky")]);
    denied("S2", "write outside the roots", ["/usr/bin/touch", join(O, "x")]);
    allowed("S2", "write a file in a write root", ["/usr/bin/touch", join(repo, "new.txt")]);
    allowed("S2", "write in the run's TMPDIR", ["/usr/bin/touch", join(runTmp, "x")]);
    denied("S2b", "rename .git", ["/bin/mv", join(repo, ".git"), join(repo, ".git-moved")]);
    denied("S2b", "remove an empty .git", ["/bin/rmdir", join(W, "empty", ".git")]);
    denied("S2b", "make a new .git", ["/bin/mkdir", join(W, "fresh", ".git")]);
    mkdirSync(join(W, "fresh"), { recursive: true });
    denied("S2b", "make a new .git (parent there)", ["/bin/mkdir", join(W, "fresh", ".git")]);
    denied("S2b", "write .git/modules/*/config", ["/usr/bin/touch", join(repo, ".git", "modules", "m", "config")]);
    denied("S2b", "write .git/worktrees/*/config", ["/usr/bin/touch", join(repo, ".git", "worktrees", "w", "config")]);
    const Ph = profile("home-writable", { write: [H] });
    for (const f of [".zshrc", ".zshenv", ".profile", ".gitconfig", "Library/LaunchAgents/x.plist"]) {
      mkdirSync(dirname(join(H, f)), { recursive: true });
      denied("S2c", `write ~/${f} with ~ writable`, ["/usr/bin/touch", join(H, f)], Ph);
    }
    allowed("S2c", "write ~/notes.txt with ~ writable", ["/usr/bin/touch", join(H, "notes.txt")], Ph);

    // S3, S3b: listeners of the probe's own, outside the sandbox (connections wait in the backlog).
    const sock = join(B, "s.sock");
    const unix = createServer((c) => c.destroy());
    const tcpA = createServer((c) => c.destroy());
    const tcpB = createServer((c) => c.destroy());
    servers.push(unix, tcpA, tcpB);
    await listen(unix, sock);
    const portA = await listen(tcpA, 0);
    const portB = await listen(tcpB, 0);
    const js = (s: string) => [node, "-e", s];
    const dns = js('require("dns").lookup("example.com",(e)=>process.exit(e?1:0))');
    const conn = (t: string) =>
      js(
        `const c=require("net").connect(${t});c.on("connect",()=>process.exit(0));c.on("error",()=>process.exit(1));setTimeout(()=>process.exit(2),5000)`,
      );
    const resolves = sb(null, dns).code === 0;
    const inside = sb(P, dns).code;
    add("S3", "getaddrinfo: denied", inside !== 0, resolves ? "resolves outside" : "no DNS outside either");
    denied("S3", "connect a unix socket outside", conn(JSON.stringify({ path: sock })));
    denied("S3", "connect TCP on this machine", conn(JSON.stringify({ host: "127.0.0.1", port: portA })));
    const Pp = profile("proxy", { network: "proxy", proxyPort: portA });
    allowed("S3b", "proxy: connect the proxy's port", conn(JSON.stringify({ host: "127.0.0.1", port: portA })), Pp);
    denied("S3b", "proxy: connect another port here", conn(JSON.stringify({ host: "127.0.0.1", port: portB })), Pp);
    denied("S3b", "proxy: connect a unix socket", conn(JSON.stringify({ path: sock })), Pp);
    denied("S3b", "proxy: getaddrinfo", dns, Pp);

    // S4
    add("S4", "the profile passes the preflight", (await preflight(P, { sandboxExec: o.sandboxExec })) === null);
    const bad = join(B, "bad.sb");
    writeFileSync(bad, "(version 1)\n(deny default)\n(no-such-operation)\n");
    add(
      "S4",
      "a profile that does not compile fails the preflight",
      (await preflight(bad, { sandboxExec: o.sandboxExec })) !== null,
    );
    allowed("S4", "HOME and TMPDIR are the run's, and writable", [
      "/bin/sh",
      "-c",
      `test "$HOME" = '${runHome}' && test "$TMPDIR" = '${runTmp}/' && touch "$HOME/h" "$TMPDIR/t"`,
    ]);

    // S5
    const git = resolveCommand("git", { path: env.PATH, cwd: repo, exec: o.exec });
    if (!git) add("S5", "git found", false, "no git");
    else {
      allowed("S5", `git status (${git})`, [git, "status", "--short"]);
      allowed("S5", "git add and commit", [
        "/bin/sh",
        "-c",
        `'${git}' add f.txt && '${git}' -c user.name=probe -c user.email=probe@example.invalid -c commit.gpgsign=false commit -qm probe`,
      ]);
    }

    // S6
    for (const p of ["/bin/launchctl", "/usr/bin/open", "/usr/bin/osascript"])
      denied("S6", `start ${p}`, [p, p.endsWith("launchctl") ? "list" : "-h"]);
    denied("S6", "start a copy of launchctl in a write root", [
      "/bin/sh",
      "-c",
      `cp /bin/launchctl '${W}/lc' && '${W}/lc' list`,
    ]);
    denied("S6", "start a script just written", [
      "/bin/sh",
      "-c",
      `printf '#!/bin/sh\\nexit 0\\n' > '${runTmp}/s' && chmod +x '${runTmp}/s' && '${runTmp}/s'`,
    ]);
    if (o.launchd)
      launchdCheck(B, sb, P, add, (j) => {
        job = j;
      });

    // S7
    if (!python) add("S7", "other processes' arguments", true, "skipped: no python3 here");
    else {
      const ps = spawnSync("/bin/ps", ["-axo", "pid=,uid="], { encoding: "utf8" });
      const rows = (ps.stdout ?? "")
        .split("\n")
        .map((l) => l.trim().split(/\s+/))
        .filter((r) => r.length === 2 && /^\d+$/.test(r[0] ?? "") && /^\d+$/.test(r[1] ?? ""))
        .map(([pid, uid]) => ({ pid: pid as string, uid: Number(uid) }));
      writeFileSync(join(runTmp, "procargs.py"), PROCARGS);
      // Every process's (null), or one user's: how many arguments readable inside and outside.
      const count = (uid: number | null) => {
        const pids = rows.filter((r) => uid === null || r.uid === uid).map((r) => r.pid);
        const f = join(runTmp, `pids-${uid ?? "all"}`);
        writeFileSync(f, pids.map((p) => `${p}\n`).join(""));
        const out = sb(null, [python, join(runTmp, "procargs.py"), f]).code ?? 0;
        const r = sb(P, [python, join(runTmp, "procargs.py"), f]);
        return { inside: r.code, detail: `${r.code ?? "?"} readable inside, ${out} outside, of ${pids.length}` };
      };
      const all = count(null);
      add("S7", "other processes' arguments: 0 readable", all.inside === 0, all.detail);
      if (typeof o.ownerUid === "number") {
        const owner = count(o.ownerUid);
        add("S7", "the owner's processes' arguments: 0 readable", owner.inside === 0, owner.detail);
      }
    }
  } finally {
    for (const s of servers) s.close();
    if (job) unloadJob(job);
    rmSync(B, { recursive: true, force: true });
  }
  return results;
}

/** S6 for real: an on-demand job of the probe's own, started from inside the sandbox. */
function launchdCheck(
  B: string,
  sb: (prof: string | null, argv: string[], cwd?: string) => { code: number | null; err: string },
  P: string,
  add: (id: string, what: string, ok: boolean, detail?: string) => void,
  loaded: (j: { domain: string; label: string }) => void,
): void {
  const uid = userInfo().uid;
  const gui = spawnSync("/bin/launchctl", ["print", `gui/${uid}`], { stdio: "ignore" }).status === 0;
  const domain = gui ? `gui/${uid}` : `user/${uid}`;
  const label = `io.agents-io-herdr.probe.${process.pid}.${Date.now().toString(36)}`;
  const mark = join(B, "launchd-ran");
  const plist = join(B, `${label}.plist`);
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/usr/bin/touch</string><string>${mark}</string></array>
<key>RunAtLoad</key><false/>
</dict></plist>
`,
  );
  if (spawnSync("/bin/launchctl", ["bootstrap", domain, plist], { stdio: "ignore" }).status !== 0) {
    add("S6", "launchd: load a job of the probe's own", false, `could not bootstrap into ${domain}`);
    return;
  }
  loaded({ domain, label });
  const k = sb(P, ["/bin/launchctl", "kickstart", `${domain}/${label}`]);
  spawnSync("/bin/sleep", ["1"]);
  const inside = k.code === 0 || existsSync(mark);
  // The control: from outside the same job does start. If it does not, the check above showed nothing.
  let outside = false;
  if (!inside) {
    spawnSync("/bin/launchctl", ["kickstart", `${domain}/${label}`], { stdio: "ignore" });
    for (let i = 0; i < 30 && !outside; i++) {
      spawnSync("/bin/sleep", ["0.1"]);
      outside = existsSync(mark);
    }
  }
  add(
    "S6",
    "launchd: kickstart an on-demand job from inside: nothing starts",
    !inside && outside,
    inside ? "it started" : outside ? "from outside it does" : "nothing shown: from outside it did not start either",
  );
}

function unloadJob(j: { domain: string; label: string }): void {
  spawnSync("/bin/launchctl", ["bootout", `${j.domain}/${j.label}`], { stdio: "ignore" });
}

/** S8: the dedicated user's boundary, outside the sandbox, as that user. */
export function userChecks(o: {
  uid: number;
  home: string;
  ownerHome: string | null;
  shared: string | null;
  exec: Exec;
}): Check[] {
  const out: Check[] = [];
  const add = (what: string, ok: boolean, detail?: string) =>
    out.push({ id: "S8", what, ok, ...(detail ? { detail } : {}) });
  if (o.ownerHome) {
    const r = o.exec("/bin/ls", [o.ownerHome], 10_000);
    add(`ls ${o.ownerHome}: denied`, !!r && r.code !== 0);
  }
  const unwritable = (dir: string, what: string) => {
    const f = join(dir, `.probe-${process.pid}`);
    try {
      writeFileSync(f, "");
      rmSync(f, { force: true });
      add(`${what}: denied`, false, "it worked");
    } catch {
      add(`${what}: denied`, true);
    }
  };
  if (o.shared) unwritable(o.shared, `write in ${o.shared}`);
  unwritable(o.home, `write in ${o.home} (.zshenv, .profile, .ssh/ cannot be made)`);
  try {
    const st = statSync(o.home);
    add(`${o.home} is root's, 755`, st.uid === 0 && (st.mode & 0o777) === 0o755);
  } catch {
    add(`${o.home} is root's, 755`, false, "missing");
  }
  const shell = userInfo().shell;
  add("the login shell is /bin/sh", shell === "/bin/sh", shell ?? "unknown");
  const m = o.exec("/bin/launchctl", ["manageruid"], 10_000);
  const manager = m?.stdout.trim() ?? "";
  add("launchd's manager uid is this user's", manager === String(o.uid), manager || "unknown");
  return out;
}
