# hwcloud-grow-runner

华为云开发者成长中心 **Agent 任务执行器**（`runner/` 子目录）。

## 安装

```bash
git clone --depth 1 https://github.com/Indigo1024/hwcloud-grow.git
cd hwcloud-grow/runner
```

已有仓库时更新：

```bash
cd hwcloud-grow && git pull --ff-only && cd runner
```

## 使用

```bash
npm install
npx playwright install chromium
npm run login
npm run agent
npm run report
```

> Linux 服务器需要虚拟显示：先起 `Xvfb :99`，再 `export DISPLAY=:99`，
> 否则扫码页无法渲染二维码。

## 单个任务

```bash
node scripts/agent-run.mjs --task=T_BBS_SUGGESTION
node scripts/agent-run.mjs --task=T_BBS_FORUM_ANSWER
```

## 目录说明

| 路径 | 说明 |
|------|------|
| `scripts/agent-run.mjs` | 主执行器，各任务 handler 在 `HANDLERS` / `TASK_ORDER` 注册 |
| `scripts/tasks/` | 独立任务实现（建议、BBS 回答、每周任务） |
| `scripts/login-daemon.mjs` | 登录守护：保活 + 失效时拉起扫码 |
| `scripts/auth-utils.mjs` | 登录态读写（含 SSO 票据保护、写锁、原子写） |
| `scripts/daily-run.sh` | 每日调度入口 |
| `scripts/weekly-run.sh` | 每周调度入口 |

## 任务能力边界

部分任务**无法**全自动，详见仓库根目录 `README.md` 的「任务自动化边界」一节。
简要说：BBS 回答需楼主采纳、实验需人工按手册操作、微认证需通过考试，
这三项脚本只做到能做的部分，**不会**越界操作或谎报完成。

## 链接

- 开放仓库：https://github.com/Indigo1024/hwcloud-grow.git
- Skill：`skill/SKILL.md`（仓库根目录）
- 门户介绍页：<你的门户主机>/grow-portal/
