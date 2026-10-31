# agents-io-herdr

**English** | [简体中文](README.zh-CN.md)

**Your coding agents, reachable from Feishu/Lark.** When a coding agent (Claude Code, Codex, …) in a [herdr](https://herdr.dev) pane is waiting for you or has finished a long turn, a bot tells you on Feishu/Lark — one topic per pane in a workbench group — and what you reply in that topic is typed into that agent. Built on [agents-io](https://github.com/Ghost-LZW/agents-io).

No model is involved anywhere: when to notify is a handful of rules, routing is a deterministic agents-io binding table, the rest is code.

## How it works

```text
  herdr panes (Claude Code, Codex, …)
        │ agent.list every 2 s           ▲ agent.prompt / agent.send_keys
        ▼                                │
  bridge (this project; an agents-io host: rules, owner, topics)
        │ deliver: cards with buttons    ▲ host inbound queue: replies, buttons, commands
        ▼                                │
  aio daemon (agents-io; its own data dir, one lark-bot channel, no agents)
        │                                ▲
        ▼                                │
  Feishu / Lark: the workbench group, one topic per pane (or your DM)
```

The bridge talks to its daemon only over the agents-io host protocol (JSONL on a unix socket); it imports nothing from agents-io and has no runtime dependencies.

## What it does

**When it tells you** (all configurable):

| Change in a pane | Default |
| --- | --- |
| The agent is **blocked** (a permission prompt, a question) | after 60 s, once per blocked stretch |
| A **working** stretch of at least 2 min ends (`done` / `idle`) | after it has settled for 30 s; a quick working → idle → working flap counts as one stretch |
| You are **looking at it**: keyboard/mouse idle under 3 min (macOS) *and* the pane is focused in herdr | nothing (a dialog is announced once you leave, if still open) |
| **Quiet hours** 23:00–08:00 | finished turns are held and sent as one overnight list at the end; blocked agents are still announced (`quietBlocked` changes that) |

**What a notice says:** the machine, the project directory (last path component only), the agent, the terminal title, and what you asked. For a finished turn: **the whole answer**, then the whole process folded under "Process: N steps, M tool calls" — what the agent said between steps, its thinking when the model wrote it down, and every tool call (command, file, pattern) with the start of its output. For a dialog: the dialog from the screen, its numbered choices and navigation keys as buttons, and the process so far. What one card cannot hold follows in the same topic (in the DM: as replies), up to 10 more messages; when even that is too little, the oldest steps are left out and a line says so. Secret-looking strings are hidden unless `notify.redact` is false; email addresses are always shortened to their domain (Feishu refuses messages that carry one).

**While it works:** a turn that has worked for three minutes gets a live card in its topic: Feishu's thinking bubble shows each step as it happens (thinking, what the agent says, every tool call and its result), updated every few seconds from the transcript. When the turn ends the card is settled with the answer and becomes the turn's only message: no separate done notice (one goes out only when the card cannot be edited). Not during quiet hours, not while you are looking at the pane, and only with an agents-io daemon that can edit what it sent (`deliver.update`).

This comes from the transcript the agent writes itself (Claude Code: `~/.claude/projects/…/<session>.jsonl`; Codex: `~/.codex/sessions/…/rollout-…-<session>.jsonl`), which herdr names for each pane; only its last 8 MB is read. When there is none (another agent, a session not yet written), the notice shows the end of the pane's output instead: Claude Code's side panel and input box and Codex's footer cut away, Claude Code's recap line and the head of the last message for a finished turn.

**Where:** a workbench group (you and the bot) that the bridge creates when you bind yourself; each herdr pane gets its own topic, opened by a line naming the machine, workspace, tab, directory and agent. The topic lasts as long as the pane: when another agent starts in it, a line says so and the topic goes on; when the pane closes, the topic says it ended. Without a workbench, notices go to your DM with the bot.

**Answering from Feishu:**

- reply in an agent's topic (in the DM: quote-reply its notice) → typed into that agent (`agent.prompt`);
- a button → that key in the dialog (`agent.send_keys`, digits and Esc);
- while a dialog is open nothing is typed: the bot says so and offers the buttons again;
- text goes to whatever agent the pane runs now; a dialog's buttons only press keys in the program that showed it (herdr's `terminal_id`); when the pane is gone, its topic says so;
- only the bound owner can drive anything; anyone else gets a polite refusal, other bots are ignored;
- every answer is short and in place: "Sent.", "Pressed 1.", or why not.

**Commands** (the owner, in the DM, the workbench, or @-mentioning the bot in a group; always `/` and the word, so ordinary text is never taken for one): `/status` (every agent: place, kind, state, since when — one card), `/help`, `/workbench` (DM: create the group again; in a group: use this group), `/pause`, `/resume`.

**Any pane, any time** (the owner, in the DM or the workbench only — a screen says what is on the computer):

- `/ls`: every pane, plain terminals too (short id, tab, directory, kind, state, title), a "view" button each;
- `/view <pane> [lines]`: the pane's screen now (80 lines by default, at most 200), wrapping text, a refresh button, and waiting-dialog buttons for choices, ↑ ↓ ← → Enter Tab Esc; **reply to that card to type into that pane**;
- `/process <pane>`: the latest turn recorded in Claude/Codex JSONL, with visible thinking, tool calls and the answer in pages; only fields actually recorded are shown;
- `/send <pane> <text>`: text and Enter — `agent.prompt` for an agent (not into a waiting dialog: the screen comes back with its buttons), literal text and Enter for a plain terminal;
- `/keys <pane> <key>…`: key presses by herdr's names (`esc`, `enter`, `tab`, `up`, `ctrl+c`, `1`…); herdr checks every name before it types anything;
- in an agent's topic (or under a screen card), `/view [lines]`, `/process` and `/keys <key>…` act on that pane; anything else there, other `/` commands too (the agent's own `/compact`), is still typed into it.

A navigation click sends one key, then reads the current screen again. Cards target the program’s terminal id; old thread-only buttons refresh once before offering current controls. For more screen context use `/view w6:p2 200`; a full-screen program can expose only its visible page. The “Process / answer” button reads the latest JSONL turn immediately; it does not wait for the automatic live-card delay or send the raw log.

`<pane>` is the pane's id (`w1:p2`), its short id (`p2`), its tab's label or its directory, the first that fits uniquely. Buttons and screen cards are tied to the program running in the pane (herdr's `terminal_id`): once another program runs there, they reach nothing.

## Agents started from a message

`spawn` rules start a new agent in herdr when the owner writes a trigger on another channel, for example a personal account loaded into the daemon as an agents-io channel plugin (`channels`, its tokens by name in `secrets`). The channel must mark the trigger as addressed to the deployment (admission `dispatch`). For each trigger the bridge:

- opens a tab in the herdr workspace `workspace` (default `ai`), in a fresh directory under `cwd` with the rule's `skills` linked into `.claude/skills` and `.agents/skills`, and its `env` (values may be `env:…` or `keychain:…`);
- runs the rule's `before` hooks there, in order (a command line or a list; `timeoutSec`, default 60; `required: true` stops the start when it fails, otherwise a failure is only logged), with the rule's `env` and `HERDR_SPAWN_RULE`, `_ID`, `_DIR`, `_CHANNEL`, `_ACCOUNT`, `_CONVERSATION`, `_TOPIC`, `_MESSAGE`;
- starts the agent (`kind`, `args`) and gives it the rule's `preamble`, where it was called (conversation, topic, message ids), the quoted message and the owner's words;
- answers in a topic under the trigger (the topic it is in, else a new one rooted at it): a progress message, edited while it works where the daemon can (`deliver.update`), settled with the answer;
- types what the owner says next in the same topic (or in reply to one of the agent's messages) into the same agent; while it waits on a dialog, a bare number or `esc` picks.

An agent can schedule itself through the daemon's external MCP endpoint (`mcp` with `declare: true`, a client allowed `schedule:` routes): `schedule_add` with action `wake` comes back here at its time; mode `resume` wakes the same agent (in its pane, or a new tab resuming its harness session if the pane is gone), `fresh` starts a new one on the same place.

A topic can have more than one agent (another trigger there, a `fresh` wake): the bridge says so in the topic, each agent's messages then start with its name (`【ai-1a2b】`), and what the owner says goes to the newest. `/agents` lists them; `/close <name>` closes one, `/close all` all of them, a bare `/close` the newest.

Only the rule's `owner` (platform-signed) is listened to. Spawned panes get no notices or live cards in the workbench; they answer where they were called.

## Requirements

- macOS for `install` (launchd); the bridge itself runs wherever Node runs, but "is the person looking" needs macOS.
- **Node.js 24+** (the TypeScript sources run directly via type stripping) and **pnpm**.
- [herdr](https://herdr.dev) with its socket API (`~/.config/herdr/herdr.sock`).
- An [agents-io](https://github.com/Ghost-LZW/agents-io) checkout from `main` at or after commit 638eccf (reply chains and topic ids reach hosts), built with `pnpm install && pnpm build`.
- A Feishu or Lark tenant where you may create a self-built app.

## Setup

### 1. Create the Feishu/Lark app

On [open.feishu.cn](https://open.feishu.cn/app) (or open.larksuite.com) create a **self-built app** — a dedicated one for this bridge, e.g. "my-mac terminal" ([create-lark-bot](https://github.com/Ghost-LZW/create-lark-bot) can do most of this). One app belongs to one daemon: do not reuse an app another bot or agents-io instance already runs.

- **Add features → Bot.**
- **Permissions** (tenant scopes; "batch import" accepts this):

  ```json
  {
    "scopes": {
      "tenant": [
        "im:message",
        "im:message:send_as_bot",
        "im:message.p2p_msg:readonly",
        "im:message.group_at_msg:readonly",
        "im:message.group_msg",
        "im:chat:create"
      ],
      "user": []
    }
  }
  ```

  `im:message.group_msg` lets the bot see your replies in a topic without an @-mention; `im:chat:create` lets it create the workbench group (without it, add the bot to a group yourself and @-mention it with `/workbench`).
- **Events & callbacks:** choose **long connection** (no public URL needed) for both; subscribe to the event `im.message.receive_v1` and the callback `card.action.trigger`. Feishu saves the long-connection mode only while a client is connected: if the console refuses, finish steps 2–5 first (the daemon keeps retrying) and come back.
- **Publish** a version, and make the app available to yourself.

### 2. Get the code

```sh
git clone https://github.com/Ghost-LZW/agents-io-herdr.git ~/src/agents-io-herdr
cd ~/src/agents-io-herdr && pnpm install          # dev tools only; nothing is needed at runtime
git clone https://github.com/Ghost-LZW/agents-io.git ~/src/agents-io
cd ~/src/agents-io && pnpm install && pnpm build
```

Optionally put the launcher on your PATH: `ln -s ~/src/agents-io-herdr/bin/agents-io-herdr ~/.local/bin/`. Run it from the clone (Node does not strip types under `node_modules`, so it is not meant to be installed as a package).

### 3. Put the credentials in the keychain

The app id and secret are read at runtime, never written to a file. launchd jobs see neither your shell's environment nor 1Password (the `op` CLI waits for an approval no one gives under launchd and hangs), so use the login keychain:

```sh
security add-generic-password -U -a "$USER" -s agents-io-herdr.app-id -w       # prompts for the app id
security add-generic-password -U -a "$USER" -s agents-io-herdr.app-secret -w   # prompts for the secret
```

Leaving the value after `-w` empty makes `security` prompt for it, so it stays out of your shell history. For a foreground run, `AGENTS_IO_HERDR_APP_ID` / `AGENTS_IO_HERDR_APP_SECRET` in the environment work too; other item or variable names are set in the config (`feishu.appId`, `feishu.appSecret`).

### 4. Configure

```sh
agents-io-herdr init --aio-repo ~/src/agents-io --machine my-mac
```

writes `~/.config/agents-io-herdr/config.json` (mode 0600) — see [config.example.json](config.example.json) and the table below.

### 5. Install

```sh
agents-io-herdr install
```

loads two launch agents: the project's own agents-io daemon (`agents-io-herdr daemon`, which runs `aio serve` with a generated config and the credentials from the keychain in its environment) and the bridge (`agents-io-herdr run`). Logs go to `~/Library/Logs/agents-io-herdr/`.

### 6. Become the owner

```sh
agents-io-herdr setup --wait
```

prints a one-time code (valid 15 minutes, 5 tries). Send it to the bot in a direct message. Whoever sends it becomes the owner; the bridge then creates the workbench group (you and the bot, named "my-mac terminal" / "my-mac 终端"), says hello there, and tells you in the DM. If the group cannot be created (e.g. `im:chat:create` missing), add the bot to any group and @-mention it with `/workbench`; until then notices come to your DM.

`agents-io-herdr test` sends a test message to check the path end to end.

## Configuration

`~/.config/agents-io-herdr/config.json` (or `$AGENTS_IO_HERDR_CONFIG`); every key is optional.

| Key | Default | Meaning |
| --- | --- | --- |
| `machine` | macOS LocalHostName | The machine's name in messages |
| `locale` | `zh` for Feishu, `en` for Lark | Language of the bot's messages |
| `timeZone` | the system's | For quiet hours and times in messages |
| `aioRepo` | — | The agents-io checkout (built); `aioCli` names the daemon CLI directly instead |
| `feishu.domain` | `feishu` | `feishu` or `lark` |
| `feishu.appId`, `feishu.appSecret` | `env:AGENTS_IO_HERDR_APP_…`, then `keychain:agents-io-herdr.app-…` | Where the credentials come from, tried in order (`env:NAME`, `keychain:SERVICE`; the app id may also be written as is) |
| `account` | `herdr` | The bot's account name inside the daemon |
| `herdrSocket` | `$HERDR_SOCKET_PATH` or `~/.config/herdr/herdr.sock` | herdr's socket |
| `notify.blockedAfterSec` | 60 | How long an agent is blocked before you hear about it |
| `notify.doneMinTurnSec` | 120 | Shorter turns are not announced |
| `notify.doneSettleSec` | 30 | How long a finished turn must stay finished |
| `notify.presentIdleSec` | 180 | Keyboard/mouse idle below this + pane focused = you are looking |
| `notify.quiet` | `23:00-08:00` | Quiet hours, or `off` |
| `notify.quietBlocked` | false | Also hold blocked notices during quiet hours |
| `notify.live` | true | A live card for long turns (needs an agents-io daemon with `deliver.update`) |
| `notify.liveAfterSec` | 180 | How long a turn works before its live card appears (never while you look at the pane) |
| `notify.redact` | true | Hide secret-looking strings in what is sent (email addresses are shortened regardless) |
| `notify.liveEverySec` | 5 | How often the live card follows the transcript (at least 2) |
| `channels` | — | More agents-io channel entries for the project's daemon, as written |
| `secrets` | — | `NAME: "keychain:…" \| "env:…"`: set in the daemon's environment, for the `env:NAME` values of `channels` |
| `externalMcp` | — | The daemon's external MCP endpoint (agents-io `externalMcp`: `listen`, `clients` with `tokenFile` and `scopes`), as written |
| `spawn` | — | Rules that start an agent from a message (above): `channel`, `account`, `owner` (required); `kind` (`claude`), `args`, `cwd`, `env`, `skills`, `preamble`, `before`, `mcp` (name → `{ url, token: "env:…" | "keychain:…" }`, written to the agent's `.mcp.json`), `trigger`, `dirPerAgent`, `workspace` (`ai`), `id` (`ai`) |
| `workbench.create` | true | Create the workbench group at setup |
| `workbench.name` | `<machine> terminal` / `<machine> 终端` | Its name |
| `dataDir` | `~/.local/share/agents-io-herdr` (or `$AGENTS_IO_HERDR_DATA`) | State and the daemon's data |

## Command line

| Command | What it does |
| --- | --- |
| `init [--aio-repo <dir>] [--machine <name>]` | Write a starter config (0600) |
| `setup [--wait]` | Print a one-time code; DM it to the bot to become the owner |
| `install` / `uninstall` | Load / remove the two launch agents (macOS) |
| `status` | What runs, who owns it, where notices go, whether the credentials are found, recent logs |
| `pause` / `resume` | A switch file: no notices and nothing typed into agents while it exists |
| `test` | Send a test message to the workbench (or the owner's DM) |
| `run` | The bridge in the foreground (what launchd runs) |
| `daemon` | The project's agents-io daemon in the foreground |

## Files

| Path | Contents |
| --- | --- |
| `~/.config/agents-io-herdr/config.json` | Configuration (no secrets) |
| `~/.config/agents-io-herdr/paused` | Present while paused |
| `~/.local/share/agents-io-herdr/state.json` | Owner, workbench, which Feishu messages and topics belong to which pane (0600) |
| `~/.local/share/agents-io-herdr/aio.config.json` | The generated daemon config (`env:` references only) |
| `~/.local/share/agents-io-herdr/aio/` | The daemon's own data, log database and socket |
| `~/Library/Logs/agents-io-herdr/` | `daemon.log`, `bridge.log` |

## Security and privacy

- Driving an agent is remote typing on your computer. Only the bound owner (their Feishu identity, platform-signed) can do it; protect that account as you would your laptop. `pause` stops everything at once.
- Pane output and transcript excerpts are redacted (tokens, keys, passwords, credentials in URLs, private keys) before it leaves the machine (`notify.redact: false` turns that off; email addresses are shortened either way), and only the last component of a working directory is shown. Logs record pane ids and lengths, never what you typed.
- Credentials live in the keychain or the environment; the generated daemon config and the launchd plists contain none.
- The daemon is dedicated to this project: its own data directory and socket, no web console, no external MCP endpoint, no agents, no local routing rules. It does not touch any other agents-io daemon on the machine. The bridge pushes the binding table: your DM, the workbench, your @-mentions and its own buttons reach it; everything else is dropped. While the bridge is down the table stays active, so your replies wait in the daemon's durable queue.

## Limits

- One machine per bot: each machine runs its own daemon, and a Feishu app can only have one long connection consumer, so a second machine needs a second app. (herdr's `--machine` remote panes are not watched.)
- Presence detection (idle time) is macOS only; elsewhere you are never considered to be looking.

## Development

```sh
pnpm install
pnpm test          # vitest; fakes only: a fake agents-io daemon on a temp socket, a fake herdr, a fake Feishu API
pnpm typecheck
pnpm lint
```

`AIO_HERDR_TEST_WORKERS` caps the test workers (default 2).

## License

[MIT](LICENSE)
