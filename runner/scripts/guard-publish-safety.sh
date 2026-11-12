#!/bin/bash
# ============================================================
# 发布前安全门禁 —— 作品会公开展示，绝不能带上真实个人信息
#
# 用法: guard-publish-safety.sh <作品目录>
# 退出码: 0 = 通过可以发布；非 0 = 拦截
#
# 检查三层：
#   1. 敏感文件是否会被提交（.gitignore 是否覆盖）
#   2. 待提交/已提交内容是否含真实凭据、服务器 IP、账号名
#   3. 仓库是否含过大文件/意外目录（如 node_modules、日志）
# ============================================================

set -u
WORK="$(cd "${1:-.}" 2>/dev/null && pwd)" || { echo "❌ 目录不存在: ${1:-}"; exit 2; }

echo "=== 发布安全门禁: $WORK ==="

if [ ! -d "$WORK/.git" ]; then
  echo "ℹ️ 非 git 仓库，跳过内容检查（skill 会自行 git init）"
  exit 0
fi

FAIL=0

# --- 1. 敏感文件不得进入版本库 ---
SENSITIVE_NAMES='sts-creds|\.env|auth\.toml|\.aksk|huaweicloud-auth|storage\.json|id_rsa|\.pem$|\.p12$'
TRACKED_BAD=$(git -C "$WORK" ls-files 2>/dev/null | grep -E "$SENSITIVE_NAMES" || true)
if [ -n "$TRACKED_BAD" ]; then
  echo "❌ 以下敏感文件已被版本库跟踪（必须移除）:"
  echo "$TRACKED_BAD" | sed 's/^/     /'
  FAIL=1
fi

# --- 2. 内容中的真实凭据/基础设施信息 ---
# 只匹配真实值特征，占位符（<你的主机>、<AK>、xxx）不会命中。
#
# 注意：模式里**不能**写真实 IP / AK 前缀 —— 这个脚本本身要进公开仓库，
# 写进去等于把敏感值印在明面上。改为从环境变量注入（本地 .env 或不入库的配置提供），
# 未提供时退化为仅匹配通用的密钥形态。
LEAK_PATTERNS="${HWCLOUD_GUARD_PATTERNS:-}"
DEFAULT_PATTERNS='[A-Z]{20,}|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{40,}'
if [ -n "$LEAK_PATTERNS" ]; then
  LEAK_PATTERNS="$LEAK_PATTERNS|$DEFAULT_PATTERNS"
else
  LEAK_PATTERNS="$DEFAULT_PATTERNS"
fi
for f in $(git -C "$WORK" ls-files 2>/dev/null); do
  fp="$WORK/$f"
  [ -f "$fp" ] || continue
  HIT=$(grep -nE "$LEAK_PATTERNS" "$fp" 2>/dev/null | head -3)
  if [ -n "$HIT" ]; then
    echo "❌ $f 含真实敏感信息:"
    echo "$HIT" | sed 's/^/     /'
    FAIL=1
  fi
done

# --- 3. 意外的大目录/大文件（易夹带本地环境） ---
for bad in node_modules .venv __pycache__ logs storage .codeartsdoer .claude .opencode; do
  if git -C "$WORK" ls-files 2>/dev/null | grep -q "^$bad/"; then
    echo "❌ 版本库包含不应发布的目录: $bad/"
    FAIL=1
  fi
done

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "🚫 安全门禁未通过。作品是公开的，请先清理上述内容再发布。"
  echo "   参考：git rm --cached <文件>；并用占位符替换真实值（如 <你的主机>）"
  exit 1
fi

echo "✅ 安全门禁通过：未发现敏感文件或真实个人信息"
exit 0
