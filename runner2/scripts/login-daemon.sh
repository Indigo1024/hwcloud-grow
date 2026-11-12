#!/bin/bash
# 华为云登录守护：常驻保活 + 失效自动拉起扫码
#
# 用法:
#   bash scripts/login-daemon.sh          # 前台常驻（需配合 setsid/nohup 后台化）
#   bash scripts/login-daemon.sh --once   # 单次自检，供 cron 调用
#
# 状态页: http://<你的主机>:6080/scan.html
# 日志:   runner/logs/login-daemon-YYYYMMDD.log
set -u

# ---------- 路径推导（不要写死绝对路径）----------
# 按本脚本位置反推：scripts/ 的上一级是 runner 目录，再上一级是项目根。
# 这样项目放在任何位置都能跑，发布出去也不会指向作者机器上的路径。
_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="${RUNNER_DIR:-$(dirname "$_SELF_DIR")}"
_GROW_ROOT="${HWCLOUD_ROOT:-$(dirname "$RUNNER_DIR")}"
_CONTROL_DIR="$_GROW_ROOT/control"

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export DISPLAY=:99

# RUNNER_DIR 由下方统一推导（见「路径推导」）
LOG_DIR="$RUNNER_DIR/logs"
mkdir -p "$LOG_DIR"

# 多账号：账号由 systemd 的 Environment=HWCLOUD_ACCOUNT=%i 传入。
# 两个实例共用一个目录，日志不带账号名会互相追加到同一个文件，
# 排查时根本分不清是哪一路守护打印的。
ACCOUNT_ID="${HWCLOUD_ACCOUNT:-main}"
export HWCLOUD_ACCOUNT="$ACCOUNT_ID"
LOG_FILE="$LOG_DIR/login-daemon-$ACCOUNT_ID-$(date +%Y%m%d).log"

# 确保 Xvfb :99 可用（扫码需真实浏览器窗口）
if ! pgrep -f "Xvfb :99" >/dev/null; then
  rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock 2>/dev/null
  setsid nohup Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +render -noreset \
    >/dev/null 2>&1 </dev/null &
  sleep 3
fi

cd "$RUNNER_DIR" || exit 1

# 互斥锁：
#   1) 与其它任务共用 hwcloud-browser.lock，避免同时启动浏览器抢 Xvfb；
#   2) 必须用 -n（非阻塞）——若已在跑就直接退出。
#      旧实现用 -w 600（等 10 分钟），会让 cron 的 --once 与 systemd 常驻
#      排队轮流起浏览器、互相覆盖 scan-qr.png，表现为「扫的码不是守护等的码，
#      怎么扫都显示等待/失效」。
#
# 注意（2026-10 踩坑）：旧版在这里 exec 9> 后一直持有锁到进程结束，
# 而本服务是常驻进程，于是这把锁被永久占死——daily-run.sh 里等锁 900s
# 后整轮任务被跳过、refresh-points.sh 直接跳过，表现为「看板数据一直不刷新」。
# 注意（2026-10 踩坑）：旧版在这里 exec 9> 后一直持有锁到进程结束，
# 而本服务是常驻进程，于是这把锁被永久占死——daily-run.sh 里等锁 900s
# 后整轮任务被跳过、refresh-points.sh 直接跳过，表现为「看板数据一直不刷新」。
# 现在只有 --once（cron 单次自检）才加锁；systemd 常驻实例不参与该锁，
# 因为常驻进程持锁=永久占死，而它启动的浏览器与日常任务各用独立 profile，不冲突。
# 锁按账号区分：两个账号各用独立浏览器 profile、互不冲突，
# 共用一把锁会让 acct2 的自愈被主号常驻实例的 --once 静默挡掉（exit 0）。
LOCK_FILE="/tmp/hwcloud-browser-${ACCOUNT_ID}.lock"
if [ "${1:-}" = "--once" ]; then
  exec 9>"$LOCK_FILE"
  if ! flock -n 9; then
    echo "[$(date +%H:%M:%S)] ⏳ 已有守护/任务在运行，本次跳过（不排队，避免抢浏览器）" >> "$LOG_FILE"
    exit 0
  fi
fi

node scripts/login-daemon.mjs "$@" >> "$LOG_FILE" 2>&1
RC=$?

# 保留最近 30 天日志
find "$LOG_DIR" -name 'login-daemon-*.log' -mtime +30 -delete 2>/dev/null
exit $RC
