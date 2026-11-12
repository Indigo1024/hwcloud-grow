#!/bin/bash
# 本部署（runner = 旧号 hw_account_main）的固定环境。
#
# 与 runner2/scripts/acct2-env.sh 对称：两个号各自一份，互不读取。
# 集中一处的原因见新号那份的注释——逐个脚本手写 export 迟早漏。
#
# 用法（每个入口脚本开头）：
#   source "$(dirname "$0")/main-env.sh"

# ---------- 账号 ----------
export HWCLOUD_ACCOUNT=main

# ---------- 码道 CLI 配置目录 ----------
# 旧号沿用原始目录，保持不变（新号在 ~/.codeartsdoer-acct2）
export CODEARTS_HOME=/root/.codeartsdoer

# ---------- 作品目录 ----------
export CODEARTS_WORKSPACE_HOME=/root/.codeartsdoer

# ---------- 凭证 ----------
export ENV_FILE=/root/.codeartsdoer/.env.aksk
if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1091
  source "$ENV_FILE"
fi

# 这几个必须显式 export：skill 里的 resolve-domain.mjs / gen_sts.py 是子进程，
# 只靠文件内 export 一旦有人改成不带 export 的写法就会静默丢失，
# 而丢了不会报错——hcloud 会退回 ~/.hcloud 的 current profile（那是另一个号的），
# 表现为「接口 201 成功，积分却记到别人名下」（2026-10-21 实际踩过）。
export CODEARTS_CLI_AK CODEARTS_CLI_SK
export HUAWEICLOUD_SDK_AK HUAWEICLOUD_SDK_SK
export HCLOUD_PROFILE

# ---------- 停用码道问答（T_CODEARTS_QA，+100）----------
# 2026-10-22 用户决定放弃该任务：它要起码道 TUI 提问，依赖 OAuth 令牌，
# 而 cli-data/auth.json 里没有可用令牌，每天必然失败并空耗时间。
# 跳过不影响其他任务。
export HWCLOUD_SKIP_CODEARTS_QA=1

# source 的凭证文件里若意外带了 HWCLOUD_ACCOUNT，会静默覆盖上面的 export
export HWCLOUD_ACCOUNT=main
