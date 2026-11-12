#!/bin/bash
# 写入 GitCode 访问令牌（PAT）到指定账号的凭证文件。
#
# 为什么用 PAT 而不是浏览器登录：
#   Star / 提 Issue 都能走 GitCode OpenAPI（POST /repos/{org}/{repo}/star），
#   只要有令牌即可，无需维持浏览器会话——比扫码登录稳得多，
#   也不会因子进程抢浏览器而失败（2026-11-10 踩过）。
#
# 用法: bash gitcode-token-set.sh <main|acct2> <token>
set -euo pipefail
acc="${1:?用法: gitcode-token-set.sh <main|acct2> <token>}"
tok="${2:?缺少 token}"
case "$acc" in
  main)  dir=/root/.gitcode ;;
  acct2) dir=/root/.gitcode-acct2 ;;
  *) echo "未知账号 $acc（只能是 main / acct2）" >&2; exit 2 ;;
esac
mkdir -p "$dir"; chmod 700 "$dir"
# 与 gitcode-tasks.mjs 的 readToken 对齐：它读 access_token = "<YOUR_GITCODE_TOKEN>"
umask 077
cat > "$dir/auth.toml" <<TOML
# GitCode 访问令牌（个人访问令牌 / PAT）
# 由 gitcode-token-set.sh 写入，权限 600
access_token = "<YOUR_GITCODE_TOKEN>"
TOML
chmod 600 "$dir/auth.toml"
echo "✅ 已写入 $dir/auth.toml（账号 $acc，token 长度 ${#tok}）"
