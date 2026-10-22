/**
 * Two launchd agents of the logged-in user (macOS): the project's agents-io daemon and the bridge.
 * Both run this project's CLI (`daemon`, `run`) with this Node; neither plist holds a secret —
 * credentials are read from the keychain at start.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Exec } from "./system.ts";

export const DAEMON_LABEL = "io.agents-io-herdr.daemon";
export const HOST_LABEL = "io.agents-io-herdr.bridge";

export interface Job {
  label: string;
  args: string[];
  log: string;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function jobs(c: Config, o: { node: string; bin: string }): Job[] {
  return [
    { label: DAEMON_LABEL, args: [o.node, o.bin, "daemon"], log: join(c.paths.logDir, "daemon.log") },
    { label: HOST_LABEL, args: [o.node, o.bin, "run"], log: join(c.paths.logDir, "bridge.log") },
  ];
}

export function plist(job: Job, o: { home: string; env: Record<string, string> }): string {
  const path = [
    join(o.home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const env: Record<string, string> = { PATH: [...new Set(path)].join(":"), HOME: o.home, ...o.env };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(job.label)}</string>
  <key>ProgramArguments</key>
  <array>
${job.args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env)
  .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
  .join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(job.log)}</string>
  <key>StandardErrorPath</key><string>${xml(job.log)}</string>
</dict>
</plist>
`;
}

export const plistPath = (home: string, label: string) => join(home, "Library", "LaunchAgents", `${label}.plist`);

export function uid(exec: Exec): string {
  const r = exec("id", ["-u"], 5000);
  if (r?.code !== 0) throw new Error("cannot read the current user's uid");
  return r.stdout.trim();
}

/** Writes and (re)loads each job; throws with launchctl's reason when one does not load. */
export function install(
  c: Config,
  o: { home: string; node: string; bin: string; env: Record<string, string>; exec: Exec },
): string[] {
  const domain = `gui/${uid(o.exec)}`;
  mkdirSync(join(o.home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(c.paths.logDir, { recursive: true });
  const done: string[] = [];
  for (const job of jobs(c, o)) {
    const path = plistPath(o.home, job.label);
    if (existsSync(path)) o.exec("launchctl", ["bootout", `${domain}/${job.label}`], 15_000);
    writeFileSync(path, plist(job, o));
    // Right after a bootout launchd may still be tearing the old job down (error 5): try a few times.
    let r = o.exec("launchctl", ["bootstrap", domain, path], 15_000);
    for (let i = 0; i < 5 && r?.code !== 0; i++) {
      o.exec("sleep", ["1"], 5000);
      r = o.exec("launchctl", ["bootstrap", domain, path], 15_000);
    }
    if (r?.code !== 0)
      throw new Error(`launchctl bootstrap ${job.label} failed: ${(r?.stderr ?? "").trim().slice(0, 200)}`);
    done.push(path);
  }
  return done;
}

export function uninstall(o: { home: string; exec: Exec }): void {
  const domain = `gui/${uid(o.exec)}`;
  for (const label of [HOST_LABEL, DAEMON_LABEL]) {
    o.exec("launchctl", ["bootout", `${domain}/${label}`], 15_000);
    rmSync(plistPath(o.home, label), { force: true });
  }
}

/** `running`, `waiting`, … as launchctl says, or `not installed`. */
export function jobState(label: string, exec: Exec): string {
  const r = exec("launchctl", ["print", `gui/${uid(exec)}/${label}`], 10_000);
  if (r?.code !== 0) return "not installed";
  return /^\s*state = (.+)$/m.exec(r.stdout)?.[1] ?? "loaded";
}

/** Restarts a loaded job (picks up a new config). */
export function kickstart(label: string, exec: Exec): boolean {
  const r = exec("launchctl", ["kickstart", "-k", `gui/${uid(exec)}/${label}`], 15_000);
  return r?.code === 0;
}
