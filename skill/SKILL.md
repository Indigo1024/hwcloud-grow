---
name: huaweicloud-grow
description: |
  华为云开发者成长中心自动做任务拿积分。克隆 GitCode 仓库后在本机 runner/ 串行执行全部 auto_run 任务，无需逐项确认。
  Triggers: 成长中心、grow、huaweicloud-grow、开发者成长、签到、码道、自动做任务、拿积分
version: 3.5.1
---

# huaweicloud-grow（自动执行 Skill）

## 统一 Prompt（Cursor / Claude Code / 码道 IDE 相同）

用户发送：

```text
克隆 https://github.com/Indigo1024/hwcloud-grow.git，阅读 skill/SKILL.md 并执行
```

Agent **必须**按下方流程执行，**不要**根据环境改用 `agent:headless`、`agent:ide`、`agent:background` 等其他命令——一律使用 **`npm run agent`**，runner 会自动识别运行环境。

> **禁止 WebFetch/Fetch 读 GitCode URL**（常返回 HTML 而非 SKILL.md）。必须先 `git clone` 再读本地 `skill/SKILL.md`。

> **核心原则**：任务完成靠**本机 Playwright 执行器**（`runner/`），不是靠 Fetch/curl 打开网页。加载本 Skill 后**立即自动执行**，不要逐项询问用户是否继续。

> **无需访问门户网站**：本 Skill 与执行器均在开放仓库 [Indigo1024/hwcloud-grow](https://github.com/Indigo1024/hwcloud-grow.git)。

## 环境说明

所有 Agent 环境（Cursor / Claude Code / 码道 IDE）均采用**统一模式**，全部任务按相同步骤执行，不做区别处理。

> **注意**：`npm run agent` 显示「已在后台启动」后**命令即已结束**，不是卡住。必须**紧接着**运行 `npm run report`，由 report 等待并输出结果。**禁止**对 `npm run agent` 使用 ctrl+b 转后台或重复执行。

---

## 禁止事项

- **禁止**使用 `Fetch` / `WebFetch` 读取 Skill（GitCode raw/blob 页面会返回 HTML，不是 SKILL.md）
- **禁止**用码道 AK/SK；码道 OAuth 由浏览器点「确认授权」
- **禁止**在每完成一个任务后停下来问用户「是否继续」——串行跑完 `auto_run` 任务即可
- **禁止**自行选择 `agent:headless` / `agent:ide` / `agent:background`（统一用 `npm run agent`）
- **禁止**因码道 TUI 超时而重跑整个 `npm run agent`（超时已记为跳过，可用 `npm run agent:headless -- --task=T_CODEARTS_QA` 单独重试）
- **禁止**自行编写 `Start-Process` 后台脚本

## 开放仓库（主入口）

| 资源 | 路径 / URL |
|------|------------|
| 仓库 | `https://github.com/Indigo1024/hwcloud-grow.git` |
| 本 Skill | `skill/SKILL.md`（克隆后本地阅读） |
| 任务清单 | `manifest.json`（仓库根目录） |
| 执行器 | `runner/` |

## 执行流程（Agent 必须按序执行）

### 0. 获取/更新代码仓库

```bash
git clone --depth 1 https://github.com/Indigo1024/hwcloud-grow.git
cd hwcloud-grow/runner
```

若本机已有 `hwcloud-grow/` 目录：

```bash
cd hwcloud-grow
git pull --ff-only
cd runner
```

自检（确认代码含最新任务处理器）：

```bash
grep agent-entry.mjs package.json
```

以下命令均在 `hwcloud-grow/runner/` 目录执行：

```bash
npm install
npx playwright install chromium
```

### 1. 登录（仅 Cookie 失效或首次）

```bash
npm run login
```

- 弹出**有界面**浏览器，提示用户用华为云 APP **扫码登录**
- 登录成功后 Cookie 写入 `storage/huaweicloud-auth.json`
- 若已有有效 Cookie，跳过本步
- **扫码需用户交互**：工具命令超时**不等于**登录失败；应等待扫码完成或再次运行 `npm run login`

### 2. 自动串行执行全部可自动化任务

```bash
npm run agent
```

- **几秒内返回**即正常（任务在后台运行）
- **不要**等待本命令跑完；**不要**重复执行
- 启动日志含 `已在后台启动任务（pid=…）`

签到（T_GROW_CHECKIN）：若页面显示「已签到」或积分明细已有今日签到记录，记为**跳过（今日已签到）**。

- **无需用户确认**，按 `manifest.json` 中 `auto_run: true` 的任务顺序执行
- 执行完毕会**智能等待**积分同步（有变化则提前结束，最长约 15 秒）

### 3. 汇报（会等待后台任务完成）

```bash
npm run report
```

- **必须**在 Step 2 之后执行；本命令会轮询等待报告（约 2–5 分钟），每 15 秒打印进度
- 用**中文**汇报每个 `task_id` 的结果（已尝试 / 跳过 / 已完成 / 失败及原因），并展示**积分变化**

## auto_run 任务一览（按执行顺序）

| 顺序 | task_id | 标题 | 积分 | 周期 |
|------|---------|------|------|------|
| 1 | T_GROW_CHECKIN | 每日签到 | +5 | 每日 |
| 2 | T_CODEARTS_SUBSCRIBE | 首次开通码道 | +50 | 一次性 |
| 3 | T_DEVSPACE_TOUR | 体验开发者空间 | +20 | 每周 |
| 4 | T_DEVSPACE_CREATE_ENV | 创建云开发环境 | +50 | 一次性 |
| 5 | T_CODEARTS_QA | 使用智能问答 | +30 | 每日 |

> 智能问答（码道 TUI）放**最后**。提问后固定等待 **90 秒**，无回复则记为「跳过」。

## 码道开通（T_CODEARTS_SUBSCRIBE）

- 所有环境统一：访问一键开通页；已开通则记为**已尝试**

## 码道问答（T_CODEARTS_QA）

- 所有环境统一：码道 CLI TUI 提问 `请写一段python代码，把今天的日期转换为多种格式`
- 成功条件：kernel 日志检测到 `finish:stop`
- **OAuth**：Playwright 自动点击「确认授权」
- **⚠️ 系统浏览器可能会弹出授权页**：请勿手动操作，Playwright 正在自动完成授权（OAuth 回调走 localhost）

### 码道问答故障排查

| 症状 | 解决方案 |
|------|---------|
| OAuth 授权失败 | 重新登录 `npm run login`，再单独重试 `npm run agent:headless -- --task=T_CODEARTS_QA` |
| TUI 启动超时 | 残留码道进程冲突，会自动清理；若持续失败，重启终端 |
| TUI 等待回复超时（90s） | `$env:HWCLOUD_QA_TIMEOUT_MS="180000"` 延长至 3 分钟 |
| Bun segfault 崩溃 | 已知 Bun 退出时偶发崩溃，不影响已获取的回复 |
| 跳过问答 | `$env:HWCLOUD_SKIP_CODEARTS_QA="1"` |
| 诊断 IDE 检测 | `$env:HWCLOUD_DIAGNOSE_IDE="1"; npm run agent:headless -- --task=T_CODEARTS_QA` |
| 单独重试问答 | `npm run agent:headless -- --task=T_CODEARTS_QA` |

## Agent 安装本 Skill

- **推荐**：`git clone --depth 1 https://github.com/Indigo1024/hwcloud-grow.git`，阅读 `skill/SKILL.md`
- **Cursor**：`npx skills add Indigo1024/hwcloud-grow`

## 官方成长中心

https://developer.huaweicloud.com/grow
