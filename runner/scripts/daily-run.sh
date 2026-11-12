#!/bin/bash
# 华为云成长中心每日任务 - 定时自动运行
# 用法: 由 crontab 每日 09:30 调用，或手动执行
# 日志: $RUNNER_DIR/logs/daily-YYYYMMDD.log

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

# ---------- 账号 ----------
# 每个账号跑一份完整流程（60 分任务 + 200 分作品）。账号由 HWCLOUD_ACCOUNT
# 指定，未指定时为主号——保持旧的单账号调用行为不变。
# 日志、凭证、workspace 都按账号派生，否则第二个号会写进主号日志、
# 用主号 AK/SK 发布主号仓库。
ACC="${HWCLOUD_ACCOUNT:-main}"
# 作品/agent 工作目录的父目录：下面清理孤儿进程要按它对出本账号路径
WORKSPACE_ROOT=/root/.codeartsdoer
export HWCLOUD_ACCOUNT="$ACC"
if [ "$ACC" = "main" ]; then
  ACC_SUFFIX=""
else
  ACC_SUFFIX="-$ACC"
fi
LOG_FILE="$LOG_DIR/daily${ACC_SUFFIX}-$(date +%Y%m%d).log"

# cron 环境 PATH 精简，显式补全 node/npm/Xvfb 等命令路径
export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# 码道 CLI 认证：必须用永久 AK/SK。
# 不加载会退化成 OAuth 扫码流程，无头环境下拿不到授权链接，
# 表现为 T_CODEARTS_QA「未能获取码道 CLI 授权链接」、问答 100 分拿不到。
#
# 账号、凭证、hcloud profile 统一从 main-env.sh 取：它会把
# CODEARTS_CLI_AK/SK、HUAWEICLOUD_SDK_AK/SK、HCLOUD_PROFILE 一并显式 export。
# 只 source .env.aksk 的话，一旦文件里某个变量没带 export，子进程会静默丢失，
# 表现为作品发布解析出别人的 domain（2026-10 实际踩过）。
# shellcheck disable=SC1091
source "$RUNNER_DIR/scripts/main-env.sh"
# 重申账号：凭证文件里若意外带了 HWCLOUD_ACCOUNT，source 会静默覆盖上面的 export，
# 整条子进程链（npm → agent-entry → agent-run）就会全部退回主号
export HWCLOUD_ACCOUNT="$ACC"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

# ---------- 定时开关（面板可切换）----------
# 状态由 panel 写入 state/schedule.json；关闭时直接跳过，不再往下跑。
# 放在 log() 定义之后，跳过原因才能写进当天的日志里备查。
if ! node $_CONTROL_DIR/schedule-gate.mjs "$ACC" daily; then
  log "⏸ 每日定时已被面板关闭，跳过本次运行"
  exit 0
fi

log "========== 每日任务开始（账号 $ACC）=========="

# 记一笔运行历史（面板「运行历史」会显示 cron 触发与手动触发两类记录）
#
# HWCLOUD_ALIVE_PID=$$ 传本 shell 的 pid 供面板探活；
# 若本轮由面板执行器启动（它已占锁），它会带 HWCLOUD_PANEL_RUN=1，
# 此时不要重复占锁、也不要在历史里另记一条（否则历史出现重复条目）。
if [ "${HWCLOUD_PANEL_RUN:-}" = "1" ]; then
  RUN_REC_ID=""
else
  # record.mjs 在「已有任务在跑」时退出码 4；此时必须跳过本轮，
  # 否则两个 daily-run 并发跑同一账号会互抢浏览器、甚至重复发文。
  RUN_REC_ID=$(HWCLOUD_ALIVE_PID=$$ node $_CONTROL_DIR/record.mjs begin "$ACC" full-daily "完整每日流程" 2>&1)
  REC_RC=$?
  if [ "$REC_RC" = "4" ]; then
    echo "[$(date '+%F %T')] ⏸ $RUN_REC_ID"
    exit 0
  fi
  [ "$REC_RC" != "0" ] && RUN_REC_ID=""
  trap 'node $_CONTROL_DIR/record.mjs end "$ACC" "$RUN_REC_ID" "$?" 2>/dev/null || true' EXIT
fi

# 1. 确保 Xvfb :99 运行（码道 TUI 与 Playwright 依赖）
if ! pgrep -f "Xvfb :99" > /dev/null; then
  log "Xvfb :99 未运行，启动中..."
  rm -f /tmp/.X11-unix/X99 /tmp/.X99-lock 2>/dev/null
  setsid nohup Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +render -noreset > /dev/null 2>&1 < /dev/null &
  sleep 3
fi
export DISPLAY=:99

# 2. 检查登录态是否有效（失效则先自愈，仍失败才中止）
cd "$RUNNER_DIR" || exit 1

# 不再抢浏览器锁：登录守护（hwcloud-login-daemon）是常驻进程、长期持有
# /tmp/hwcloud-browser.lock，旧代码在这里 flock -w 900 会白等 15 分钟后
# 整轮任务被跳过。实际互斥需求只在「启动浏览器的瞬间」，而 Playwright
# 各用独立 profile，不会互相抢 Xvfb；真正会打架的是扫码过程中的窗口，
# 这里用 quick-check 判活即可，必要时由 login-daemon --once 自愈。
# （2026-10 踩坑：改成 -n 后又变成永远跳过，故直接不参与该锁。）

CHECK_OUT=$(node scripts/quick-check.mjs 2>&1)
echo "$CHECK_OUT" >> "$LOG_FILE"
if ! echo "$CHECK_OUT" | grep -q "登录检测: ok=true"; then
  log "⚠️ 登录态失效，触发自愈（保活 + 必要时拉起扫码）..."
  node scripts/login-daemon.mjs --once >> "$LOG_FILE" 2>&1 || true
  CHECK_OUT=$(node scripts/quick-check.mjs 2>&1)
  echo "$CHECK_OUT" >> "$LOG_FILE"
fi
if ! echo "$CHECK_OUT" | grep -q "登录检测: ok=true"; then
  log "❌ 登录态仍失效，跳过本次运行"
  log "   请打开 http://<你的主机>:6080/scan.html 扫码（登录守护会持续等待）"
  exit 2
fi
log "登录态有效 ✓"

# 3. 清理残留浏览器进程（只杀本账号的）
# 不加账号过滤会把另一个账号正在跑的浏览器/codearts 一起杀掉，
# 表现为「另一号任务莫名其妙失败、分数没拿到」。
if [ "$ACC" = "main" ]; then
  AGENT_WS_PATTERN='agent-workspace/'
else
  AGENT_WS_PATTERN="agent-workspace-${ACC}/"
fi
for pid in $(pgrep -f 'playwright_chromiumdev_profil[e]'); do
  if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "$AGENT_WS_PATTERN"; then
    kill "$pid" 2>/dev/null
  fi
done
# codearts 是本账号的问答 TUI。之前漏清理导致孤儿进程每天累积
# （10-20 起堆到 7 个、占 3.4G 内存），原因是：
#   1) 进程 cmdline 里没有 workspace 路径，真正带路径的是 cwd；
#   2) 二进制路径是 installers/bin/codearts，用 'codearts -m' 匹配不到。
# 现按「进程 cwd 是否属于本账号 workspace」判定，只杀自己的。
OWN_WS="$WORKSPACE_ROOT/agent-workspace-${ACC}"
[ "$ACC" = "main" ] && OWN_WS="$WORKSPACE_ROOT/agent-workspace"
for pid in $(pgrep -f 'installers/bin/codearts'); do
  if [ "$(readlink /proc/"$pid"/cwd 2>/dev/null)" = "$OWN_WS" ]; then
    kill -9 "$pid" 2>/dev/null
  fi
done
sleep 2

# 4. 运行全套任务（码道问答超时放宽到 240s 以覆盖排队等待）
export HWCLOUD_QA_TIMEOUT_MS=240000
log "启动 npm run agent..."
# 加硬超时：agent 曾出现「日志已收尾但进程不退出」的孤儿残留，
# 会长期占用浏览器与锁，导致后续任务与登录守护互相干扰。
timeout --signal=KILL 1800 npm run agent >> "$LOG_FILE" 2>&1
AGENT_RC=$?
if [ "$AGENT_RC" -eq 137 ]; then
  log "⚠️ agent 超过 1800s 被强制结束（可能有任务卡住）"
fi
log "agent 退出码=$AGENT_RC"

# 4.4 每日发文（每日 +60 积分，自带「今日是否已领」判定，已领则跳过）
# 单独成步而不是塞进 manifest：发文走 BBS 页面交互（要勾免责声明、点 submit），
# 与 manifest 里那批纯接口/页面浏览任务的成功判据不同，失败原因要能单独定位。
log "启动每日发文（约 2~3 分钟）..."
# 直接跑 tasks/bbs-article.mjs（Playwright 填表），不走 article-daily.mjs。
#
# 为什么换：article-daily.mjs 是套壳调码道 TUI 的，两个坑——
#   1) 它把主号目录算成 agent-workspace-main（实际是 agent-workspace），
#      目录不存在时 spawn 报 ENOENT，错误信息只提可执行文件，极易误判成 codearts 装丢；
#   2) TUI 交互多（升级提示、权限弹窗），无人值守常整轮卡到 900s 超时。
# bbs-article.mjs 直接操作页面，两分钟完成，且自带幂等（今日已到账则跳过）。
#
# 退出码：0=已到账；1=已提交但平台延迟入账（**不能重跑**，会重复发文）；2=异常
timeout --signal=KILL 600 node scripts/tasks/bbs-article.mjs >> "$LOG_FILE" 2>&1
ARTICLE_RC=$?
case "$ARTICLE_RC" in
  0) log "今日发文 +60 已到账" ;;
  1) log "发文已提交，积分待平台审核入账（不重跑，避免重复发文）" ;;
  *) log "⚠️ 发文异常，退出码=$ARTICLE_RC" ;;
esac

# 4.45 每日体验 AI DevSpace（每日 +30）
# 严格按 hw-task/devspace.py 经验:
#   兜底直开 developer.huaweicloud.com/devspace?utm_source=officeagent
#   → 点体验版卡片 → CDP 点立即进入 → 勾两个协议 → 点进入
#   → 「同意」AK/SK 同步弹窗 → 容器创建 → sleep(60) 延迟落账
# 真成功判据: 落在 devstation.developer.huaweicloud.com/aidevspace
# 幂等靠「今日积分明细是否已有 DevSpace +30」
log "启动每日体验 AI DevSpace（约 3~5 分钟）..."
timeout --signal=KILL 900 node scripts/devspace-py-style.mjs >> "$LOG_FILE" 2>&1
DS_RC=$?
case "$DS_RC" in
  0) log "DevSpace 动作已执行（积分可能延迟，以明细为准）" ;;
  3) log "⚠️ DevSpace 登录态失效，需重新扫码" ;;
  *) log "⚠️ DevSpace 异常，退出码=$DS_RC" ;;
esac

# 4.46 鸿蒙每日浏览一个案例（+10）
# 任务规则: 打开任意案例详情页并保持浏览 30 秒
# 入口: harmonybp.developer.huaweicloud.com/#practice-tasks → 去浏览案例
log "启动鸿蒙每日浏览案例（约 1 分钟）..."
timeout --signal=KILL 420 node harmony-daily.mjs >> "$LOG_FILE" 2>&1
HM_RC=$?
case "$HM_RC" in
  0) log "鸿蒙浏览动作已执行（以明细为准）" ;;
  *) log "⚠️ 鸿蒙浏览异常，退出码=$HM_RC" ;;
esac

# 4.5 展览馆作品发布（MONTHLY×1）
# 每天调用，由 gallery-daily.sh 内部 --month 幂等判断决定是否发布：
# 本月已计分则跳过，未计分才发布。不用「1 号」的日期判断——那样一旦 1 号
# 当天机器没跑成（断电/断网/登录态失效），整月就漏掉了。
log "启动展览馆发布（月度任务，已计分则自动跳过）..."
bash scripts/gallery-daily.sh >> "$LOG_FILE" 2>&1
log "展览馆发布退出码=$?"

# 4.7 周任务（每日流程内一并处理）
#
# 用户要求：完整流程要覆盖"这周该做的"。周任务本身就是幂等的
# （脚本内部按「本周是否已到账」判断，做过就跳过），所以每天跑一次不会重复发分，
# 也不会漏掉——哪天做的都算在这一周里。
#
#   T_AI_OFFICE_ISSUE 每周给 Agent 开发实践中心代码仓提 Issue (+60) —— 每周可做
#
# 注意 T_AI_OFFICE_STAR（每周 Star +50）**不在主号调度里**：
# 主号已把该组织 32 个仓库全部 Star 完，GitCode 又不提供取消 Star 的接口，
# 无法再产生新动作 —— 对本账号它已是一次性任务，继续调只会空转。详见 weekly-run.sh。
log "启动周任务：Agent 中心提 Issue（已计分则跳过）..."
timeout --signal=KILL 600 node scripts/agent-run.mjs --headless --task=T_AI_OFFICE_ISSUE >> "$LOG_FILE" 2>&1
log "T_AI_OFFICE_ISSUE 退出码=$?"

# 4.9 代码一致性自检：两套部署的业务逻辑必须一致，
# 否则修了一边另一边继续踩坑，而且从分数上看不出原因。
log "两套代码一致性校验..."
bash $RUNNER_DIR/scripts/code-sync.sh check >> "$LOG_FILE" 2>&1
CS_RC=$?
if [ "$CS_RC" -ne 0 ]; then
  log "⚠️ 两套代码存在漂移（详见日志），请执行 code-sync.sh apply 对齐"
fi

# 5. 等待并生成报告
log "等待并生成报告..."
timeout --signal=KILL 300 npm run report >> "$LOG_FILE" 2>&1

# 每日核对：积分明细 + 任务面板（写进日志，方便早上验收）
log "每日核对（积分明细 + 任务面板）..."
node scripts/daily-report.mjs >> "$LOG_FILE" 2>&1

log "========== 每日任务结束 =========="

# 6. 保留最近 30 天日志
find "$LOG_DIR" -name 'daily*.log' -mtime +30 -delete 2>/dev/null

# 7. 输出尾部摘要（运行历史由脚本开头的 trap 统一收尾，这里不再重复记）供 cron 邮件/查看
tail -30 "$LOG_FILE"
