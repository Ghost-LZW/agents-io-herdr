/**
 * The Feishu app's credentials, read when needed and never written anywhere: from the environment
 * (`env:NAME`) or a macOS keychain item (`keychain:SERVICE`, read with
 * `security find-generic-password -s SERVICE -w`). The keychain is what launchd jobs should use:
 * a login keychain item made with `security add-generic-password` is readable by the user's own
 * launch agents without a prompt. (1Password's `op` CLI is not: it waits for someone to approve
 * the process, which never happens under launchd.)
 */
import { spawnSync } from "node:child_process";
import type { Config, Env, SecretRef } from "./config.ts";

export type Lookup = { ok: true; value: string; from: string } | { ok: false; reason: string };

export interface SecretSource {
  env: Env;
  /** A keychain generic password by service name; null when there is none or it cannot be read. */
  keychain: (service: string) => { ok: true; value: string } | { ok: false; reason: string };
}

export function realKeychain(service: string): { ok: true; value: string } | { ok: false; reason: string } {
  if (process.platform !== "darwin") return { ok: false, reason: "no keychain on this platform" };
  const r = spawnSync("security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
  if (r.error) return { ok: false, reason: (r.error as NodeJS.ErrnoException).code ?? "cannot run security" };
  if (r.status !== 0) {
    // security's own message names the item, never its value.
    const why = (r.stderr ?? "").split("\n").find((l) => l.trim()) ?? `exit ${r.status}`;
    return { ok: false, reason: why.trim().slice(0, 160) };
  }
  const value = (r.stdout ?? "").trim();
  return value ? { ok: true, value } : { ok: false, reason: "empty value" };
}

export const realSecretSource = (env: Env): SecretSource => ({ env, keychain: realKeychain });

/** The first ref that yields a value; the failure names every ref tried and why, never a value. */
export function lookup(refs: SecretRef[], src: SecretSource): Lookup {
  const why: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith("env:")) {
      const name = ref.slice(4);
      const v = src.env[name];
      if (v?.trim()) return { ok: true, value: v.trim(), from: ref };
      why.push(`${ref}: not set`);
    } else if (ref.startsWith("keychain:")) {
      const r = src.keychain(ref.slice(9));
      if (r.ok) return { ok: true, value: r.value, from: ref };
      why.push(`${ref}: ${r.reason}`);
    } else {
      return { ok: true, value: ref, from: "config" };
    }
  }
  return { ok: false, reason: why.join("; ") };
}

export interface AppCredentials {
  appId: string;
  appSecret: string;
}

export class CredentialError extends Error {}

export function appCredentials(c: Config, src: SecretSource): AppCredentials {
  const id = lookup(c.feishu.appId, src);
  if (!id.ok) throw new CredentialError(`Feishu app id not found (${id.reason})`);
  const secret = lookup(c.feishu.appSecret, src);
  if (!secret.ok) throw new CredentialError(`Feishu app secret not found (${secret.reason})`);
  return { appId: id.value, appSecret: secret.value };
}
