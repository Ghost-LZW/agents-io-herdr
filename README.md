# agents-io-herdr

**English** | [简体中文](README.zh-CN.md)

**Your coding agents, reachable from Feishu/Lark.** When a coding agent (Claude Code, Codex, …) in a [herdr](https://herdr.dev) pane is waiting for you or has finished a long turn, a bot tells you on Feishu/Lark — one topic per agent in a workbench group — and what you reply in that topic is typed into that agent. Built on [agents-io](https://github.com/Ghost-LZW/agents-io).

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

**What a notice says:** the machine, the project directory (last path component only), the agent, the terminal title, and the end of the pane's output — Claude Code's side panel and input box and Codex's footer cut away, secrets redacted. For a finished turn: Claude Code's recap line and the head of the last message (the conclusion comes first). For a dialog: its numbered choices as buttons, plus Esc.

**Where:** a workbench group (you and the bot) that the bridge creates when you bind yourself; each herdr pane gets its own topic. Without a workbench, notices go to your DM with the bot.

**Answering from Feishu:**

- reply in an agent's topic (in the DM: quote-reply its notice) → typed into that agent (`agent.prompt`);
- a button → that key in the dialog (`agent.send_keys`, digits and Esc);
- while a dialog is open nothing is typed: the bot says so and offers the buttons again;
- the bridge checks that the pane still runs the same program (herdr's `terminal_id`); when the agent is gone, its topic says so;
- only the bound owner can drive anything; anyone else gets a polite refusal, other bots are ignored;
- every answer is short and in place: "Sent.", "Pressed 1.", or why not.

**Commands** (the owner, in the DM, the workbench, or @-mentioning the bot in a group): `status` / `状态` (every agent: place, kind, state, since when — one card), `help` / `帮助`, `workbench` / `工作台` (DM: create the group again; in a group: use this group), `pause` / `暂停`, `resume` / `恢复`.

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

  `im:message.group_msg` lets the bot see your replies in a topic without an @-mention; `im:chat:create` lets it create the workbench group (without it, add the bot to a group yourself and @-mention it with `workbench`).
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

prints a one-time code (valid 15 minutes, 5 tries). Send it to the bot in a direct message. Whoever sends it becomes the owner; the bridge then creates the workbench group (you and the bot, named "my-mac terminal" / "my-mac 终端"), says hello there, and tells you in the DM. If the group cannot be created (e.g. `im:chat:create` missing), add the bot to any group and @-mention it with `workbench` / `工作台`; until then notices come to your DM.

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
- Pane output is redacted (tokens, keys, passwords, credentials in URLs, private keys) before it leaves the machine, and only the last component of a working directory is shown. Logs record pane ids and lengths, never what you typed.
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
