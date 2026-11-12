#!/bin/bash
# 本部署（runner2 = 新号 hw_account_2）的固定环境。
#
# 为什么单独抽一个文件：码道的账号身份存在 cli-data/auth.json 里，
# 2026-10 就是因为两个号共用同一份配置，新号发布的作品全落到旧号名下、
# 「展览馆 +200」永远不到账。隔离要覆盖到每一个入口脚本，
# 逐个脚本手写 export 迟早漏一个（当时 7 个 .sh 里有 6 个没设），
# 所以统一从这里取。
#
# 用法（每个入口脚本开头）：
#   source "$(dirname "$0")/acct2-env.sh"

# ---------- 账号 ----------
# 不读外部环境变量：漏设也不能退回主号，否则就是串号。
export HWCLOUD_ACCOUNT=acct2

# ---------- 码道 CLI 配置目录（按账号隔离，本次修复的核心）----------
# 该目录下有独立的 cli-data/auth.json，身份已换成新号。
export CODEARTS_HOME=/root/.codeartsdoer-acct2

# ---------- 作品目录（不随配置目录搬家）----------
# 带 git remote 与提交历史，是既有资产；只钉死后不走 CODEARTS_HOME。
export CODEARTS_WORKSPACE_HOME=/root/.codeartsdoer

# ---------- 凭证 ----------
export ENV_FILE=/root/.codeartsdoer/.env.aksk-acct2
if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1091
  source "$ENV_FILE"
fi

# 这几个必须显式 export：skill 里的 resolve-domain.mjs / gen_sts.py 是子进程，
# 只靠文件内 export 一旦有人改成不带 export 的写法就会静默丢失，
# 而丢了不会报错——hcloud 会退回 ~/.hcloud 的 current profile（可能是另一个号的），
# 表现为「接口 201 成功，积分却记到别人名下」（2026-10-21 旧号实际踩过）。
export CODEARTS_CLI_AK CODEARTS_CLI_SK
export HUAWEICLOUD_SDK_AK HUAWEICLOUD_SDK_SK
export HCLOUD_PROFILE

# ---------- 停用码道问答（T_CODEARTS_QA，+100）----------
# 2026-10-22 用户决定放弃该任务：它要起码道 TUI 提问，依赖 OAuth 令牌，
# 而两个号的 cli-data/auth.json 都没有可用令牌（旧号无、新号是手写占位且已过期），
# 每天必然失败并空耗时间。跳过不影响其他任务。
export HWCLOUD_SKIP_CODEARTS_QA=1

# source 的凭证文件里若意外带了 HWCLOUD_ACCOUNT，会静默覆盖上面的 export，
# 整条子进程链（npm → agent-entry → agent-run）就会退回主号。这里重申一次。
export HWCLOUD_ACCOUNT=acct2
