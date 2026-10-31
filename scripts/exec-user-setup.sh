#!/bin/bash
# 单独执行用户的一次性准备（docs/exec.md N9）。在要给 agent 开执行的 Mac 上由这台电脑的主人跑，
# 先过目；不带 --apply 只把要做的事打印出来，什么都不改：
#
#   bash scripts/exec-user-setup.sh --user <名字>                    # 先看一遍
#   sudo bash scripts/exec-user-setup.sh --user <名字> --apply        # 再真做
#   sudo bash scripts/exec-user-setup.sh --user <名字>-staging --sessions-dir /Users/<你>/.config/agents-io-herdr-staging --apply
#
# 做的事：
#   1. 建非管理员、隐藏的用户 <名字>：口令禁用（'*'），登录 shell /bin/sh，主组 staff。
#   2. /Users/<名字> 归 root:wheel、755（这个用户在家目录顶层什么都建不了：.zshenv、.profile、.ssh/
#      都不行）；里面 work/（沙箱的 HOME 和它自己的 clone）、exec/（每条执行的临时目录）归它、700。
#   3. chmod 700 你的家目录（macOS 用户的主组都是 staff，750 的话它读得到）。
#   4. sshd：/etc/ssh/sshd_config.d/ 下加一段 Match User <名字>：只认 /etc/ssh/authorized_keys/<名字>
#      这一把公钥、不要口令、不给 tty、不转发、ForceCommand 只跑 exec-shim；`sshd -t` 核过，不过就撤回这段再停下。
#      「远程登录」限定了用户（com.apple.access_ssh）的话把它加进去。
#   5. 执行专用钥匙 <sessions>/exec/<名字>_ed25519（你的、600），公钥写进
#      /etc/ssh/authorized_keys/<名字>（root 的、644），带 from="127.0.0.1,::1",restrict,command=…；
#      <sessions>/known_hosts_local 没有的话从本机的 host key 写一份。
#   6. 用 git archive 把这份代码（HEAD）解到 /Users/Shared/agents-io-herdr/<提交>/，归你、它只读；
#      这个用户自己的链接 current-<名字> 指过去（<名字>-staging 换新代码不动 <名字> 的）。
#   7. （可选，--pf <代理端口>）pf 锚点：这个用户出站一律拦，只放行 lo0 上到这个端口的 TCP。
#      只装进运行中的 pf，重启后不在；要长期生效另说。
#
# 不做的事：不放任何凭据进这个用户；不写上限文件（之后在你自己的身份下跑
# agents-io-herdr exec ceiling --preset agent-user --user <名字>）；不重启 sshd（macOS 每个连接现起一个）。
#
# 回退：sudo rm /etc/ssh/authorized_keys/<名字>（之后执行回 runner_unavailable）；
#       sudo pkill -KILL -U <名字>；要彻底删：sudo dscl . -delete /Users/<名字> && sudo rm -rf /Users/<名字>，
#       再删 /etc/ssh/sshd_config.d/200-agents-io-herdr-<名字>.conf。
set -euo pipefail

NODE=/opt/homebrew/opt/node@24/bin/node
SHARED=/Users/Shared/agents-io-herdr
HERE=$(cd "$(dirname "$0")/.." && pwd -P)

USER_NAME=""
OWNER="${SUDO_USER:-$(id -un)}"
SESSIONS=""
PF_PORT=""
APPLY=0
while [ $# -gt 0 ]; do
  case $1 in
  --user) USER_NAME=${2:-}; shift 2 ;;
  --owner) OWNER=${2:-}; shift 2 ;;
  --sessions-dir) SESSIONS=${2:-}; shift 2 ;;
  --pf) PF_PORT=${2:-}; shift 2 ;;
  --apply) APPLY=1; shift ;;
  -h | --help) sed -n '2,33p' "$0"; exit 0 ;;
  *) echo "不认识的参数：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

die() { echo "停下：$*" >&2; exit 1; }
# as_owner <命令…>：以你的身份跑（只打印时你本来就是你，不用 sudo）
as_owner() {
  if [ "$(id -un)" = "$OWNER" ]; then "$@"; else sudo -u "$OWNER" "$@"; fi
}
say() { printf '\n== %s\n' "$*"; }
# act <说明> <命令…>：打印；--apply 时才执行
act() {
  local what=$1
  shift
  printf '  %s\n    $' "$what"
  printf ' %q' "$@"
  printf '\n'
  if [ "$APPLY" = 1 ]; then "$@"; fi
}
# write <文件> <属主> <权限>：stdin 是内容；打印出来，--apply 时才写
write() {
  local file=$1 owner=$2 mode=$3 body
  body=$(cat)
  printf '  写 %s（%s，%s）：\n' "$file" "$owner" "$mode"
  printf '%s\n' "$body" | sed 's/^/    | /'
  if [ "$APPLY" = 1 ]; then
    printf '%s\n' "$body" >"$file"
    chown "$owner" "$file"
    chmod "$mode" "$file"
  fi
}

[ "$(uname -s)" = Darwin ] || die "只在 macOS 上用"
echo "$USER_NAME" | grep -Eq '^[a-z_][a-z0-9_-]{0,30}$' || die "--user 要一个 macOS 短用户名（小写字母开头）"
[ "$USER_NAME" != "$OWNER" ] || die "--user 不能是你自己"
id -u "$OWNER" >/dev/null 2>&1 || die "没有用户 $OWNER（--owner）"
OWNER_HOME=$(dscl . -read "/Users/$OWNER" NFSHomeDirectory | awk '{print $2}')
[ -n "$SESSIONS" ] || SESSIONS="$OWNER_HOME/.config/agents-io-herdr"
case $SESSIONS in /*) ;; *) die "--sessions-dir 要绝对路径" ;; esac
if [ -n "$PF_PORT" ]; then
  echo "$PF_PORT" | grep -Eq '^[0-9]{4,5}$' || die "--pf 要一个固定端口号"
fi
if [ "$APPLY" = 1 ] && [ "$(id -u)" != 0 ]; then die "--apply 要 sudo"; fi
[ -x "$NODE" ] || echo "注意：没有 $NODE（brew install node@24）；强制命令要用它。" >&2
U=$USER_NAME
UHOME=/Users/$U
KEY=$SESSIONS/exec/${U}_ed25519
KNOWN=$SESSIONS/known_hosts_local
FORCE="$NODE $SHARED/current-$U/bin/agents-io-herdr exec-shim"
CONF=/etc/ssh/sshd_config.d/200-agents-io-herdr-$U.conf

if [ "$APPLY" = 1 ]; then echo "照下面一步步做（--apply）。"; else echo "只打印，不改任何东西；看过没问题再 sudo … --apply。"; fi
echo "用户 $U，你是 $OWNER（$OWNER_HOME），采集器的目录 $SESSIONS"

say "1. 用户 $U"
if id -u "$U" >/dev/null 2>&1; then
  echo "  已经有 $U（uid $(id -u "$U")），不重建。"
  if dseditgroup -o checkmember -m "$U" admin >/dev/null 2>&1; then die "$U 是管理员：不能当执行用户"; fi
else
  NEW_UID=$(dscl . -list /Users UniqueID | awk '{print $2}' | sort -n | awk 'BEGIN{u=600} $1==u{u++} END{print u}')
  [ "$NEW_UID" -lt 700 ] || die "600–699 没有空的 uid"
  act "建用户" dscl . -create "/Users/$U"
  act "登录 shell /bin/sh（zsh 会读 ~/.zshenv）" dscl . -create "/Users/$U" UserShell /bin/sh
  act "名字" dscl . -create "/Users/$U" RealName "agents-io-herdr exec ($U)"
  act "uid" dscl . -create "/Users/$U" UniqueID "$NEW_UID"
  act "主组 staff" dscl . -create "/Users/$U" PrimaryGroupID 20
  act "家目录" dscl . -create "/Users/$U" NFSHomeDirectory "$UHOME"
  act "口令禁用" dscl . -create "/Users/$U" Password '*'
  act "登录窗口里不出现" dscl . -create "/Users/$U" IsHidden 1
fi

say "2. 目录"
act "家目录" mkdir -p "$UHOME"
act "家目录归 root" chown root:wheel "$UHOME"
act "755：它在这里什么都建不了" chmod 755 "$UHOME"
for d in work exec; do
  act "$d/" mkdir -p "$UHOME/$d"
  act "$d/ 归 $U" chown "$U:staff" "$UHOME/$d"
  act "$d/ 700" chmod 700 "$UHOME/$d"
done

say "3. 你的家目录"
echo "  现在：$(stat -f '%Sp %Su:%Sg' "$OWNER_HOME")"
act "只有你能进" chmod 700 "$OWNER_HOME"

say "4. sshd"
grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config.d/\*' /etc/ssh/sshd_config ||
  die "/etc/ssh/sshd_config 里没有 Include /etc/ssh/sshd_config.d/*；先手动加上再跑"
OLD_CONF=""
if [ -f "$CONF" ]; then OLD_CONF=$(cat "$CONF"); fi
write "$CONF" root:wheel 644 <<EOF
# agents-io-herdr exec（docs/exec.md N9）：$U 只能经这一把钥匙进强制命令。
Match User $U
  AuthorizedKeysFile /etc/ssh/authorized_keys/%u
  AuthenticationMethods publickey
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  PermitTTY no
  PermitUserEnvironment no
  PermitUserRC no
  AllowTcpForwarding no
  AllowStreamLocalForwarding no
  AllowAgentForwarding no
  X11Forwarding no
  PermitTunnel no
  ForceCommand $FORCE
Match all
EOF
# sshd 每个连接都现读配置：这段要是让 sshd -t 不过，谁都 ssh 不进这台机器（包括你自己远程进来）。
# 所以不过就撤回（原来有这个文件的，换回原来的内容），再停下。
printf '  核一遍 sshd 的配置，不过就撤回这段\n    $ /usr/sbin/sshd -t\n'
if [ "$APPLY" = 1 ] && ! /usr/sbin/sshd -t; then
  if [ -n "$OLD_CONF" ]; then printf '%s\n' "$OLD_CONF" >"$CONF"; else rm -f "$CONF"; fi
  die "sshd -t 不过，已撤回 $CONF（前面几步已经做了，重跑不碍事）"
fi
if dscl . -read /Groups/com.apple.access_ssh >/dev/null 2>&1; then
  act "「远程登录」限定了用户：把 $U 加进去" dseditgroup -o edit -a "$U" -t user com.apple.access_ssh
fi

say "5. 执行专用钥匙"
act "钥匙的目录" as_owner mkdir -p "$SESSIONS/exec"
act "700" as_owner chmod 700 "$SESSIONS" "$SESSIONS/exec"
if [ -f "$KEY" ]; then
  echo "  已经有 $KEY，沿用。"
else
  act "生成（没有口令短语，只给这一个强制命令用）" as_owner ssh-keygen -q -t ed25519 -N "" -C aih-exec -f "$KEY"
fi
act "authorized_keys 的目录" mkdir -p /etc/ssh/authorized_keys
act "归 root" chown root:wheel /etc/ssh/authorized_keys
act "755" chmod 755 /etc/ssh/authorized_keys
PUB="<$KEY.pub 的内容>"
if [ -f "$KEY.pub" ]; then PUB=$(cat "$KEY.pub"); fi
write "/etc/ssh/authorized_keys/$U" root:wheel 644 <<EOF
from="127.0.0.1,::1",restrict,command="$FORCE" $PUB
EOF
if [ -f "$KNOWN" ]; then
  echo "  已经有 $KNOWN，沿用。"
else
  write "$KNOWN" "$OWNER:staff" 600 <<EOF
127.0.0.1 $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)
EOF
fi

say "6. 代码"
REV=$(as_owner git -C "$HERE" rev-parse --short HEAD)
if [ -n "$(as_owner git -C "$HERE" status --porcelain)" ]; then
  echo "  注意：$HERE 有没提交的改动；解出去的是提交 $REV，不含它们。"
fi
DEST=$SHARED/$REV
act "目录" mkdir -p "$DEST"
if [ "$APPLY" = 1 ]; then
  as_owner git -C "$HERE" archive HEAD | tar -x -C "$DEST"
else
  printf '  解开 HEAD\n    $ sudo -u %q git -C %q archive HEAD | tar -x -C %q\n' "$OWNER" "$HERE" "$DEST"
fi
act "归你" chown -R "$OWNER:staff" "$SHARED"
act "它只读" chmod -R go-w,a+rX "$SHARED"
act "current-$U → $REV（只动这个用户的）" ln -sfn "$REV" "$SHARED/current-$U"

if [ -n "$PF_PORT" ]; then
  say "7. pf（可选）"
  ANCHOR=/etc/pf.anchors/agents-io-herdr.$U
  write "$ANCHOR" root:wheel 644 <<EOF
# agents-io-herdr exec：$U 只连得到本机代理的固定端口（docs/exec.md N9）
pass out quick on lo0 proto tcp from any to 127.0.0.1 port $PF_PORT user $U
block drop out quick user $U
EOF
  act "装进运行中的 pf（com.apple 锚点下）" pfctl -a "com.apple/agents-io-herdr.$U" -f "$ANCHOR"
  act "打开 pf（已经开着就只是多一个引用）" pfctl -E
  echo "  重启以后不在；要长期生效得另加一个 LaunchDaemon，先不做。"
fi

say "接下来（在你自己的身份下）"
# 采集器的目录不是默认的（staging 那个）：每条命令都要带上它，采集器另装一个 launchd 标签
DIRENV=""
if [ "$SESSIONS" != "$OWNER_HOME/.config/agents-io-herdr" ]; then DIRENV="AGENTS_IO_HERDR_SESSIONS_DIR=$SESSIONS "; fi
echo "  ${DIRENV}agents-io-herdr exec ceiling --preset agent-user --user $U"
echo "  ${DIRENV}agents-io-herdr exec doctor"
echo "  ${DIRENV}bash scripts/exec-sandbox-probe.sh --user $U"
if [ -n "$DIRENV" ]; then
  echo "  ${DIRENV}agents-io-herdr sessions install --label-suffix <后缀，比如 staging> --via-ssh"
fi
echo "  （探针 --user 也会确认：不带命令、带别的命令的 ssh 都只进 exec-shim，口令登录不行。）"
