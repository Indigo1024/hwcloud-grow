#!/bin/bash
# 华为云作品展览馆发布 —— 纯脚本直连版（不经码道 TUI）
#
# 为什么不用码道：原实现起 codearts TUI 让它自己调 skill，耗时 10~14 分钟，
# 且失败时退出码仍是 0（AK 失效、模型排队都静默吞掉），日志里才看得出。
# 现在直接调 skill 的脚本接口，全程约 20~40 秒：
#   resolve-domain → gen_sts → api/camps → publish-work → 核验积分
#
# 账号：本部署（runner2）固定 acct2，凭证/身份全部来自 acct2-env.sh。
set -u

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

# RUNNER_DIR 由下方统一推导（见「路径推导」）
LOG_DIR="$RUNNER_DIR/logs"
mkdir -p "$LOG_DIR"

ACC=acct2
# shellcheck disable=SC1091
source "$RUNNER_DIR/scripts/acct2-env.sh"
export DISPLAY="${DISPLAY:-:99}"
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

WORKSPACE=/root/.codeartsdoer/agent-workspace-acct2
SKILL_DIR=/root/.codeartsdoer-acct2/skills/huawei-cloud-publish-work-to-gallery/scripts
TRAINING_CAMP_ID=47d6ba99-fca0-4797-947d-a8776f506df1   # 闯关活动
GIT_URL=https://gitcode.com/gitcode_user_2/todo-app.git
GIT_BRANCH=master
STATIC_PORT=8081

LOG_FILE="$LOG_DIR/gallery-$(date +%Y%m%d).log"
BONUS_KEYWORD="展览馆"
BONUS_POINTS=200

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

log "========== 展览馆发布开始（账号 $ACC，脚本直连）=========="

# ---------- 0. 本月是否已领 ----------
# 成长中心这条是 MONTHLY×1（rule_list: mission_cycle_type=MONTHLY）：
# 月度只计一次分，但发布接口重复调用都会返回 201。
# 原来用「今日是否到账」判断，跨月后第一天会误判为「没到账」，
# 且每天跑一次都会重复发布。这里改为按月判断。
if node "$RUNNER_DIR/scripts/gallery-bonus-check.mjs" --month >> "$LOG_FILE" 2>&1; then
  log "本月 $BONUS_KEYWORD +$BONUS_POINTS 已到账，跳过发布"
  log "========== 展览馆发布结束（本月已领过）=========="
  exit 0
fi
log "本月尚未领取，开始发布"

cd "$WORKSPACE" || { log "❌ workspace 不存在: $WORKSPACE"; exit 2; }

# ---------- 1. 解析 domain（权威身份，必须与账号一致）----------
DOMAIN=$(node "$SKILL_DIR/resolve-domain.mjs" 2>&1 | tee -a "$LOG_FILE" | grep -oE '#domain=[0-9a-f]{32}' | cut -d= -f2 | head -1)
if [ -z "$DOMAIN" ]; then
  log "❌ domain 解析失败"
  exit 2
fi
EXPECTED_DOMAIN=$( [ "$ACC" = "main" ] && echo "HW_DOMAIN_ID_MAIN" || echo "HW_DOMAIN_ID_2" )
if [ "$DOMAIN" != "$EXPECTED_DOMAIN" ]; then
  # 身份串号是最贵的错误：接口会返回成功，积分却记到另一个号。
  log "❌ 身份不符！解析出 $DOMAIN，期望 $EXPECTED_DOMAIN（AK/profile 配错）"
  exit 2
fi
log "身份校验通过: $DOMAIN"

# ---------- 2. 生成 STS 临时凭证 ----------
STS_FILE="/tmp/sts-$ACC.json"
if ! python3 "$SKILL_DIR/gen_sts.py" --account "$DOMAIN" --hcloud /usr/local/bin/hcloud \
      --creds-out "$STS_FILE" --sh-out "/tmp/sts-$ACC.sh" >> "$LOG_FILE" 2>&1; then
  log "❌ STS 临时凭证生成失败（常见：新号缺 SELF_VERIFY 委托、AK 失效）"
  exit 2
fi

# ---------- 3. 网络预检 ----------
if ! node "$SKILL_DIR/api.mjs" GET /v1/gallery/camps --creds-file "$STS_FILE" 2>&1 \
     | tee -a "$LOG_FILE" | grep -q "#status=200"; then
  log "❌ 平台接口不可用（STS 或网络异常）"
  exit 2
fi

# ---------- 4. 作品名轮换 ----------
if NAME_OUT=$(node "$RUNNER_DIR/scripts/rotate-workname.mjs" "$WORKSPACE" 2>&1); then
  echo "$NAME_OUT" >> "$LOG_FILE"
  WORK_NAME=$(echo "$NAME_OUT" | head -1 | sed 's/^#workname=//')
  log "作品名: $WORK_NAME"
else
  echo "$NAME_OUT" >> "$LOG_FILE"
  log "⚠️ 作品名轮换失败"
  exit 2
fi

# ---------- 5. 门禁前置（preflight / ensure-utf8） ----------
# check-gates 校验 /tmp/font-gate-ok、/tmp/utf8-gate-ok 标记（含内容防伪造）。
# /tmp 重启即清，必须每次发布前重跑这两步，否则门禁恒失败。
if ! python3 "$SKILL_DIR/preflight.sh" >> "$LOG_FILE" 2>&1; then
  log "⚠️ preflight 未通过（字体/依赖缺失）"
fi
if ! node "$SKILL_DIR/ensure-utf8.mjs" "$WORKSPACE" >> "$LOG_FILE" 2>&1; then
  log "⚠️ ensure-utf8 未通过（存在非 UTF-8 文件）"
fi

# ---------- 6. 封面 / 详情包 ----------
# 详情包：README + resources 打包并校验
if ! node "$SKILL_DIR/build-detail-zip.mjs" \
      --readme "$WORKSPACE/README.md" \
      --resources "$WORKSPACE/resources" \
      --out /tmp/detail.zip >> "$LOG_FILE" 2>&1; then
  log "⚠️ 详情包生成失败，尝试沿用已有 /tmp/detail.zip"
  [ -f /tmp/detail.zip ] || { log "❌ 无可用详情包"; exit 2; }
fi

# 封面：build-cover 需要项目先跑在本地端口上并截图。
# 起静态服务 → 生成封面 → 收掉服务。
if [ -f "$WORKSPACE/index.html" ]; then
  ( cd "$WORKSPACE" && python3 -m http.server "$STATIC_PORT" --bind 127.0.0.1 \
      >/dev/null 2>&1 & echo $! > /tmp/static-$ACC.pid )
  sleep 3
  if ! node "$SKILL_DIR/build-cover.mjs" \
        --url "http://127.0.0.1:$STATIC_PORT" \
        --project-dir "$WORKSPACE" \
        --title "$WORK_NAME" \
        --tagline "轻量待办清单" \
        --description "浏览器端任务管理工具" \
        --out /tmp/cover.png >> "$LOG_FILE" 2>&1; then
    log "⚠️ 封面生成失败，尝试沿用已有 /tmp/cover.png"
  fi
  kill "$(cat /tmp/static-$ACC.pid 2>/dev/null)" 2>/dev/null
  rm -f /tmp/static-$ACC.pid
fi
fuser -k "${STATIC_PORT}/tcp" 2>/dev/null
[ -f /tmp/cover.png ] || { log "❌ 无可用封面"; exit 2; }

# ---------- 6. 组装参数并发布 ----------
PARAMS="/tmp/pub-$ACC.json"
python3 - "$STS_FILE" "$PARAMS" "$WORK_NAME" "$DOMAIN" <<'PY' || exit 2
import json, sys, time
sts_file, out, work_name, domain = sys.argv[1:5]
d = json.load(open(sts_file))
c = d.get("Credentials") or d.get("credentials") or d
p = {
  "idempotencyKey": f"gallery-publish-{domain}-{int(time.time())}",
  "accessKeyId": c.get("accessKeyId") or c.get("AccessKeyId"),
  "secretAccessKey": c.get("secretAccessKey") or c.get("SecretAccessKey"),
  "securityToken": c.get("securityToken") or c.get("SecurityToken"),
  "trainingCampId": "47d6ba99-fca0-4797-947d-a8776f506df1",
  "workName": work_name,
  "introduction": "一个基于前端的待办清单工具，支持任务增删改查与日期格式化展示。",
  "coverImage": "/tmp/cover.png",
  "detailZip": "/tmp/detail.zip",
  "gitUrl": "https://gitcode.com/gitcode_user_2/todo-app.git",
  "gitBranch": "master",
  "envUrl": "",
}
json.dump(p, open(out, "w"), ensure_ascii=False, indent=1)
PY

PUB_OUT=$(node "$SKILL_DIR/publish-work.mjs" "$PARAMS" 2>&1)
echo "$PUB_OUT" >> "$LOG_FILE"
echo "$PUB_OUT" | tail -6

if ! echo "$PUB_OUT" | grep -q "#status=201"; then
  log "❌ 发布失败（未见 status=201）"
  log "========== 展览馆发布结束（失败）=========="
  exit 1
fi
log "✅ 发布成功"

# ---------- 7. 核验积分 ----------
# 2026-11-01：判据从「积分明细接口」改为「成长中心任务 is_finish」——
# 原 bonus-flow 接口已被华为云下线（返回 200+HTML）。任务完成后服务端
# 置 is_finish=1 有延迟，多等几轮。
BONUS_OK=0
for attempt in 1 2 3 4; do
  sleep $([ "$attempt" = "1" ] && echo 30 || echo 60)
  if node "$RUNNER_DIR/scripts/gallery-bonus-check.mjs" --month >> "$LOG_FILE" 2>&1; then
    BONUS_OK=1; break
  fi
  log "任务尚未标记完成（第 ${attempt} 次核验）"
done

if [ "$BONUS_OK" = "1" ]; then
  log "✅ 本月 $BONUS_KEYWORD +$BONUS_POINTS 积分已到账（is_finish=1）"
  log "========== 展览馆发布结束 =========="
  exit 0
fi
log "⚠️ 作品已发布（201），任务未在核验窗口内标记完成，平台有延迟，稍后复查"
log "========== 展览馆发布结束（待确认积分）=========="
exit 0
