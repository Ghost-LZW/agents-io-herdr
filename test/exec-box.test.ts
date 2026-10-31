/** The Box's admission: the turn's person, one installed version, fixed install steps and transfers. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { admitBox, type BoxAdmission, DOWNLOAD_MAX, pathProblem, stagingOf } from "../src/exec/box.ts";
import { capsFor, intersect, parseCeiling, preset, resolveCeiling } from "../src/exec/ceiling.ts";
import { type CallFrame, parseCall, parseExecArgs } from "../src/exec/frames.ts";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/exec-contract.json"), "utf8"));
const calls = fixture.box.frames.call as Record<string, Record<string, unknown>>;
const NOW = 1761300000000;
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const PERSON = "00000000-0000-4000-8000-0000000000b2";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(install = false) {
  const d = mkdtempSync(join(tmpdir(), "aih-box-"));
  dirs.push(d);
  const f = preset(install ? "box-install" : "box");
  f.peopleRoot = join(d, "people");
  f.toolsRoot = join(d, "tools");
  const raw = JSON.stringify(f);
  const p = parseCeiling(raw);
  if (!p.ok) throw Error(p.problems.join("; "));
  const r = resolveCeiling(p.file, { raw, home: join(d, "state"), own: [join(d, "state")] });
  if (!r.ok) throw Error(r.problems.join("; "));
  mkdirSync(join(f.peopleRoot, PERSON), { recursive: true });
  const tool = join(f.toolsRoot, "sheet", "0.1.0-9f2c4e1a7b3d");
  mkdirSync(join(tool, "bin"), { recursive: true });
  const record = {
    name: "sheet",
    version: "0.1.0",
    tree: "9f2c4e1a7b3d5c6e8f0a1b2c3d4e5f6a7b8c9d0e",
    entries: { sheet: "sheet:main" },
    personDir: "rw",
  };
  writeFileSync(join(tool, ".box-tool.json"), JSON.stringify(record));
  writeFileSync(join(tool, "bin/sheet"), "entry");
  const ctx = { ceiling: r.ceiling, owner: OWNER, lbNow: NOW, env: { SECRET_TOKEN: "hidden" } };
  const call = (name: string): CallFrame => {
    const c = parseCall(structuredClone(calls[name] as Record<string, unknown>));
    if (!c) throw Error(name);
    return c;
  };
  const admit = (c: CallFrame) => admitBox(c, ctx);
  const job = (name: string): BoxAdmission => {
    const a = admit(call(name));
    if (!a.ok) throw Error(JSON.stringify(a.answer));
    return a.admission;
  };
  return { d, f, ctx, call, admit, job, record, tool };
}

describe("Box admission", () => {
  it("mounts only the turn's person and named version; the person need not own the node", () => {
    const s = setup();
    const a = s.job("exec_box");
    expect(a.job.sandbox).toEqual({
      network: "off",
      mounts: [
        { kind: "rw", src: join(s.f.peopleRoot, PERSON), dst: "/home/me" },
        { kind: "ro", src: s.tool, dst: "/opt/tool" },
        { kind: "tmpfs", dst: "/tmp" },
      ],
      env: { PATH: "/opt/tool/bin:/usr/bin", HOME: "/home/me", LANG: "C.UTF-8", TZ: "UTC" },
      cwd: "/home/me",
      argv: ["/opt/tool/bin/sheet", "import", "inbox/2026-10.csv"],
    });
    const ro = s.job("exec_box_readonly").job;
    expect(ro.sandbox.mounts[0]?.kind).toBe("ro");
    expect(ro.sandbox.cwd).toBe("/home/me/out");
    expect(ro.stdin).toBe('{"rows":2}\n');
  });

  it("refuses another person's directory, groups, a missing person, another tree and arbitrary commands", () => {
    const s = setup();
    const check = (change: (c: CallFrame) => void, code: string) => {
      const c = s.call("exec_box");
      change(c);
      expect(s.admit(c)).toMatchObject({ ok: false, answer: { error: { code } } });
    };
    check((c) => {
      if (c.origin) c.origin.person = OWNER;
    }, "not_owner");
    check((c) => {
      if (c.origin) c.origin.where = "group";
    }, "never");
    check((c) => {
      c.args.box = {};
    }, "bad_request");
    check((c) => {
      c.args.argv = ["/usr/bin/python3"];
    }, "never");
    check((c) => {
      c.args.argv = ["unknown"];
    }, "never");
    check((c) => {
      c.args.argv = ["sheet", "--input=~/secret"];
    }, "use_relative_path");
    check((c) => {
      c.args.argv = ["sheet", "~/secret"];
    }, "use_relative_path");
    check((c) => {
      c.args.cwd = "~/../other";
    }, "bad_request");
    check((c) => {
      c.args.cwd = "~/";
    }, "bad_request");
    check((c) => {
      c.args.policy = { network: "open", write: [] };
    }, "over_ceiling");
    check((c) => {
      c.args.env = { LANG: "C" };
    }, "over_ceiling");
    writeFileSync(join(s.tool, ".box-tool.json"), JSON.stringify({ ...s.record, tree: "a".repeat(40) }));
    check(() => undefined, "tool_mismatch");
    rmSync(join(s.f.peopleRoot, PERSON), { recursive: true });
    check(() => undefined, "not_found");
    expect(() => readFileSync(join(s.f.peopleRoot, PERSON))).toThrow();
  });

  it("rejects writable calls for a read-only manifest, symlinked person dirs and symlinked tool versions", () => {
    const s = setup();
    writeFileSync(join(s.tool, ".box-tool.json"), JSON.stringify({ ...s.record, personDir: "ro" }));
    expect(s.admit(s.call("exec_box"))).toMatchObject({ answer: { error: { code: "over_ceiling" } } });
    expect(s.admit(s.call("exec_box_readonly")).ok).toBe(true);
    rmSync(s.tool, { recursive: true });
    symlinkSync(s.d, s.tool);
    expect(s.admit(s.call("exec_box"))).toMatchObject({ answer: { error: { code: "tool_mismatch" } } });
    rmSync(join(s.f.peopleRoot, PERSON), { recursive: true });
    symlinkSync(s.d, join(s.f.peopleRoot, PERSON));
    expect(s.admit(s.call("exec_box"))).toMatchObject({ answer: { error: { code: "not_found" } } });
  });

  it("admits every install-cell sample with its exact LB arguments and the step's own mounts", () => {
    const s = setup(true);
    const i = (
      s.call("exec_install").args.box as { install: { name: string; version: string; tree: string; tarSha256: string } }
    ).install;
    const incoming = join(s.f.toolsRoot, ".incoming");
    mkdirSync(incoming);
    writeFileSync(join(incoming, `${i.tarSha256}.tar`), "tar");
    const lock = (s.call("exec_lock").args.box as { install: { tarSha256: string } }).install;
    writeFileSync(join(incoming, `${lock.tarSha256}.requirements.in`), "requirements");
    mkdirSync(join(s.f.toolsRoot, ".staging", stagingOf(i)), { recursive: true });
    for (const step of ["install", "smoke", "commit", "lock"]) {
      const a = s.job(`exec_${step}`);
      expect(a.job.sandbox.argv.slice(0, 5)).toEqual([
        "/usr/bin/python3",
        "-I",
        "-S",
        "/usr/lib/box/box-install",
        step,
      ]);
      expect(a.job.sandbox.cwd).toBe("/");
      expect(a.job.sandbox.network).toBe(["install", "lock"].includes(step) ? "open" : "off");
      expect(a.job.sandbox.mounts.some((m) => "src" in m && m.src.startsWith(s.f.peopleRoot))).toBe(false);
      expect(a.job.rawStdout).toBe(step === "lock");
    }
    expect(s.job("exec_lock").job.sandbox.mounts[0]).toMatchObject({
      kind: "ro",
      src: join(incoming, `${lock.tarSha256}.requirements.in`),
    });
    for (const name of ["exec_box", "upload_person", "download_person"]) {
      const c = s.call(name);
      if (c.origin) c.origin.person = OWNER;
      expect(s.admit(c)).toMatchObject({ answer: { error: { code: "bad_request" } } });
    }
    const c = s.call("exec_smoke");
    c.args.policy = { network: "open", write: [] };
    expect(s.admit(c)).toMatchObject({ answer: { error: { code: "over_ceiling" } } });
    const other = s.call("upload_staging");
    if (other.origin) other.origin.person = PERSON;
    expect(s.admit(other)).toMatchObject({ answer: { error: { code: "not_owner" } } });
  });

  it("uses isolated Python helpers for transfers; caps files and requires content-addressed staging names", () => {
    const s = setup();
    expect(s.job("upload_person").job.sandbox.argv).toEqual([
      "/usr/bin/python3",
      "-I",
      "-S",
      "/usr/lib/box/box-put",
      "--root",
      "/home/me",
      "inbox/2026-10.csv",
      "11",
      "0c7519a734cd41ac2c8fcc599c713091d0dddb2ccd90ecad7f30e4d9575aed40",
    ]);
    expect(s.job("download_person").job.transfer).toMatchObject({ max: DOWNLOAD_MAX });
    const c = s.call("upload_person");
    c.args.size = DOWNLOAD_MAX + 1;
    expect(s.admit(c)).toMatchObject({ answer: { error: { code: "too_large" } } });
    const cell = setup(true);
    expect(cell.job("upload_staging").job.sandbox.argv).toContain("--content-addressed");
    const archive = cell.call("upload_staging");
    archive.args.size = 32 * 1024 * 1024;
    expect(cell.admit(archive).ok).toBe(true);
    expect(cell.job("upload_requirements").job.sandbox.mounts[0]).toEqual({
      kind: "rw",
      src: join(cell.f.toolsRoot, ".incoming"),
      dst: "/home/me",
    });
    const bad = cell.call("upload_staging");
    bad.args.path = "other.tar";
    expect(cell.admit(bad)).toMatchObject({ answer: { error: { code: "bad_request" } } });
  });
});

describe("Box ceiling and paths", () => {
  it("allows open only for box-install, resolves ~ inside bwrap, and announces transfers only there", () => {
    for (const name of ["box", "box-install"] as const) {
      const s = setup(name === "box-install");
      expect(s.ctx.ceiling.home).toBe("/home/me");
      expect(
        capsFor({ ceiling: s.ctx.ceiling, exec: { on: true }, problems: [], scan: null }, { execOnly: true }),
      ).toEqual(["exec.v1", "transfer.v1"]);
    }
    for (const name of ["box", "personal-readonly", "agent-user"] as const) {
      const f = { ...preset(name, { user: "runner" }), network: "open" };
      expect(parseCeiling(JSON.stringify(f)).ok).toBe(false);
    }
    const s = setup();
    const a = parseExecArgs({ argv: ["cat"], cwd: "~", policy: { network: "open", write: [] } });
    expect(intersect(s.ctx.ceiling, a as NonNullable<typeof a>)).toMatchObject({ code: "over_ceiling" });
    const f = { ...s.f, toolsRoot: join(s.d, "state", "tools") };
    expect(resolveCeiling(f, { raw: JSON.stringify(f), home: "/unused", own: [join(s.d, "state")] }).ok).toBe(false);
  });

  it.each(["", "/a", "~a", "a//b", "a/", "a/./b", "a/../b", "a\0b", "é".repeat(257)])("refuses path %j", (path) => {
    expect(pathProblem(path)).not.toBeNull();
  });
  it("accepts relative unicode paths up to 512 bytes", () => {
    for (const p of ["inbox/data.csv", "résumé.csv", "é".repeat(256)]) expect(pathProblem(p)).toBeNull();
  });
});
