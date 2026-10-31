#!/bin/bash
# exec.v1 沙箱探针（docs/exec.md N8，检查 S1–S8）。在要开执行的那台 Mac 上跑：
#
#   bash scripts/exec-sandbox-probe.sh [--launchd]            同用户：你的身份，在 /tmp 下自己的目录里
#   bash scripts/exec-sandbox-probe.sh --user <名字> [--launchd] 单独用户：经执行专用钥匙进这个用户的 exec-shim
#
# 不手写 profile：试的就是代码生成的那份（src/exec/sandbox.ts 的 buildProfile），改了生成逻辑
# 以后重跑就是回归。检查本身在 src/exec/probe.ts：
#   S1 读诱饵（~/.ssh、gh、mihomo、shell 历史、git 凭据、npmrc、kubeconfig、tfstate、.env、带 .exec-private
#      的目录）和 ls ~ 都失败，读根、写根、本次的 TMPDIR 能读；S1b /opt/homebrew/etc 读不到、bin 读得到。
#   S2 写 git hooks/config、.husky、.claude、CLAUDE.md、.mcp.json、AGENTS.md、.envrc、根以外都失败；
#      S2b .git 改名、删、新建都失败，modules、worktrees 里的 config 也是；S2c 就算 ~ 可写，shell 启动文件、
#      LaunchAgents、~/.gitconfig 照样写不了。
#   S3 不能解析域名、连不上外面的 unix socket 和本机 TCP；S3b 走代理时只连得上代理那个端口。
#   S4 编不过的 profile 预检不过；HOME、TMPDIR 是本次自己的。  S5 git（xcrun 壳解析成真身）能跑能提交。
#   S6 launchctl、open、osascript、拷进可写目录的程序都起不来；--launchd 时另外装一个自己的按需任务
#      （程序只 touch 探针目录里的一个文件），从沙箱里 kickstart 它，确认没起来；再从外面 kickstart 一次，
#      确认它本来起得来（对照，不然前面那项什么也没证明），再卸掉。
#   S7 读不到别的进程的参数（python 的 sysctl KERN_PROCARGS2，一个都不行）；--user 时另算你的进程，
#      沙箱里一个都不行，外面能读几个也列出来（所以 exec doctor 要清点你进程参数里的令牌）。
#   S8（只在 --user）：读不了你的家目录；/Users/Shared/agents-io-herdr 和它自己的家目录都写不了；
#      家目录归 root、755；登录 shell 是 /bin/sh；launchctl manageruid 是它自己。另外从外面确认：不带命令、
#      带别的命令的 ssh 都只进 exec-shim 并被拒；口令登录不行；你的家目录是 700。
# S9（沙箱成员回收）还没做，这里不测。只看退出码，读到的东西不打印；临时目录和监听结束时都清掉。
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd -P)
NODE=${NODE:-$(command -v node || true)}
[ -x "$NODE" ] || NODE=/opt/homebrew/opt/node@24/bin/node
[ -x "$NODE" ] || { echo "要 node 24（NODE=…）" >&2; exit 1; }

U=""
LAUNCHD=""
KEY=""
while [ $# -gt 0 ]; do
  case $1 in
  --user) U=${2:-}; shift 2 ;;
  --key) KEY=${2:-}; shift 2 ;;
  --launchd) LAUNCHD=1; shift ;;
  -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
  *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
done

echo "machine=$(scutil --get LocalHostName 2>/dev/null) macos=$(sw_vers -productVersion) node=$NODE"
if [ -z "$U" ]; then
  exec "$NODE" "$HERE/bin/agents-io-herdr" exec probe ${LAUNCHD:+--launchd}
fi

SESSIONS=${AGENTS_IO_HERDR_SESSIONS_DIR:-$HOME/.config/agents-io-herdr}
[ -n "$KEY" ] || KEY=$SESSIONS/exec/${U}_ed25519
KNOWN=$SESSIONS/known_hosts_local
[ -f "$KEY" ] || { echo "没有 $KEY（scripts/exec-user-setup.sh --user $U）" >&2; exit 1; }
[ -f "$KNOWN" ] || { echo "没有 $KNOWN" >&2; exit 1; }
SSH=(/usr/bin/ssh -T -F /dev/null -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$KNOWN" -o GlobalKnownHostsFile=/dev/null
  -o LogLevel=ERROR -o ConnectTimeout=10)
FAILED=0
check() { # check <结果 0/1> <说明>
  if [ "$1" = 0 ]; then echo "ok   S8   $2"; else echo "FAIL S8   $2"; FAILED=$((FAILED + 1)); fi
}

out=$("${SSH[@]}" "$U@127.0.0.1" </dev/null 2>&1)
rc=$?
case $out in *"runs only the exec shim"*) r=0 ;; *) r=1 ;; esac
[ $rc = 2 ] || r=1
check $r "不带命令的 ssh 只进 exec-shim，被拒（rc=$rc）"
out=$("${SSH[@]}" "$U@127.0.0.1" "ls /" </dev/null 2>&1)
rc=$?
case $out in *"is not something this key runs"*) r=0 ;; *) r=1 ;; esac
[ $rc = 2 ] || r=1
check $r "带别的命令（ls /）的 ssh 也只进 exec-shim，被拒（rc=$rc）"
/usr/bin/ssh -T -F /dev/null -o BatchMode=yes -o PubkeyAuthentication=no \
  -o PreferredAuthentications=password,keyboard-interactive -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=$KNOWN" -o ConnectTimeout=10 "$U@127.0.0.1" true </dev/null >/dev/null 2>&1
rc=$?
[ $rc != 0 ] && r=0 || r=1
check $r "不用这把钥匙（口令、键盘交互）登不进去（rc=$rc）"
mode=$(stat -f %Lp "$HOME")
[ "$mode" = 700 ] && r=0 || r=1
check $r "你的家目录是 700（现在 $mode）"

# 其余在 $U 那边：S8 的另一半和 S1–S7。stdout 是分帧的（src/exec/wire.ts），这里解开。
printf '{"ownerHome":"%s","ownerUid":%s,"shared":"/Users/Shared/agents-io-herdr","launchd":%s}\n' "$HOME" "$(id -u)" "${LAUNCHD:+true}${LAUNCHD:-false}" |
  "${SSH[@]}" "$U@127.0.0.1" probe |
  "$NODE" -e '
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      let b = Buffer.concat(chunks), failed = -1;
      while (b.length >= 5) {
        const ch = b[0], len = b.readUInt32BE(1), data = b.subarray(5, 5 + len);
        if (ch === 1) process.stdout.write(data);
        if (ch === 9) failed = JSON.parse(data).failed ?? -1;
        b = b.subarray(5 + len);
      }
      if (failed < 0) console.log("FAIL      exec-shim probe 没有答完");
      process.exit(failed === 0 ? 0 : 1);
    });'
rc=$?
[ $rc = 0 ] && [ $FAILED = 0 ] && { echo "全部通过"; exit 0; }
echo "有失败（外面 $FAILED 项；$U 那边 rc=$rc）"
exit 1
