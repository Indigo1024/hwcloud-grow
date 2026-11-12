#!/usr/bin/env bash

# ---------- 路径推导（不要写死绝对路径）----------
# 按本脚本位置反推：scripts/ 的上一级是 runner 目录，再上一级是项目根。
# 这样项目放在任何位置都能跑，发布出去也不会指向作者机器上的路径。
_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="${RUNNER_DIR:-$(dirname "$_SELF_DIR")}"
_GROW_ROOT="${HWCLOUD_ROOT:-$(dirname "$RUNNER_DIR")}"
_CONTROL_DIR="$_GROW_ROOT/control"
#
# code-sync.sh — 两套部署（runner / runner2）的代码一致性校验与同步
#
# 背景：
#   runner   = 主号（main）部署
#   runner2  = 新号（acct2）部署，从 runner 物理复制出来
#
#   两套只应在「账号/端口/日志名」这类**部署参数**上不同，
#   业务逻辑（任务实现、bug 修复）必须一致——否则修了一边另一边继续踩坑，
#   而且从分数上看不出原因。
#
# 用法：
#   bash scripts/code-sync.sh check    # 只校验，列出差异（默认）
#   bash scripts/code-sync.sh diff     # 打印具体差异内容
#   bash scripts/code-sync.sh apply    # 把 runner 的业务代码同步到 runner2
#
# 判断哪些文件允许不同：见 EXPECTED_DIFF 列表。不在列表里的差异一律视为「漂移」。

set -uo pipefail

ROOT=$_GROW_ROOT
A="$ROOT/runner"
B="$ROOT/runner2"
MODE="${1:-check}"

# 允许（且预期）两套不同的文件 —— 都是部署参数，不是业务逻辑
EXPECTED_DIFF=(
  "scripts/accounts.mjs"        # 账号注册表：主号多账号 / 新号固定 acct2
  "scripts/auth-path.mjs"       # storage 布局与门户端口 8080 vs 8090
  "scripts/daily-run.sh"        # 账号、日志名、凭证路径
  "scripts/gallery-daily.sh"    # 账号、workspace、静态端口 8080 vs 8081
  "scripts/login-daemon.sh"     # 账号、锁文件
  "scripts/refresh-points.sh"   # 账号、日志名
  "scripts/weekly-run.sh"       # 账号、日志名
  # 账号专属环境文件：主号 main-env.sh / 新号 acct2-env.sh，只有一份存在于各自部署
  "scripts/main-env.sh"
  "scripts/acct2-env.sh"
  # 以下三个含「按账号派生路径」的实现：主号兜底 main、新号兜底 acct2，
  # 且新号多读 CODEARTS_HOME/WORKSPACE_HOME。差异是部署参数，不是业务逻辑。
  # 校验时请用 code-sync.sh diff 人眼确认差异只落在兜底值/注释上。
  "scripts/codearts-cli.mjs"
  "scripts/gallery-publish.mjs"
  "scripts/auth-utils.mjs"
  # 下面几个只是把 $RUNNER_DIR 字样换成了 runner2（脚本内绝对路径），
  # 逻辑一字不差；路径本身就是部署参数。
  "scripts/do-oauth.mjs"
  "scripts/probe-alive.mjs"
  "scripts/rotate-workname.mjs"
)

is_expected() {
  local rel="$1"
  for e in "${EXPECTED_DIFF[@]}"; do
    [ "$e" = "$rel" ] && return 0
  done
  return 1
}

# 收集两套 scripts 下的全部文件（相对路径）
collect() {
  cd "$1" || return
  find scripts -type f \( -name '*.mjs' -o -name '*.sh' -o -name '*.json' \) 2>/dev/null | sort
}

mapfile -t FILES < <( { collect "$A"; collect "$B"; } | sort -u )

drift=0
only_a=()
only_b=()
unexpected=()

for rel in "${FILES[@]}"; do
  fa="$A/$rel"
  fb="$B/$rel"
  if [ -f "$fa" ] && [ ! -f "$fb" ]; then
    only_a+=("$rel"); drift=$((drift+1)); continue
  fi
  if [ ! -f "$fa" ] && [ -f "$fb" ]; then
    only_b+=("$rel"); drift=$((drift+1)); continue
  fi
  if ! cmp -s "$fa" "$fb"; then
    is_expected "$rel" || { unexpected+=("$rel"); drift=$((drift+1)); }
  fi
done

echo "===== 两套代码一致性校验 ====="
echo "对比：$A  ←→  $B"
echo

if [ ${#only_a[@]} -gt 0 ]; then
  # 账号专属文件（main-env.sh / acct2-env.sh）本就只存在于各自部署，不算缺失
  _real=()
  for _f in "${only_a[@]}"; do is_expected "$_f" || _real+=("$_f"); done
  if [ ${#_real[@]} -gt 0 ]; then
    echo "⚠️ 只在主号存在（新号缺失，需要同步过去）："
    printf '   %s\n' "${_real[@]}"
  fi
fi
if [ ${#only_b[@]} -gt 0 ]; then
  _real=()
  for _f in "${only_b[@]}"; do is_expected "$_f" || _real+=("$_f"); done
  if [ ${#_real[@]} -gt 0 ]; then
    echo "⚠️ 只在新号存在（主号缺失）："
    printf '   %s\n' "${_real[@]}"
  fi
fi
if [ ${#unexpected[@]} -gt 0 ]; then
  echo "❌ 业务逻辑漂移（不在预期差异列表内，必须对齐）："
  printf '   %s\n' "${unexpected[@]}"
fi

if [ "$drift" -eq 0 ]; then
  echo "✅ 一致：除 ${#EXPECTED_DIFF[@]} 个部署参数文件外，两套代码完全相同。"
  exit 0
fi

echo
echo "共 $drift 处需要处理。"

case "$MODE" in
  diff)
    for rel in "${only_a[@]:-}"; do
      [ -n "$rel" ] && { echo "───── 仅主号: $rel ─────"; head -30 "$A/$rel"; }
    done
    for rel in "${unexpected[@]:-}"; do
      [ -n "$rel" ] && { echo "───── 漂移: $rel ─────"; diff -u "$A/$rel" "$B/$rel" | head -40; }
    done
    ;;
  apply)
    echo "开始同步（以主号为准，覆盖 / 补齐到新号）…"
    for rel in "${only_a[@]:-}"; do
      [ -z "$rel" ] && continue
      mkdir -p "$B/$(dirname "$rel")"
      cp -a "$A/$rel" "$B/$rel" && echo "  ➕ $rel"
    done
    for rel in "${unexpected[@]:-}"; do
      [ -z "$rel" ] && continue
      cp -a "$A/$rel" "$B/$rel" && echo "  🔄 $rel"
    done
    echo
    echo "同步完成。注意：只覆盖业务逻辑文件，"
    echo "accounts/auth-path/daily-run 等【预期差异】文件保持各自独立，不会被覆盖。"
    echo "同步后请各自跑一次 node --check / bash -n 确认语法。"
    ;;
esac

exit 1
