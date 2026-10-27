# agents-io-herdr

[English](README.md) | **简体中文**

**在飞书/Lark 上照看你的 coding agent。** [herdr](https://herdr.dev) 窗格里的 coding agent（Claude Code、Codex 等）在等你、或做完一段长活时，机器人在飞书/Lark 上告诉你——工作台群里每个 agent 一个话题——你在话题里回复的文字就送进那个 agent。基于 [agents-io](https://github.com/Ghost-LZW/agents-io)。

全程不调用模型：什么时候通知是几条规则，路由是 agents-io 的确定性 Binding 表，其余都是代码。

## 工作原理

```text
  herdr 窗格（Claude Code、Codex……）
        │ 每 2 秒 agent.list             ▲ agent.prompt / agent.send_keys
        ▼                                │
  bridge（本项目；agents-io 宿主：规则、主人、话题）
        │ deliver：带按钮的卡片          ▲ 宿主入站队列：回复、按钮、命令
        ▼                                │
  aio 守护进程（agents-io；独立数据目录，一个 lark-bot 通道，没有 agent）
        │                                ▲
        ▼                                │
  飞书 / Lark：工作台群，每个窗格一个话题（或你的私聊）
```

bridge 只通过 agents-io 的宿主协议（unix socket 上的 JSONL）和自己的守护进程说话，不引用 agents-io 的任何包，也没有运行时依赖。

## 能做什么

**什么时候告诉你**（都可以配置）：

| 窗格里的变化 | 默认 |
| --- | --- |
| agent **卡住**（等审批、在提问） | 卡住 60 秒后，每段卡住只发一次 |
| 至少 2 分钟的一段 **working** 结束（`done` / `idle`） | 稳定 30 秒后发；working → idle → working 的短暂来回算同一段 |
| **你正看着它**：键鼠空闲不到 3 分钟（macOS）*并且* herdr 前台正是这个窗格 | 不发（对话框在你离开后还开着就发） |
| **安静时段** 23:00–08:00 | 做完的先攒着，时段结束时合成一条「夜里做完的」；卡住的照发（`quietBlocked` 可改） |

**通知里有什么**：哪台机器、项目目录（只取最后一级）、哪个 agent、终端标题，以及你问的是什么。做完时：**完整的回答**，再把整个过程折叠在“过程：N 步，M 次工具调用”下面——agent 在各步之间说的话、模型写下的思考，以及每次工具调用（命令、文件、搜索词）和它输出的开头。卡在对话框时：屏幕上的对话框，带编号的选项做成按钮外加 Esc，以及到此为止的过程。一张卡放不下的，接着发在同一个话题里（私聊里是回复），最多再发 10 条；还不够时，最早的几步不发，并有一行说明。全部内容都已脱敏。

**正在做的时候**：一轮做满一分钟，就在它的话题里发一张实时卡片：飞书的思考气泡一步步显示它在做什么（思考、agent 说的话、每次工具调用和结果），每隔几秒按会话记录更新。这一轮结束时卡片收尾、写上回答，做完的通知指向它。安静时段不发，你正看着这个窗格时不发，守护进程不支持修改已发消息（`deliver.update`）时也不发。

这些来自 agent 自己写的会话记录（Claude Code：`~/.claude/projects/…/<会话>.jsonl`；Codex：`~/.codex/sessions/…/rollout-…-<会话>.jsonl`），herdr 会告诉我们每个窗格对应哪个会话；只读最后 8 MB。没有会话记录时（别的 agent、会话还没写文件），通知改用窗格输出的末尾：去掉 Claude Code 的侧栏和输入框、Codex 的底栏；做完时是 Claude Code 的 recap 行加最后一条消息的开头。

**发到哪**：一个工作台群（你和机器人），在你绑定主人时由 bridge 自动创建；herdr 的每个窗格一个话题。没有工作台时发到你和机器人的私聊。

**在飞书上回话**：

- 在 agent 的话题里回复（私聊里：引用回复它的通知）→ 送进那个 agent（`agent.prompt`）；
- 点按钮 → 在对话框里按那个键（`agent.send_keys`，数字和 Esc）；
- 对话框开着时不送字：机器人说明一下，再把按钮发一遍；
- bridge 会核对窗格里还是同一个程序（herdr 的 `terminal_id`）；agent 已经结束时，话题里会说；
- 只有绑定的主人能操作；别人会被礼貌地拒绝，其他机器人一律不理；
- 回答都很短、就在原处：「已送到」「已按 1」或者没送到的原因。

**命令**（主人在私聊、工作台，或在群里 @机器人；一律是 `/` 加英文单词，普通文字不会被当成命令）：`/status`（所有 agent：位置、类型、状态、持续多久，一张卡片）、`/help`、`/workbench`（私聊里：重新建群；群里：把这个群当工作台）、`/pause`、`/resume`。

**随时看、随时操作任何 pane**（主人，只在私聊和工作台里——屏幕内容就是电脑上的内容）：

- `/ls`：所有 pane，包括普通终端（短 id、tab、目录、类型、状态、标题），每个一个「看」按钮；
- `/view <pane> [行数]`：它现在的屏幕（默认 40 行，最多 200），带刷新按钮；卡住的对话框会给出选项按钮；**回复这张卡片就是往那个 pane 里输入**；
- `/send <pane> <文字>`：输入文字并回车——agent 用 `agent.prompt`（对话框开着时不输入，改为发回屏幕和按钮），普通终端直接输入文字再回车；
- `/keys <pane> <键>…`：按键，用 herdr 的键名（`esc`、`enter`、`tab`、`up`、`ctrl+c`、`1`…），herdr 会先检查所有键名，有一个不对就什么都不按；
- 在 agent 的话题里（或屏幕卡片下面），`/view [行数]` 和 `/keys <键>…` 作用于那个 pane；其他文字，包括别的 `/` 命令（agent 自己的 `/compact` 等），照旧输入给它。

`<pane>` 可以是 pane 的 id（`w1:p2`）、短 id（`p2`）、tab 名或目录名，按这个顺序取第一个唯一匹配的。按钮和屏幕卡片绑定 pane 里运行的那个程序（herdr 的 `terminal_id`）：换了程序之后就不再起作用。

## 从消息启动 agent

`spawn` 规则让主人在另一个通道上写触发词时，在 herdr 里新开一个 agent。比如把个人账号作为 agents-io 通道插件挂进守护进程（`channels`，它的 token 按名字写在 `secrets`）。通道要把触发消息标成“对本部署说的”（admission `dispatch`）。每次触发，桥接会：

- 在 herdr 的 `workspace` 工作区（默认 `ai`）开一个 tab，目录是 `cwd` 下新建的一个，规则的 `skills` 链接进 `.claude/skills` 和 `.agents/skills`，环境变量用 `env`（值可写 `env:…`、`keychain:…`）；
- 在那里依次运行规则的 `before` 钩子（一行命令或一个列表；`timeoutSec` 默认 60；`required: true` 时失败就不开 agent，否则只记日志），环境变量是规则的 `env`，外加 `HERDR_SPAWN_RULE`、`_ID`、`_DIR`、`_CHANNEL`、`_ACCOUNT`、`_CONVERSATION`、`_TOPIC`、`_MESSAGE`；
- 启动 agent（`kind`、`args`），告诉它规则的 `preamble`、在哪被叫的（会话、话题、消息 id）、引用的消息和主人的话；
- 在触发消息下的话题里回答（它本来在话题里就用那个话题，否则以它为根开一个新话题）：先发一条进度消息，守护进程能改已发消息（`deliver.update`）时边做边改，最后改成回答；
- 主人之后在同一个话题里（或回复 agent 的消息）说的话，交给同一个 agent；它在等选择时，回一个数字或 `esc` 就是选。

只听规则里的 `owner`（平台签名的身份）。这些窗格不在工作台发通知和实时卡片，只在被叫的地方回答。

## 需要

- `install` 需要 macOS（launchd）；bridge 本身在有 Node 的地方都能跑，但「人是不是正看着」只在 macOS 上能判断。
- **Node.js 24+**（直接运行 TypeScript 源码，靠类型剥离）和 **pnpm**。
- [herdr](https://herdr.dev) 及其 socket API（`~/.config/herdr/herdr.sock`）。
- [agents-io](https://github.com/Ghost-LZW/agents-io) 的 `main`，不早于 638eccf（回复链和话题 id 交给宿主），已 `pnpm install && pnpm build`。
- 一个能建企业自建应用的飞书或 Lark 租户。

## 安装配置

### 1. 建飞书/Lark 应用

在 [open.feishu.cn](https://open.feishu.cn/app)（或 open.larksuite.com）建一个**企业自建应用**——专门给这个 bridge 用，比如叫「my-mac 终端」（[create-lark-bot](https://github.com/Ghost-LZW/create-lark-bot) 能代劳大部分步骤）。一个应用只属于一个守护进程：不要复用别的机器人或别的 agents-io 实例已经在用的应用。

- **添加应用能力 → 机器人。**
- **权限**（应用身份；「批量导入」可以直接用）：

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

  `im:message.group_msg` 让机器人在话题里不被 @ 也能收到你的回复；`im:chat:create` 让它能建工作台群（没有的话，自己把机器人拉进一个群，@它发 `/workbench`）。
- **事件与回调**：两者都选**长连接**（不需要公网地址）；订阅事件 `im.message.receive_v1` 和回调 `card.action.trigger`。飞书只在有客户端连着时才能保存长连接模式：控制台不让保存的话，先做完第 2–5 步（守护进程会一直重连），再回来设置。
- **发布**一个版本，并让自己在应用的可用范围内。

### 2. 取代码

```sh
git clone https://github.com/Ghost-LZW/agents-io-herdr.git ~/src/agents-io-herdr
cd ~/src/agents-io-herdr && pnpm install          # 只装开发工具；运行时什么都不需要
git clone https://github.com/Ghost-LZW/agents-io.git ~/src/agents-io
cd ~/src/agents-io && pnpm install && pnpm build
```

可以把启动脚本放进 PATH：`ln -s ~/src/agents-io-herdr/bin/agents-io-herdr ~/.local/bin/`。请从克隆的目录运行（Node 不剥离 `node_modules` 里的类型，所以它不是用来当包安装的）。

### 3. 把凭据放进钥匙串

app id 和 secret 在运行时读取，从不写进文件。launchd 任务看不到 shell 的环境变量，也用不了 1Password（`op` CLI 在 launchd 下会一直等一个没人点的授权，卡死），所以用登录钥匙串：

```sh
security add-generic-password -U -a "$USER" -s agents-io-herdr.app-id -w       # 提示输入 app id
security add-generic-password -U -a "$USER" -s agents-io-herdr.app-secret -w   # 提示输入 secret
```

`-w` 后面不写值，`security` 会提示输入，值就不会进 shell 历史。前台运行时也可以用环境变量 `AGENTS_IO_HERDR_APP_ID` / `AGENTS_IO_HERDR_APP_SECRET`；别的钥匙串条目名或变量名在配置里改（`feishu.appId`、`feishu.appSecret`）。

### 4. 配置

```sh
agents-io-herdr init --aio-repo ~/src/agents-io --machine my-mac
```

写出 `~/.config/agents-io-herdr/config.json`（权限 0600）——参考 [config.example.json](config.example.json) 和下面的表。

### 5. 装成常驻

```sh
agents-io-herdr install
```

装两个 launch agent：本项目自己的 agents-io 守护进程（`agents-io-herdr daemon`，用生成的配置运行 `aio serve`，凭据从钥匙串读出、只放进它的环境变量）和 bridge（`agents-io-herdr run`）。日志在 `~/Library/Logs/agents-io-herdr/`。

### 6. 成为主人

```sh
agents-io-herdr setup --wait
```

打印一个一次性配对码（15 分钟内有效，可试 5 次）。在私聊里把它发给机器人。谁发了它，谁就是主人；bridge 随后建好工作台群（你和机器人，名字是「my-mac 终端」/「my-mac terminal」），在群里打个招呼，并在私聊里告诉你。建不了群时（比如缺 `im:chat:create`），把机器人拉进任意一个群，@它发 `/workbench`；在那之前通知发到私聊。

`agents-io-herdr test` 发一条测试消息，检查整条链路。

## 配置项

`~/.config/agents-io-herdr/config.json`（或 `$AGENTS_IO_HERDR_CONFIG`）；每一项都可以不写。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `machine` | macOS 的 LocalHostName | 消息里这台机器的名字 |
| `locale` | 飞书 `zh`，Lark `en` | 机器人说话的语言 |
| `timeZone` | 系统时区 | 安静时段和消息里的时间 |
| `aioRepo` | — | agents-io 的克隆目录（已构建）；也可以用 `aioCli` 直接指定守护进程的 CLI |
| `feishu.domain` | `feishu` | `feishu` 或 `lark` |
| `feishu.appId`、`feishu.appSecret` | 先 `env:AGENTS_IO_HERDR_APP_…`，再 `keychain:agents-io-herdr.app-…` | 凭据从哪里来，按顺序尝试（`env:变量名`、`keychain:服务名`；app id 也可以直接写值） |
| `account` | `herdr` | 机器人在守护进程里的账号名 |
| `herdrSocket` | `$HERDR_SOCKET_PATH` 或 `~/.config/herdr/herdr.sock` | herdr 的 socket |
| `notify.blockedAfterSec` | 60 | 卡住多久才告诉你 |
| `notify.doneMinTurnSec` | 120 | 更短的一轮不通知 |
| `notify.doneSettleSec` | 30 | 做完后要稳定多久 |
| `notify.presentIdleSec` | 180 | 键鼠空闲少于这个且窗格在前台 = 你正看着 |
| `notify.quiet` | `23:00-08:00` | 安静时段，或 `off` |
| `notify.quietBlocked` | false | 安静时段里卡住的也先攒着 |
| `notify.live` | true | 长的一轮发实时卡片（需要支持 `deliver.update` 的 agents-io 守护进程） |
| `notify.liveAfterSec` | 60 | 一轮做了多久之后发实时卡片 |
| `notify.liveEverySec` | 5 | 实时卡片多久按会话记录更新一次（至少 2） |
| `channels` | — | 给项目守护进程加的 agents-io 通道条目，原样写入 |
| `secrets` | — | `名字: "keychain:…" \| "env:…"`：放进守护进程的环境变量，给 `channels` 里的 `env:名字` 用 |
| `externalMcp` | — | 守护进程的对外 MCP 端点（agents-io 的 `externalMcp`：`listen`、带 `tokenFile` 和 `scopes` 的 `clients`），原样写入 |
| `spawn` | — | 从消息启动 agent 的规则（见上）：`channel`、`account`、`owner` 必填；`kind`（`claude`）、`args`、`cwd`、`env`、`skills`、`preamble`、`before`、`mcp`（名字 → `{ url, token: "env:…" | "keychain:…" }`，写进 agent 的 `.mcp.json`）、`trigger`、`dirPerAgent`、`workspace`（`ai`）、`id`（`ai`） |
| `workbench.create` | true | 绑定主人时自动建工作台群 |
| `workbench.name` | `<machine> 终端` / `<machine> terminal` | 群名 |
| `dataDir` | `~/.local/share/agents-io-herdr`（或 `$AGENTS_IO_HERDR_DATA`） | 状态和守护进程的数据 |

## 命令行

| 命令 | 作用 |
| --- | --- |
| `init [--aio-repo <目录>] [--machine <名字>]` | 写出初始配置（0600） |
| `setup [--wait]` | 打印一次性配对码；私聊发给机器人即成为主人 |
| `install` / `uninstall` | 装上 / 移除两个 launch agent（macOS） |
| `status` | 在不在跑、主人是谁、通知发到哪、凭据找不找得到、最近的日志 |
| `pause` / `resume` | 一个开关文件：存在时不发通知，也不往 agent 里送字 |
| `test` | 往工作台（或主人的私聊）发一条测试消息 |
| `run` | 前台运行 bridge（launchd 运行的就是它） |
| `daemon` | 前台运行本项目的 agents-io 守护进程 |

## 文件

| 路径 | 内容 |
| --- | --- |
| `~/.config/agents-io-herdr/config.json` | 配置（没有秘密） |
| `~/.config/agents-io-herdr/paused` | 暂停时存在 |
| `~/.local/share/agents-io-herdr/state.json` | 主人、工作台、哪些飞书消息和话题属于哪个窗格（0600） |
| `~/.local/share/agents-io-herdr/aio.config.json` | 生成的守护进程配置（只有 `env:` 引用） |
| `~/.local/share/agents-io-herdr/aio/` | 守护进程自己的数据、日志库和 socket |
| `~/Library/Logs/agents-io-herdr/` | `daemon.log`、`bridge.log` |

## 安全与隐私

- 驱动 agent 等于在你的电脑上远程打字。只有绑定的主人（飞书身份，平台签名）能这样做；请像保护笔记本一样保护这个账号。`pause` 一下子停掉一切。
- 窗格输出和会话记录的摘录离开电脑前先脱敏（令牌、密钥、密码、URL 里的凭据、私钥），工作目录只显示最后一级。日志只记窗格 id 和长度，从不记你打的字。
- 凭据只在钥匙串或环境变量里；生成的守护进程配置和 launchd plist 里都没有。
- 守护进程专属于本项目：独立的数据目录和 socket，没有网页控制台、没有对外 MCP 端点、没有 agent、没有本地路由规则，不碰这台机器上别的 agents-io 守护进程。Binding 表由 bridge 推送：你的私聊、工作台、你的 @ 和它自己的按钮交给它，其余一律丢弃。bridge 停着的时候表照样生效，你的回复在守护进程的持久队列里等它。

## 限制

- 一个机器人对应一台机器：每台机器跑自己的守护进程，而一个飞书应用只能有一个长连接消费者，所以第二台机器要第二个应用。（herdr `--machine` 的远程窗格不在监视范围内。）
- 「人是不是正看着」（空闲时间）只在 macOS 上能判断；在别处一律当作没在看。

## 开发

```sh
pnpm install
pnpm test          # vitest；只用假的：临时 socket 上的假 agents-io 守护进程、假 herdr、假飞书 API
pnpm typecheck
pnpm lint
```

`AIO_HERDR_TEST_WORKERS` 限制测试的并发（默认 2）。

## 许可证

[MIT](LICENSE)
