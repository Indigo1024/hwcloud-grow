#!/bin/bash
# 积分看板数据刷新：cron 定时 + 看板按钮按需，共用这一份。
#
# 注意（踩坑）：不能去抢 /tmp/hwcloud-browser.lock。
# 登录守护（hwcloud-login-daemon）是常驻进程、长期持有该锁，
# 用 flock -w 去等只会白等到超时，用 flock -n 又会永远跳过，
# 表现为「看板数据一直不更新」。
# 本脚本只读积分接口、跑几十秒，直接跑即可；真要互斥时由调用方决定。
set -u

# ---------- 路径推导（不要写死绝对路径）----------
# 按本脚本位置反推：scripts/ 的上一级是 runner 目录，再上一级是项目根。
# 这样项目放在任何位置都能跑，发布出去也不会指向作者机器上的路径。
_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="${RUNNER_DIR:-$(dirname "$_SELF_DIR")}"
_GROW_ROOT="${HWCLOUD_ROOT:-$(dirname "$RUNNER_DIR")}"
_CONTROL_DIR="$_GROW_ROOT/control"
# 面板/扫码数据目录（生产在 Web 目录；见 auth-utils.mjs 的 dataDir()）。
# 不设的话会回落到 <root>/panel —— 那是编辑副本，不是实时数据所在。
export HWCLOUD_DATA_DIR="${HWCLOUD_DATA_DIR:-/usr/share/novnc}"

# RUNNER_DIR 由下方统一推导（见「路径推导」）
LOG_DIR="$RUNNER_DIR/logs"
mkdir -p "$LOG_DIR"

# 多账号：账号由调用方（cron / 看板按钮）通过 HWCLOUD_ACCOUNT 传入。
# 不读该变量时 points-snapshot 恒解析为 main，acct2 的看板永远不刷新。
ACC="${HWCLOUD_ACCOUNT:-main}"
export HWCLOUD_ACCOUNT="$ACC"
if [ "$ACC" = "main" ]; then
  ACC_SUFFIX=""
else
  ACC_SUFFIX="-$ACC"
fi
LOG_FILE="$LOG_DIR/points-refresh${ACC_SUFFIX}.log"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

cd "$RUNNER_DIR" || exit 1

# 用独立锁避免两次采集并发（同一脚本重入），不与登录守护共用
exec 8>"/tmp/hwcloud-points-snapshot${ACC_SUFFIX}.lock"
if ! flock -n 8; then
  echo "[$(date '+%F %T')] ⏳ 上一次采集还在跑，跳过" >> "$LOG_FILE"
  exit 0
fi

# 浏览器互斥：与登录守护、鸿蒙预热、面板任务串行，避免并发消费 SSOTGC
# （华为云 SSO 的 TGC 换一次票就消费一次，并发访问会让别的组件回落成「未登录」）。
# 拿不到锁就跳过本次——采集每 30 分钟一次，错过一轮无妨，不该硬挤。
# shellcheck disable=SC1091
source "$RUNNER_DIR/scripts/browser-lock.sh"
if ! browser_lock_acquire "$ACC" 120; then
  echo "[$(date '+%F %T')] ⏳ 另有进程正在访问华为云，跳过本次采集" >> "$LOG_FILE"
  exit 0
fi
echo "[$(date '+%F %T')] 采集开始" >> "$LOG_FILE"
timeout 240 node scripts/points-snapshot.mjs --quiet >> "$LOG_FILE" 2>&1
RC=$?
browser_lock_release
exec 8>&-
echo "[$(date '+%F %T')] 采集完成 rc=$RC" >> "$LOG_FILE"
# 日志只留最近 500 行
tail -500 "$LOG_FILE" > "$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE"
exit $RC
