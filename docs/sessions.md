# Sessions: this machine's Claude Code and Codex sessions for LB

A read-only collector runs on each machine, lists the Claude Code and Codex sessions there, and hands the list to LB — the assistant server the machine is paired with — over a node connection. LB's assistant can then see what runs on the owner's machines and read a session page by page; how much of it the assistant may repeat, and to whom, is LB's policy.

With a ceiling file the same connection also carries command execution ([exec.md](exec.md)); without one the collector only reads.

## What it collects

- **Where:** `agents-io-herdr sessions collect`, as the launchd agent `io.agents-io-herdr.sessions` (`sessions install`), every 10 s. For launchd the Node path is made stable: a Homebrew Node is written as its formula's `opt` link (`/opt/homebrew/opt/node@24/bin/node`), so `brew upgrade` does not break the job; another Node as it is (after switching versions, run `sessions install` again).
- **Which sessions:** agents in herdr panes, ones started in a plain terminal, and headless ones (`claude -p`, the SDK, `codex exec`). All that run now, and those that ended within `recentHours` (24 by default).
- **What each session says:** machine, directory, title (the one Claude Code made or a person set, Codex's thread name; otherwise the first prompt), state (running, waiting for a person, ended), start, last activity, a one-line summary (title or first prompt → the latest line), herdr's pane id, whether it is headless. No file paths, no full text.
- **Read from** (all read only):
  - Claude Code's transcripts `~/.config/claude/projects/*/<id>.jsonl` and `~/.claude/projects/*/<id>.jsonl`, and its registry of live sessions `~/.config/claude/sessions/<pid>.json` (`busy` means running);
  - Codex's `~/.codex/sessions/<y>/<m>/<d>/rollout-…jsonl` and `~/.config/codex/sessions/…`, titles from `session_index.jsonl`;
  - `ps` and `lsof`: which `claude` / `codex` process has which directory open (an unregistered process is matched to the newest session there);
  - herdr's `agent.list`: inside herdr its state wins (`working` is running; `blocked`, `idle`, `done` are waiting).
- **State:** a process with an unfinished turn is running, a finished turn is waiting; no process is ended (a headless transcript still moving in the last two minutes with an unfinished turn counts as running).
- Transcripts are read incrementally, each file from where the last scan stopped; a very large file seen for the first time is read at its head and tail only.
- The latest list is also written locally, `~/.config/agents-io-herdr/sessions-latest.json` (0600).

## The connection to LB

- The collector connects out to `wss://<LB>/api/nodes/connect`; LB sends a challenge and the collector signs `lb-node:<nonce>` with the machine's node key (ed25519). There is no long-lived token.
- **Where the node key is** (`report` in `sessions.json`): `keyFile`, a file only this user can read (PKCS#8 PEM, file 0600, directory 0700; anything else is not used), or `keychainService` / `keychainAccount` in the login keychain. With both, the file wins. A machine nobody is logged in to needs the file: the login keychain is locked in ssh sessions and in jobs started over ssh.
- **The key never appears in a command's arguments** (`ps` shows them): files are written in-process; the keychain is written with `security -i`, the command read from stdin, and read with `security find-generic-password -w`, the key only on its stdout.
- One frame of its own, `{t:"sessions", machine, at, sessions:[…]}`: sent when the list changes, at least every minute. LB keeps it in memory; a machine that is not connected is not listed.
- One call answered, `session.read {id, offset, limit}` (one page). Typing into an agent or pressing keys is `unsupported`. It never sends `panes` or `notice` frames.
- **Exec only with a ceiling file** ([exec.md](exec.md)). Without a valid `exec-ceiling.json`, with `exec.off`, or once the machine is retired, the collector is read-only: hello's `caps` is `["sessions"]` and every exec call is refused. With one, `exec.v1` and the like appear in `caps`, and LB still asks the owner to confirm them before it sends any. A change of the ceiling or of the switch makes the collector say hello again on its next pass. On the machine: `agents-io-herdr exec status`, `exec off`, `exec doctor`, `exec probe`. A collector stopped by launchd (SIGTERM) stops its runs first.
- The hello is version 2 (`agents-io-herdr-sessions/2`: generation, ceiling summary, this machine's clock); the welcome gives the generation and the owner (`node.json`). An LB that does not know these fields drops them and sessions go on. Reconnecting: after a 4408 or 4410 close or a wake, at once the first time; otherwise backing off from 5 s to 60 s. With nothing from LB for 75 s the collector drops the connection and reconnects.
- An LB that does not know the `sessions` frame ignores it, so the collector can be installed before LB is upgraded.

**Pairing a machine:** `agents-io-herdr sessions pair --lb-url <url> --machine <name>`. LB asks its owner to accept the new node. The command shows a six-digit pairing code derived from the public key; accept only if LB's card shows the same code. When the code LB answers does not match, the command fails and keeps no key.

- The personal token is read from `LB_TOKEN`, or with `--token-stdin` from the first line of stdin — for pairing over ssh, so the token is in no argument and no file:
  `<print the token> | ssh <host> 'agents-io-herdr sessions pair --token-stdin --lb-url <url> --machine <name>'`
- The key goes to `~/.config/agents-io-herdr/node-key.pem` by default (`--key-file` elsewhere), or with `--key-store keychain` to the login keychain (`--key-service`, `--key-account` for the item; a locked keychain fails and suggests the file).
- `sessions init` writes the configuration for a node that is already registered (`--lb-url`, `--node`, and `--key-file` or `--key-service` / `--key-account`).

## A machine nobody is logged in to: through ssh loopback

macOS's Local Network privacy refuses LAN addresses to a Node that launchd starts directly (`EHOSTUNREACH`) until someone allows it in System Settings → Privacy & Security → Local Network; a process sshd starts is not affected. So the job can go through ssh to the same machine:

- A local key of its own, `~/.config/agents-io-herdr/local_ed25519` (0600, comment `agents-io-herdr-sessions-local`), and `known_hosts_local` with 127.0.0.1's host key.
- `agents-io-herdr sessions install --via-ssh`: the launchd job becomes `ssh -i local_ed25519 <user>@127.0.0.1`, and the command prints the line for `~/.ssh/authorized_keys` with its restrictions: `from="127.0.0.1,::1"`, `command="exec env PATH=… <node> <install dir>/bin/agents-io-herdr sessions collect"`, `no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc`. Whatever the client asks for, only the collector runs.
- The collector's parent is then sshd. sshd does not end it when the connection drops, so the collector checks its parent on every pass and exits when it is gone; launchd's next connection does not leave a second one behind. Every collector also writes its pid to `collector.pid` at start, and an older one that sees another pid exits, however it was left behind.
- To undo: remove the `authorized_keys` line commented `agents-io-herdr-sessions-local` and `local_ed25519*`, then `sessions install` without `--via-ssh`, or `sessions uninstall`.

**A second collector on the same machine** (for example one linked to a staging LB): `AGENTS_IO_HERDR_SESSIONS_DIR=<its own directory> agents-io-herdr sessions install --label-suffix staging [--via-ssh]`. The launchd label is `io.agents-io-herdr.sessions.staging`; node, key, `local_ed25519`, ceiling, effect ledger and switches are all in that directory, apart from the first collector's. Without a directory, or with the default one, the command refuses. The directory must be an absolute path without spaces or quotes: it is written as it is into the launchd job's environment and, with `--via-ssh`, into the `authorized_keys` line's `command="exec env … AGENTS_IO_HERDR_SESSIONS_DIR=<dir> …"` (a forced command does not get launchd's environment). `sessions status --label-suffix staging` and `sessions uninstall --label-suffix staging` act on it.

**Exec only** (`AGENTS_IO_HERDR_EXEC_ONLY=1`, or `execOnly: true` in `sessions.json`): no sessions at all, only the node link and exec; for the Linux Box ([exec.md](exec.md)).

## Redaction of what is read

- A page holds at most 100 entries (30 by default) and about 40,000 characters; an entry at most 2000 characters, a tool call or result 600. Without `offset` the last page comes (what it is doing now); `prev` pages back.
- Only people's prompts, the agent's words, tool calls and their results are read; thinking, encrypted reasoning, request records and file snapshots are not.
- Everything passes `src/redact.ts` in strict mode on this machine first: private keys, prefixed tokens, JWTs, `Authorization` and `Cookie` header values of any scheme and length, passwords in URLs, secret flags, the forms that name no key (`curl -u user:pass`, `mysql -ppass`, `sshpass -p`, `redis-cli -a`, `docker login -p`, `.netrc`), kubeconfig client data, a docker config's `"auth"`, base64 PEM keys, and every value after a key like `password=`, `token:`, `api_key:` however short or plain (except `true` / `false`, `$VAR`, `<placeholder>`). Titles, first prompts, summaries and every entry read alike.
- LB is expected to redact again with its own rules; it may replace `[REDACTED]` with its own marker.

## Turning it off

- Pause: `agents-io-herdr sessions off` (nothing listed or read; LB gets an empty list); resume: `sessions on`.
- Uninstall: `agents-io-herdr sessions uninstall` (stops and removes the launchd job), then remove `~/.config/agents-io-herdr/sessions*.json` and the install directory `~/.local/share/agents-io-herdr-sessions`.
- Stop reporting only: remove `report` from `sessions.json`, or revoke the machine on LB (it disconnects and refuses it from then on).
- A new node key: revoke the machine on LB, remove `node-key.pem` (or the keychain item), and `sessions pair` again.
