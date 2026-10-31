# Running commands on a node: exec.v1

The session collector ([sessions.md](sessions.md)) links a machine to LB, the assistant server it is paired with, over one outbound WebSocket (the *node link*). With a **ceiling file** on the machine, the same link also carries `exec.v1`: LB asks the machine to run a command for a person in one of its conversations, and the machine decides on its own whether, as whom and inside what sandbox. This document describes the protocol and the machine's side as built. LB's side — approval cards, its tables, its audit — is its own; what both sides must agree on is in `test/fixtures/exec-contract.json`.

What the design holds to:

- **The boundary is on the machine.** A ceiling file only this machine's user can write, a deny-by-default sandbox generated here, and, where it matters, a separate unprivileged user. LB can narrow what a call asks for, never widen the ceiling.
- **Nothing runs twice.** Every call carries an effect id; the effect ledger has a line for it before any process starts. A call with a known id is answered from the ledger.
- **Output is redacted here**, before it leaves the machine.
- **No standing permission.** Commands outside the ceiling's `auto` tier need a grant: one command once, or a short window. LB issues it from the owner's approval; the machine checks it again. Lasting changes are edits to the ceiling file.
- **No sandbox, no run.** A profile that does not compile, a runner that is not there: the call is refused, never run without the sandbox.
- **No ceiling file, no exec.** Without one the collector does exactly what it did before: sessions only.

## Parts

The parts are referred to by these labels in the code.

| | Part | Where |
|---|---|---|
| N1 | The node link v2: hello / welcome v2, asynchronous calls, effects until acknowledged, close codes, reconnects | `src/exec/frames.ts`, `src/exec/calls.ts`, `LbLink` in `src/collector.ts` |
| N2 | The ceiling file v2, presets, command tiers, deny lists | `src/exec/ceiling.ts`, `src/exec/commands.ts`, `src/exec/deny.ts` |
| N3 | The effect ledger | `src/exec/effects.ts` |
| N4 | The node's generation and owner | `src/exec/generation.ts` |
| N5 | Admission and grants | `src/exec/grants.ts` |
| N6 | Output: bounded, redacted, cut | `src/exec/output.ts`, `src/redact.ts` |
| N7 | The executor and the same-user runner | `src/exec/executor.ts`, `src/exec/run.ts` |
| N8 | The macOS seatbelt profile and the probe | `src/exec/sandbox.ts`, `src/exec/probe.ts`, `scripts/exec-sandbox-probe.sh` |
| N9 | The dedicated-user runner and its forced command | `src/exec/user-runner.ts`, `src/exec/shim.ts`, `src/exec/wire.ts`, `scripts/exec-user-setup.sh` |
| N10 | File transfer (`upload.v1`, `download.v1`) | Linux `bwrap` runner only (`src/exec/bwrap.ts`, `src/exec/box/`); not on the macOS runners yet |
| N11 | Delegation to the coding agents in herdr (`agents.v1`) | not built; the ceiling keys exist |
| N12 | The command line | `src/execcli.ts`, `sessions install --label-suffix` in `src/sessionscli.ts` |
| N13 | A local filtering proxy for `network: "proxy"` | not built; the ceiling keys and the profile rule exist |

Everything exec keeps is next to the collector's files, in `~/.config/agents-io-herdr` (or `$AGENTS_IO_HERDR_SESSIONS_DIR`): `exec-ceiling.json`, the switch `exec.off`, `node.json`, and under `exec/` the ledger `effects.jsonl`, `grants-used.jsonl`, `retired` and `sweep.json`. All are 0600 in 0700 directories, and none is readable or writable from inside the sandbox.

## The node link (N1)

```jsonc
// machine → LB: exec.v1 / transfer.v1 / agents.v1 appear in caps only with a valid ceiling, exec on, not retired
{"t":"hello","node":"…","sig":"…","version":"agents-io-herdr-sessions/2",
 "caps":["sessions","exec.v1"],"machine":{"name":"host-a","platform":"darwin"},
 "generation":3,"ceiling":{"sha":"<16 hex>","summary":{…}},"clock":1761300000000}
// LB → machine
{"t":"welcome","generation":3,"owner":"<owner id>","now":1761300000123,"exec":true}
// LB → machine: grant is filled in by LB's server from an approved grant, never by an agent
{"t":"call","id":"…","op":"exec.v1","effect_id":"eff_…","deadline":1761300120000,"generation":3,"grant":null,
 "origin":{"conversation":"…","turn":"…","person":"…","agent":"…","attended":true,"where":"dm|group|routine|followup"},
 "args":{"argv":["git","status","--short"],"cwd":"~/repos/app","shell":false,"stdin":null,"env":{},
         "policy":{"network":"off","write":[]}}}
// machine → LB, at once: taken, or refused (error.data ≤ 4 KiB, left out whole if larger)
{"t":"result","id":"…","ok":true,"data":{"effect_id":"eff_…","state":"running","effective":{…}}}
{"t":"result","id":"…","ok":false,"error":{"code":"needs_grant","message":"","data":{"tier":"grant","commandHash":"…","maxMinutes":15,"window":true}}}
// machine → LB when it ends, again after every welcome until LB answers {"t":"effect_ack","effect_id":"eff_…"}
{"t":"effect","effect_id":"eff_…","state":"done","exit":0,"signal":null,"stdout":"…","stderr":"…",
 "redacted":{"stdout":0,"stderr":0},"truncated":false,"bytes":{"stdout":120,"stderr":0},
 "sha256":{"stdout":"…","stderr":"…"},"startedAt":…,"endedAt":…,"grant":null,"reason":null}
```

- The challenge signature is unchanged (`lb-node:<nonce>`, the node's ed25519 key). `hello.generation` 0 means the machine has not been given one yet.
- Ops: `exec.v1`; `cancel.v1` (`args.target`: the effect to stop; itself an effect that ends at once, with `target: {effect_id, state}`); `upload.v1` and `download.v1` (N10, below). `session.read` is answered as before.
- States: `running` → `done` (a non-zero exit is still `done`, with `exit`) | `failed` | `timeout` (output so far included) | `cancelled` | `unknown` (it was running when the machine or the collector went down: nobody knows whether it finished).
- `effect.reason` explains a state; LB shows it and does not interpret it: `deadline`, `cancel`, `eof`, `generation_changed`, `exec_off`, `revoked`, `lb_off`, `retired`, `stale_generation`, `lb_old`, `collector_restart`, `host_restart`, `not_found`, `spawn_failed: …`, `not_running`, `sandbox_unavailable`, `runner_unavailable`, `runner_protocol`, `bad_spec`, `path_outside`, `path_denied`, `unsupported`.
- An `effect` frame stays under 2 MiB (LB's payload limit), however much of the output JSON escapes (see N6).
- A result goes only on the connection the call came in on; when that connection is gone LB has already counted the call as offline.

**Refusal codes:** `unsupported`, `bad_request` (an exec call without `effect_id`, `deadline`, `generation` or `origin`, or malformed), `exec_off` (with `error.data.reason`: `no_ceiling`, `bad_ceiling`, `ceiling_off`, `switched_off`, `unacknowledged`, `lb_old`, `lb_off`, `not_linked`), `retired`, `clock_skew`, `stale_generation`, `deadline_passed`, `deadline_too_far`, `over_ceiling`, `never`, `needs_grant`, `grant_invalid`, `widen_disabled`, `not_owner`, `unattended`, `busy`, `runner_unavailable`, `sandbox_unavailable`, `path_outside`, `path_denied`, `too_large`, `effect_conflict`; on the Box also `not_found`, `tool_mismatch`, `exists`, `use_relative_path`. A handler that throws answers `internal`.

**Close codes and reconnecting:** 4400, 4401, 4403, 4408, 4409 as before, and **4410** (generation changed). After 4408, 4410 or a wake (a watch tick more than 30 s late) the first reconnect is immediate; the same reason again within 60 s backs off 5 s, 10 s, 20 s… up to 60 s, ±20 % jitter. Anything else backs off from 5 s to 60 s. With nothing from LB for 75 s the machine drops the connection without waiting for a close. When the caps or the ceiling's sha change (a ceiling edit, `exec off` / `on`) the collector closes with 1000 (`relink`) on its next pass and says hello again.

**When LB takes exec back**, what runs is stopped: a 4403 close (the node was revoked, `revoked`); a welcome with `exec: false`, also on a live link (`lb_off`); a welcome naming another owner (`retired`); a welcome with a generation below this machine's (`stale_generation`); a welcome without a generation (LB went back to a version without exec, `lb_old`). An ordinary disconnect stops nothing: runs go on to their deadline and their effects are sent after the next welcome. A clock skew over 30 s only stops new work.

### Hashes

Both sides must compute these alike; the contract fixture has samples. Canonical JSON: object keys sorted, no whitespace, UTF-8; `policy.write` sorted, other arrays in order.

- `argsHash = sha256(canonical({op, args}))`
- `commandHash = sha256(canonical({argv, cwd, shell, network, write}))`, with `cwd` as sent, not expanded.

### Effect ids

LB works them out: `effect_id = "eff_" + base32(sha256(turnKey|nodeId|op|argsHash|ordinal))[:26]`, where `ordinal` counts the same (node, op, argsHash) within the turn. A retried turn therefore asks for the same id and gets the first answer instead of a second run. This is best effort only: a retry whose argv differs by one character is a new effect. The machine only checks the format, `eff_[A-Za-z0-9_-]{1,96}`.

### Compatibility

| Combination | What happens |
|---|---|
| An older collector, a newer LB | No generation in hello: LB sends it no exec calls; sessions as before |
| A newer collector, an older LB | LB drops the new hello fields; a welcome without a generation is `exec_off(lb_old)`; sessions as before |
| No ceiling file | `caps: ["sessions"]`, every exec call refused: the collector as it was |
| A node paired before `node.json` existed | The first welcome v2 writes owner and generation (first trust) |

## The ceiling file (N2)

`exec-ceiling.json`, next to the collector's files. It is written on the machine only, by hand or with `agents-io-herdr exec ceiling --preset …`; it never comes from LB.

- **Who may write it:** a regular file (not a link) of this user, 0600, in a directory nobody else can write. Otherwise exec is off (`exec_off`, `bad_ceiling`) and sessions go on. It is read again whenever its mtime, size, inode or mode change.
- **Keys:** `version` (2), `preset`, `exec` (`on` / `off`; on by default — writing the file means wanting exec), `runner` (`same`: a child of the collector; `user`: a dedicated user over ssh, N9; `bwrap`: Linux, below), `user` (`{name, home}`, for `runner: "user"`), `commands` (`default` and the `auto` / `grant` / `never` lists), `read` (`roots`; `deny`: names or paths added to the built-in lists), `toolRead`, `write`, `cacheDirs` (inside a write root), `network` (`off` / `proxy`; `open` only for the Box's install cell), `proxy` (`{port, allow, allowPrivate: [{host, ip}]}`, a fixed port), `unattended`, `groupTurns` (`grant` / `never`), `widenOnGrant` (`{network, write}`), `limits` (`maxSeconds` ≤ 7200, `outputBytes` 1 KiB–512 KiB per stream, `concurrent` ≤ 8, `fileBytes` ≤ 64 MiB), `grants` (`maxMinutes` ≤ 30, `window`), `envPass`, `gitIdentity` (`name` only), `agents`, `agentWorkspace`, `agentCommand`, `others` (whom besides the owner exec may run for), `acknowledged`; for `runner: "bwrap"` also `peopleRoot`, `toolsRoot`, `seccompBpf`. An unknown key makes the file invalid. A key left out takes the narrowest value.
- **`~`**, in the file and in LB's paths, is the home of the user the runner runs as.
- **Roots one by one.** `/`, a top-level directory, a home and anything above it, and with `runner: "same"` a directory right under the home (`~/repos`, `~/Downloads`) are refused in `read.roots`, `toolRead`, `write`, `cacheDirs` and `widenOnGrant.write` unless written as they are into `acknowledged`. A dedicated user's `~/work` is its own and does not count.
- **Never readable** (`src/exec/deny.ts`; the ceiling can add, never remove): under the home, keys and credentials (`.ssh`, keychains, `.gnupg`, cloud CLIs' credentials, `.kube`, `.docker`, `.netrc`, `.git-credentials`, `.npmrc`, `.pypirc`, `.pgpass`, `gh` / `glab` / `gcloud` configs, password managers), proxy client configs, shell and REPL histories, coding agents' logins, browser profiles, other tools that keep tokens, and the collector's own directory wherever it is; in any directory, `.env*`, `*.tfvars`, `*.tfstate*`, `.terraform`, `*kubeconfig*`, `.kube*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.age`, `*.sops.*`, `secrets*`, `id_*` keys, `credentials.json`, `application_default_credentials*.json`. Names ignore case. A directory holding a file named **`.exec-private`** is neither readable nor writable, all of it. A root that is itself on a list is invalid.
- **Never writable**, even inside a write root: `.git` itself, `.git/{hooks,info,config}` and the config and hooks under `modules` and `worktrees`, `.husky`, `.githooks`, `.pre-commit-config.yaml`, `.claude`, `CLAUDE.md`, `CLAUDE.local.md`, `.mcp.json`, `.codex`, `AGENTS.md`, `.cursor`, `.vscode`, `.envrc` (what git, coding agents, direnv and editors run or take as instructions outside the sandbox), wherever `core.hooksPath` points, and under the home the shell start-up files, `Library/LaunchAgents` and `.gitconfig`.
- **Name scan.** With `runner: "same"` and exec on, the collector scans the names under the read and write roots when the ceiling changes and at least hourly (names only; not into `node_modules`, `.git` or links; at most 50,000 entries). A denied name or a `.exec-private` directory keeps exec off (`unacknowledged`) until it is written into `acknowledged` — and it stays unreadable after. A scan that cannot finish counts as not acknowledged. A dedicated user's directories are checked by its forced command instead (N9).
- **Environment.** Only the names in `envPass` reach a run, and never secret-looking ones (`TOKEN`, `SECRET`, `PASSW`, `KEY`, `AUTH`, `COOKIE`, `SESSION`, `SSH_AUTH_SOCK`…; `exec doctor` points them out). LB's `env` may only use the names left.
- **Summary** (in hello, for LB to show; it acts on nothing there): version, preset, exec, runner, the command tiers, read roots (deny entries as a count), `toolRead`, `write`, `cacheDirs`, network, the proxy's allowed hosts, `unattended`, `groupTurns`, `widenOnGrant`, limits, grants, agents. Not `acknowledged`, not user names, not `envPass`. The sha is the first 16 hex digits of the file's sha256.

**Presets** (`exec ceiling --preset <name>`; `--force` to replace a file). None names a machine or a person.

| Preset | For | What it says |
|---|---|---|
| `personal-readonly` | a person's own computer | `runner: "same"`, **`exec: "off"`** until the owner turns it on; default tier `grant`, read-only commands `auto` (`ls`, `cat`, `rg`, `git status/log/diff/show`…); read roots empty until listed one by one; no writes, no network; not unattended; 120 s, 64 KiB, one at a time; grants up to 15 minutes; `agents: "grant"`, `agentWorkspace: "delegated"`, `agentCommand: "claude"` (a machine that starts its agent another way sets its own command in its file) |
| `agent-user` (`--user <name>`) | an always-on agent machine with a dedicated user | `runner: "user"`, read and write `~/work`, cache `~/work/.cache`; default tier `auto`; package installs, force pushes and `rm -rf` need a grant; `security`, `op`, `ssh-keygen`, `dscl`, `defaults write`, `pfctl`… never; no network; unattended allowed; runs up to 30 minutes, four at a time; grants up to 30 minutes |
| `box`, `box-install` | the Linux Box and its install cell | below |

### Command tiers

- An entry is a program name and the start of its arguments, `*` only at the end. `auto` entries match as a prefix; `grant` and `never` entries as a subsequence (`git -C x push origin --force` is still `git push --force`). When several match, the longer entry wins, `grant` on a tie. A program given by path matches an `auto` entry only from the usual system directories (`./git` matches none).
- `never` comes first: built in `sudo`, `su`, `doas`, `launchctl`, `open`, `osascript`, plus the ceiling's. Every command inside a shell line, after a launcher (`env X=1`, `xargs`, `sh -c`) or after `find -exec` is checked too (`grep open` is not `open`). This is best effort; the sandbox is the boundary.
- What cannot be seen through needs at least a grant: `shell: true`; shells and launchers (`bash x.sh`, `env`, `xargs`, `nohup`, `timeout`, `awk`…); interpreters with inline code (`python3 -c`, `node -e`, `perl -e`…), also under a default `auto`.
- Dangerous options lift an `auto` entry to `grant` (`git -c`, `--ext-diff`, `--output`, `find -exec` / `-delete`, `rg --pre`, `sort -o`…).
- A group turn lifts `auto` to `grant`; `groupTurns: "never"` refuses it.

## Admission and grants (N5)

In this order (`admitExec`):

1. The arguments read (`bad_request`).
2. `origin.person` is the owner LB named, or in `others` (`not_owner`; before any owner is known, always `not_owner`).
3. The deadline has not passed (`deadline_passed`) and is no later than LB's now + `maxSeconds` + 60 s (`deadline_too_far`; LB's now is this clock plus the skew measured at the last welcome). A run lasts until min(deadline, now + `maxSeconds`).
4. stdin ≤ 64 KiB (`too_large`).
5. Narrowing: the write paths lie in `write` (or in `widenOnGrant.write`, which counts as widening); `network: "proxy"` is the ceiling's, or `widenOnGrant.network` (widening); `cwd` is in a read root, a write root or this call's write paths (`path_outside`); nothing touches a denied path or a private directory (`path_denied`).
6. The command's tier; `never` is refused.
7. Widening: `widen_disabled` on `runner: "same"`; a once grant on `runner: "user"`.
8. An unattended turn (`attended: false`) on a ceiling with `unattended: false` is refused whatever the tier, `auto` included (`unattended`). `auto` is taken. `grant` without a grant is `needs_grant` (`data`: `tier`, `commandHash`, `maxMinutes`, `window`); with one, the grant is checked: its node and generation, `approvedBy` is the owner, not expired by LB's clock, no longer than `grants.maxMinutes`; a once grant names this `commandHash` and is unused; a window grant is allowed by the ceiling, in the same conversation, with `cwd` under its directory, and never for group turns or widening. Otherwise `grant_invalid`, the message saying which check failed.

A grant as it arrives in a call:

```jsonc
{"id":"gr_…","node":"…","generation":3,"kind":"once",          // once: this commandHash, one time; window: a time window
 "commandHash":"…","scope":{"conversation":"…","cwd":"~/repos/app"},
 "approvedBy":"<owner id>","approvedAt":…,"expiresAt":…}
```

Used once grants are written to `exec/grants-used.jsonl` (kept 24 hours) in the same step that claims the effect, so a replay from LB does not work twice. There is no "always allow".

## The effect ledger (N3)

`exec/effects.jsonl`, one JSON line per change. A run is written `running` (effect id, argsHash, generation, origin's person and conversation, node, deadline) **before** its process starts; its end is written when it ends. Then:

- **The ledger is asked first**, before any gate: a known id is answered from it whatever the generation or the switch — its state, or the whole final frame (`outputExpired: true` once the output has been cleared). The same id with other arguments is `effect_conflict`. A known effect is answered only to the person and the conversation it was taken for: anyone else gets `not_owner`, another conversation `effect_conflict`, neither with output.
- After a restart, lines still `running` become `unknown`: `host_restart` if they started before the machine booted, else `collector_restart`. Nothing is run again; LB tells the person it does not know.
- A 4410 clears grants and stops runs; it does not touch the ledger.
- Output is cleared an hour after LB acknowledged the effect; a line is kept until max(deadline, end) + 24 hours, longer than any id can come back (`deadline_too_far` bounds it).
- Each line names its node; after `sessions pair` an old node's effects are not sent over the new node's link.

## Generation and owner (N4)

`node.json` (0600) holds `{node, owner, generation}`. `sessions pair` writes the node and the owner LB answers, generation 0, and removes `exec/retired`.

- A welcome with a higher generation and the same owner is written down and used. A lower one turns exec off (`stale_generation`); it is never wound back.
- A welcome naming another owner writes `exec/retired`, stops runs and the link, and nothing links again until the machine is paired anew. Sessions are still collected locally.
- 4410: runs are cancelled, grants dropped, the link comes back for the new generation.
- On every collector pass (default every 10 s) the node and owner in `node.json` are checked; when they change the old process exits and launchd starts it again under the new identity.

## Output (N6)

Each stream is kept up to `outputBytes` + 4 KiB, **redacted whole** in strict mode (`src/redact.ts`), then cut at a line end to `outputBytes`. Cutting first would split a token in two and let half of it through. When a stream was cut, the last word left is dropped too (half a token no rule recognises), at most its last 4096 characters; a word that already ends in `[REDACTED]` stays. A PEM private key with no END line is hidden from its BEGIN line on. Then each stream is cut again to 768 KiB of escaped JSON, so the frame stays under 2 MiB. `bytes` counts what the stream gave before redaction, `redacted` how many places were hidden; `sha256` is of the text that leaves, which is also what the ledger keeps — never a hash of the raw output (a short secret could be guessed against it).

Strict redaction hides private keys, prefixed tokens (GitHub, GitLab, Slack, npm, Hugging Face, Stripe, Tailscale, OpenAI / Anthropic / OpenRouter, AWS `AKIA` / `ASIA`, Alibaba Cloud `LTAI`, Google, LB's `lba_` / `lbp_` / `lbs_`, agents-io's `agk_`), JWTs, `Authorization` and `Cookie` header values, passwords in URLs, secret flags (`--password x`), the forms that name no key (`curl -u user:pass`, `mysql -ppass`, `sshpass -p`, `redis-cli -a`, `docker login -p`, `.netrc`), kubeconfig client data, a docker config's `"auth"`, base64 PEM keys, and every value after a secret-looking key. `notify.redact: false` (for notices) does not change it.

## Running a command (N7)

`Executor.take`:

1. Admission as above.
2. Over `limits.concurrent`, a dedicated user not swept yet or due for a sweep, the same effect id being prepared: `busy`.
3. The runner prepares: the same-user runner makes the run's own directory (`$TMPDIR/agents-io-herdr-exec/<effect>.<random>/{home,tmp}`), writes the profile and preflights it with `/usr/bin/true`; the dedicated-user runner checks its key and host key and builds the profile. A failure is `sandbox_unavailable` or `runner_unavailable`, and nothing has been claimed.
4. Preparing is asynchronous, so everything is checked again: the gate still open, the generation unchanged (`stale_generation`), the id still new, still under the limit, the once grant still unused.
5. Synchronously: the ledger line (`running`), the grant marked used; only then the process starts. The same-user runner then records the process group and its start time.
6. The result `{effect_id, state: "running", effective}` goes at once; the `effect` follows when it ends.

**Stopping.** Each run is its own process group (a new session). At the deadline (checked by the wall clock every second, so a machine that slept past it records `timeout`; LB's deadline is turned into this clock's time with the skew from the last welcome, the ledger keeps LB's), on `cancel.v1`, a 4410 or a welcome that skipped a generation (`generation_changed`), exec turned off here (`exec_off`) or LB taking exec back: SIGTERM to the group, SIGKILL 5 s later. When the first process exits, what is left of its group is killed. A program that cannot be found is still an effect, `failed` with `not_found`. A collector told to stop cancels its runs (`collector_restart`), waits 6 s and writes `unknown` for what has not ended. A collector killed with `kill -9` leaves process groups behind; the next one marks those effects `unknown` and kills the groups it recorded — not when the group leader is alive with another start time (a reused pid), and not after a reboot.

**Environment.** Only `envPass` (the collector's values, then LB's), `TERM=dumb`, a default `PATH` of `/usr/bin:/bin:/usr/sbin:/sbin` when none is passed. `gitIdentity.name` becomes `GIT_AUTHOR_NAME` and `GIT_COMMITTER_NAME`. The first of `cacheDirs` is `XDG_CACHE_HOME`, with npm, pip and uv caches under it. `network: "proxy"` sets `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` (both cases) and `NODE_USE_ENV_PROXY=1` to the ceiling's fixed port. argv[0] is found outside the sandbox: with a `/` as given (relative to `cwd`), otherwise along the **collector's** `PATH`, never LB's — a bare `ls` in the `auto` tier must not resolve to a script of that name in a read root. On macOS the `xcrun` shims in `/usr/bin` (`git`, `python3`, `make`…) are replaced by what `xcrun --find` names, since the shims cannot start in a deny-by-default sandbox.

## macOS: the seatbelt profile (N8)

Every run gets `/usr/bin/sandbox-exec -f <profile>` (an absolute path), the profile generated from the effective policy, the same for both macOS runners with different paths:

- Deny by default; `process-fork`, `process-exec`; signals only to `same-sandbox`; `(deny process-info*)` and then `(allow process-info* (target self))`; `sysctl-read` from an allow list; `file-read-metadata` everywhere.
- Read: `/`, `/usr`, `/bin`, `/sbin`, `/System`, `/private/etc`, `/private/var/db/timezone`, the Command Line Tools and Xcode, a few `/dev` devices; of `/opt/homebrew` only `bin`, `sbin`, `opt`, `Cellar`, `lib`, `libexec`, `share`, `include`, `Frameworks`; the read roots, `toolRead`, the write roots and the run's own directory.
- Write: the run's write paths (LB's request within the ceiling), `cacheDirs`, its own directory, `/dev/null`.
- Denials come last, so they win: the deny lists and private directories; the never-writable list and wherever `core.hooksPath` points (read from the config files' text, git is not run there); no `exec` of `/bin/launchctl`, `/usr/bin/open`, `/usr/bin/osascript`, nor of any file in a write root, the run's directory, `/private/tmp`, `/private/var/tmp` or `/private/var/folders`; `(deny system-fcntl (fcntl-command 80 110))`; `(deny mach-lookup (xpc-service-name-prefix ""))`. No unix sockets, no mach services.
- Network: `off` allows nothing; `proxy` only `(remote ip "localhost:<port>")`.
- A path with a quote, a backslash or a control character is not escaped: no profile is made (`sandbox_unavailable`).
- `sandbox-exec` exits 65 when a profile does not compile, which a command can also do, so each run first runs `/usr/bin/true` under the same profile.

Consequences worth knowing: programs in a write root (scripts, `node_modules/.bin`, built test binaries) cannot be started directly — run them through an interpreter (`sh x.sh`, `node x.js`, `python3 -m pytest`); `git init` and `git clone` cannot run in the sandbox, since `.git` itself is not writable.

**Hardening.** What a plain deny-by-default profile left open, and what closes it:

| # | Hole | Fix | Check |
|---|---|---|---|
| 1 | Renaming `.git` away to escape path-based write denials | `.git` itself is not writable (no rename, delete or create), nor `hooks`, `info`, `config`, and the config and hooks in `modules` and `worktrees` | S2b |
| 2 | `setsid` leaves the process group | A dedicated user: its processes are swept by uid. The same user: widening is off until sandbox membership can be reaped (S9) | S9 |
| 3 | Local TCP ports reachable | network is `off` or `proxy` only; `proxy` allows only the proxy's port | S3b |
| 4 | Homebrew's configuration readable | only Homebrew's program directories, not `etc` or `var` | S1b |
| 5 | Other processes' argv and environment readable | `sysctl-read` allow list, `process-info*` denied except for itself | S7 |
| 6 | `launchctl kickstart` (without `-k`) starts an on-demand job outside the sandbox | no exec of `launchctl`, `open`, `osascript` or of anything in a writable directory; `exec doctor` lists on-demand jobs | S6 |
| 7 | A dedicated user's shell start-up files, written from the sandbox, run unsandboxed at the next ssh login | its home belongs to root; login shell `/bin/sh`; the sandbox HOME is `~/work`; `PermitUserEnvironment no` | S8 |

**launchd.** Deny by default stops `submit` and `bootstrap` (`job-creation`) and `kickstart -k`, `kill`, `remove`, `bootout` of existing jobs (`signal`). It does not stop a plain `kickstart` of an already loaded on-demand job, which then runs outside the sandbox. Hence #6. Talking to launchd's private XPC directly is a remaining risk, narrowed by the mach-lookup denial, read-only defaults and the dedicated user's sweep. Setuid programs (`sudo`, `crontab`) fail inside the sandbox; `sudo` is `never` everywhere.

## macOS: a dedicated user (N9)

For an always-on agent machine the boundary is a separate, hidden, non-admin macOS user, with the same profile inside. The collector, running as the machine's owner, keeps the control — the ceiling, the ledger, the node key — and only the process itself runs as the dedicated user.

`scripts/exec-user-setup.sh --user <name>` prints what it would do; with `--apply` (sudo) it does it:

1. A hidden non-admin user: password disabled, login shell `/bin/sh`, primary group staff.
2. Its home `root:wheel`, 755 (it can create nothing at the top: no `.zshenv`, `.profile`, `.ssh/`); inside, `work/` (the sandbox HOME and its own clones) and `exec/` (each run's directory), its own, 700.
3. `chmod 700` on the owner's home (every user's primary group is staff).
4. An sshd drop-in `Match User <name>`: only the key in `/etc/ssh/authorized_keys/<name>`, no password, no tty, no forwarding, `PermitUserEnvironment no`, `PermitUserRC no`, `ForceCommand` the shim; checked with `sshd -t` and taken back if that fails (sshd reads its configuration on every connection — a broken one locks everyone out).
5. A key for this alone, `<sessions>/exec/<name>_ed25519` (the owner's, 0600), installed with `from="127.0.0.1,::1",restrict,command="…"`; `known_hosts_local` pinned to this machine's host key.
6. The code, `git archive HEAD`, unpacked to `/Users/Shared/agents-io-herdr/<commit>/` (the owner's, read-only for the user), linked as `current-<name>` — a link per user, so a staging user moved to newer code leaves the production one alone.
7. Optional, `--pf <port>`: a pf anchor that blocks the user's outgoing traffic except to the proxy port on `lo0` (loaded into the running pf only).

It puts no credentials into the user and does not write the ceiling: afterwards, as the owner, `agents-io-herdr exec ceiling --preset agent-user --user <name>`, `exec doctor`, `scripts/exec-sandbox-probe.sh --user <name>`.

**A run.** The collector starts `ssh -T -F /dev/null -i <key> -o IdentitiesOnly=yes -o IdentityAgent=none -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<sessions>/known_hosts_local <name>@127.0.0.1 run`, writes one JSON line (effect, argv, cwd, env, the `PATH` to find argv[0] along, home, tmp, the profile, the roots, stdin size, deadline, outputBytes), then stdin, then only `cancel` lines; EOF also cancels. Out come frames `[channel u8][length u32be][data]`: 1 stdout, 2 stderr, 9 the closing JSON `{state, exit, signal, reason, bytes}`. The shim forwards at most `outputBytes` + 4 KiB per stream and only counts the rest, framing every 16 KiB or 250 ms. The collector takes no more than that per stream, no empty frame, a closing frame of at most 16 KiB, nothing after it; anything else kills ssh and records `failed(runner_protocol)`. ssh that cannot connect is `failed(runner_unavailable)`. Redaction happens in the collector.

**The shim** (`agents-io-herdr exec-shim`, sshd's forced command) accepts `SSH_ORIGINAL_COMMAND` `run`, `upload`, `download`, `sweep`, `probe` and nothing else (exit 2, no output). It first checks that it runs as a user the setup script made — not root, home owned by root and not writable by others — or exits 3. `run` resolves `cwd` and paths with realpath inside the roots and refuses links on the way; refuses a `cwd` or write path in a `.exec-private` directory (`path_denied`); scans the roots by name (at most 100,000 entries, not into `cacheDirs`, `node_modules`, `.git` or links) and appends a deny rule for every private directory found; writes the profile, preflights it, enforces the deadline itself, and removes `~/exec/<effect>` at the end. `upload` and `download` are `failed(unsupported)` for now.

**The sweep.** `sweep` lists the user's processes, keeps the shim and its ancestors (sshd's session process runs as the user too), SIGKILLs the rest, and reports how many and their program names (no arguments). The collector sweeps only while nothing runs: once at start (new work is `busy` until then), after a run that wrote or used the proxy, after runs were stopped, and at least every 15 minutes (new work is `busy` once it is due). A sweep that failed does not count: it is tried again a minute later. With exec off here the one due sweep still happens. The last good sweep is in `exec/sweep.json` and shown by `exec status`. So a process that escaped with `setsid` lives at most 15 minutes plus a deadline.

`exec doctor` compares the code the user runs with the collector's own (the sha256 of `package.json`, `bin/` and `src/`, path and bytes): the frames on ssh have no version, both sides must be the same code. Uncommitted changes in the collector's copy count as a difference.

## The probe (N8)

`agents-io-herdr exec probe [--launchd]` (the same user, in a directory of its own under `/tmp`) and `scripts/exec-sandbox-probe.sh [--user <name>] [--launchd]` try the profile this build generates, so running them again after a change to the generator is the regression test. Only exit codes are looked at; nothing read is printed.

- **S1** Decoys at credential locations (`~/.ssh`, `gh`, proxy configs, shell history, git credentials, `.npmrc`, kubeconfig, tfstate, `.env`, a `.exec-private` directory) and `ls ~` all fail; the roots and the run's TMPDIR are readable. **S1b** Homebrew's `etc` is not readable, its `bin` is.
- **S2** Writes to git hooks and config, `.husky`, `.claude`, `CLAUDE.md`, `.mcp.json`, `AGENTS.md`, `.envrc` and outside the roots fail. **S2b** Renaming, deleting or creating `.git` fails, also in `modules` and `worktrees`. **S2c** Even with `~` writable, shell start-up files, `LaunchAgents` and `~/.gitconfig` are not.
- **S3** No name resolution, no outside unix socket, no local TCP. **S3b** With the proxy, only its port.
- **S4** A profile that does not compile fails the preflight; HOME and TMPDIR are the run's own.
- **S5** `git` (the real binary behind the xcrun shim) runs and commits.
- **S6** `launchctl`, `open`, `osascript` and a program copied into a writable directory cannot start. With `--launchd` the probe loads an on-demand job of its own, fails to kickstart it from inside, kickstarts it from outside (the control: otherwise the first check proves nothing), and unloads it.
- **S7** No other process's arguments readable from inside; with `--user`, also none of the owner's (how many are readable from outside is listed).
- **S8** (`--user`) The owner's home is not readable; the shared code and the user's own home are not writable; the home belongs to root, the login shell is `/bin/sh`, `launchctl manageruid` is the user; from outside, ssh without a command or with another one only reaches the shim and is refused, password login fails, the owner's home is 700.
- **S9** Reaping every member of a sandbox, also those that left the group: not built yet.

The vitest suite runs the real-sandbox group only on macOS with `AIH_SANDBOX_TESTS=1`.

## Linux: bubblewrap and the Box

`runner: "bwrap"` serves a shared **Box** — people's tools, each person in their own directory — and a separate **install cell** that installs tools into it. The `box` and `box-install` presets fix what they admit: the Box runs only an installed tool's entry points, the install cell only the image's `box-install`; the command lists cannot open either to an arbitrary shell. The other runners are unchanged.

### Image and start

`src/exec/box/box-put`, `box-get` and `box-install` are copied by the image, as they are, to `/usr/lib/box/`; they use Python's standard library only. The collector always calls them as `/usr/bin/python3 -I -S /usr/lib/box/<helper>` inside bwrap, never along `PATH`. The installer also uses the image's `/usr/local/bin/uv` (or `/usr/bin/uv`). The image needs `/usr/bin/bwrap`, `/usr/bin/python3`, CA certificates and a compiled `/usr/lib/box/seccomp.bpf`.

The state volume and the collector's HOME are `/var/lib/herdr`; the ceiling is `/var/lib/herdr/exec-ceiling.json`, 0600, owned by the uid the collector runs as. The deployment's prepare step creates the node key (`newNodeKey` / `keepNodeKey`) and registers the node with LB; it writes the node id LB returns into the configuration and `node.json`, then starts:

```sh
HOME=/var/lib/herdr AGENTS_IO_HERDR_SESSIONS_DIR=/var/lib/herdr \
AGENTS_IO_HERDR_EXEC_ONLY=1 \
node /opt/agents-io-herdr/bin/agents-io-herdr sessions collect
```

(or `main(["sessions", "collect"])` from `src/main.ts`, same environment). **Exec-only mode** (`AGENTS_IO_HERDR_EXEC_ONLY=1`, or `execOnly: true` in `sessions.json`): no session scans, no herdr, no `sessions` frames, no `sessions` cap, `session.read` is `unsupported`. The link, the ledger and exec stay; with a valid ceiling and exec on, hello says `exec.v1` and `transfer.v1`.

`exec ceiling --preset box` / `--preset box-install` writes the ceiling. `peopleRoot` and `toolsRoot` default to `/srv/people` and `/srv/tools`; they may not overlap each other or the collector's state. `seccompBpf` may be null; a path that cannot be read refuses every call. `exec doctor` preflights bwrap with an empty HOME and no personal directory; every call is preflighted again with its own arguments.

| Preset | Network | maxSeconds | outputBytes (per stream) | concurrent | fileBytes |
|---|---|---:|---:|---:|---:|
| `box` | off | 1800 | 262144 | 1 | 67108864 |
| `box-install` | `install`, `lock`: open; `smoke`, `commit`: off | 1800 | 524288 | 1 | 67108864 |

### The boundary of a run

`bwrap --unshare-all --die-with-parent --new-session --cap-drop ALL --clearenv`, with only `PATH`, `HOME`, `LANG`, `TZ` set; `--share-net` only for `open`, which only the install cell may use. `/usr` read-only with `/bin`, `/sbin`, `/lib`, `/lib64` linked into it; of `/etc` only what dynamic linking, time zones and user lookup need, plus DNS and CA files for steps with network. `/tmp` is a size-limited tmpfs, `/dev` bwrap's minimal set.

**No `/proc`:** procfs is not mounted and the container's is not bound, so a process with the same uid cannot read the collector's environment or root. The state volume, other people's directories and other versions of a tool never enter a tool's sandbox. `--unshare-all` includes a PID namespace: when the entry process ends the namespace goes with it, and `setsid` leaves nothing behind. The seccomp filter is passed on fd 3 to every start; generated by the image, it refuses new user namespaces, io_uring, bpf, perf_event_open, keyctl and TIOCSTI, and keeps AF_UNIX.

Each run is preceded by `/bin/true` with exactly the same mounts, environment, cwd, network and filter. No bwrap, an unreadable filter, a preflight that times out or exits non-zero: `sandbox_unavailable`. There is no path without the sandbox.

A Box call carries `args.box = {person, tool: {name, version, tree, dir}}`, part of the argsHash. `origin.person` must equal `box.person` (the person served this turn, not the node's owner); group turns are refused. `<peopleRoot>/<person>/` must exist and not be a link (`not_found`; the node does not create it). It becomes `/home/me`; `cwd` is `~` or `~/<relative path>`. `argv[0]` is a bare entry name: the node checks name, version, tree and entries in `<toolsRoot>/<dir>/.box-tool.json` and runs `/opt/tool/bin/<entry>`, with that tool version mounted read-only at `/opt/tool`. Metadata or an entry that does not match is `tool_mismatch`; any other command is `never`. `policy.network` must be off; `policy.write` is `["~"]` or `[]` (a tool whose manifest says ro cannot ask to write). `env` is always `{}`, no shell. An argument starting with `~` or containing `=~` is `use_relative_path`: tools take relative paths. Cancelling checks the effect's person and conversation, not the shared node's owner. Whether a direct-chat turn really began with the person's own message is LB's check.

### Files in and out (N10)

Only the bwrap runner serves `upload.v1` and `download.v1`. Paths are relative — not starting with `/` or `~`, no empty segment, `.`, `..` or NUL, at most 512 UTF-8 bytes. Files in a person's directory are limited by the ceiling's `fileBytes` and at most 20 MiB; the install cell's tar and requirements uploads by the ceiling only (64 MiB by default). A transfer takes a concurrency slot, has a deadline and stops on a disconnect; chunks are not replayed after a reconnect — LB fetches again with a new effect id.

The node takes the call in its result first; then LB sends the chunks (`seq` from 0, the last with `last: true`; an empty file is one empty last chunk). `box-put` opens the path inside the sandbox one directory fd at a time with `O_NOFOLLOW`; the temporary file is `O_CREAT|O_EXCL|O_NOFOLLOW`, 0600, its size and sha256 checked while written. It is published with an exclusive `link` in the same directory and the temporary name removed, so a target created meanwhile is never overwritten (a file system without hard links fails rather than fall back to `rename`). An existing target in a person's directory is `exists`. Install-cell uploads use `--content-addressed`: only `<sha256>.tar` and `<sha256>.requirements.in`; an existing file with the right size and sha256 is success, a bad one is never overwritten.

`box-get` refuses links on the way, reads regular files only and sends binary data as it is, not redacted. The node counts and hashes on its own and sends the `effect` after the last chunk. A successful effect may carry `data: {path, size, sha256}`, kept in the ledger and sent again with it; a failure's reason is the helper's (`exists`, `path_denied`, `too_large`, `mismatch`…).

### Installing a tool

The install cell takes calls from the node's owner only and mounts no personal directory. LB always sends `argv: ["box-install", <step>]`, `cwd: "/"`, `env: {}`, `stdin: null`, `policy.write: []`; the rest is `box.install {step, name, version, tree, tarSha256}`:

1. **install**: reads `.incoming/<tarSha256>.tar`, checks its sha256, unpacks it safely into `.staging/<name>-<version>-<tree12>/src/` (no links, hard links, absolute paths, `..`, devices, FIFOs or duplicates); computes the git tree id (SHA-1 or SHA-256) with the standard library and checks it and the manifest's name and version against the approved ones. `uv venv` with the image's Python; dependencies only through `uv pip install --require-hashes --only-binary :all: --no-deps`. It writes a source `.pth` and `#!/opt/tool/venv/bin/python -I` entry points and precompiles with the system `python3 -I -S -m compileall`, never importing the tool's or its dependencies' code.
2. **smoke**: no network, the staged tool read-only at `/opt/tool`, an empty tmpfs HOME; every entry's `--help` must exit 0.
3. **commit**: the helper gets the tools volume writable, writes `.box-tool.json` (name, version, tree, tarSha256, entries, personDir, installedAt) and renames the directory atomically to `<name>/<version>-<tree12>/`. The same tree again is success; another tree is `exists`. LB orders install → smoke → commit; the node keeps no approval state of its own.
4. **lock**: reads `.incoming/<tarSha256>.requirements.in` (here `tarSha256` is that file's sha256) and runs `uv pip compile --generate-hashes --only-binary :all: --python-version 3.13 --python-platform x86_64-manylinux_2_28`. Its stdout is the lock file as it is, `--hash=sha256:…` included — not redacted, still within the output and frame limits.

The fixture's `box` section comes from LB as it is. macOS unit tests use a fake bwrap and argument snapshots; the Python helper tests use a real `git archive`, temporary files and a fake uv. The real-isolation tests run only on Linux with `/usr/bin/bwrap`; where user namespaces are unavailable they check `sandbox_unavailable`, never a run without the sandbox. The image, the seccomp filter and the orchestration are verified where they are deployed.

## Commands (N12)

- `agents-io-herdr exec status`: the switch, the ceiling, the caps hello says, the node, the ledger, the last sweep.
- `agents-io-herdr exec ceiling --preset <name> [--user <name>] [--force]`: write the ceiling from a preset; edit it by hand after.
- `agents-io-herdr exec log [--limit N] [--json] [<effect id>]`: what ran here; one id with its redacted output.
- `agents-io-herdr exec off` / `on`: refuse every exec call at once / take them again (`exec.off`).
- `agents-io-herdr exec doctor`: the ceiling, the sandbox preflight, secret-looking `envPass` names, the name scan, on-demand launchd jobs; for a dedicated user its home, the owner's home mode, Node, the key, the code it runs.
- `agents-io-herdr exec probe [--launchd]`: S1–S7 for real.
- `agents-io-herdr sessions install --label-suffix <s>`: a second collector with its own directory (for example a staging one), see [sessions.md](sessions.md).

When the collector is stopped by launchd (SIGTERM) while runs are going, it stops them first.

## Deploying

**A person's own Mac.** Pair the collector ([sessions.md](sessions.md)). `agents-io-herdr exec ceiling --preset personal-readonly` writes a ceiling with exec off; list the read roots one by one (a project, not `~/repos`), run `exec doctor` and `exec probe`, acknowledge what the name scan finds only if you mean it, then set `"exec": "on"`. LB still has to have the owner confirm the new caps before it sends anything. To start delegated agents with another command than `claude`, set `agentCommand` in this file.

**An always-on agent Mac.** Run `scripts/exec-user-setup.sh --user <name>` and read it, then again with `sudo … --apply`. As the owner: `exec ceiling --preset agent-user --user <name>`, `exec doctor`, `scripts/exec-sandbox-probe.sh --user <name>`. A Mac nobody is logged in to runs the collector through ssh loopback ([sessions.md](sessions.md)). A second, staging collector with its own user: `--user <name>-staging --sessions-dir <its directory>` for the script, `AGENTS_IO_HERDR_SESSIONS_DIR=<its directory>` and `--label-suffix` for the collector.

**A Linux Box.** Build an image with the helpers, bwrap, Python, uv and the seccomp filter; run the collector in exec-only mode with `box` (and a separate one with `box-install`), as above.

**Turning it off.** `agents-io-herdr exec off` on the machine, at once; removing the ceiling file; on LB, taking exec back or revoking the node.

## Acceptance cases

What the tests are written against (machine side, a fake LB):

1. The same effect id twice: one process; the second call gets the same answer; other arguments get `effect_conflict`.
2. The collector killed mid-run and started again: the run is `unknown`, not run again.
3. A disconnect: the run goes on, its `effect` is sent after reconnecting, and not again once acknowledged.
4. A deadline already past: `deadline_passed`; a run reaching its deadline: the whole group killed, `timeout` with the output so far.
5. A call asking more than the ceiling (network, write) without a grant: `over_ceiling`; no ceiling, one others can write, one that does not parse: `exec_off`.
6. The sandbox: S1–S5.
7. Grants: expired, used once grants, another generation, too long, another hash — all `grant_invalid`; a window grant in another conversation does not hold.
8. Generation: a 4410 cancels runs and drops grants, the link comes back for the new generation; another owner writes `retired` and nothing links until paired again; a lower generation keeps exec off; a new node id in `node.json` makes the old process exit.
9. `origin.person` not the owner: `not_owner`; an unattended turn where the ceiling does not allow it: `unattended`.
10. An LB without generations or effect frames: sessions as before, no exec.
11. A new generation does not run an effect again: the same id after a 4410 gets the earlier answer; grants are gone, the ledger is not.
12. Redaction: tokens, an `Authorization` header and `password=…` in stdout are `[REDACTED]` in the frame with matching counts; the hash is of the redacted text; a token across the `outputBytes` boundary does not get through.
13. A collector killed with `kill -9` leaves no orphans: the next one kills the recorded groups and writes `unknown`; a reused pid is told apart by its start time.

## Not built yet

- N10 on the macOS runners (`upload.v1`, `download.v1` answer `unsupported` there).
- N11, delegation to the coding agents in herdr (`agents.v1`): the ceiling's `agents`, `agentWorkspace` and `agentCommand` are read but nothing acts on them.
- N13, the filtering proxy (fixed IP per host name, private ranges refused, SNI checked): until then `network: "proxy"` reaches a port nothing filters, so leave it off.
- S9, reaping a sandbox's members on the same user; until then widening is `widen_disabled` there.
