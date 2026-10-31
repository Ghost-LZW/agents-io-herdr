/**
 * What goes through ssh between the collector and the dedicated user's forced command (docs/exec.md
 * N9). In: one JSON line (the spec), then the run's stdin bytes, then control lines
 * (`cancel`); EOF means cancel too. Out: frames `[channel u8][length u32be][data]` — 1 stdout,
 * 2 stderr, 9 the end (JSON). The shim forwards at most the ceiling's outputBytes + 4 KiB of each
 * stream and counts the rest; the collector, which redacts, holds it to that: more than one stream's
 * share on that stream (in one frame or in all of them), an empty frame (so the headers stay at most
 * 5 bytes a byte of data, however a long run trickles), an unknown channel or anything after the end
 * is the runner breaking the protocol (`failed`, `runner_protocol`) — the dedicated user can shape
 * these bytes.
 */
import { OVERSHOOT } from "./output.ts";

export const CH_STDOUT = 1;
export const CH_STDERR = 2;
export const CH_END = 9;
/** The end frame's JSON. */
export const END_MAX = 16 * 1024;
/** The spec line (the profile and argv are in it). */
export const SPEC_MAX = 4 * 1024 * 1024;
/** The forced command's subcommands (`SSH_ORIGINAL_COMMAND`). */
export const SHIM_OPS = ["run", "upload", "download", "sweep", "probe"] as const;
export type ShimOp = (typeof SHIM_OPS)[number];

export function frame(ch: number, data: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(ch, 0);
  head.writeUInt32BE(data.length, 1);
  return Buffer.concat([head, data]);
}

/** One stream's frames: pieces of at most `max` bytes. */
export function frames(ch: number, data: Buffer, max: number): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += max) out.push(frame(ch, data.subarray(i, i + max)));
  return out;
}

export class WireError extends Error {}

export interface Frame {
  ch: number;
  data: Buffer;
}

/** Reads frames as they come, within the limits for one run's output. */
export class FrameReader {
  #buf: Buffer = Buffer.alloc(0);
  /** Data so far on each stream (the headers are not counted: each frame carries some). */
  #seen = new Map<number, number>([
    [CH_STDOUT, 0],
    [CH_STDERR, 0],
  ]);
  #ended = false;
  /** One stream's share, which is also the most one frame of it may carry. */
  readonly frameMax: number;

  constructor(outputBytes: number) {
    this.frameMax = outputBytes + OVERSHOOT;
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** The frames complete so far; throws WireError when the bytes break the protocol. */
  push(b: Buffer): Frame[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, b]) : b;
    const out: Frame[] = [];
    while (this.#buf.length >= 5) {
      if (this.#ended) throw new WireError("bytes after the end frame");
      const ch = this.#buf.readUInt8(0);
      const len = this.#buf.readUInt32BE(1);
      if (ch !== CH_STDOUT && ch !== CH_STDERR && ch !== CH_END) throw new WireError(`unknown channel ${ch}`);
      if (len > (ch === CH_END ? END_MAX : this.frameMax))
        throw new WireError(`a frame of ${len} bytes on channel ${ch}`);
      // Told by the header alone: nothing is buffered for a frame that would go past the share.
      const seen = this.#seen.get(ch);
      if (seen !== undefined) {
        if (len === 0) throw new WireError(`an empty frame on channel ${ch}`);
        if (seen + len > this.frameMax) throw new WireError(`more than ${this.frameMax} bytes on channel ${ch}`);
      }
      if (this.#buf.length < 5 + len) break;
      if (seen !== undefined) this.#seen.set(ch, seen + len);
      out.push({ ch, data: Buffer.from(this.#buf.subarray(5, 5 + len)) });
      this.#buf = this.#buf.subarray(5 + len);
      if (ch === CH_END) this.#ended = true;
    }
    if (this.#ended && this.#buf.length) throw new WireError("bytes after the end frame");
    return out;
  }

  /** The stream has closed: anything left over is a frame cut short. */
  close(): void {
    if (this.#buf.length) throw new WireError("a frame cut short");
  }
}

/**
 * Reads a stream piece by piece: a line, then a number of bytes, then lines again. Returns null at
 * the end of the stream.
 */
export class StreamReader {
  #buf: Buffer = Buffer.alloc(0);
  #ended = false;
  #wake: (() => void) | null = null;

  constructor(stream: NodeJS.ReadableStream) {
    stream.on("data", (b: Buffer | string) => {
      this.#buf = Buffer.concat([this.#buf, typeof b === "string" ? Buffer.from(b) : b]);
      this.#wake?.();
    });
    stream.on("end", () => {
      this.#ended = true;
      this.#wake?.();
    });
    stream.on("error", () => {
      this.#ended = true;
      this.#wake?.();
    });
  }

  async #more(): Promise<boolean> {
    if (this.#ended) return false;
    await new Promise<void>((r) => {
      this.#wake = r;
    });
    this.#wake = null;
    return true;
  }

  /** A line without its newline; null at the end; throws past `max` bytes. */
  async line(max: number): Promise<string | null> {
    for (;;) {
      const nl = this.#buf.indexOf(10);
      if (nl >= 0) {
        const s = this.#buf.subarray(0, nl).toString("utf8");
        this.#buf = this.#buf.subarray(nl + 1);
        return s;
      }
      if (this.#buf.length > max) throw new WireError(`a line longer than ${max} bytes`);
      if (!(await this.#more())) return null;
    }
  }

  /** Exactly `n` bytes; null when the stream ends first. */
  async bytes(n: number): Promise<Buffer | null> {
    while (this.#buf.length < n) if (!(await this.#more())) return null;
    const b = Buffer.from(this.#buf.subarray(0, n));
    this.#buf = this.#buf.subarray(n);
    return b;
  }
}
