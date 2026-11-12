#!/usr/bin/env bash
# 华为云浏览器互斥：同一账号同时只允许一个进程开浏览器访问华为云。
#
# 为什么必须做（2026-11-11 调研结论）：
#   华为云 SSO 的 SSOTGC 每换一次票就被消费一次，而本机有 4 个组件各自开浏览器、
#   共用同一份 cookie 快照（登录守护每 30 分钟、积分采集每 30 分钟、鸿蒙预热每 5 分钟、
#   面板按需）。互不协调 → 谁都可能把 TGC 用掉 → 别的组件再访问就变成「登录/注册」，
#   表现为莫名其妙的 logged-out、必须人工重扫。这就是「老被踢」的机制。
#
# 用 flock 而不是自己写 pid 文件：flock 是内核态锁，随文件描述符存活，
# 进程异常退出会自动释放；自己写 pid 文件在 CLI 场景下做不了长期持有
# （进程一退锁就成了「死锁」，反而要额外的探活逻辑）。
#
# 用法:
#   source scripts/browser-lock.sh
#   browser_lock_acquire main 180   # 拿锁，最长等 180s；退出码 3 = 超时
#   ...访问华为云...
#   browser_lock_release            # 释放（脚本退出时也会自动释放）
set -u

BROWSER_LOCK_DIR="${BROWSER_LOCK_DIR:-/tmp}"
_browser_lock_fd=""

# $1=账号 $2=超时秒数（默认 180）
browser_lock_acquire() {
  local acc="${1:?browser_lock_acquire 需要账号}"
  local timeout="${2:-180}"
  local file="${BROWSER_LOCK_DIR}/.huaweicloud-browser-${acc}.lock"

  _browser_lock_try() {
    local fd
    # 动态分配 fd（9~30），避免与脚本里已用的冲突。
    # 注意：eval "exec N>>file" 失败时要确保 fd 不被 flock 引用，
    # 否则会报 "Bad file descriptor"。
    for fd in $(seq 9 30); do
      if eval "exec ${fd}>>\"\$file\"" 2>/dev/null; then
        if flock -n "$fd" 2>/dev/null; then
          _browser_lock_fd="$fd"
          return 0
        fi
        eval "exec ${fd}>&-" 2>/dev/null || true
      fi
    done
    return 1
  }

  _browser_lock_try && return 0

  # 没抢到：等一下再试（带超时）
  local waited=0
  while [ "$waited" -lt "$timeout" ]; do
    sleep 2
    waited=$((waited + 2))
    _browser_lock_try && return 0
  done
  return 3
}

browser_lock_release() {
  if [ -n "$_browser_lock_fd" ]; then
    eval "exec ${_browser_lock_fd}>&-" 2>/dev/null || true
    _browser_lock_fd=""
  fi
}
