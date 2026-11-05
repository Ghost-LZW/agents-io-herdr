/** Terminal-bound controls: old cards cannot drive a replacement program in the same pane. */
import type { Strings } from "./i18n.ts";
import type { RenderedMessage } from "./protocol.ts";
import { redact } from "./redact.ts";
import type { DialogOption } from "./screen.ts";

export const VIEW_ACTION = /^herdr:view:([\w-]{1,64})$/;
export const PANE_KEY_ACTION = /^herdr:pk:([\w-]{1,64}):([1-9]|esc|up|down|left|right|enter|tab)$/;
export const PROCESS_ACTION = /^herdr:process:([\w-]{1,64}):(\d{1,4})$/;
export const viewAction = (terminalId: string) => `herdr:view:${terminalId}`;
export const processAction = (terminalId: string, page = 0) => `herdr:process:${terminalId}:${page}`;

export function paneButtons(
  terminalId: string,
  options: DialogOption[],
  s: Strings,
): NonNullable<RenderedMessage["actions"]> {
  return [
    ...options.map((o) => ({ key: o.key, label: `${o.key} ${o.label}`.trim().slice(0, 20) })),
    ...["up", "down", "left", "right", "enter", "tab"].map((key, i) => ({
      key,
      label: ["↑", "↓", "←", "→", "Enter", "Tab"][i] as string,
    })),
    { key: "esc", label: s.escLabel },
  ].map((o) => ({ id: `herdr:pk:${terminalId}:${o.key}`, label: o.label }));
}

/** Screen text wraps on narrow cards; escape terminal text before it reaches card Markdown. */
export function screenText(text: string): string {
  const chars = [...redact(text).text];
  const out: string[] = [];
  let size = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const escaped = (chars[i] as string)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/([\\`*_{}[\]()#+.!|~-])/g, "\\$1");
    if (size + Buffer.byteLength(escaped) > 16_000) return `…\n${out.reverse().join("")}`;
    out.push(escaped);
    size += Buffer.byteLength(escaped);
  }
  return out.reverse().join("");
}
