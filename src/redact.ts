/**
 * Hides secret-looking strings before a pane's output or a session's text leaves the machine. It
 * errs on the side of hiding: a redacted id is cheap, a token sent to a chat is not.
 *
 * `strict` (the session collector: titles, first prompts, summaries, transcript pages) hides every
 * value after a secret-looking key, as LB's own redaction does; without it a token- or key-named
 * value counts only when it has a digit or is long, so a pane's `token: readonly` stays readable.
 * A password-named value (`password=hunterpass`) and a secret flag's value (`--password x`) are
 * hidden either way, as are the forms that name no key: `curl -u user:pass`, `mysql -ppass`,
 * `sshpass -p pass`, `redis-cli -a pass`, `docker login -p pass`, a `.netrc` line, an
 * `Authorization:` / `Cookie:` header's value whatever its scheme, a kubeconfig's
 * `client-key-data:` / `client-certificate-data:`, a docker config's `"auth"` and a base64 PEM key.
 *
 * Also: Alibaba Cloud `LTAI…` and AWS temporary `ASIA…` access key ids, OpenRouter's `sk-or-`, and a
 * PEM private key with no END line — output cut short mid-key — hidden from its BEGIN line to the end
 * of the text (docs/exec.md N6).
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

/**
 * Email addresses, in notices only: Feishu's audit refuses a message that carries one (230028
 * "sensitive data: EMAIL_ADDRESS"), and an edit of a card that gained one fails the same way. The
 * domain stays.
 */
const EMAIL: Rule = {
  re: /\b[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g,
  replace: (_m, domain) => `…@${domain}`,
};

/** Key names whose value is a password whatever it looks like. */
const PASSWORD_KEY = "[A-Za-z0-9_.-]*?(?:password|passwd|passphrase|(?<![A-Za-z])pwd|(?<![A-Za-z])pass)";

/** A value that is a word, not a secret: `password: false`, `token: string`. */
const NOT_A_VALUE = /^(?:true|false|null|none|nil|undefined|required|optional|string|number|boolean)$/i;

/** A key = value value: ASCII, never `$VAR`, `<placeholder>` or `$(command)`. */
const VALUE = "[A-Za-z0-9_\\-+/=.~!@#%^&*:?|]";

const hideValue = (m: string, head: string, value: string) => (NOT_A_VALUE.test(value) ? m : `${head}${REDACTED}`);

const RULES: Rule[] = [
  // PEM private keys (RSA, EC, OPENSSH, PKCS#8, PGP).
  {
    re: /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?-----END \1-----/g,
    replace: (_m, kind) => `-----BEGIN ${kind}----- ${REDACTED} -----END ${kind}-----`,
  },
  // One with no END after it (the text was cut mid-key): everything from its BEGIN line on.
  {
    re: /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----(?![\s\S]*?-----END \1-----)[\s\S]*/g,
    replace: (_m, kind) => `-----BEGIN ${kind}----- ${REDACTED}`,
  },
  // Prefixed tokens: Tailscale, GitHub, GitLab, Slack, npm, Hugging Face, Stripe.
  {
    re: /\b(tskey-(?:auth-|api-|client-)?|gh[pousr]_|github_pat_|glpat-|xox[abeprs]-|npm_|hf_|[rs]k_live_)[A-Za-z0-9_-]{16,}/g,
    replace: keepPrefix,
  },
  // LB's own tokens (`lba_`, `lbp_`, `lbs_`) and agents-io's keys (`agk_`).
  { re: /\b(lb[aps]_|agk_)[A-Za-z0-9._-]{6,}/g, replace: keepPrefix },
  // OpenAI / Anthropic / OpenRouter style keys.
  { re: /\b(sk-(?:ant-|proj-|or-)?)[A-Za-z0-9_-]{20,}/g, replace: keepPrefix },
  // AWS access key ids, long-term (AKIA) and temporary (ASIA).
  { re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: keepPrefix },
  // Alibaba Cloud AccessKey ids.
  { re: /\b(LTAI)[A-Za-z0-9]{12,}/g, replace: keepPrefix },
  // Google API keys.
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/g, replace: () => `AIza${REDACTED}` },
  // JSON Web Tokens.
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replace: () => REDACTED },
  // Authorization headers with a literal value.
  { re: /\b((?:Bearer|Basic|token)\s+)([A-Za-z0-9._~+/=-]{16,})/g, replace: keepPrefix },
  // Credentials in URLs: scheme://user:secret@host, scheme://:secret@host (not placeholders like
  // `<password>` or `$PW`).
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)([^\s@/<>${}]+)@/gi,
    replace: (_m, head) => `${head}${REDACTED}@`,
  },
  // An Authorization header's value whatever the scheme or length (`-H 'Authorization: Basic …'`).
  {
    re: /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:(?:bearer|basic|token|digest|negotiate)\s+)?)(?![$<[])(?!(?:bearer|basic|token|digest|negotiate)\b)([^\s"',;]+)/gi,
    replace: hideValue,
  },
  // A Cookie / Set-Cookie header's value, every pair of it.
  {
    re: /\b((?:set-)?cookie["']?\s*:\s*["']?)(?![\s$<[])([^\n"'\\]*[^\s"'\\])/gi,
    replace: hideValue,
  },
  // kubeconfig client credentials (base64 of a key or certificate), a k8s Secret's `tls.key`, a
  // docker config's `"auth"` (base64 user:password).
  {
    re: /(?<![A-Za-z0-9])((?:client-key-data|client-certificate-data|tls\.key)["']?\s*:\s*["']?|"auth"\s*:\s*")(?![$<[])([A-Za-z0-9+/=_-]{3,})/gi,
    replace: hideValue,
  },
  // A base64 PEM private key on its own (`LS0tLS1CRUdJTi…` is `-----BEGIN`).
  {
    re: /\bLS0tLS1CRUdJTi[A-Za-z0-9+/]{16,}={0,2}/g,
    replace: (m) => (/PRIVATE KEY/.test(Buffer.from(m.slice(0, 80), "base64").toString("latin1")) ? REDACTED : m),
  },
  // `curl -u user:pass`, `--user user:pass`, `-U` / `--proxy-user`: the password (a value without a
  // colon is a user name and stays).
  {
    re: /(?<![A-Za-z0-9-])((?:-[uU]\s*|--(?:proxy-)?user(?:\s+|=))["']?[^\s:"'$<[]*:)(?![$<[])([^\s"']+)/g,
    replace: hideValue,
  },
  // A password flag that names no secret: `mysql -ppass` (attached; `-p` alone prompts),
  // `sshpass -p pass`, `redis-cli -a pass`, `docker login -p pass`.
  {
    re: /(\b(?:mysql\w*|mariadb[\w-]*)\b[^\n;|&]*?\s-p)(?![\s$<[-])('[^'\n]*'|"[^"\n]*"|[^\s"';|&]+)/g,
    replace: hideValue,
  },
  {
    re: /(\b(?:sshpass\b[^\n;|&]*?\s-p|redis-cli\b[^\n;|&]*?\s-a|(?:docker|podman|nerdctl|buildah|skopeo|oras|helm\s+registry)\s+login\b[^\n;|&]*?\s-p)\s*)(?![$<[-])('[^'\n]*'|"[^"\n]*"|[^\s"';|&]+)/g,
    replace: hideValue,
  },
  // `.netrc`: `machine h login u password p`, or a `password p` line.
  {
    re: /(\b(?:login|account)\s+\S+\s+password\s+|^[ \t]*password[ \t]+)(?![$<[])(\S+)/gm,
    replace: hideValue,
  },
  // key = value / key: value with a secret-looking key. The value is ASCII and counts when it has a
  // digit or is long (so `token: readonly`, `…Token=false` stay readable); `$VAR`, `<placeholder>`
  // and `$(command)` never match.
  {
    re: new RegExp(`\\b(${SECRET_KEY}["']?\\s*[=:]\\s*["']?)(${VALUE}{8,})`, "gi"),
    replace: (m, head, value) => (!(/\d/.test(value) || value.length >= 20) ? m : `${head}${REDACTED}`),
  },
  // A password-named key's value, however short or plain.
  {
    re: new RegExp(`(?<![A-Za-z0-9])(${PASSWORD_KEY}["']?\\s*[=:]\\s*["']?)(?!\\[REDACTED)(${VALUE}{3,})`, "gi"),
    replace: hideValue,
  },
  // A secret flag and its value: `--password hunter2`, `--client-secret x`, `-token x`.
  {
    re: /(?<![A-Za-z0-9-])(--?(?:[A-Za-z0-9]+-)*(?:token|secret|password|passwd|pass|pwd|api-?key|access-?key|private-?key|credentials?)\s+)(?![-$<[])([^\s"']+)/gi,
    replace: hideValue,
  },
];

/** Strict only: any secret-looking key's value (`token=abcdefgh`, `api_key: plainword`). */
const STRICT_RULES: Rule[] = [
  {
    re: new RegExp(`\\b(${SECRET_KEY}["']?\\s*[=:]\\s*["']?)(?!\\[REDACTED)(${VALUE}{3,})`, "gi"),
    replace: hideValue,
  },
];

/**
 * Secret hiding in notices on (the default) or off (config `notify.redact: false`); email addresses
 * are hidden either way. `strict` text (sessions, exec output) is redacted whatever this says.
 */
let secretsHidden = true;
export const hideSecrets = (on: boolean) => {
  secretsHidden = on;
};

const rulesFor = (strict: boolean): Rule[] =>
  strict ? [...RULES, ...STRICT_RULES] : secretsHidden ? [...RULES, EMAIL] : [EMAIL];

export interface Redacted {
  text: string;
  count: number;
}

export function redact(text: string, o: { strict?: boolean } = {}): Redacted {
  let count = 0;
  let out = text;
  for (const rule of rulesFor(o.strict === true)) {
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
