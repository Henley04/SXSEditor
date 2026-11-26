#!/usr/bin/env bash
# 推送本地 commit 到 GitHub —— 按可用通道依次尝试，带有限重试。
#
# 背景（本机实测）：
#   - gh-proxy 只支持 clone/下载，不支持 push；
#   - 直连 github.com 常被 reset（Recv failure / TLS unexpected eof）；
#   - 稳定通道是 Clash 代理 7897 + schannel TLS 后端（git 默认 openssl 走代理必失败）。
#
# 用法：
#   bash scripts/push-with-retry.sh                 # origin + 当前分支
#   bash scripts/push-with-retry.sh origin master
#   MAX_TRIES=4 bash scripts/push-with-retry.sh     # 每通道重试次数（默认 3）
#
# 说明：
#   1) 每通道最多 MAX_TRIES 次、失败后 1s/2s/3s 退避。不要改成无间隔无限重试：
#      TLS 握手失败不会因为"更快"而成功，高频请求只会触发 GitHub 的 abuse
#      限流，反而把出口 IP 拖进黑名单。
#   2) 判定成功**不能看退出码**：`git pushd` 是 `!` 复合别名，内部最后一条
#      （恢复 insteadOf 配置）成功会让整体返回 0，即使 push 本身失败。
#      这里统一用 "本地 HEAD == 远端分支 SHA" 判定。
set -uo pipefail

REMOTE="${1:-origin}"
BRANCH="${2:-$(git rev-parse --abbrev-ref HEAD)}"
MAX_TRIES="${MAX_TRIES:-3}"
PROXY="${HTTPS_PROXY_FOR_PUSH:-http://127.0.0.1:7897}"

if [ "$BRANCH" = "HEAD" ]; then
  echo "detached HEAD; pass the branch name explicitly" >&2
  exit 2
fi

LOCAL_SHA=$(git rev-parse HEAD)
echo "push target: $REMOTE $BRANCH  (HEAD=${LOCAL_SHA:0:9}, max $MAX_TRIES tries/channel)"

pushed() {
  local remote_sha
  remote_sha=$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1}' | head -1)
  [ -n "$remote_sha" ] && [ "$remote_sha" = "$LOCAL_SHA" ]
}

try_channel() {
  local label="$1"; shift
  local n=1
  while [ "$n" -le "$MAX_TRIES" ]; do
    printf '\n[%s] attempt %d/%d\n' "$label" "$n" "$MAX_TRIES"
    "$@" 2>&1 | tail -6 || true
    if pushed; then
      printf '\n[%s] OK (remote %s == HEAD)\n' "$label" "${LOCAL_SHA:0:9}"
      return 0
    fi
    if [ "$n" -lt "$MAX_TRIES" ]; then sleep "$n"; fi
    n=$((n + 1))
  done
  printf '\n[%s] failed after %d attempts\n' "$label" "$MAX_TRIES"
  return 1
}

probe() { # $1=url [$2=proxy]
  local code
  if [ -n "${2:-}" ]; then
    code=$(curl -s -m 4 -o /dev/null -w '%{http_code}' -x "$2" "$1" 2>/dev/null)
  else
    code=$(curl -s -m 4 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)
  fi
  echo "${code:-000}"
}

# --- 通道 1：直连（先探测，避免每次白等 21s 连接超时）
dcode=$(probe https://github.com)
case "$dcode" in
  2*|3*) try_channel "pushd/direct" git pushd "$REMOTE" "$BRANCH" && exit 0 ;;
  *) echo "[pushd/direct] github.com unreachable directly (http=$dcode), skipping" ;;
esac

# --- 通道 2：Clash 代理 + schannel（本机唯一稳定通道）
pcode=$(probe https://github.com "$PROXY")
case "$pcode" in
  2*|3*)
    try_channel "proxy/schannel" \
      git -c http.sslBackend=schannel -c http.proxy="$PROXY" push "$REMOTE" "$BRANCH" && exit 0
    try_channel "proxy/schannel-http1.1" \
      git -c http.sslBackend=schannel -c http.version=HTTP/1.1 -c http.proxy="$PROXY" push "$REMOTE" "$BRANCH" && exit 0
    ;;
  *) echo "[proxy/schannel] $PROXY unreachable (http=$pcode), skipping" ;;
esac

# --- 通道 3：直连 + schannel（没有 pushd 别名时的兜底）
try_channel "direct/schannel" \
  git -c http.sslBackend=schannel push "$REMOTE" "$BRANCH" && exit 0

echo ""
echo "all channels failed. Check:"
echo "  1) proxy:  curl -sS -m 5 -x $PROXY https://github.com -o /dev/null -w '%{http_code}\\n'"
echo "  2) auth:   git credential fill <<< \$'protocol=https\\nhost=github.com\\n\\n'"
echo "  3) gap:    git log --oneline $REMOTE/$BRANCH..$BRANCH | head"
exit 1
