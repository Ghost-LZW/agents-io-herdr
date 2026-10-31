/**
 * The exec.v1 contract (docs/exec.md, the contract fixture): every sample in test/fixtures/exec-contract.json, which LB
 * keeps a verbatim copy of. Frames LB sends are read without losing a field; frames this machine
 * sends are built deep-equal to the sample; both hashes come out as written there.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOWNLOAD_MAX, PATH_MAX } from "../src/exec/box.ts";
import { preset } from "../src/exec/ceiling.ts";
import {
  argsHash,
  BOX_REFUSALS,
  CHUNK_MAX,
  CLOSE_BAD_HELLO,
  CLOSE_GENERATION,
  CLOSE_PENDING,
  CLOSE_REFUSED,
  CLOSE_REPLACED,
  CLOSE_SILENT,
  type Command,
  canonical,
  chunkFrame,
  commandHash,
  DATA_MAX,
  type EffectReport,
  effectFrame,
  FINAL_STATES,
  helloFrame,
  parseCall,
  parseChunk,
  parseEffectAck,
  parseWelcome,
  REFUSALS,
  type RefusalCode,
  refuse,
  resultFrame,
  VERSION,
} from "../src/exec/frames.ts";

type Frame = Record<string, unknown>;
interface Contract {
  close: Record<string, string>;
  refusals: string[];
  limits: { errorDataBytes: number; chunkBytes: number };
  frames: {
    hello: Record<"v1" | "v2" | "v2_no_ceiling", Frame>;
    welcome: Record<"v1" | "v2" | "v2_exec_off", Frame>;
    call: Record<string, Frame>;
    result: { accepted: Frame; known_done: Frame; refused: Record<string, Frame> };
    effect: Record<string, Frame>;
    effect_ack: Frame;
    chunk: Record<"upload" | "download", Frame>;
  };
  hashes: {
    argsHash: { op: string; args: Frame; canonical: string; sha256: string }[];
    commandHash: { command: Command; canonical: string; sha256: string }[];
  };
}

interface BoxContract {
  contract: string;
  notes: string[];
  refusals: string[];
  limits: { fileBytes: number; pathBytes: number; maxSeconds: number };
  frames: {
    call: Record<string, Frame>;
    result: { accepted_box: Frame; accepted_install: Frame; accepted_transfer: Frame; refused: Record<string, Frame> };
    effect: Record<string, Frame & EffectReport>;
    chunk: Record<string, Frame>;
  };
  hashes: Pick<Contract["hashes"], "argsHash">;
}

const C = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "exec-contract.json"), "utf8")) as Contract;
const F = C.frames;
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const B = (C as Contract & { box: BoxContract }).box;

describe("exec contract", () => {
  it("names the close codes and refusal codes this side uses", () => {
    expect(C.close).toEqual({
      [CLOSE_BAD_HELLO]: "bad_hello",
      [CLOSE_PENDING]: "pending",
      [CLOSE_REFUSED]: "refused",
      [CLOSE_SILENT]: "silent",
      [CLOSE_REPLACED]: "replaced",
      [CLOSE_GENERATION]: "generation_changed",
    });
    expect([...C.refusals, ...BOX_REFUSALS]).toEqual([...REFUSALS]);
    expect(C.limits).toMatchObject({ errorDataBytes: DATA_MAX, chunkBytes: CHUNK_MAX });
  });

  it("builds hello v2 as the samples, with and without a ceiling; v1 is what older collectors send", () => {
    for (const k of ["v2", "v2_no_ceiling"] as const) {
      const s = F.hello[k] as Frame & { caps: string[]; generation: number; ceiling?: never; clock: number };
      const built = helloFrame({
        node: s.node as string,
        sig: s.sig as string,
        machine: s.machine as { name: string; platform: string },
        state: { caps: s.caps, generation: s.generation, ceiling: s.ceiling ?? null },
        clock: s.clock,
      });
      expect(built).toEqual(s);
      expect(built.version).toBe(VERSION);
    }
    expect(F.hello.v1.version).toBe("agents-io-herdr-sessions/1");
    expect(F.hello.v1).not.toHaveProperty("generation");
  });

  it("reads welcome v2, and an old LB's bare welcome as no generation (exec stays off)", () => {
    expect(parseWelcome(F.welcome.v1)).toEqual({ generation: null, owner: null, now: null, exec: false });
    expect(parseWelcome(F.welcome.v2)).toEqual({
      generation: F.welcome.v2.generation,
      owner: F.welcome.v2.owner,
      now: F.welcome.v2.now,
      exec: true,
    });
    expect(parseWelcome(F.welcome.v2_exec_off).exec).toBe(false);
  });

  it("reads every call without losing a field; the args hash is of the args as sent", () => {
    for (const [name, f] of Object.entries(F.call)) {
      const c = parseCall(f);
      expect(c, name).not.toBeNull();
      expect(c?.id).toBe(f.id);
      expect(c?.op).toBe(f.op);
      expect(c?.args).toEqual(f.args);
      if (f.op === "session.read") continue;
      expect(c?.effectId, name).toBe(f.effect_id);
      expect(c?.deadline).toBe(f.deadline);
      expect(c?.generation).toBe(f.generation);
      expect(c?.origin, name).toEqual(f.origin);
      expect(c?.grant).toEqual(f.grant);
      const listed = C.hashes.argsHash.find((h) => h.op === f.op && canonical(h.args) === canonical(f.args));
      expect(listed, name).toBeDefined();
      expect(argsHash(f.op as string, f.args as Frame)).toBe(listed?.sha256);
    }
    // The once grant names the command it was given for.
    const g = F.call.exec_group_granted as {
      args: { argv: string[]; cwd: string; shell: boolean; policy: { network: "off" | "proxy"; write: string[] } };
      grant: { commandHash: string };
    };
    const { argv, cwd, shell, policy } = g.args;
    expect(commandHash({ argv, cwd, shell, network: policy.network, write: policy.write })).toBe(g.grant.commandHash);
  });

  it("builds every result as the samples: accepted, a known effect, each refusal with its error.data", () => {
    for (const r of [F.result.accepted, F.result.known_done])
      expect(resultFrame(r.id as string, { ok: true, data: r.data })).toEqual(r);
    expect(Object.keys(F.result.refused).sort()).toEqual([...C.refusals].sort());
    for (const [code, r] of Object.entries(F.result.refused)) {
      const e = r.error as { message: string; data?: Frame };
      expect(resultFrame(r.id as string, refuse(code as RefusalCode, e.message, e.data))).toEqual(r);
    }
    // error.data over 4 KiB is left out, never cut into something LB cannot read.
    const big = resultFrame("c", refuse("needs_grant", "", { pad: "x".repeat(DATA_MAX) }));
    expect(big).toEqual({ t: "result", id: "c", ok: false, error: { code: "needs_grant", message: "" } });
  });

  it("builds every effect state as the samples; the hashes are of the redacted text in the frame", () => {
    const keys: (keyof EffectReport)[] = [
      "effect_id",
      "state",
      "exit",
      "signal",
      "stdout",
      "stderr",
      "redacted",
      "truncated",
      "bytes",
      "sha256",
      "startedAt",
      "endedAt",
      "grant",
      "reason",
    ];
    const states = new Set<string>();
    for (const [name, f] of Object.entries(F.effect)) {
      const { t, ...r } = f as Frame & EffectReport;
      expect(t).toBe("effect");
      expect(Object.keys(r).sort(), name).toEqual([...keys].sort());
      expect(effectFrame(r as EffectReport)).toEqual(f);
      expect(r.sha256).toEqual({ stdout: sha(r.stdout), stderr: sha(r.stderr) });
      states.add(r.state);
    }
    expect([...states].sort()).toEqual([...FINAL_STATES].sort());
    // A known effect is answered with the same fields, without `t`.
    const { t: _, ...done } = F.effect.done as Frame;
    expect(F.result.known_done.data).toEqual(done);
    expect(parseEffectAck(F.effect_ack)).toBe(F.effect_ack.effect_id);
    expect(parseEffectAck({ t: "effect_ack", effect_id: "not-an-effect" })).toBeNull();
  });

  it("reads an upload chunk and builds a download chunk as the samples", () => {
    const { t: _, ...up } = F.chunk.upload;
    expect(parseChunk(F.chunk.upload)).toEqual(up);
    const { t: __, ...down } = F.chunk.download;
    expect(chunkFrame(down as never)).toEqual(F.chunk.download);
    expect(parseChunk({ ...F.chunk.upload, data: "!!" })).toBeNull();
    expect(parseChunk({ ...F.chunk.upload, data: Buffer.alloc(CHUNK_MAX + 1).toString("base64") })).toBeNull();
  });

  it("works out both hashes as written: canonical JSON, policy.write sorted, other arrays in order", () => {
    for (const h of C.hashes.argsHash) {
      expect(argsHash(h.op, h.args)).toBe(h.sha256);
      expect(sha(h.canonical)).toBe(h.sha256);
    }
    for (const h of C.hashes.commandHash) {
      expect(commandHash(h.command)).toBe(h.sha256);
      expect(canonical({ ...h.command, write: [...h.command.write].sort() })).toBe(h.canonical);
      expect(sha(h.canonical)).toBe(h.sha256);
    }
    // argv order matters; write order does not.
    const c = C.hashes.commandHash[0]?.command as Command;
    expect(commandHash({ ...c, write: [...c.write].reverse() })).toBe(commandHash(c));
    expect(commandHash({ ...c, argv: [...c.argv].reverse() })).not.toBe(commandHash(c));
    expect(canonical({ b: 1, a: [2, { d: null, c: "é" }], u: undefined })).toBe('{"a":[2,{"c":"é","d":null}],"b":1}');
  });
});

describe("Box contract", () => {
  it("keeps its notes, additional refusal codes and limits alongside B's unchanged samples", () => {
    expect(B.contract).toContain("s7-box");
    expect(B.notes.length).toBeGreaterThan(0);
    expect(B.refusals).toEqual([...BOX_REFUSALS]);
    expect(B.limits).toEqual({
      fileBytes: DOWNLOAD_MAX,
      pathBytes: PATH_MAX,
      maxSeconds: preset("box").limits.maxSeconds,
    });
  });

  it("reads all Box and install calls without losing args.box or the origin, and hashes the exact arguments", () => {
    for (const [name, f] of Object.entries(B.frames.call)) {
      const c = parseCall(f);
      expect(c, name).not.toBeNull();
      expect(c).toMatchObject({
        id: f.id,
        op: f.op,
        effectId: f.effect_id,
        deadline: f.deadline,
        generation: f.generation,
        grant: f.grant,
        origin: f.origin,
        args: f.args,
      });
      const h = B.hashes.argsHash.find((h) => h.op === f.op && canonical(h.args) === canonical(f.args));
      expect(h, name).toBeDefined();
      expect(argsHash(f.op as string, f.args as Frame)).toBe(h?.sha256);
    }
    for (const h of B.hashes.argsHash) {
      expect(argsHash(h.op, h.args)).toBe(h.sha256);
      expect(sha(h.canonical)).toBe(h.sha256);
    }
  });

  it("builds each accepted or refused result and every effect, including optional transfer data and intact lock hashes", () => {
    for (const f of [B.frames.result.accepted_box, B.frames.result.accepted_install, B.frames.result.accepted_transfer])
      expect(resultFrame(f.id as string, { ok: true, data: f.data })).toEqual(f);
    expect(Object.keys(B.frames.result.refused)).toEqual([...BOX_REFUSALS]);
    for (const [code, f] of Object.entries(B.frames.result.refused)) {
      const e = f.error as { message: string };
      expect(resultFrame(f.id as string, refuse(code as RefusalCode, e.message))).toEqual(f);
    }
    for (const f of Object.values(B.frames.effect)) {
      const { t, ...r } = f;
      expect(t).toBe("effect");
      expect(effectFrame(r)).toEqual(f);
      expect(r.sha256).toEqual({ stdout: sha(r.stdout), stderr: sha(r.stderr) });
    }
    expect(B.frames.effect.lock_done?.stdout).toContain("--hash=sha256:");
    expect(B.frames.effect.upload_done?.data).toMatchObject({ path: "inbox/2026-10.csv", size: 11 });
  });

  it("reads and builds every binary transfer chunk unchanged", () => {
    for (const f of Object.values(B.frames.chunk)) {
      const { t, ...c } = f;
      expect(t).toBe("chunk");
      expect(parseChunk(f)).toEqual(c);
      expect(chunkFrame(c as never)).toEqual(f);
    }
  });
});
