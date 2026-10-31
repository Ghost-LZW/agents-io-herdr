/** Facts about the machine: its name, how long the keyboard and mouse have been idle, local time. */
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `input`, when given, is written to the program's stdin: the way to hand it a secret (never in `args`, which `ps` shows). */
export type Exec = (cmd: string, args: string[], timeoutMs?: number, input?: string) => ExecResult | null;

/** Runs a program without a shell; null when it cannot be started. */
export const realExec: Exec = (cmd, args, timeoutMs = 30_000, input) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    ...(input === undefined ? {} : { input }),
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") return null;
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** The configured name, else macOS's LocalHostName, else the host name without its domain. */
export function machineName(configured: string | null, exec: Exec = realExec, platform = process.platform): string {
  if (configured?.trim()) return configured.trim();
  if (platform === "darwin") {
    const r = exec("scutil", ["--get", "LocalHostName"], 5000);
    if (r?.code === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return hostname().split(".")[0] || "this computer";
}

/** Keyboard and mouse idle time (macOS `HIDIdleTime`); null elsewhere or when unreadable. */
export function idleMs(exec: Exec = realExec, platform = process.platform): number | null {
  if (platform !== "darwin") return null;
  const r = exec("ioreg", ["-c", "IOHIDSystem", "-d", "4"], 5000);
  const m = r?.code === 0 ? /"HIDIdleTime"\s*=\s*(\d+)/.exec(r.stdout) : null;
  return m ? Math.floor(Number(m[1]) / 1_000_000) : null;
}

export function minuteOfDay(d: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, x) => {
      acc[x.type] = x.value;
      return acc;
    }, {});
  return Number(parts.hour) * 60 + Number(parts.minute);
}
