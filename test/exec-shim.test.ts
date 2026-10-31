/**
 * The dedicated user's runner and its forced command (docs/exec.md N9), without sshd, the
 * user or the sandbox: the real binary refuses a missing or foreign SSH_ORIGINAL_COMMAND and refuses
 * to run as anyone but a dedicated user (this test's user is not one); the shim in this process and
 * as a child over real pipes: frames, output held to the collector's share, EOF and `cancel` stop
 * the run, the deadline, paths outside the roots or through a symlink, `.exec-private` (refused, or
 * denied at the end of the profile); the collector's reader kills a runner that sends an oversized
 * frame or too much; the sweep spares the shim and its ancestors.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { userChecks } from "../src/exec/probe.ts";
import type { RunPlan } from "../src/exec/run.ts";
import {
  ancestors,
  parseRunSpec,
  privateDirs,
  type RunSpec,
  realInterlock,
  type ShimIo,
  shim,
} from "../src/exec/shim.ts";
import { UserRunner } from "../src/exec/user-runner.ts";
import { CH_END, CH_STDERR, CH_STDOUT, FrameReader, frame, WireError } from "../src/exec/wire.ts";
import type { Exec } from "../src/system.ts";
import { realExec } from "../src/system.ts";

const ROOT = join(import.meta.dirname, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "aio-herdr-shim-")));
  dirs.push(d);
  return d;
}

/** A "user's" home with ~/work and ~/exec, as the setup script makes them (minus root's ownership). */
function userHome() {
  const home = join(temp(), "runner");
  mkdirSync(join(home, "work", "app"), { recursive: true });
  mkdirSync(join(home, "exec"), { recursive: true });
  return home;
}

function spec(home: string, argv: string[], over: Partial<RunSpec> = {}): RunSpec {
  const effect = over.effect ?? "eff_shim1";
  return {
    effect,
    argv,
    cwd: join(home, "work", "app"),
    env: { PATH: "/usr/bin:/bin", TERM: "dumb" },
    home: join(home, "work"),
    tmp: join(home, "exec", effect, "tmp"),
    profile: "(version 1)\n(deny default)\n",
    roots: { read: [join(home, "work")], write: [join(home, "work")] },
    stdinBytes: 0,
    deadline: Date.now() + 20_000,
    outputBytes: 1024,
    ...over,
  };
}

/** The shim in this process; stdin is a stream the test writes. */
function inProcess(home: string, command: string, over: Partial<ShimIo> = {}) {
  const stdin = new PassThrough();
  const out: Buffer[] = [];
  const err: string[] = [];
  const io: ShimIo = {
    command,
    stdin,
    out: (b) => out.push(b),
    err: (s) => err.push(s),
    now: Date.now,
    uid: 501,
    home,
    pid: process.pid,
    exec: realExec,
    interlock: () => null,
    sandboxExec: null,
    graceMs: 200,
    ...over,
  };
  const frames = () => {
    const r = new FrameReader(1024 * 1024);
    return r.push(Buffer.concat(out));
  };
  const end = () =>
    JSON.parse(
      frames()
        .find((f) => f.ch === CH_END)
        ?.data.toString() ?? "null",
    );
  const text = (ch: number) =>
    Buffer.concat(
      frames()
        .filter((f) => f.ch === ch)
        .map((f) => f.data),
    ).toString("utf8");
  return { io, stdin, out, err, frames, end, text, done: shim(io) };
}

describe("exec-shim, the real binary", () => {
  const bin = join(ROOT, "bin", "agents-io-herdr");
  const run = (command: string | undefined) =>
    spawnSync(process.execPath, [bin, "exec-shim"], {
      env: { PATH: "/usr/bin:/bin", ...(command === undefined ? {} : { SSH_ORIGINAL_COMMAND: command }) },
      input: "",
      encoding: "utf8",
    });

  it("no command, or another one: refused, nothing on stdout", () => {
    const none = run(undefined);
    expect(none.status).toBe(2);
    expect(none.stdout).toBe("");
    expect(none.stderr).toContain("runs only the exec shim");
    const other = run("ls -la /");
    expect(other.status).toBe(2);
    expect(other.stdout).toBe("");
    expect(other.stderr).toContain('"ls -la /" is not something this key runs');
  });

  it("as a user that is not a dedicated runner user (this one): refused before anything", () => {
    const r = run("run");
    expect(r.status).toBe(3);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/not a dedicated runner user|does not run as root/);
  });
});

describe("the interlock", () => {
  it("not root; a home of root's no one else can write", () => {
    const mine = temp();
    expect(realInterlock(0, "/var/root")).toContain("root");
    expect(realInterlock(501, mine)).toContain("not a dedicated runner user");
    expect(realInterlock(501, join(mine, "missing"))).toContain("no ");
    // /var/empty (or /usr) is root's and closed to writes on macOS and Linux alike.
    expect(realInterlock(501, "/usr")).toBeNull();
  });
});

describe("the shim in this process", () => {
  it("run: stdin in, frames out, the end with all the bytes; the run's directory goes", async () => {
    const home = userHome();
    const s = inProcess(home, "run");
    const stdin = Buffer.from("hello from stdin\n");
    const sp = spec(home, ["/bin/sh", "-c", 'cat; echo "home=$HOME tmp=$TMPDIR"; echo oops >&2; exit 3'], {
      stdinBytes: stdin.length,
    });
    s.stdin.write(`${JSON.stringify(sp)}\n`);
    s.stdin.write(stdin);
    expect(await s.done).toBe(0);
    s.stdin.end();
    expect(s.text(CH_STDOUT)).toBe(`hello from stdin\nhome=${join(home, "work")} tmp=${sp.tmp}/\n`);
    expect(s.text(CH_STDERR)).toBe("oops\n");
    expect(s.end()).toEqual({
      state: "done",
      exit: 3,
      signal: null,
      reason: null,
      bytes: { stdout: Buffer.byteLength(s.text(CH_STDOUT)), stderr: 5 },
    });
    expect(spawnSync("/bin/ls", [join(home, "exec")], { encoding: "utf8" }).stdout).toBe("");
  });

  it("output beyond the collector's share is counted, not sent", async () => {
    const home = userHome();
    const s = inProcess(home, "run");
    s.stdin.write(`${JSON.stringify(spec(home, ["/bin/sh", "-c", "head -c 100000 /dev/zero | tr '\\0' a"]))}\n`);
    expect(await s.done).toBe(0);
    s.stdin.end();
    expect(s.text(CH_STDOUT).length).toBe(1024 + 4096);
    expect(s.end().bytes).toEqual({ stdout: 100_000, stderr: 0 });
    for (const f of s.frames()) expect(f.data.length).toBeLessThanOrEqual(1024 + 4096);
  });

  it("EOF (the collector gone) and `cancel` stop the run; the deadline too", async () => {
    const home = userHome();
    const eof = inProcess(home, "run");
    eof.stdin.write(`${JSON.stringify(spec(home, ["/bin/sleep", "30"], { effect: "eff_eof" }))}\n`);
    setTimeout(() => eof.stdin.end(), 150);
    expect(await eof.done).toBe(0);
    expect(eof.end()).toMatchObject({ state: "cancelled", reason: "eof", signal: "SIGTERM" });
    const cancel = inProcess(home, "run");
    cancel.stdin.write(`${JSON.stringify(spec(home, ["/bin/sleep", "30"], { effect: "eff_cancel" }))}\n`);
    setTimeout(() => cancel.stdin.write("cancel\n"), 150);
    expect(await cancel.done).toBe(0);
    cancel.stdin.end();
    expect(cancel.end()).toMatchObject({ state: "cancelled", reason: "cancel" });
    const late = inProcess(home, "run");
    late.stdin.write(
      `${JSON.stringify(spec(home, ["/bin/sleep", "30"], { effect: "eff_late", deadline: Date.now() + 300 }))}\n`,
    );
    expect(await late.done).toBe(0);
    late.stdin.end();
    expect(late.end()).toMatchObject({ state: "timeout", reason: "deadline" });
  });

  it("cwd outside the roots, a symlink on the way, a TMPDIR elsewhere, a spec that does not read: failed", async () => {
    const home = userHome();
    const outside = temp();
    symlinkSync(join(home, "work", "app"), join(home, "work", "link"));
    const cases: [Partial<RunSpec> | string, string][] = [
      [{ cwd: outside }, "path_outside"],
      [{ cwd: join(home, "work", "link") }, "path_denied"],
      [{ tmp: join(outside, "tmp") }, "bad_spec"],
      ['{"effect":"eff_x"}', "bad_spec"],
    ];
    for (const [over, reason] of cases) {
      const s = inProcess(home, "run");
      s.stdin.write(`${typeof over === "string" ? over : JSON.stringify(spec(home, ["/bin/echo"], over))}\n`);
      expect(await s.done).toBe(0);
      s.stdin.end();
      expect(s.end()).toMatchObject({ state: "failed", reason });
      expect(s.text(CH_STDOUT)).toBe("");
    }
  });

  it("`.exec-private` here: cwd or a write path in a marked directory refused; the others denied in the profile", async () => {
    const home = userHome();
    const work = join(home, "work");
    const mark = (...p: string[]) => {
      mkdirSync(join(work, ...p), { recursive: true });
      writeFileSync(join(work, ...p, ".exec-private"), "");
    };
    mark("app", "keep");
    mark("notes");
    mark(".cache", "pkg");
    const refused: Partial<RunSpec>[] = [
      { cwd: join(work, "app", "keep") },
      { roots: { read: [work], write: [join(work, "notes", "out")] } },
    ];
    for (const over of refused) {
      const s = inProcess(home, "run");
      s.stdin.write(`${JSON.stringify(spec(home, ["/bin/echo"], over))}\n`);
      expect(await s.done).toBe(0);
      s.stdin.end();
      expect(s.end()).toMatchObject({ state: "failed", reason: "path_denied" });
      expect(s.err.join("")).toContain("marked .exec-private");
      expect(s.text(CH_STDOUT)).toBe("");
    }
    // Otherwise the run goes, and its profile ends with a deny of each marked directory (not the cache's).
    const fake = join(temp(), "sandbox-exec");
    writeFileSync(fake, '#!/bin/sh\nshift 3\nexec "$@"\n');
    chmodSync(fake, 0o755);
    let profile = "";
    const s = inProcess(home, "run", {
      sandboxExec: fake,
      spawn: async (_cmd, args) => {
        profile = readFileSync(args[1] as string, "utf8");
        return { code: 0 };
      },
    });
    const cache = join(work, ".cache");
    s.stdin.write(
      `${JSON.stringify(spec(home, ["/bin/echo", "ran"], { roots: { read: [work], write: [cache], cache: [cache] } }))}\n`,
    );
    expect(await s.done).toBe(0);
    s.stdin.end();
    expect(s.end()).toMatchObject({ state: "done", exit: 0 });
    expect(s.text(CH_STDOUT)).toBe("ran\n");
    expect(profile.startsWith("(version 1)\n(deny default)\n(deny file-read* file-write*\n")).toBe(true);
    expect(profile).toContain(`(subpath "${join(work, "app", "keep")}")`);
    expect(profile).toContain(`(subpath "${join(work, "notes")}")`);
    expect(profile).not.toContain(cache);
    // A scan that cannot finish refuses the run; no marker anywhere, nothing added.
    expect(privateDirs(spec(home, ["/bin/echo"]), home, 3)).toEqual({
      refused: ["path_denied", expect.stringContaining("list narrower roots")],
    });
    const clean = userHome();
    expect(privateDirs(spec(clean, ["/bin/echo"]), clean)).toEqual({ dirs: [] });
  });

  it("unknown op, no op: refused; upload and download wait for N10", async () => {
    const home = userHome();
    expect(await inProcess(home, "shell").done).toBe(2);
    expect(await inProcess(home, "").done).toBe(2);
    const up = inProcess(home, "upload");
    expect(await up.done).toBe(0);
    expect(up.end()).toMatchObject({ state: "failed", reason: "unsupported" });
    const no = inProcess(home, "run", { interlock: () => "not this user" });
    expect(await no.done).toBe(3);
    expect(no.out).toEqual([]);
  });

  it("sweep: every process of this user but the shim and its ancestors; names only", async () => {
    const killed: number[] = [];
    const table = [
      "    1     0     0 /sbin/launchd",
      "  100     1   501 /usr/sbin/sshd",
      "  200   100   501 sshd-session",
      "  300   200   501 /opt/homebrew/opt/node@24/bin/node",
      "  400     1   501 /usr/bin/python3",
      "  401   400   501 sleep",
      "  500     1   502 /usr/bin/someone-else",
    ].join("\n");
    const exec: Exec = (cmd) => (cmd === "/bin/ps" ? { code: 0, stdout: table, stderr: "" } : null);
    const s = inProcess(userHome(), "sweep", { pid: 300, exec, kill: (pid) => killed.push(pid) });
    expect(await s.done).toBe(0);
    expect(killed).toEqual([400, 401]);
    expect(s.end()).toEqual({ state: "done", killed: 2, comms: ["python3", "sleep"] });
    expect(
      ancestors(
        300,
        new Map([
          [300, 200],
          [200, 100],
          [100, 1],
          [1, 0],
        ]),
      ),
    ).toEqual(new Set([300, 200, 100, 1]));
  });
});

describe("the collector's reader", () => {
  it("frames within the run's limits; beyond them, an unknown channel, bytes after the end: broken", () => {
    const r = new FrameReader(1024);
    expect(r.push(frame(CH_STDOUT, Buffer.alloc(1024 + 4096)))).toHaveLength(1);
    expect(() => new FrameReader(1024).push(frame(CH_STDOUT, Buffer.alloc(1024 + 4097)))).toThrow(WireError);
    // A header alone announcing too much is enough: nothing is buffered for it.
    expect(() => new FrameReader(1024).push(Buffer.from([CH_STDERR, 0x7f, 0xff, 0xff, 0xff]))).toThrow(WireError);
    expect(() => new FrameReader(1024).push(frame(7, Buffer.from("x")))).toThrow("unknown channel");
    const total = new FrameReader(1024);
    expect(() => {
      for (let i = 0; i < 40; i++) total.push(frame(CH_STDOUT, Buffer.alloc(4000)));
    }).toThrow("more than 5120 bytes on channel 1");
    expect(() => new FrameReader(1024).push(frame(CH_STDERR, Buffer.alloc(0)))).toThrow("an empty frame");
    const after = new FrameReader(1024);
    expect(() =>
      after.push(Buffer.concat([frame(CH_END, Buffer.from("{}")), frame(CH_STDOUT, Buffer.from("x"))])),
    ).toThrow("after the end");
    const cut = new FrameReader(1024);
    cut.push(frame(CH_STDOUT, Buffer.from("abc")).subarray(0, 6));
    expect(() => cut.close()).toThrow("cut short");
    expect(parseRunSpec({ effect: "eff_1" })).toBeNull();
  });

  it("a long run that trickles (40 bytes every flush on both streams, up to their shares) is not cut off by its headers", () => {
    const r = new FrameReader(262_144);
    const share = 262_144 + 4096;
    let data = 0;
    let wire = 0;
    for (let sent = 0; sent < share; sent += 40)
      for (const ch of [CH_STDOUT, CH_STDERR]) {
        const f = frame(ch, Buffer.alloc(Math.min(40, share - sent), 0x61));
        wire += f.length;
        for (const x of r.push(f)) data += x.data.length;
      }
    expect(data).toBe(2 * share);
    // More on the wire than both shares and the 64 KiB the reader used to allow in all.
    expect(wire).toBeGreaterThan(2 * share + 64 * 1024);
    expect(r.push(frame(CH_END, Buffer.from("{}")))).toHaveLength(1);
    // One byte more on either stream is too much.
    const over = new FrameReader(1024);
    over.push(frame(CH_STDERR, Buffer.alloc(1024 + 4096)));
    expect(() => over.push(frame(CH_STDERR, Buffer.from("x")))).toThrow("more than");
  });
});

describe("the user runner, over pipes to the shim as a child", () => {
  const child =
    (home: string, env: Record<string, string> = {}) =>
    (op: string) =>
      spawn(process.execPath, [join(ROOT, "test", "shim-child.ts"), op], {
        stdio: "pipe",
        env: { PATH: "/usr/bin:/bin", AIH_TEST_HOME: home, ...env },
      });

  function plan(home: string, argv: string[], over: Partial<RunPlan> = {}): RunPlan {
    return {
      effectId: "eff_pipe1",
      argv,
      cwd: join(home, "work", "app"),
      env: { PATH: "/usr/bin:/bin", TERM: "dumb" },
      path: "/usr/bin:/bin",
      stdin: null,
      deadline: Date.now() + 20_000,
      outputBytes: 1024,
      profile: {
        home,
        read: [join(home, "work")],
        write: [join(home, "work")],
        deny: [],
        private: [],
        noWrite: [],
        network: "off",
        proxyPort: null,
      },
      roots: { read: [join(home, "work")], write: [join(home, "work")] },
      home: null,
      ...over,
    };
  }

  const runner = (home: string, connect: UserRunnerConnect) =>
    new UserRunner({
      user: { name: "runner-test", home },
      key: "/nonexistent/key",
      knownHosts: "/nonexistent/known_hosts",
      now: Date.now,
      log: () => undefined,
      connect,
    });
  type UserRunnerConnect = (op: string) => ReturnType<typeof spawn>;

  it("a run: the profile and spec go in, the output comes back redacted, bytes counted", async () => {
    const home = userHome();
    const r = runner(home, child(home));
    const p = await r.prepare(
      plan(home, ["/bin/sh", "-c", "cat; echo token=abcdefghijklmnop; head -c 20000 /dev/zero | tr '\\0' b"], {
        stdin: "from LB\n",
      }),
    );
    if (!p.ok) throw new Error(p.message);
    const o = await p.prepared.start().done;
    expect(o).toMatchObject({ state: "done", exit: 0, reason: null, truncated: true });
    expect(o.stdout.startsWith("from LB\ntoken=[REDACTED]\n")).toBe(true);
    expect(o.bytes.stdout).toBe(8 + 23 + 20_000);
    expect(Buffer.byteLength(o.stdout)).toBeLessThanOrEqual(1024);
  });

  it("stop: `cancel` goes to the shim; the collector's reason is kept", async () => {
    const home = userHome();
    const r = runner(home, child(home));
    const p = await r.prepare(plan(home, ["/bin/sleep", "30"], { effectId: "eff_pipe2" }));
    if (!p.ok) throw new Error(p.message);
    const s = p.prepared.start();
    setTimeout(() => s.stop("cancelled", "generation_changed"), 300);
    expect(await s.done).toMatchObject({ state: "cancelled", reason: "generation_changed" });
  });

  it("a runner that sends an oversized frame is stopped: failed, runner_protocol", async () => {
    const home = userHome();
    let killedWith: string | null = null;
    const r = runner(home, () => {
      const c = spawn("/bin/sh", ["-c", "printf '\\001\\177\\377\\377\\377'; exec sleep 30"], { stdio: "pipe" });
      const kill = c.kill.bind(c);
      c.kill = (sig?: NodeJS.Signals | number) => {
        killedWith = String(sig);
        return kill(sig);
      };
      return c;
    });
    const p = await r.prepare(plan(home, ["/bin/true"], { effectId: "eff_pipe3" }));
    if (!p.ok) throw new Error(p.message);
    expect(await p.prepared.start().done).toMatchObject({ state: "failed", reason: "runner_protocol" });
    expect(killedWith).toBe("SIGKILL");
  });

  it("ssh that cannot connect (255, nothing said): runner_unavailable; no key: refused before the claim", async () => {
    const home = userHome();
    const r = runner(home, () => spawn("/bin/sh", ["-c", "exit 255"], { stdio: "pipe" }));
    const p = await r.prepare(plan(home, ["/bin/true"], { effectId: "eff_pipe4" }));
    if (!p.ok) throw new Error(p.message);
    expect(await p.prepared.start().done).toMatchObject({ state: "failed", reason: "runner_unavailable" });
    const real = new UserRunner({
      user: { name: "runner-test", home },
      key: join(home, "no-key"),
      knownHosts: join(home, "no-known-hosts"),
      now: Date.now,
      log: () => undefined,
    });
    expect(await real.prepare(plan(home, ["/bin/true"]))).toMatchObject({ ok: false, code: "runner_unavailable" });
    expect(real.sshArgs("run")).toEqual(
      expect.arrayContaining(["-F", "/dev/null", "IdentitiesOnly=yes", "runner-test@127.0.0.1", "run"]),
    );
  });

  it("sweep: the count and the names come back (the child's ps is made up; nothing is killed)", async () => {
    const home = userHome();
    const r = runner(home, child(home));
    expect(await r.sweep()).toEqual({ killed: 1, comms: ["left-behind"] });
  });

  it("a sweep whose ps failed is no sweep: null, not 0 killed", async () => {
    const home = userHome();
    const logs: string[] = [];
    const r = new UserRunner({
      user: { name: "runner-test", home },
      key: "/nonexistent/key",
      knownHosts: "/nonexistent/known_hosts",
      now: Date.now,
      log: (s) => logs.push(s),
      connect: child(home, { AIH_TEST_PS_FAILS: "1" }),
    });
    expect(await r.sweep()).toBeNull();
    expect(logs).toEqual(["exec: the sweep failed (ps)"]);
  });
});

describe("S8 checks", () => {
  it("a home that can be written is a failure", () => {
    const home = temp();
    const out = userChecks({ uid: process.getuid?.() ?? 501, home, ownerHome: null, shared: null, exec: realExec });
    expect(out.find((c) => c.what.startsWith(`write in ${home}`))).toMatchObject({ ok: false, detail: "it worked" });
    expect(out.find((c) => c.what.includes("root's, 755"))).toMatchObject({ ok: false });
    writeFileSync(join(home, "x"), "");
  });
});
