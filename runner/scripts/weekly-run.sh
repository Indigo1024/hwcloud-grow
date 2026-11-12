#!/bin/bash

# ---------- 路径推导（不要写死绝对路径）----------
# 按本脚本位置反推：scripts/ 的上一级是 runner 目录，再上一级是项目根。
# 这样项目放在任何位置都能跑，发布出去也不会指向作者机器上的路径。
_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="${RUNNER_DIR:-$(dirname "$_SELF_DIR")}"
_GROW_ROOT="${HWCLOUD_ROOT:-$(dirname "$RUNNER_DIR")}"
_CONTROL_DIR="$_GROW_ROOT/control"
# 面板/扫码数据目录：任务"真干活"，写数据文件必须落在实时数据所在处。
# 生产在 /usr/share/novnc（面板读这里）；新装环境回落到 <root>/panel
# （见 auth-utils.mjs 的 dataDir()）。不设会写进 panel/ 那个编辑副本、面板读不到
# （2026-11-12 发现 daily-run 与 weekly-run 都漏了这行）。
export HWCLOUD_DATA_DIR="${HWCLOUD_DATA_DIR:-/usr/share/novnc}"
# 每周任务调度入口（建议 crontab：周一 09:00）
#
# 与 daily-run.sh 的分工：
#   daily-run.sh  —— 每天跑一次性/每日任务（签到、建议、BBS 回答等）
#   weekly-run.sh —— 每周跑一次周度任务（AI 开发者空间体验等）
#
# 注意：T_WEEKLY_LAB（实验 +50）与 T_WEEKLY_CERT（微认证 +100）**故意不在这里跑**。
# 它们需要人工在控制台真实操作 / 答题考试，自动化只会消耗名额和考试机会，
# 且频繁开退实验会被判刷量。详见 scripts/tasks/weekly.mjs 顶部说明。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

# 多账号：不读 HWCLOUD_ACCOUNT 时 agent-run 恒解析为 main，
# acct2 的周任务就完全不会跑、日志也被主号占位。
ACC="${HWCLOUD_ACCOUNT:-main}"
export HWCLOUD_ACCOUNT="$ACC"
if [ "$ACC" = "main" ]; then
  ACC_SUFFIX=""
  ENV_FILE=/root/.codeartsdoer/.env.aksk
else
  ACC_SUFFIX="-$ACC"
  ENV_FILE="/root/.codeartsdoer/.env.aksk-${ACC}"
fi
LOG_FILE="$LOG_DIR/weekly${ACC_SUFFIX}-$(date +%Y%m%d).log"
exec >> "$LOG_FILE" 2>&1

# 码道 CLI 需要 AK/SK，否则周任务退化成扫码流程而失败
if [ -r "$ENV_FILE" ]; then
  set +u
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set -u
  export CODEARTS_CLI_AK CODEARTS_CLI_SK
fi
export HWCLOUD_ACCOUNT="$ACC"

export DISPLAY="${DISPLAY:-:99}"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# ---------- 定时开关（面板可切换）----------
if ! node $_CONTROL_DIR/schedule-gate.mjs "$ACC" weekly; then
  log "⏸ 每周定时已被面板关闭，跳过本次运行"
  exit 0
fi

log "========== 每周任务开始 =========="

# 记一笔运行历史，供面板「运行历史」显示；trap 保证中途退出也能收尾
if [ "${HWCLOUD_PANEL_RUN:-}" = "1" ]; then
  RUN_REC_ID=""
else
  # record.mjs 在「已有任务在跑」时退出码 4；此时跳过本轮避免并发
  RUN_REC_ID=$(HWCLOUD_ALIVE_PID=$$ node $_CONTROL_DIR/record.mjs begin "$ACC" weekly "每周任务" 2>&1)
  REC_RC=$?
  if [ "$REC_RC" = "4" ]; then
    echo "[$(date '+%F %T')] ⏸ $RUN_REC_ID"
    exit 0
  fi
  [ "$REC_RC" != "0" ] && RUN_REC_ID=""
  trap 'node $_CONTROL_DIR/record.mjs end "$ACC" "$RUN_REC_ID" "$?" 2>/dev/null || true' EXIT
fi

# 用户 2026-11-06 明确要求把「每周实践一个实验 +50」纳入自动化。
# 用 lab-weekly.mjs 打开 ECS 入门实验并保持 90s（环境启动失败不重试，防刷量）。
log "启动每周实验（ECS 入门，约 2 分钟）..."
timeout --signal=KILL 300 node scripts/lab-weekly.mjs
log "lab-weekly 退出码=$?"

# AI 办公实践中心的周任务：
#   T_AI_OFFICE_ISSUE 每周给 Agent 开发实践中心代码仓提 Issue (+60)
#   T_AI_OFFICE_STAR  每周 Star 一个 Agent 代码仓 (+50)  ← **主号已停用，见下**
#
# 关于 Star：主号已把该组织 **32 个仓库全部 Star 完**（实测 /user/starred 32 个、
# 未 Star 的为 0），而 GitCode 没有取消 Star 的接口（5 种写法实测全 405/404），
# 因此无法再产生新的 Star 动作、这一项对本账号已成**一次性任务**。
# 继续跑只会每轮打印"已全部 Star"的空转日志，故从主号调度中移除。
# （账号2 仍在跑：它只用了 11/32，还能继续拿分——见 runner2 的 weekly-run.sh）
log "启动 Agent 中心提 Issue（每周 +60）..."
timeout --signal=KILL 600 node scripts/agent-run.mjs --task=T_AI_OFFICE_ISSUE
log "T_AI_OFFICE_ISSUE 退出码=$?"

# 周任务里其余项（微认证 / 开发者赛事 / 建议被采纳）需要人工操作，不在此调度。
timeout --signal=KILL 900 node scripts/agent-run.mjs --task=T_DEVSPACE_AI_SHELL
rc=$?
log "T_DEVSPACE_AI_SHELL 退出码=$rc"

# 顺带跑一遍日常任务：签到/发文/DevSpace 等是每日任务，
# 周一若 daily-run 因登录态问题失败，这里能补上（都带幂等，不会重复发分）。
log "补跑日常任务（幂等，已做过会跳过）..."
timeout --signal=KILL 1800 node scripts/agent-run.mjs
log "日常补跑退出码=$?"

log "========== 每周任务结束 =========="
