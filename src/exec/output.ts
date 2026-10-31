/**
 * What a run's output becomes before it leaves the machine (docs/exec.md N6): each
 * stream is kept up to the ceiling's `outputBytes` plus 4 KiB, redacted whole (strict, as the session
 * collector does), and only then cut to `outputBytes` at a line end. Cutting first would split a token
 * and let half of it through.
 *
 * - When the stream was longer than what was kept, the last word of the kept part (a token cut off
 *   mid-way, `password=hun`, which no rule can tell) goes once the rest is redacted — all of it, or
 *   of a long run with no space in it (base64, minified code) only its last OVERSHOOT characters,
 *   which is more than a token is long; the run itself is redacted whole first.
 * - A PEM private key cut off before its END line is hidden from its BEGIN line on (src/redact.ts).
 * - `bytes` counts everything the stream gave, before redaction; `truncated` says some of it is not in
 *   the text; `redacted` counts the places hidden; the ledger hashes the text that goes out.
 * - The text is also cut to ESCAPED_MAX as JSON escapes it, so the `effect` frame fits FRAME_MAX.
 */
import { REDACTED, redact } from "../redact.ts";
import type { Pair } from "./frames.ts";

/** Kept beyond the limit, so a token across the cut is whole when redaction sees it. */
export const OVERSHOOT = 4096;

/**
 * At most this many bytes of a stream once escaped in a JSON string. `outputBytes` counts UTF-8,
 * but a control character takes six bytes in JSON (`\u001b`): 512 KiB of them would be 3 MiB, and LB
 * closes the connection on a frame over FRAME_MAX (1009) — the effect, never acknowledged, would go
 * again after every reconnect. Two streams at this and the rest of the frame stay under 2 MiB.
 */
export const ESCAPED_MAX = 768 * 1024;

/** Bytes `s` takes inside a JSON string (what JSON.stringify makes of it, less the quotes). */
export const escapedBytes = (s: string): number => Buffer.byteLength(JSON.stringify(s), "utf8") - 2;

export interface StreamOutput {
  text: string;
  /** Places hidden. */
  redacted: number;
  /** Some of the stream is not in `text`. */
  truncated: boolean;
  /** Everything the stream gave, before redaction. */
  bytes: number;
}

/** One stream of a run (stdout or stderr), bounded. */
export class BoundedSink {
  readonly limit: number;
  #chunks: Buffer[] = [];
  #kept = 0;
  #bytes = 0;

  #redact: boolean;

  constructor(limit: number, o: { redact?: boolean } = {}) {
    this.limit = limit;
    this.#redact = o.redact !== false;
  }

  get bytes(): number {
    return this.#bytes;
  }

  write(data: Buffer | string): void {
    const b = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    this.#bytes += b.length;
    const room = this.limit + OVERSHOOT - this.#kept;
    if (room <= 0) return;
    const part = b.length > room ? b.subarray(0, room) : b;
    this.#chunks.push(Buffer.from(part));
    this.#kept += part.length;
  }

  /**
   * Bytes the stream gave that never reached this sink (the dedicated user's shim forwards only what
   * a sink keeps and counts the rest): they count in `bytes`, and the text is cut.
   */
  unseen(n: number): void {
    if (n > 0) this.#bytes += n;
  }

  /** Redacted, then cut to the limit at a line end. */
  finish(): StreamOutput {
    const raw = Buffer.concat(this.#chunks).toString("utf8");
    const cut = this.#bytes > this.#kept;
    const r = this.#redact ? redact(raw, { strict: true }) : { text: raw, count: 0 };
    // The stream went on past what was kept: whatever word the cut fell in is unknowable; drop it.
    let text = cut && this.#redact ? dropCutWord(r.text) : r.text;
    let truncated = cut;
    if (Buffer.byteLength(text, "utf8") > this.limit) {
      text = cutAtLine(text, this.limit);
      truncated = true;
    }
    if (escapedBytes(text) > ESCAPED_MAX) {
      text = cutEscaped(text, ESCAPED_MAX);
      truncated = true;
    }
    return { text, redacted: r.count, truncated, bytes: this.#bytes };
  }
}

/**
 * Without the word at the end (a token the cut fell in): the whole word, or of a run longer than
 * OVERSHOOT characters only its last OVERSHOOT — dropping a single long line whole (`base64 file`,
 * minified JSON) would leave nothing at all. A word that ends hidden (a key with no END line) stays.
 * Never between the halves of a surrogate pair.
 */
export function dropCutWord(text: string): string {
  const m = /\S+$/.exec(text);
  if (!m || m[0].endsWith(REDACTED)) return text;
  let end = m[0].length <= OVERSHOOT ? m.index : text.length - OVERSHOOT;
  const c = text.charCodeAt(end);
  if (c >= 0xdc00 && c <= 0xdfff) end--;
  return text.slice(0, end);
}

/** At most `limit` bytes of UTF-8: up to the last line end within them, or (one long line) the last whole character. */
export function cutAtLine(text: string, limit: number): string {
  const b = Buffer.from(text, "utf8");
  if (b.length <= limit) return text;
  let end = limit;
  // Not inside a character: a continuation byte is 10xxxxxx.
  while (end > 0 && ((b[end] ?? 0) & 0xc0) === 0x80) end--;
  const head = b.subarray(0, end).toString("utf8");
  const nl = head.lastIndexOf("\n");
  return nl >= 0 ? head.slice(0, nl + 1) : head;
}

/** At most `max` bytes JSON-escaped (escapedBytes): up to the last line end within them, or the last whole character. */
export function cutEscaped(text: string, max: number): string {
  if (escapedBytes(text) <= max) return text;
  let used = 0;
  let end = 0;
  // By code point, so a surrogate pair is never split.
  for (const ch of text) {
    used += escapedBytes(ch);
    if (used > max) break;
    end += ch.length;
  }
  const head = text.slice(0, end);
  const nl = head.lastIndexOf("\n");
  return nl >= 0 ? head.slice(0, nl + 1) : head;
}

/** Both streams as the ledger's outcome and the `effect` frame carry them. */
export function finishOutput(stdout: BoundedSink, stderr: BoundedSink) {
  const o = stdout.finish();
  const e = stderr.finish();
  return {
    stdout: o.text,
    stderr: e.text,
    redacted: { stdout: o.redacted, stderr: e.redacted } satisfies Pair<number>,
    truncated: o.truncated || e.truncated,
    bytes: { stdout: o.bytes, stderr: e.bytes } satisfies Pair<number>,
  };
}
