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
  /** The agent's own session (Claude Code's session id, …): where its transcript is. */
  agent_session?: { source?: string; agent?: string; kind: string; value: string } | null;
  state_change_seq?: number;
  tab_id?: string;
  workspace_id?: string;
}

/** One row of `tab.list` (the fields this project reads). */
export interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
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

/**
 * herdr cannot read the history of a full-screen program while it shows a dialog (it scrolls to
 * capture it, only while idle): what is on the screen then, which is where the dialog is.
 */
async function withVisible(read: (source: string) => Promise<{ read: { text: string } }>): Promise<string> {
  try {
    return (await read("recent_unwrapped")).read?.text ?? "";
  } catch (e) {
    if (!(e instanceof HerdrError) || !/alternate-screen|visible/i.test(e.message)) throw e;
    return (await read("visible")).read?.text ?? "";
  }
}

/** The pane's recent output, soft wraps joined, without colors (`recent_unwrapped`; the screen while blocked). */
export async function readAgent(h: Herdr, target: string, lines: number): Promise<string> {
  return withVisible((source) => h.call("agent.read", { target, source, lines }));
}

/** Text and Enter as one submission; refused (`agent_blocked`) while a dialog is open. */
export async function promptAgent(h: Herdr, target: string, text: string): Promise<void> {
  await h.call("agent.prompt", { target, text });
}

export async function sendKeys(h: Herdr, target: string, keys: string[]): Promise<void> {
  await h.call("agent.send_keys", { target, keys });
}

/** Every pane, agent or not (the same rows as `agent.list`, `agent` null for a plain terminal). */
export async function listPanes(h: Herdr): Promise<HerdrAgent[]> {
  const r = await h.call<{ panes: HerdrAgent[] }>("pane.list", {});
  return r.panes ?? [];
}

export async function listTabs(h: Herdr): Promise<HerdrTab[]> {
  const r = await h.call<{ tabs: HerdrTab[] }>("tab.list", {});
  return r.tabs ?? [];
}

export async function readPane(h: Herdr, paneId: string, lines: number): Promise<string> {
  return withVisible((source) => h.call("pane.read", { pane_id: paneId, source, lines }));
}

/** Literal text, then Enter (a plain terminal: no bracketed paste, no dialog check). */
export async function runInPane(h: Herdr, paneId: string, text: string): Promise<void> {
  await h.call("pane.send_text", { pane_id: paneId, text });
  await h.call("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
}

/** herdr checks every key name (`invalid_key`) before it writes anything. */
export async function sendPaneKeys(h: Herdr, paneId: string, keys: string[]): Promise<void> {
  await h.call("pane.send_keys", { pane_id: paneId, keys });
}

/** One row of `workspace.list` (the fields this project reads). */
export interface HerdrWorkspace {
  workspace_id: string;
  label: string;
}

export async function listWorkspaces(h: Herdr): Promise<HerdrWorkspace[]> {
  const r = await h.call<{ workspaces: HerdrWorkspace[] }>("workspace.list", {});
  return r.workspaces ?? [];
}

/** A new workspace (its first tab and pane come with it), not focused. */
export async function createWorkspace(
  h: Herdr,
  o: { label: string; cwd: string },
): Promise<{ workspace: HerdrWorkspace; root_pane: HerdrAgent }> {
  return await h.call("workspace.create", { label: o.label, cwd: o.cwd, focus: false });
}

/** A new tab with a shell in `cwd` (its environment as given), not focused. */
export async function createTab(
  h: Herdr,
  o: { workspaceId: string; label: string; cwd: string; env: Record<string, string> },
): Promise<{ tab: HerdrTab; root_pane: HerdrAgent }> {
  return await h.call("tab.create", {
    workspace_id: o.workspaceId,
    label: o.label,
    cwd: o.cwd,
    env: o.env,
    focus: false,
  });
}

/**
 * Starts an agent in a pane at its shell prompt and waits until herdr sees it ready for input:
 * over the socket `agent.start` answers at once (`launch_pending`), and a prompt before the agent
 * is up is refused (`agent_not_ready`). A dialog at startup (a folder trust question) is
 * `agent_not_ready` too.
 */
export async function startAgent(
  h: Herdr,
  o: {
    name: string;
    kind: string;
    paneId: string;
    args: string[];
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    /** A dialog at startup: the keys that answer it (from what the screen says), or null to give up. */
    onDialog?: (screen: string) => string[] | null;
  },
): Promise<void> {
  const timeoutMs = o.timeoutMs ?? 60_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  await h.call(
    "agent.start",
    { name: o.name, kind: o.kind, pane_id: o.paneId, args: o.args, timeout_ms: timeoutMs },
    timeoutMs + 10_000,
  );
  const until = Date.now() + timeoutMs;
  let answered = 0;
  for (;;) {
    const r = await h.call<{
      agent?: { interactive_ready?: boolean; launch_pending?: boolean; agent_status?: string };
    }>("agent.get", { target: o.paneId });
    const a = r.agent;
    if (a?.interactive_ready) return;
    if (a?.agent_status === "blocked") {
      const shown = await h.call<{ read: { text: string } }>("agent.read", {
        target: o.paneId,
        source: "visible",
        lines: 40,
      });
      const screen = shown.read?.text ?? "";
      const keys = answered < 3 ? (o.onDialog?.(screen) ?? null) : null;
      if (!keys) {
        const ask = screen
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-4)
          .join(" / ");
        throw new HerdrError("agent_not_ready", `${o.kind} is waiting on a dialog at startup: ${ask.slice(0, 300)}`);
      }
      answered++;
      await h.call("agent.send_keys", { target: o.paneId, keys });
    }
    if (Date.now() > until)
      throw new HerdrError("agent_not_ready", `${o.kind} was not ready within ${Math.round(timeoutMs / 1000)} s`);
    await sleep(500);
  }
}
