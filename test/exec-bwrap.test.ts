/** bwrap argv and fail-closed preflight on every platform; byte streams through a fake executable. */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BoxJob, SandboxSpec } from "../src/exec/box.ts";
import { BWRAP, BwrapRunner, bwrapArgs } from "../src/exec/bwrap.ts";
import { parseCeiling, preset, resolveCeiling } from "../src/exec/ceiling.ts";
import { EffectLedger, report } from "../src/exec/effects.ts";
import { Executor } from "../src/exec/executor.ts";
import { argsHash, CHUNK_MAX, type Chunk, type EffectReport, parseCall } from "../src/exec/frames.ts";
import { GrantsUsed } from "../src/exec/grants.ts";
import { realExec } from "../src/system.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "aih-bwrap-"));
  dirs.push(d);
  return d;
};
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const sandbox: SandboxSpec = {
  network: "off",
  mounts: [
    { kind: "rw", src: "/srv/people/person", dst: "/home/me" },
    { kind: "ro", src: "/srv/tools/tool/version", dst: "/opt/tool" },
    { kind: "tmpfs", dst: "/tmp" },
  ],
  env: { PATH: "/opt/tool/bin:/usr/bin", HOME: "/home/me", LANG: "C.UTF-8", TZ: "UTC" },
  cwd: "/home/me",
  argv: ["/opt/tool/bin/tool", "--help"],
};
const job = (over: Partial<BoxJob> = {}): BoxJob => ({
  effectId: "eff_test",
  sandbox,
  stdin: null,
  transfer: null,
  helper: true,
  deadline: Date.now() + 5000,
  outputBytes: 524288,
  ensure: [],
  reset: [],
  ...over,
});

function fake(d: string, body: string, preflight = "process.exit(0)") {
  const p = join(d, "bwrap");
  const log = join(d, "argv.jsonl");
  writeFileSync(
    p,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, filter: args.includes('--seccomp') ? fs.readFileSync(3, 'utf8') : null}) + '\\n');
if (args.at(-1) === '/bin/true') { ${preflight}; } else { ${body}; }
`,
    { mode: 0o755 },
  );
  return { p, log, runner: new BwrapRunner({ bwrap: p, now: Date.now, log: () => undefined, graceMs: 20 }) };
}
async function start(
  runner: BwrapRunner,
  j: BoxJob,
  send?: (c: { seq: number; data: Buffer; last: boolean }) => boolean,
) {
  const a = await runner.prepareBox(j, { seccomp: null, send });
  if (!a.ok) throw Error(JSON.stringify(a));
  return a.prepared.start();
}

describe("bwrap", () => {
  it("snapshots the isolation boundary: no proc, only whitelisted etc, clean env and one person's mounts", () => {
    const args = bwrapArgs(sandbox, { seccomp: true });
    expect(args).toMatchSnapshot();
    expect(args).not.toContain("--proc");
    expect(args).not.toContain("--share-net");
    expect(args).not.toContain("/etc/resolv.conf");
    expect(args).not.toContain("/var/lib/herdr");
    expect(bwrapArgs({ ...sandbox, network: "open" }, { seccomp: true })).toMatchSnapshot();
  });

  it("preflights /bin/true with identical mounts/env/filter, reopening seccomp for the actual run", async () => {
    const d = temp();
    const filter = join(d, "seccomp.bpf");
    writeFileSync(filter, "filter-bytes");
    const f = fake(d, "process.stdout.write('ok')");
    const a = await f.runner.prepareBox(job(), { seccomp: filter });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(await a.prepared.start().done).toMatchObject({ state: "done", exit: 0, stdout: "ok" });
    const rows = readFileSync(f.log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.filter)).toEqual(["filter-bytes", "filter-bytes"]);
    const head = (args: string[]) => args.slice(0, args.indexOf("--") + 1);
    expect(head(rows[0].args)).toEqual(head(rows[1].args));
    expect(rows[0].args.at(-1)).toBe("/bin/true");
    expect(rows[1].args.slice(-2)).toEqual(["/opt/tool/bin/tool", "--help"]);
  });

  it("never starts the job when bwrap, the filter or the preflight is unavailable", async () => {
    const d = temp();
    const f = fake(d, "fs.writeFileSync('should-not-run', 'bad')", "process.stderr.write('denied'); process.exit(1)");
    expect(await f.runner.prepareBox(job(), { seccomp: null })).toMatchObject({ code: "sandbox_unavailable" });
    expect(readFileSync(f.log, "utf8").trim().split("\n")).toHaveLength(1);
    expect(await f.runner.prepareBox(job(), { seccomp: join(d, "missing") })).toMatchObject({
      code: "sandbox_unavailable",
    });
    const missing = new BwrapRunner({ bwrap: join(d, "absent"), now: Date.now, log: () => undefined });
    expect(await missing.prepareBox(job(), { seccomp: null })).toMatchObject({ code: "sandbox_unavailable" });
    const hung = fake(temp(), "process.exit(0)", "setTimeout(() => process.exit(0), 10000)");
    const timeout = new BwrapRunner({ bwrap: hung.p, now: Date.now, log: () => undefined, preflightMs: 50 });
    expect(await timeout.prepareBox(job(), { seccomp: null })).toMatchObject({ code: "sandbox_unavailable" });
  });

  it("streams uploads in order, counts and hashes them, and ignores the helper's JSON stdout", async () => {
    const b = Buffer.from([0, 255, 10, 128, 2]);
    const f = fake(temp(), "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{}\\n'))");
    const run = await start(
      f.runner,
      job({ transfer: { kind: "upload", path: "a.bin", size: b.length, sha256: sha(b) } }),
    );
    run.feed?.({ seq: 0, data: b.subarray(0, 2), last: false });
    run.feed?.({ seq: 1, data: b.subarray(2), last: true });
    expect(await run.done).toMatchObject({
      state: "done",
      stdout: "",
      data: { path: "a.bin", size: 5, sha256: sha(b) },
    });
  });

  it("fails gaps, oversized uploads and a digest mismatch; deadlines stop an incomplete upload", async () => {
    const f = fake(temp(), "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))");
    const t = { kind: "upload" as const, path: "a", size: 1, sha256: sha("a") };
    for (const [piece, reason] of [
      [{ seq: 1, data: Buffer.from("a"), last: true }, "bad_chunk"],
      [{ seq: 0, data: Buffer.from("ab"), last: true }, "too_large"],
      [{ seq: 0, data: Buffer.from("b"), last: true }, "mismatch"],
    ] as const) {
      const run = await start(f.runner, job({ transfer: t }));
      run.feed?.(piece);
      expect(await run.done).toMatchObject({ state: "failed", reason });
    }
    const run = await start(f.runner, job({ transfer: t, deadline: Date.now() + 100 }));
    expect(await run.done).toMatchObject({ state: "timeout" });
  });

  it("sends binary downloads before completion, including an empty last chunk; stops if the link goes", async () => {
    const f = fake(temp(), `process.stdout.write(Buffer.alloc(${CHUNK_MAX + 17}, 255))`);
    const chunks: { seq: number; data: Buffer; last: boolean }[] = [];
    const run = await start(f.runner, job({ transfer: { kind: "download", path: "a", max: CHUNK_MAX * 2 } }), (c) => {
      chunks.push(c);
      return true;
    });
    const done = await run.done;
    expect(chunks.map((c) => [c.seq, c.data.length, c.last])).toEqual([
      [0, CHUNK_MAX, false],
      [1, 17, true],
    ]);
    expect(done).toMatchObject({
      state: "done",
      stdout: "",
      data: { size: CHUNK_MAX + 17, sha256: sha(Buffer.concat(chunks.map((c) => c.data))) },
    });
    const empty = fake(temp(), "process.exit(0)");
    const pieces: number[] = [];
    const zero = await start(empty.runner, job({ transfer: { kind: "download", path: "empty", max: 10 } }), (c) => {
      pieces.push(c.data.length);
      expect(c.last).toBe(true);
      return true;
    });
    expect((await zero.done).data).toMatchObject({ size: 0, sha256: sha("") });
    expect(pieces).toEqual([0]);
    const lost = await start(
      f.runner,
      job({ transfer: { kind: "download", path: "a", max: CHUNK_MAX * 2 } }),
      () => false,
    );
    expect(await lost.done).toMatchObject({ state: "failed", reason: "link_lost" });
    const big = await start(f.runner, job({ transfer: { kind: "download", path: "a", max: 10 } }), () => true);
    expect(await big.done).toMatchObject({ state: "failed", reason: "too_large" });
  });

  it("keeps a real-sized lock file's hash lines verbatim, while other output still gets redacted", async () => {
    const lock = `dependency==1.0 \\\n    --hash=sha256:${"a".repeat(64)}\n`.repeat(3000);
    const f = fake(temp(), `process.stdout.write(${JSON.stringify(lock)})`);
    const run = await start(f.runner, job({ rawStdout: true }));
    expect(await run.done).toMatchObject({ stdout: lock, redacted: { stdout: 0 }, truncated: false });
    const secret = fake(temp(), "process.stdout.write('token=abcdefghijklmnop')");
    const redacted = await start(secret.runner, job());
    expect((await redacted.done).stdout).toBe("token=[REDACTED]");
  });

  it("retains transfer metadata through the ledger, and sends all chunks before the final effect", async () => {
    const d = temp();
    const person = "00000000-0000-4000-8000-0000000000b2";
    const f = preset("box");
    f.seccompBpf = null;
    f.peopleRoot = join(d, "people");
    f.toolsRoot = join(d, "tools");
    mkdirSync(join(f.peopleRoot, person), { recursive: true });
    const raw = JSON.stringify(f);
    const p = parseCeiling(raw);
    if (!p.ok) throw Error(p.problems.join("; "));
    const c = resolveCeiling(p.file, { raw, home: join(d, "state") });
    if (!c.ok) throw Error(c.problems.join("; "));
    const ledger = EffectLedger.open(join(d, "state/effects.jsonl"), { now: Date.now, bootAt: 0 });
    const sent: (Chunk | EffectReport)[] = [];
    const runner = fake(d, "process.stdout.write(Buffer.from([0, 255, 128]))").runner;
    const x = new Executor({
      ledger,
      used: new GrantsUsed(join(d, "state/used.jsonl"), Date.now),
      runnerFor: () => runner,
      env: {},
      now: Date.now,
      log: () => undefined,
      exec: realExec,
      sendChunk: (c) => {
        sent.push(c);
        return true;
      },
      sendEffect: (e) => sent.push(e),
    });
    const call = parseCall({
      t: "call",
      id: "c",
      op: "download.v1",
      effect_id: "eff_download",
      deadline: Date.now() + 30000,
      generation: 1,
      grant: null,
      origin: { person, conversation: "dm", agent: "agent", turn: "input", where: "dm", attended: true },
      args: { box: { person }, path: "a" },
    });
    if (!call) throw Error("call");
    const accepted = await x.take(call, argsHash(call.op, call.args), {
      ceiling: c.ceiling,
      scan: null,
      owner: "admin",
      nodeId: "node",
      generation: 1,
      lbNow: Date.now(),
    });
    expect(accepted).toMatchObject({ ok: true, data: { state: "running" } });
    expect(sent).toHaveLength(0);
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[0]).toMatchObject({ seq: 0, last: true, data: Buffer.from([0, 255, 128]).toString("base64") });
    expect(sent[1]).toMatchObject({ state: "done", data: { path: "a", size: 3 } });
    const reopened = EffectLedger.open(ledger.path, { now: Date.now, bootAt: 0 });
    const entry = reopened.get("eff_download");
    expect(entry && report(entry)).toEqual(sent[1]);
    const cancel = {
      ...call,
      op: "cancel.v1",
      effectId: "eff_cancel",
      args: { target: "eff_download" },
      origin: { ...call.origin, person: "admin", conversation: "dm" } as NonNullable<typeof call.origin>,
    };
    const ctx = { ceiling: c.ceiling, scan: null, owner: "admin", nodeId: "node", generation: 1, lbNow: Date.now() };
    expect(await x.take(cancel, "cancel", ctx)).toMatchObject({ error: { code: "not_owner" } });
    cancel.origin.person = person;
    cancel.origin.conversation = "another-dm";
    expect(await x.take(cancel, "cancel", ctx)).toMatchObject({ error: { code: "effect_conflict" } });
    cancel.origin.conversation = "dm";
    expect(await x.take(cancel, "cancel", ctx)).toMatchObject({ ok: true, data: { reason: "not_running" } });
  });
});

describe.skipIf(process.platform !== "linux" || !existsSync(BWRAP))("real bwrap", () => {
  it("hides other people, collector state and proc; denies network and writes outside the person's directory", async () => {
    const d = temp();
    const own = join(d, "person");
    const other = join(d, "other");
    const state = join(d, "state");
    for (const p of [own, other, state]) mkdirSync(p);
    writeFileSync(join(other, "secret"), "hidden");
    writeFileSync(join(state, "node-key.pem"), "hidden");
    const script = `import os, socket
assert not os.path.exists('/proc/self')
assert not os.path.exists(${JSON.stringify(other)})
assert not os.path.exists(${JSON.stringify(state)})
open('/home/me/result', 'w').write('ok')
try:
    open('/usr/box-denied', 'w')
    raise AssertionError('writable usr')
except OSError:
    pass
try:
    socket.create_connection(('192.0.2.1', 443), timeout=0.1)
    raise AssertionError('network')
except OSError:
    pass
`;
    const s: SandboxSpec = {
      ...sandbox,
      argv: ["/usr/bin/python3", "-I", "-S", "-c", script],
      mounts: [
        { kind: "rw", src: own, dst: "/home/me" },
        { kind: "tmpfs", dst: "/tmp" },
      ],
    };
    const runner = new BwrapRunner({ now: Date.now, log: () => undefined });
    const prepared = await runner.prepareBox(job({ sandbox: s }), { seccomp: null });
    // A Linux host without usable user namespaces is a sandbox refusal, never an unsandboxed run.
    if (!prepared.ok) {
      expect(prepared.code).toBe("sandbox_unavailable");
      expect(existsSync(join(own, "result"))).toBe(false);
      return;
    }
    const run = prepared.prepared.start();
    expect(await run.done).toMatchObject({ state: "done", exit: 0 });
    expect(readFileSync(join(own, "result"), "utf8")).toBe("ok");
  });
});
