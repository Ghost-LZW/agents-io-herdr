/**
 * A client of herdr's socket API (`~/.config/herdr/herdr.sock`, `$HERDR_SOCKET_PATH`): one JSON
 * request per line, one response line. Each call opens its own connection; the bridge polls
 * `agent.list` instead of holding an `events.subscribe` stream, which needs a pane id per
 * subscription, drops slow readers and replays nothing after a reconnect.
 */
import { connect } from "node:net";
import { join } from "node:path";

/** One row of `agent.list` (the fields this project reads). */
export interface HerdrAgent {
  pane_id: string;
  terminal_id: string;
  /** `claude`, `codex`, … */
  agent: string | null;
  /** `idle`, `working`, `blocked`, `done`, `unknown`. */
  agent_status: string;
  terminal_title_stripped?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  focused: boolean;
  state_change_seq?: number;
}

export class HerdrError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function herdrSocket(env: Record<string, string | undefined>, home: string): string {
  return env.HERDR_SOCKET_PATH || join(home, ".config", "herdr", "herdr.sock");
}

export interface Herdr {
  call<T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
}

export function herdrClient(socket: string): Herdr {
  let seq = 0;
  return {
    call<T>(method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
      const id = `aio-herdr-${++seq}`;
      return new Promise<T>((resolve, reject) => {
        const s = connect(socket);
        let buf = "";
        let settled = false;
        const done = (fn: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          s.destroy();
          fn();
        };
        const timer = setTimeout(
          () => done(() => reject(new HerdrError("timeout", `herdr ${method} timed out`))),
          timeoutMs,
        );
        s.setEncoding("utf8");
        s.on("connect", () => s.write(`${JSON.stringify({ id, method, params })}\n`));
        s.on("data", (chunk: string) => {
          buf += chunk;
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          let msg: { result?: T; error?: { code?: string; message?: string } };
          try {
            msg = JSON.parse(buf.slice(0, nl));
          } catch {
            return done(() => reject(new HerdrError("bad_response", `herdr ${method}: the answer is not JSON`)));
          }
          if (msg.error) {
            const e = msg.error;
            return done(() => reject(new HerdrError(e.code ?? "error", e.message ?? `herdr ${method} failed`)));
          }
          done(() => resolve(msg.result as T));
        });
        s.on("error", (e: NodeJS.ErrnoException) =>
          done(() => reject(new HerdrError(e.code ?? "socket", `cannot reach herdr (${socket}): ${e.message}`))),
        );
        s.on("close", () =>
          done(() => reject(new HerdrError("closed", `herdr closed the connection during ${method}`))),
        );
      });
    },
  };
}

export async function listAgents(h: Herdr): Promise<HerdrAgent[]> {
  const r = await h.call<{ agents: HerdrAgent[] }>("agent.list", {});
  return r.agents ?? [];
}

/** The pane's recent output, soft wraps joined, without colors (the read source is `recent_unwrapped`). */
export async function readAgent(h: Herdr, target: string, lines: number): Promise<string> {
  const r = await h.call<{ read: { text: string } }>("agent.read", { target, source: "recent_unwrapped", lines });
  return r.read?.text ?? "";
}

/** Text and Enter as one submission; refused (`agent_blocked`) while a dialog is open. */
export async function promptAgent(h: Herdr, target: string, text: string): Promise<void> {
  await h.call("agent.prompt", { target, text });
}

export async function sendKeys(h: Herdr, target: string, keys: string[]): Promise<void> {
  await h.call("agent.send_keys", { target, keys });
}
