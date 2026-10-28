/**
 * Hides secret-looking strings before a pane's output leaves the machine. It errs on the side of
 * hiding: a redacted id is cheap, a token sent to a chat is not.
 */

export const REDACTED = "[REDACTED]";

interface Rule {
  re: RegExp;
  replace: (m: string, ...groups: string[]) => string;
}

const keepPrefix = (_m: string, prefix: string) => `${prefix}${REDACTED}`;

/** Key names whose value is a secret: `password=…`, `"api_key": "…"`, `AppSecret: …`, `FOO_TOKEN=…`. */
const SECRET_KEY =
  "[A-Za-z0-9_.-]*?(?:secret|password|passwd|pwd|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential)";

const EMAIL: Rule = {
  re: /\b[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g,
  replace: (_m, domain) => `…@${domain}`,
};

const RULES: Rule[] = [
  // PEM private keys (RSA, EC, OPENSSH, PKCS#8, PGP).
  {
    re: /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?-----END \1-----/g,
    replace: (_m, kind) => `-----BEGIN ${kind}----- ${REDACTED} -----END ${kind}-----`,
  },
  // Prefixed tokens: Tailscale, GitHub, GitLab, Slack, npm, Hugging Face, Stripe.
  {
    re: /\b(tskey-(?:auth-|api-|client-)?|gh[pousr]_|github_pat_|glpat-|xox[abeprs]-|npm_|hf_|[rs]k_live_)[A-Za-z0-9_-]{16,}/g,
    replace: keepPrefix,
  },
  // OpenAI / Anthropic style keys.
  { re: /\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{20,}/g, replace: keepPrefix },
  // AWS access key ids.
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: () => `AKIA${REDACTED}` },
  // Email addresses: Feishu's audit refuses a message that carries one (230028 "sensitive data:
  // EMAIL_ADDRESS"), and an edit of a card that gained one fails the same way. The domain stays.
  EMAIL,
  // Google API keys.
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => `AIza${REDACTED}` },
  // JSON Web Tokens.
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: () => REDACTED },
  // Authorization headers with a literal value.
  { re: /\b((?:Bearer|Basic|token)\s+)([A-Za-z0-9._~+/=-]{16,})/g, replace: keepPrefix },
  // Credentials in URLs: scheme://user:secret@host (not placeholders like `<password>` or `$PW`).
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/<>${}]+)@/gi,
    replace: (_m, head) => `${head}${REDACTED}@`,
  },
  // key = value / key: value with a secret-looking key. The value is ASCII and counts when it has a
  // digit or is long (so `token: readonly`, `…Token=false` stay readable); `$VAR`, `<placeholder>`
  // and `$(command)` never match.
  {
    re: new RegExp(`\\b(${SECRET_KEY}["']?\\s*[=:]\\s*["']?)([A-Za-z0-9_\\-+/=.~!@#%^&*:?|]{8,})`, "gi"),
    replace: (m, head, value) => (!(/\d/.test(value) || value.length >= 20) ? m : `${head}${REDACTED}`),
  },
];

/** Secret hiding on (the default) or off (config `notify.redact: false`); email addresses are hidden either way. */
let secretsHidden = true;
export const hideSecrets = (on: boolean) => {
  secretsHidden = on;
};

export interface Redacted {
  text: string;
  count: number;
}

export function redact(text: string): Redacted {
  let count = 0;
  let out = text;
  for (const rule of secretsHidden ? RULES : [EMAIL]) {
    out = out.replace(rule.re, (...args: unknown[]) => {
      const m = String(args[0]);
      // replace() passes match, groups…, offset (a number), input[, named groups].
      const offsetAt = args.findIndex((a, i) => i > 0 && typeof a === "number");
      const groups = args.slice(1, offsetAt).map((g) => (typeof g === "string" ? g : ""));
      const r = rule.replace(m, ...groups);
      if (r !== m) count++;
      return r;
    });
  }
  return { text: out, count };
}
