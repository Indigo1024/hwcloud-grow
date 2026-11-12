#!/bin/bash
# 启动前自检 + 拉起（"衔接装置"）。
#
# 作用：把「环境是否就绪」与「开始跑任务」串起来——
#   ① 先跑 doctor.mjs 检查浏览器/依赖/显示环境
#   ② 有阻塞项 → 打印指引并退出（不带着坏环境去跑，避免莫名其妙的失败）
#   ③ 只有警告 → 提示后继续（多数任务能跑，只有扫码这类有头操作受影响）
#   ④ 全部就绪 → 拉起登录守护 + 面板（或按参数只检查）
#
# 用法:
#   bash control/bootstrap.sh            # 自检 → 就绪则拉起服务
#   bash control/bootstrap.sh --check    # 只自检，不拉起
#   bash control/bootstrap.sh --json     # 输出机器可读结果
set -uo pipefail

_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_HERE="$(dirname "$_SELF_DIR")"
NODE="${NODE:-node}"

MODE="${1:-}"

echo "───── 环境自检 ─────"
if [ "$MODE" = "--json" ]; then
  "$NODE" "$_SELF_DIR/doctor.mjs" --json
  RC=$?
else
  "$NODE" "$_SELF_DIR/doctor.mjs" ${MODE:+}
  RC=$?
fi

if [ "$RC" = "1" ]; then
  echo "❌ 环境未就绪，已中止启动。请按上面提示处理后重试。"
  exit 1
fi
if [ "$MODE" = "--check" ] || [ "$MODE" = "--json" ]; then
  exit $RC
fi

if [ "$RC" = "2" ]; then
  echo "⚠️  存在警告，继续启动（扫码登录等有头操作可能受影响）。"
fi

echo "───── 启动服务 ─────"
STARTED=0

# 面板（若已由 systemd 托管则优先用 systemd，否则直接后台起）
if systemctl list-unit-files 2>/dev/null | grep -q "^hw-points-panel\.service"; then
  systemctl start hw-points-panel 2>/dev/null && { echo "  ✓ 面板已启动（systemd: hw-points-panel）"; STARTED=1; }
fi
if [ "$STARTED" = "0" ]; then
  PORT="${PANEL_PORT:-4173}"
  if command -v python3 >/dev/null 2>&1; then
    # 用 setsid 彻底脱离当前会话：否则 bootstrap 退出时子进程会跟着被带走
    # （2026-11-11 实测：直接 nohup 仍会被调用方的进程组回收，导致脚本"卡住"）
    setsid python3 "$_HERE/panel-server.py" "$PORT" >/tmp/grow-panel.log 2>&1 &
    sleep 2
    if curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null; then
      echo "  ✓ 面板已启动（http://127.0.0.1:$PORT，日志 /tmp/grow-panel.log）"
    else
      echo "  ⚠️ 面板可能未就绪，查看 /tmp/grow-panel.log"
    fi
  else
    echo "  ⚠️ 未找到 python3，跳过面板启动"
  fi
fi

# 登录守护
# ⚠️ 关键：不能用 `list-unit-files | grep hwcloud-login-daemon` 判断——
#    模板实例（hwcloud-login-daemon@main）在 list-unit-files 里显示为
#    `hwcloud-login-daemon@.service`，grep 那个名字匹配不到，于是**误判为"没装"**
#    而再起一个手动守护 → 两个守护抢同一把浏览器锁，
#    其中一个拿到锁无限等扫码、另一个永远拿不到 → 保活停摆、登录态失效。
#    （2026-11-12 实际踩到：主号因此 14 小时无保活、当天 0 分。）
#    改为先查 systemd 是否已有该实例在跑，有就完全不碰。
if systemctl is-active --quiet hwcloud-login-daemon@main 2>/dev/null; then
  echo "  ✓ 登录守护已在运行（systemd: hwcloud-login-daemon@main），跳过"
  systemctl is-active --quiet hwcloud-login-daemon-acct2 2>/dev/null \
    && echo "  ✓ 账号2 登录守护已在运行（systemd）" \
    || systemctl start hwcloud-login-daemon-acct2 2>/dev/null && echo "  ✓ 已启动账号2 登录守护（systemd）"
else
  # 没有 systemd 托管时才手动起（且加防重复：已有别的守护在跑就不起）
  RUNNING=$(pgrep -fc "login-daemon.mjs" 2>/dev/null || echo 0)
  if [ "$RUNNING" -gt 0 ]; then
    echo "  ✓ 已有 $RUNNING 个登录守护在运行（非 systemd），跳过启动"
  else
    for r in runner runner2; do
      [ -f "$_HERE/$r/scripts/login-daemon.sh" ] || continue
      ( cd "$_HERE/$r" && setsid bash scripts/login-daemon.sh >/tmp/grow-login-$r.log 2>&1 & )
      echo "  ✓ $r 登录守护已启动（日志 /tmp/grow-login-$r.log）"
    done
  fi
fi

echo
echo "完成。查看面板：http://127.0.0.1:${PANEL_PORT:-4173}"
