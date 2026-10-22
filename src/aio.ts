/**
 * A host connection to an agents-io daemon (`aio serve`): JSONL over its unix socket, requests
 * answered by `result` frames with the same id (agents-io `docs/HOSTS.md` §4). The token is read
 * from the 0600 file next to the socket on every connect (the daemon makes a new one each start).
 *
 * With `consumer` the connection push-consumes the host inbound queue: the daemon sends one
 * `inbound` frame at a time and moves on once it is answered `{ accepted: true }`. The client
 * reconnects with backoff and says hello with `takeover`, so a restarted host replaces a half-open
 * connection of its previous self.
 */
import { readFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import type { Frame, HostHelloResult, InboundItem, ResultFrame } from "./protocol.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";

export class AioError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type AioState = "connecting" | "online" | "offline";

export interface AioClientOptions {
  socket: string;
  /** Default `<socket>.token`. */
  tokenFile?: string;
  name: string;
  /** Push-consume the host inbound queue as this consumer (makes this connection the host). */
  consumer?: string;
  /** Takes `inbound` pushes; resolve true once the item is durably taken. */
  onInbound?: (item: InboundItem) => Promise<boolean>;
  /** After each successful hello (push the binding table here). */
  onReady?: (hello: HostHelloResult) => Promise<void> | void;
  onState?: (state: AioState, detail?: string) => void;
  log?: (msg: string) => void;
  /** First reconnect delay; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** Reconnect after a drop (default true; one-shot CLI connections say false). */
  reconnect?: boolean;
}

interface Pending {
  resolve: (f: ResultFrame) => void;
  timer: NodeJS.Timeout;
}

export class AioClient {
  readonly #o: AioClientOptions;
  #socket: Socket | null = null;
  #pending = new Map<string, Pending>();
  #seq = 0;
  #state: AioState = "offline";
  #stopped = true;
  #retryMs: number;
  #timer: NodeJS.Timeout | null = null;
  #readyWaiters: ((ok: boolean) => void)[] = [];
  hello: HostHelloResult | null = null;

  constructor(o: AioClientOptions) {
    this.#o = o;
    this.#retryMs = o.retryMs ?? 1000;
  }

  get state(): AioState {
    return this.#state;
  }

  get online(): boolean {
    return this.#state === "online";
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  /** Resolves true once online, false when `timeoutMs` passes first. */
  waitOnline(timeoutMs: number): Promise<boolean> {
    if (this.online) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.#readyWaiters = this.#readyWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      const done = (ok: boolean) => {
        clearTimeout(t);
        resolve(ok);
      };
      this.#readyWaiters.push(done);
    });
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#socket?.destroy();
    this.#socket = null;
    this.#failPending("stopped", "client stopped");
    this.#setState("offline");
  }

  /** One request; resolves its `value`, rejects `AioError` (`offline` when not connected). */
  async request<T>(type: string, body: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.online && type !== "host.hello") throw new AioError("offline", "not connected to the agents-io daemon");
    const r = await this.#send(type, body, timeoutMs);
    if (!r.ok) throw new AioError(r.error?.code ?? "error", r.error?.message ?? `${type} failed`);
    return r.value as T;
  }

  #send(type: string, body: Record<string, unknown>, timeoutMs: number): Promise<ResultFrame> {
    const s = this.#socket;
    const id = `h${++this.#seq}`;
    return new Promise((resolve) => {
      const fail = (code: string, message: string): ResultFrame => ({
        v: PROTOCOL_VERSION,
        type: "result",
        id,
        ok: false,
        error: { code, message },
      });
      if (!s || s.destroyed) return resolve(fail("offline", "not connected"));
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve(fail("timeout", `${type}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, timer });
      s.write(`${JSON.stringify({ v: PROTOCOL_VERSION, type, id, ...body })}\n`);
    });
  }

  #setState(s: AioState, detail?: string): void {
    if (s === this.#state) return;
    this.#state = s;
    this.#o.onState?.(s, detail);
  }

  #failPending(code: string, message: string): void {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.resolve({ v: PROTOCOL_VERSION, type: "result", id, ok: false, error: { code, message } });
    }
    this.#pending.clear();
  }

  #connect(): void {
    if (this.#stopped) return;
    this.#setState("connecting");
    let token: string;
    try {
      token = readFileSync(this.#o.tokenFile ?? `${this.#o.socket}.token`, "utf8").trim();
    } catch (e) {
      this.#retry(`no token file next to ${this.#o.socket} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      return;
    }
    const s = connect(this.#o.socket);
    this.#socket = s;
    let buf = "";
    s.setEncoding("utf8");
    s.on("connect", () => void this.#hello(token));
    s.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.#onLine(line);
        nl = buf.indexOf("\n");
      }
    });
    s.on("error", (e: NodeJS.ErrnoException) => {
      this.#o.log?.(`aio: ${e.code ?? "error"}: ${e.message}`);
    });
    s.on("close", () => {
      if (this.#socket !== s) return;
      this.#socket = null;
      this.#failPending("disconnected", "connection closed");
      this.#retry("connection closed");
    });
  }

  async #hello(token: string): Promise<void> {
    const r = await this.#send(
      "host.hello",
      {
        token,
        name: this.#o.name,
        ...(this.#o.consumer ? { consumer: this.#o.consumer, takeover: true } : {}),
      },
      15_000,
    );
    if (!r.ok) {
      this.#o.log?.(`aio: hello refused: ${r.error?.code}: ${r.error?.message}`);
      this.#socket?.destroy();
      return;
    }
    this.hello = r.value as HostHelloResult;
    this.#retryMs = this.#o.retryMs ?? 1000;
    this.#setState("online");
    try {
      await this.#o.onReady?.(this.hello);
    } catch (e) {
      this.#o.log?.(`aio: after hello: ${(e as Error).message}`);
    }
    for (const w of this.#readyWaiters.splice(0)) w(true);
  }

  #retry(detail: string): void {
    this.#setState("offline", detail);
    if (this.#stopped || this.#o.reconnect === false) {
      for (const w of this.#readyWaiters.splice(0)) w(false);
      return;
    }
    if (this.#timer) return;
    const wait = this.#retryMs;
    this.#retryMs = Math.min(this.#o.maxRetryMs ?? 30_000, this.#retryMs * 2);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#connect();
    }, wait);
  }

  #onLine(line: string): void {
    let f: Frame;
    try {
      f = JSON.parse(line) as Frame;
    } catch {
      this.#o.log?.("aio: a line that is not JSON; skipped");
      return;
    }
    if (f.type === "result" && typeof f.id === "string") {
      const p = this.#pending.get(f.id);
      if (!p) return;
      this.#pending.delete(f.id);
      clearTimeout(p.timer);
      p.resolve(f as ResultFrame);
      return;
    }
    if (f.type === "inbound" && typeof f.id === "string") {
      void this.#inbound(f.id, f.item as InboundItem);
      return;
    }
    // Callouts this host never asked for: say so instead of letting the daemon time out.
    if (f.type === "policy" && typeof f.id === "string") this.#answer(f.id, false, undefined, "unsupported");
    // Everything else (run.ended, events) is not ours: ignored, as the protocol says.
  }

  async #inbound(id: string, item: InboundItem): Promise<void> {
    let accepted = false;
    try {
      accepted = (await this.#o.onInbound?.(item)) ?? false;
    } catch (e) {
      this.#o.log?.(`aio: inbound ${item?.channelRef ?? "?"}: ${(e as Error).message}`);
    }
    this.#answer(id, true, { accepted });
  }

  #answer(id: string, ok: boolean, value?: unknown, code?: string): void {
    const s = this.#socket;
    if (!s || s.destroyed) return;
    const frame: ResultFrame = ok
      ? { v: PROTOCOL_VERSION, type: "result", id, ok: true, value }
      : {
          v: PROTOCOL_VERSION,
          type: "result",
          id,
          ok: false,
          error: { code: code ?? "error", message: code ?? "error" },
        };
    s.write(`${JSON.stringify(frame)}\n`);
  }
}
