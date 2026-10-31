/**
 * A run's output before it leaves the machine (docs/exec.md N6; acceptance case 12): redacted
 * whole, then cut at a line end; a token across the cut, and a private key cut off before its END
 * line, never get through; four more forms (Alibaba Cloud and AWS temporary key ids, OpenRouter keys,
 * a cut-off PEM key). Every secret here is made up, and token-shaped ones are put together at run
 * time so no scanner takes the source for a leak.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EffectLedger, report } from "../src/exec/effects.ts";
import { effectFrame, FRAME_MAX } from "../src/exec/frames.ts";
import {
  BoundedSink,
  cutAtLine,
  cutEscaped,
  dropCutWord,
  ESCAPED_MAX,
  escapedBytes,
  finishOutput,
  OVERSHOOT,
} from "../src/exec/output.ts";
import { REDACTED, redact } from "../src/redact.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** A made-up key body, 64 base64 characters like a PEM line. */
const PEM_BODY = `MIIE${"x0Fake".repeat(10)}`;
const LTAI_ID = ["LTAI", "5tAbCdEfGh1234567890"].join("");
const ASIA_ID = ["ASIA", "ABCDEFGHIJKLMNOP"].join("");

describe("redact: four more forms", () => {
  it("hides Alibaba Cloud and AWS temporary key ids and OpenRouter keys, keeping the prefix", () => {
    const cases: [string, string, string][] = [
      [`ALIYUN_ID=${LTAI_ID}`, `LTAI${REDACTED}`, "5tAbCdEfGh1234567890"],
      [`aws_access_key_id = ${ASIA_ID}`, `ASIA${REDACTED}`, "ABCDEFGHIJKLMNOP"],
      [`key: sk-or-v1-${"0a".repeat(32)}`, `sk-or-${REDACTED}`, "0a0a0a0a"],
    ];
    for (const strict of [false, true])
      for (const [input, expected, secret] of cases) {
        const r = redact(input, { strict });
        expect(r.text, input).toContain(expected);
        expect(r.text, input).not.toContain(secret);
        expect(redact(r.text, { strict }).text, input).toBe(r.text);
      }
    for (const s of ["LTAI is short", "ASIA/Shanghai", "the sk-or key"]) expect(redact(s).text, s).toBe(s);
  });

  it("hides a private key with no END line from its BEGIN line to the end; a whole one stays as before", () => {
    const cut = `before\n-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n${PEM_BODY.slice(0, 20)}`;
    const r = redact(cut);
    expect(r.text).toBe(`before\n-----BEGIN RSA PRIVATE KEY----- ${REDACTED}`);
    expect(r.count).toBe(1);
    expect(redact(r.text)).toEqual({ text: r.text, count: 0 });
    const whole = `-----BEGIN EC PRIVATE KEY-----\n${PEM_BODY}\n-----END EC PRIVATE KEY-----\nafter`;
    expect(redact(whole).text).toBe(`-----BEGIN EC PRIVATE KEY----- ${REDACTED} -----END EC PRIVATE KEY-----\nafter`);
    // A whole key and then a cut one: each in its own way.
    const both = redact(`${whole}\n-----BEGIN OPENSSH PRIVATE KEY-----\n${PEM_BODY}`);
    expect(both.text).toContain("-----END EC PRIVATE KEY-----\nafter\n-----BEGIN OPENSSH PRIVATE KEY----- [REDACTED]");
    expect(both.text).not.toContain(PEM_BODY);
  });
});

describe("output", () => {
  it("redacts every token form, counts the places, and the ledger hashes the redacted text (I-12)", () => {
    const out = new BoundedSink(65_536);
    const err = new BoundedSink(65_536);
    out.write("deploy key lba_Q1w2E3r4T5y6U7i8\nagents agk_z9x8c7v6b5n4\n");
    out.write(Buffer.from("curl -H 'Authorization: Bearer abc.def.ghi' x\npassword=hunterpass\n"));
    err.write("token=abcdefgh\n");
    const o = finishOutput(out, err);
    for (const secret of ["Q1w2E3r4T5y6U7i8", "z9x8c7v6b5n4", "abc.def.ghi", "hunterpass", "abcdefgh"]) {
      expect(o.stdout + o.stderr).not.toContain(secret);
    }
    expect(o.redacted).toEqual({ stdout: 4, stderr: 1 });
    expect(o.stdout.split(REDACTED).length - 1).toBe(4);
    expect(o.truncated).toBe(false);
    expect(o.bytes.stdout).toBe(
      Buffer.byteLength("deploy key lba_Q1w2E3r4T5y6U7i8\nagents agk_z9x8c7v6b5n4\n") +
        Buffer.byteLength("curl -H 'Authorization: Bearer abc.def.ghi' x\npassword=hunterpass\n"),
    );
    const dir = mkdtempSync(join(tmpdir(), "aio-herdr-out-"));
    dirs.push(dir);
    const l = new EffectLedger(join(dir, "effects.jsonl"), () => 1_000);
    l.claim({
      effect_id: "eff_out1",
      op: "exec.v1",
      argsHash: "a".repeat(64),
      generation: 1,
      deadline: 9_000,
      grant: null,
    });
    const done = l.finish("eff_out1", { state: "done", exit: 0, signal: null, reason: null, ...o });
    expect(done?.sha256).toEqual({ stdout: sha256(o.stdout), stderr: sha256(o.stderr) });
  });

  it("a token across the outputBytes line is redacted whole, then the text is cut at a line end (I-12)", () => {
    const limit = 1024;
    const token = `ghp_${"A1b2".repeat(9)}`;
    const head = `${"x".repeat(limit - 20)}\n`;
    const sink = new BoundedSink(limit);
    sink.write(`${head}secret ${token} here\nmore\n`);
    const r = sink.finish();
    expect(r.text).not.toContain("A1b2A1b2");
    expect(r.text).toBe(head);
    expect(r.truncated).toBe(true);
    expect(r.redacted).toBe(1);
    expect(r.bytes).toBe(Buffer.byteLength(`${head}secret ${token} here\nmore\n`));
  });

  it("past what is kept, the word the cut fell in is dropped: half a token is never sent", () => {
    const limit = 1024;
    // A whole key early shrinks to a line when redacted, which pulls the end of what was kept inside
    // the limit; that end falls in a token too short there for any rule to know it.
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${`${PEM_BODY}\n`.repeat(70)}-----END RSA PRIVATE KEY-----\n`;
    const kept = limit + OVERSHOOT;
    // The cut falls 10 bytes into the token.
    const before = `${key}${"z".repeat(kept - 10 - Buffer.byteLength(key) - 6)}\nnext `;
    expect(Buffer.byteLength(before)).toBe(kept - 10);
    const token = `ghp_${"A1b2".repeat(9)}`;
    const sink = new BoundedSink(limit);
    sink.write(`${before}${token} and more\n`);
    const r = sink.finish();
    expect(r.truncated).toBe(true);
    expect(r.text).not.toContain("ghp_");
    expect(r.text.endsWith("next ")).toBe(true);
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(limit);
  });

  it("one long line with no space in it (base64, minified code) cut short: its head is kept, not the whole of it dropped", () => {
    const limit = 1024;
    const b64 = new BoundedSink(limit);
    b64.write(Buffer.alloc(300_000, "QUJD"));
    const r = b64.finish();
    expect(r.truncated).toBe(true);
    expect(r.text).toBe("QUJD".repeat(256));
    // The cut falls inside a token at the end of the run: its last OVERSHOOT characters go, the token with them.
    const run = new BoundedSink(limit);
    run.write(`${"x".repeat(limit + OVERSHOOT - 10)}ghp_${"A1b2".repeat(9)}${"y".repeat(100)}`);
    const t = run.finish();
    expect(t.text).toBe("x".repeat(limit));
    expect(t.text).not.toContain("ghp_");
    expect(dropCutWord("a b😀cd")).toBe("a ");
    expect(dropCutWord(`${"😀".repeat(OVERSHOOT / 2 + 1)}x`)).toBe("😀");
    expect(dropCutWord(`k=${REDACTED}`)).toBe(`k=${REDACTED}`);
    expect(dropCutWord("ends in a space ")).toBe("ends in a space ");
  });

  it("a private key cut off by the limit is hidden from its BEGIN line on (I-12)", () => {
    const limit = 1024;
    const sink = new BoundedSink(limit);
    const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${`${PEM_BODY}\n`.repeat(200)}-----END OPENSSH PRIVATE KEY-----\n`;
    sink.write(`listing\n${key}`);
    const r = sink.finish();
    expect(r.text).toBe(`listing\n-----BEGIN OPENSSH PRIVATE KEY----- ${REDACTED}`);
    expect(r.text).not.toContain(PEM_BODY.slice(0, 12));
    expect(r.truncated).toBe(true);
  });

  it("keeps the effect frame under LB's 2 MiB however much of the output JSON has to escape", () => {
    // 512 KiB of control characters (colour codes, a binary) is 3 MiB in JSON: LB would close with 1009
    // and the effect, never acknowledged, would go again after every reconnect.
    const line = `${"\x1b[0m\x01\x02".repeat(8)}\n`;
    const out = new BoundedSink(524_288);
    const err = new BoundedSink(524_288);
    for (let n = 0; n < 20_000; n++) {
      out.write(line);
      err.write(line);
    }
    const o = finishOutput(out, err);
    expect(o.truncated).toBe(true);
    for (const t of [o.stdout, o.stderr]) {
      expect(escapedBytes(t)).toBeLessThanOrEqual(ESCAPED_MAX);
      expect(escapedBytes(t)).toBeGreaterThan(ESCAPED_MAX - escapedBytes(line));
      expect(t.endsWith("\n")).toBe(true);
    }
    const dir = mkdtempSync(join(tmpdir(), "aio-herdr-out-"));
    dirs.push(dir);
    const l = new EffectLedger(join(dir, "effects.jsonl"), () => 1_000);
    l.claim({
      effect_id: "eff_big1",
      op: "exec.v1",
      argsHash: "a".repeat(64),
      generation: 1,
      deadline: 9_000,
      grant: null,
    });
    const done = l.finish("eff_big1", { state: "done", exit: 0, signal: null, reason: null, ...o });
    if (!done) throw new Error("not finished");
    const frame = JSON.stringify(effectFrame(report(done)));
    expect(Buffer.byteLength(frame)).toBeLessThan(FRAME_MAX);
    expect(done.sha256.stdout).toBe(sha256(o.stdout));
    // Plain text up to the limit is never cut by this.
    const plain = new BoundedSink(524_288);
    plain.write(`${"x".repeat(1023)}\n`.repeat(512));
    expect(plain.finish().truncated).toBe(false);
  });

  it("cuts JSON-escaped size at a line end or a whole character, never inside a surrogate pair", () => {
    expect(escapedBytes('a"\\\n\x01é😀')).toBe(1 + 2 + 2 + 2 + 6 + 2 + 4);
    expect(cutEscaped("ab\n\x01\x01\n", 10)).toBe("ab\n");
    expect(cutEscaped("😀😀😀", 9)).toBe("😀😀");
    expect(cutEscaped("\x01\x01", 11)).toBe("\x01");
    expect(cutEscaped("short", 64)).toBe("short");
  });

  it("cuts on a character boundary when there is no line end; keeps short output whole", () => {
    expect(cutAtLine("ab\ncd\nef", 7)).toBe("ab\ncd\n");
    expect(cutAtLine("一二三四", 7)).toBe("一二");
    expect(cutAtLine("short", 64)).toBe("short");
    const s = new BoundedSink(2048);
    s.write("line one\n");
    s.write("line two\n");
    expect(s.finish()).toEqual({ text: "line one\nline two\n", redacted: 0, truncated: false, bytes: 18 });
  });
});
