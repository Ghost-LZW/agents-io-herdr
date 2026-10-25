/**
 * The few Feishu/Lark Open API calls the bridge makes itself, with the app's own credentials
 * (tenant_access_token): creating the workbench group. REST only — the event connection belongs
 * to the agents-io daemon, and a second one for the same app would steal half of its events.
 */
import type { Domain } from "./config.ts";

export class FeishuError extends Error {
  code: number | string;
  constructor(code: number | string, message: string) {
    super(message);
    this.code = code;
  }
}

export const apiBase = (domain: Domain) =>
  domain === "lark" ? "https://open.larksuite.com/open-apis" : "https://open.feishu.cn/open-apis";

/** The id type of a Feishu user id, from its prefix (`on_` union_id, `ou_` open_id, else user_id). */
export function userIdType(id: string): "union_id" | "open_id" | "user_id" {
  return id.startsWith("on_") ? "union_id" : id.startsWith("ou_") ? "open_id" : "user_id";
}

export interface FeishuApiOptions {
  appId: string;
  appSecret: string;
  domain: Domain;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface ApiAnswer {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
  tenant_access_token?: string;
  expire?: number;
}

export class FeishuApi {
  readonly #o: FeishuApiOptions;
  #token: { value: string; until: number } | null = null;

  constructor(o: FeishuApiOptions) {
    this.#o = o;
  }

  async #call(method: string, path: string, body: unknown, auth: boolean): Promise<ApiAnswer> {
    const f = this.#o.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
    if (auth) headers.authorization = `Bearer ${await this.token()}`;
    let res: Response;
    try {
      res = await f(`${apiBase(this.#o.domain)}${path}`, {
        method,
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? 15_000),
      });
    } catch (e) {
      throw new FeishuError("network", `${path}: ${(e as Error).message}`);
    }
    let json: ApiAnswer;
    try {
      json = (await res.json()) as ApiAnswer;
    } catch {
      throw new FeishuError(`http_${res.status}`, `${path}: HTTP ${res.status}, not JSON`);
    }
    if (json.code !== 0) throw new FeishuError(json.code ?? `http_${res.status}`, `${path}: ${json.msg ?? "failed"}`);
    return json;
  }

  /** A tenant_access_token, cached until a minute before it expires. */
  async token(): Promise<string> {
    const now = (this.#o.now ?? Date.now)();
    if (this.#token && this.#token.until > now) return this.#token.value;
    const r = await this.#call(
      "POST",
      "/auth/v3/tenant_access_token/internal",
      { app_id: this.#o.appId, app_secret: this.#o.appSecret },
      false,
    );
    if (!r.tenant_access_token) throw new FeishuError("no_token", "tenant_access_token missing in the answer");
    this.#token = { value: r.tenant_access_token, until: now + Math.max(60, (r.expire ?? 7200) - 60) * 1000 };
    return this.#token.value;
  }

  /**
   * A private group with the bot (it creates it) and `ownerId`, who owns it; the bot is made a
   * manager. Needs the `im:chat:create` scope (创建群).
   */
  async createChat(o: {
    name: string;
    description?: string;
    ownerId: string;
    uuid?: string;
  }): Promise<{ chatId: string }> {
    const type = userIdType(o.ownerId);
    // `uuid`: Feishu creates at most one group per uuid within an hour (a retried request makes no second group).
    const dedup = o.uuid ? `&uuid=${encodeURIComponent(o.uuid)}` : "";
    const r = await this.#call(
      "POST",
      `/im/v1/chats?user_id_type=${type}&set_bot_manager=true${dedup}`,
      {
        name: o.name,
        ...(o.description ? { description: o.description } : {}),
        owner_id: o.ownerId,
        user_id_list: [o.ownerId],
        chat_mode: "group",
        chat_type: "private",
      },
      true,
    );
    const chatId = typeof r.data?.chat_id === "string" ? r.data.chat_id : "";
    if (!chatId) throw new FeishuError("no_chat_id", "chat_id missing in the answer");
    return { chatId };
  }

  /** An emoji reaction on a message (`DONE`, … from Feishu's list). Needs `im:message.reactions:write_only`. */
  async react(messageId: string, emoji: string): Promise<void> {
    await this.#call(
      "POST",
      `/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      { reaction_type: { emoji_type: emoji } },
      true,
    );
  }
}

/** Feishu's answers when the app lacks a scope: retrying will not help until it is granted. */
export const isScopeError = (e: unknown) => e instanceof FeishuError && (e.code === 99991672 || e.code === 99991679);
