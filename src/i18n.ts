/** Every sentence the bot says, in Chinese and English (`locale`; default by Feishu domain). */
import type { Locale } from "./config.ts";

export interface Strings {
  state: (s: string) => string;
  duration: (ms: number) => string;
  blockedHead: (machine: string, place: string, agent: string) => string;
  doneHead: (machine: string, place: string, agent: string, dur: string) => string;
  workingHead: (machine: string, place: string, agent: string) => string;
  /** A done notice whose turn has a live card: the answer and the process are there. */
  liveAbove: string;
  /** A live card the bridge lost track of (it restarted while the turn ran). */
  liveLost: string;
  spawnStarted: (where: string) => string;
  spawnWorking: (dur: string) => string;
  spawnDone: (dur: string, steps: number, tools: number) => string;
  spawnNoAnswer: string;
  spawnFailed: (why: string) => string;
  spawnGone: string;
  spawnClosed: string;
  spawnChoice: (screen: string) => string;
  overnightHead: (machine: string) => string;
  overnightItem: (place: string, agent: string, title: string, dur: string, at: string) => string;
  footerTopic: (pane: string) => string;
  footerDm: (pane: string) => string;
  escLabel: string;
  asked: string;
  processHead: (tools: number, steps: number) => string;
  stepsLeftOut: (n: number) => string;
  continued: string;
  sent: string;
  pressed: (key: string) => string;
  notOwner: string;
  waitingChoice: string;
  waitingChoiceNoOptions: string;
  gone: string;
  ended: string;
  paused: string;
  herdrDown: (reason: string) => string;
  textOnly: string;
  tooLong: (max: number) => string;
  failed: (reason: string) => string;
  bound: string;
  alreadyBound: string;
  codeWrong: (left: number) => string;
  workbenchName: (machine: string) => string;
  workbenchDescription: (machine: string) => string;
  workbenchCreated: (name: string) => string;
  workbenchFailed: (reason: string) => string;
  workbenchHello: (machine: string) => string;
  workbenchSet: string;
  workbenchSame: string;
  workbenchExists: string;
  statusHead: (machine: string, n: number) => string;
  statusLine: (place: string, agent: string, state: string, since: string, title: string) => string;
  statusNone: string;
  statusHerdrDown: (reason: string) => string;
  statusFooter: (o: { paused: boolean; quiet: string | null; workbench: boolean }) => string;
  help: (machine: string) => string;
  pausedNow: string;
  resumedNow: string;
  testMessage: (machine: string) => string;
  noDestination: string;
  terminalKind: string;
  panesHead: (machine: string, n: number) => string;
  paneLine: (id: string, tab: string, place: string, kind: string, state: string, title: string) => string;
  panesNone: string;
  panesFooter: string;
  viewLabel: (id: string) => string;
  refreshLabel: string;
  viewHead: (machine: string, id: string, place: string, kind: string, state: string) => string;
  viewEmpty: string;
  viewFooter: (id: string) => string;
  viewFooterTopic: string;
  paneUsage: string;
  paneNotFound: (ref: string) => string;
  paneAmbiguous: (ref: string, ids: string[]) => string;
  paneGone: (id: string) => string;
  paneNotHere: string;
  paneSent: (id: string) => string;
  paneKeysSent: (id: string, keys: string) => string;
  paneWaiting: string;
  badKey: (reason: string) => string;
}

const zh: Strings = {
  state: (s) => ({ working: "在干活", blocked: "在等你", done: "做完了", idle: "空闲", unknown: "不确定" })[s] ?? s,
  duration: (ms) => {
    const m = Math.max(0, Math.round(ms / 60_000));
    return m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
  },
  blockedHead: (machine, place, agent) => `**${machine} · ${place} · ${agent} 在等你**`,
  doneHead: (machine, place, agent, dur) => `**${machine} · ${place} · ${agent} 做完了**（这一轮 ${dur}）`,
  workingHead: (machine, place, agent) => `**${machine} · ${place} · ${agent} 正在做**`,
  liveAbove: "完整的回答和过程在上面那张卡片里。",
  liveLost: "_（桥接重启了，这张卡片不再更新，后面的进度看新卡片或通知）_",
  spawnStarted: (where) => `⏳ 收到，在 ${where} 开了一个 agent，在看了…`,
  spawnWorking: (dur) => `⏳ 正在做（${dur}）`,
  spawnDone: (dur, steps, tools) => `✓ 做完了（${dur}，${steps} 步，${tools} 次工具调用）`,
  spawnNoAnswer: "（这一轮没有文字回答）",
  spawnFailed: (why) => `没能开 agent：${why}`,
  spawnGone: "这个 agent 已经结束；要继续请重新叫一个。",
  spawnClosed: "已关掉这个 agent。",
  spawnChoice: (screen) => `它在等你选择，回复数字（或 esc）：\n${screen}`,
  overnightHead: (machine) => `**${machine} · 夜里做完的**`,
  overnightItem: (place, agent, title, dur, at) =>
    `- ${place} · ${agent}${title ? ` · ${title}` : ""}（${dur}，${at} 做完）`,
  footerTopic: (pane) => `${pane} · 在这个话题里回复，就是对它说话`,
  footerDm: (pane) => `${pane} · 回复这条消息，就是对它说话`,
  escLabel: "Esc 取消",
  asked: "问的是：",
  processHead: (tools, steps) => `过程：${steps} 步，${tools} 次工具调用`,
  stepsLeftOut: (n) => `_（前面 ${n} 步太长，没有发）_`,
  continued: "_（接下面）_",
  sent: "已送到",
  pressed: (key) => `已按 ${key}`,
  notOwner: "只有这台电脑的主人能回这个 agent。",
  waitingChoice: "它在等你选，没有送到。点一个选项：",
  waitingChoiceNoOptions: "它在等你在电脑上选，没有送到。",
  gone: "这个 agent 已经不在了，没有送到。",
  ended: "这个 agent 已经结束。",
  paused: "已暂停（agents-io-herdr resume 恢复），没有送到。",
  herdrDown: (reason) => `herdr 没有响应，没有送到（${reason}）。`,
  textOnly: "只能送文字，这条没有送出。",
  tooLong: (max) => `文字太长了，最多 ${max} 字，没有送出。`,
  failed: (reason) => `没有送到：${reason}`,
  bound: "好的，你是这台电脑的主人了。",
  alreadyBound: "这台电脑已经有主人了。",
  codeWrong: (left) =>
    left > 0 ? `配对码不对，还能再试 ${left} 次。` : "配对码不对，这个码已经作废，请重新运行 setup。",
  workbenchName: (machine) => `${machine} 终端`,
  workbenchDescription: (machine) => `${machine} 上 herdr 里的 coding agent：每个 agent 一个话题`,
  workbenchCreated: (name) =>
    `建好了工作台群「${name}」。agent 在等你或做完一段长活时会在那里告诉你，每个 agent 一个话题；在话题里回复就是对它说话。`,
  workbenchFailed: (reason) =>
    `没能自动建群（${reason}）。可以把我拉进任意一个群，@我发 /workbench；在那之前通知发到这里。`,
  workbenchHello: (machine) =>
    `这里是 ${machine} 的工作台。herdr 里的 agent 在等你或做完一段长活时，会在这里开一个话题告诉你；在话题里回复就是对它说话，卡住时点按钮就是按键。发 /status 看所有 agent，/help 看所有命令。`,
  workbenchSet: "好的，这个群是工作台了。agent 的通知会发到这里，每个 agent 一个话题，在话题里回复就是对它说话。",
  workbenchSame: "这个群已经是工作台。",
  workbenchExists: "已经有工作台群了，通知都发在那里。",
  statusHead: (machine, n) => `**${machine} · ${n} 个 agent**`,
  statusLine: (place, agent, state, since, title) =>
    `- ${place} · ${agent} · ${state} · ${since}${title ? ` · ${title}` : ""}`,
  statusNone: "herdr 里现在没有 agent。",
  statusHerdrDown: (reason) => `读不了 herdr：${reason}`,
  statusFooter: (o) =>
    [
      o.paused ? "已暂停发送" : "正在发送",
      o.quiet ? `安静时段 ${o.quiet}` : "没有安静时段",
      o.workbench ? "通知发到工作台" : "通知发到私聊",
    ].join(" · "),
  help: (machine) =>
    [
      `**${machine} · 能做什么**`,
      "- 在 agent 的话题里回复（私聊里回复它的通知）：就是对它说话",
      "- 卡住时点按钮：就是在它的对话框里按那个键",
      "- /status：列出所有 agent",
      "- /ls：列出所有 pane（包括普通终端），点按钮看屏幕",
      "- /view <pane> [行数]：看它现在的屏幕；回复那张卡片就是对那个 pane 说话",
      "- /send <pane> <文字>：输入文字并回车",
      "- /keys <pane> <键>…：按键，如 esc、enter、ctrl+c、up、1",
      "- 在 agent 的话题里：/view 看屏幕，/keys esc 按键；其他 / 命令照旧发给 agent",
      "- /workbench：私聊里补建工作台群；在群里 @我发，就把那个群当工作台",
      "- /pause、/resume：停发、恢复通知",
    ].join("\n"),
  pausedNow: "已暂停：不再发通知，也不往 agent 里送（发 /resume 继续）。",
  resumedNow: "已恢复。",
  testMessage: (machine) =>
    `**${machine} · 测试**\nagents-io-herdr 能发到这里了。herdr 里的 agent 卡住等你、或做完一段长活时，会在这里说一声。`,
  noDestination: "还没有主人：运行 agents-io-herdr setup",
  terminalKind: "终端",
  panesHead: (machine, n) => `**${machine} · ${n} 个 pane**`,
  paneLine: (id, tab, place, kind, state, title) =>
    `- ${id}${tab && tab !== place ? ` · ${tab}` : ""} · ${place} · ${kind}${state ? ` · ${state}` : ""}${title ? ` · ${title}` : ""}`,
  panesNone: "herdr 里现在没有 pane。",
  panesFooter: "/view p2 看屏幕 · /send p2 文字 输入 · /keys p2 esc 按键",
  viewLabel: (id) => `看 ${id}`,
  refreshLabel: "刷新",
  viewHead: (machine, id, place, kind, state) =>
    `**${machine} · ${id} · ${place} · ${kind}${state ? ` · ${state}` : ""}**`,
  viewEmpty: "（屏幕是空的）",
  viewFooter: (id) => `回复这张卡片就是对 ${id} 说话（/view 刷新，/keys esc 按键）`,
  viewFooterTopic: "在这个话题里回复就是对它说话（/view 刷新，/keys esc 按键）",
  paneUsage: [
    "用法：",
    "- /ls：所有 pane",
    "- /view <pane> [行数]：看它的屏幕",
    "- /send <pane> <文字>：输入文字并回车",
    "- /keys <pane> <键>…：按键，如 esc、enter、ctrl+c、up、1",
    "<pane> 可以是 p2、w1:p2、tab 名或目录名。在 agent 的话题里用 /view、/keys esc。",
  ].join("\n"),
  paneNotFound: (ref) => `没有叫「${ref}」的 pane。发 /ls 看看有哪些。`,
  paneAmbiguous: (ref, ids) => `「${ref}」对得上好几个 pane：${ids.join("、")}。用 pane 的 id 说。`,
  paneGone: (id) => `${id} 已经不是原来那个程序了，没有送到。发 /ls 看看现在有哪些。`,
  paneNotHere: "看屏幕和操作 pane 只在私聊和工作台里可以。",
  paneSent: (id) => `已送到 ${id}`,
  paneKeysSent: (id, keys) => `已在 ${id} 按 ${keys}`,
  paneWaiting: "它在等你选，没有送到。点一个选项，或者用 /keys：",
  badKey: (reason) => `键名不对，什么都没按（${reason}）。可以用 esc、enter、tab、up、down、ctrl+c、1…`,
};

const en: Strings = {
  state: (s) =>
    ({ working: "working", blocked: "waiting for you", done: "done", idle: "idle", unknown: "unknown" })[s] ?? s,
  duration: (ms) => {
    const m = Math.max(0, Math.round(ms / 60_000));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  },
  blockedHead: (machine, place, agent) => `**${machine} · ${place} · ${agent} is waiting for you**`,
  doneHead: (machine, place, agent, dur) => `**${machine} · ${place} · ${agent} finished** (this turn: ${dur})`,
  workingHead: (machine, place, agent) => `**${machine} · ${place} · ${agent} is working**`,
  liveAbove: "The whole answer and the process are in the card above.",
  liveLost: "_(the bridge restarted: this card is no longer updated; see the next card or notice)_",
  spawnStarted: (where) => `⏳ On it: started an agent in ${where}…`,
  spawnWorking: (dur) => `⏳ Working (${dur})`,
  spawnDone: (dur, steps, tools) => `✓ Done (${dur}, ${steps} steps, ${tools} tool calls)`,
  spawnNoAnswer: "(no written answer this turn)",
  spawnFailed: (why) => `Could not start an agent: ${why}`,
  spawnGone: "This agent has ended; start another with the trigger.",
  spawnClosed: "Closed this agent.",
  spawnChoice: (screen) => `It is waiting for a choice; reply with a number (or esc):\n${screen}`,
  overnightHead: (machine) => `**${machine} · finished overnight**`,
  overnightItem: (place, agent, title, dur, at) =>
    `- ${place} · ${agent}${title ? ` · ${title}` : ""} (${dur}, done at ${at})`,
  footerTopic: (pane) => `${pane} · reply in this topic to talk to it`,
  footerDm: (pane) => `${pane} · reply to this message to talk to it`,
  escLabel: "Esc cancel",
  asked: "Asked:",
  processHead: (tools, steps) =>
    `Process: ${steps} step${steps === 1 ? "" : "s"}, ${tools} tool call${tools === 1 ? "" : "s"}`,
  stepsLeftOut: (n) => `_(the first ${n} steps are left out: too long)_`,
  continued: "_(continued below)_",
  sent: "Sent.",
  pressed: (key) => `Pressed ${key}.`,
  notOwner: "Only this machine's owner can answer this agent.",
  waitingChoice: "It is waiting for a choice; not sent. Pick one:",
  waitingChoiceNoOptions: "It is waiting for a choice on the computer; not sent.",
  gone: "This agent is gone; not sent.",
  ended: "This agent has ended.",
  paused: "Paused (agents-io-herdr resume); not sent.",
  herdrDown: (reason) => `herdr is not answering; not sent (${reason}).`,
  textOnly: "Only text can be sent; this was not.",
  tooLong: (max) => `Too long (at most ${max} characters); not sent.`,
  failed: (reason) => `Not sent: ${reason}`,
  bound: "Done: you own this machine now.",
  alreadyBound: "This machine already has an owner.",
  codeWrong: (left) =>
    left > 0 ? `That code is wrong; ${left} tries left.` : "That code is wrong and no longer valid; run setup again.",
  workbenchName: (machine) => `${machine} terminal`,
  workbenchDescription: (machine) => `Coding agents in herdr on ${machine}: one topic per agent`,
  workbenchCreated: (name) =>
    `Created the workbench group "${name}". Agents that wait for you or finish a long turn are announced there, one topic per agent; reply in a topic to talk to that agent.`,
  workbenchFailed: (reason) =>
    `Could not create the workbench group (${reason}). Add me to any group and @-mention me with /workbench; until then notices come here.`,
  workbenchHello: (machine) =>
    `This is the workbench of ${machine}. When an agent in herdr waits for you or finishes a long turn, it gets a topic here; reply in the topic to talk to it, press a button to press that key. Send /status to list all agents, /help for every command.`,
  workbenchSet:
    "Done: this group is the workbench. Agent notices come here, one topic per agent; reply in a topic to talk to that agent.",
  workbenchSame: "This group already is the workbench.",
  workbenchExists: "There already is a workbench group; notices go there.",
  statusHead: (machine, n) => `**${machine} · ${n} agent${n === 1 ? "" : "s"}**`,
  statusLine: (place, agent, state, since, title) =>
    `- ${place} · ${agent} · ${state} · ${since}${title ? ` · ${title}` : ""}`,
  statusNone: "No agents in herdr right now.",
  statusHerdrDown: (reason) => `Cannot read herdr: ${reason}`,
  statusFooter: (o) =>
    [
      o.paused ? "paused" : "sending",
      o.quiet ? `quiet hours ${o.quiet}` : "no quiet hours",
      o.workbench ? "notices go to the workbench" : "notices go to this DM",
    ].join(" · "),
  help: (machine) =>
    [
      `**${machine} · what I do**`,
      "- Reply in an agent's topic (in the DM: reply to its notice) to talk to it",
      "- Press a button on a waiting agent's notice to press that key in its dialog",
      "- /status: list all agents",
      "- /ls: list every pane (plain terminals too), with buttons to view each",
      "- /view <pane> [lines]: its screen now; reply to that card to talk to that pane",
      "- /send <pane> <text>: type the text and Enter",
      "- /keys <pane> <key>…: press keys, e.g. esc, enter, ctrl+c, up, 1",
      "- In an agent's topic: /view for its screen, /keys esc to press keys; other / commands go to the agent",
      "- /workbench: in the DM, create the workbench group again; @-mention me with it in a group to use that group",
      "- /pause, /resume: stop / resume notices",
    ].join("\n"),
  pausedNow: "Paused: no notices, nothing typed into agents (send /resume to continue).",
  resumedNow: "Resumed.",
  testMessage: (machine) =>
    `**${machine} · test**\nagents-io-herdr can send here. When an agent in herdr waits for you or finishes a long turn, you will hear about it here.`,
  noDestination: "No owner yet: run agents-io-herdr setup",
  terminalKind: "terminal",
  panesHead: (machine, n) => `**${machine} · ${n} pane${n === 1 ? "" : "s"}**`,
  paneLine: (id, tab, place, kind, state, title) =>
    `- ${id}${tab && tab !== place ? ` · ${tab}` : ""} · ${place} · ${kind}${state ? ` · ${state}` : ""}${title ? ` · ${title}` : ""}`,
  panesNone: "No panes in herdr right now.",
  panesFooter: "/view p2 for its screen · /send p2 text to type · /keys p2 esc to press keys",
  viewLabel: (id) => `View ${id}`,
  refreshLabel: "Refresh",
  viewHead: (machine, id, place, kind, state) =>
    `**${machine} · ${id} · ${place} · ${kind}${state ? ` · ${state}` : ""}**`,
  viewEmpty: "(the screen is empty)",
  viewFooter: (id) => `Reply to this card to talk to ${id} (/view to refresh, /keys esc to press keys)`,
  viewFooterTopic: "Reply in this topic to talk to it (/view to refresh, /keys esc to press keys)",
  paneUsage: [
    "Usage:",
    "- /ls: every pane",
    "- /view <pane> [lines]: its screen",
    "- /send <pane> <text>: type the text and Enter",
    "- /keys <pane> <key>…: press keys, e.g. esc, enter, ctrl+c, up, 1",
    "<pane> is p2, w1:p2, a tab's name or a directory. In an agent's topic: /view, /keys esc.",
  ].join("\n"),
  paneNotFound: (ref) => `No pane called "${ref}". Send /ls to see them.`,
  paneAmbiguous: (ref, ids) => `"${ref}" fits several panes: ${ids.join(", ")}. Name it by its id.`,
  paneGone: (id) => `${id} runs something else now; not sent. Send /ls to see what is there.`,
  paneNotHere: "Screens and pane control only work in the DM and the workbench.",
  paneSent: (id) => `Sent to ${id}.`,
  paneKeysSent: (id, keys) => `Pressed ${keys} in ${id}.`,
  paneWaiting: "It is waiting for a choice; not sent. Pick one, or use /keys:",
  badKey: (reason) => `Unknown key, nothing pressed (${reason}). Try esc, enter, tab, up, down, ctrl+c, 1…`,
};

export const strings = (l: Locale): Strings => (l === "zh" ? zh : en);

export type Command = "status" | "help" | "workbench" | "pause" | "resume";

const COMMANDS: Record<string, Command> = {
  status: "status",
  help: "help",
  workbench: "workbench",
  pause: "pause",
  resume: "resume",
};

/** A whole message that is one command: `/` and the word (`/status`), else null. */
export function commandOf(text: string): Command | null {
  const m = /^\/(\S+)$/.exec(text.replace(/(^|\s)@\S+/g, "$1").trim());
  return m ? (COMMANDS[(m[1] as string).toLowerCase()] ?? null) : null;
}
