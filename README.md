# hwcloud-grow · 华为云成长中心任务自动化

把华为云开发者「成长中心」的每日/每周/每月任务做成可定时、可手动触发的自动化，
带一个能看积分、能跑任务、能扫码登录的 Web 面板。

也支持任意三方 Agent 加载 huaweicloud-grow Skill 自动执行（步骤见 `skill/SKILL.md`）。

## ⚠️ 部署到服务器前，先读这一段

**这套东西最需要你理解的一点：登录态不是永久的，掉了要重新扫码。**

很多人第一次部署会以为"配一次就能一直跑"，结果第二天发现任务全失败 ——
不是脚本坏了，是华为云把会话作废了，需要重新扫码。

### 为什么必须扫码，而且无法避免

华为云的登录会话（SSO）**由服务端控制有效期**。这不是我们本地能绕过的：

- 客户端改 cookie 的有效期**没用** —— 实测把有效期改到 2027 年，接口照样返回未登录
- 平台从不承诺长期会话，官方文档明确写「会根据您的实际使用情况发生变化」
- 这是通用的安全设计：**会话过期只能由服务端决定**（OWASP 会话管理规范里的原则）

所以现实目标是「**掉得少 + 掉了能快速恢复**」，而不是「永不掉线」。

### 实际频率（本机两个账号跑了 9 天的实测）

| 情况 | 频率 |
|---|---|
| 正常 | 一天掉 0~2 次 |
| 异常（一天掉十几次） | 多半是有多个进程在抢浏览器锁，看日志里有没有「未取得浏览器互斥锁」 |

### 所以服务器部署要这样做

**1. 扫码入口要能远程访问**

登录守护会自动生成二维码。你需要一个能从手机访问到的地址来扫：

```bash
# 面板自带扫码页（默认在面板同端口）
http://<你的服务器IP>:<面板端口>/scan.html
```

如果服务器没有公网 IP，用内网穿透（如 cloudflared、frp）把面板暴露出来。

**2. 掉了怎么知道**

三种方式，任选：

- **看面板**：顶部「华为云登录态」会显示「⚠️ 等待扫码」（登录有效时显示「✅ 登录有效」）
- **看运行历史**：连续几天出现"失败"就要查
- **看积分**：面板顶部有今日/今日增量。该拿的分没到账 = 有问题

**3. 扫完之后**

守护会自动继续（无需重启、无需其它操作）。任务本身是幂等的
（已到账的会跳过），所以补跑不会重复发分。

### 想减少扫码频率，可以做什么

| 做法 | 效果 | 代价 |
|---|---|---|
| 保持登录守护常驻（默认已开） | 掉得少一些 | 无 |
| **持久化浏览器 profile** | 可能明显延长 | 要改代码，见 `docs/持久化改造备忘录.md` |
| 提高保活频率 | ❌ **反效果**：会被平台限流 | — |
| 延长 cookie 有效期 | ❌ **无效**（服务端说了算） | — |

---

## ⚡ 快速开始

### 0. 环境自检（**强烈建议先跑这一步**）

```bash
git clone --depth 1 <YOUR_REPO_URL>
cd hwcloud-grow
node control/doctor.mjs        # 检查 Node/依赖/浏览器/显示环境/数据目录
```

它会逐项告诉你缺什么、怎么装。

> ⚠️ **必须的三步，少一步就跑不起来：**
> ```bash
> cd runner
> npm install                        # ① 装 Node 依赖
> npx playwright install chromium    # ② 装浏览器（npm install 不会自动装！）
> npx playwright install-deps chromium  # ③ 装浏览器系统依赖（Debian/Ubuntu 常用）
> ```
> 只做了 ① 的话，面板能打开，但**点任何任务都会失败**。
> 面板会给出明确提示（不会静默失败），但仍建议先跑 `doctor.mjs` 一次性装齐。

也可以直接用它启动（自检不通过就不会继续）：

```bash
bash control/bootstrap.sh            # 自检 → 就绪则启动面板与登录守护
bash control/bootstrap.sh --check    # 只自检，不启动
```

### 1. 图形环境（有头操作必需）

扫码登录**必须用有头浏览器**（无头模式下华为云登录页行为不同、拿不到二维码）。

| 场景 | 做法 |
|---|---|
| 有桌面环境（Windows/macOS/带桌面的 Linux） | 直接用，无需额外配置 |
| **Linux 服务器（无桌面）** | 装虚拟显示 Xvfb |

服务器上：

```bash
apt install -y xvfb
Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +extension RENDER -noreset &
export DISPLAY=:99
```

想让它开机自启 + 崩溃自愈，建议做成 systemd 服务（本仓库在生产环境即如此管理，
`/etc/systemd/system/xvfb.service`）。

> **只用无头任务可以跳过这一步**：签到、发文、GitCode Star/Issue 等走 API 或
> headless 的任务不依赖 DISPLAY；只有「扫码登录」和少数页面操作需要。

### 2. 登录与运行

```bash
npm run login          # 首次：扫码登录（面板的 scan.html 会显示二维码）
npm run agent          # 自动执行全部任务（环境自动识别）
npm run report         # 中文摘要
```

## 🧩 环境要求一览

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 18** | 用到全局 `fetch`、顶层 `await` |
| 浏览器 | **Chromium**（Playwright 自带） | `npx playwright install chromium` |
| 浏览器系统库 | Linux 上建议装 | `npx playwright install-deps chromium` |
| 是否可用系统 Chrome | 可选 | 代码优先尝试 `channel: "chrome"`，失败自动回退自带 Chromium |
| 有头模式 | 扫码登录**必需** | 需要 X server（桌面环境或 Xvfb） |
| 无头模式 | API 类任务即可 | 不依赖显示环境 |
| 磁盘 | 约 400MB | Playwright 浏览器二进制较大 |
| Python 3 | 面板服务需要 | `panel-server.py`（仅标准库，无第三方依赖） |

`node control/doctor.mjs` 会逐项检查以上内容，并**实测浏览器能否真正启动**
（只看文件在不在不够——缺系统库时启动照样失败）。

## ❓ 常见问题

**Q：面板能打开，但点任何任务都没反应 / 提示"运行依赖未安装"**
没装依赖。按上面第 0 步的三条命令装齐。

**Q：提示"未找到账号 xxx 的已保存登录态"**
还没登录。在面板点「＋ 加账号」扫码，或跑 `npm run login`。

**Q：扫码页打开但二维码是空白/占位图**
1. 没装依赖（同上）；2. 没有 X server（扫码要开有头浏览器）——设好 `DISPLAY` 再试。

**Q：任务跑起来了但很快失败**
看面板的「运行日志」区，或 `runner/logs/` 下的日志。多数是登录态过期或平台改版。



## 🕐 定时运行

推荐用 cron 分两条链路，互不干扰：

```cron
# 每日任务（签到、建议、BBS 回答等）
30 0 * * *   /path/to/runner/scripts/daily-run.sh

# 每周任务（AI 开发者空间等）
0 9 * * 1    /path/to/runner/scripts/weekly-run.sh

# 看板积分刷新
7,37 * * * * /path/to/runner/scripts/refresh-points.sh
```

`weekly-run.sh` **故意不跑**实验和微认证——那两项需要人工操作与答题，见上方「任务自动化边界」。

## 🤖 任务自动化边界（重要，请先读）

并非所有任务都能自动完成。下表如实标注每项的真实能力，**不做越界操作、不谎报完成**：

| task_id | 任务 | 积分 | 周期 | 能否自动 | 说明 |
|---|---|---|---|---|---|
| T_GROW_CHECKIN | 每日签到 | +10 | 每日 | ✅ 全自动 | 页面已签到时自动跳过 |
| T_CODEARTS_SUBSCRIBE | 首次开通码道 | +300 | 一次性 | ✅ 全自动 | 已开通则跳过 |
| T_CODEARTS_QA | 使用智能问答 | +100 | 每日 | ✅ 全自动 | 调用码道 CLI TUI 提问 |
| T_DEVSPACE_TOUR | 体验开发者空间 | +20 | 每周 | ✅ 全自动 | 浏览空间导航页 |
| T_DEVSPACE_CREATE_ENV | 创建云开发环境 | +50 | 一次性 | ✅ 全自动 | 已有环境则跳过 |
| T_AI_OFFICE_STAR | Star 办公实践中心仓库 | +50 | 一次性 | ✅ 全自动 | 自动拉组织仓库清单逐个 Star |
| T_AI_OFFICE_ISSUE | 提 Issue | +60 | 一次性 | ✅ 全自动 | 已提过同主题则跳过 |
| T_BBS_SUGGESTION | 提交产品建议 | +30 | 每日 | ✅ 全自动 | 自动填写并提交 |
| T_BBS_FORUM_ANSWER | 每日回答问题**且被采纳** | +60 | 每日 | ⚠️ **半自动** | 见下方说明 |
| T_DEVSPACE_AI_SHELL | 每周体验 AI 开发者空间 | +30 | 每周 | ⚠️ **半自动** | 见下方说明 |
| T_WEEKLY_LAB | 每周实践一个实验 | +50 | 每周 | ❌ **不自动** | 见下方说明 |
| T_WEEKLY_CERT | 每周通过一项微认证 | +100 | 每周 | ❌ **不自动** | 见下方说明 |
| — | 开发者赛事参与 / 晋级 | +100 / +200 | 每周 | ❌ **不自动** | 晋级依赖真实排名 |

### 为什么有些任务不能全自动

**BBS 回答问题（+60）—— 半自动**

任务原文是「每日回答问题**且被采纳**」，这是**合取条件**。回答可以自动提交，但「采纳」按钮只有**楼主**能看到，回答者页面上没有这个入口，因此这 60 分无法由脚本独立达成。

脚本的策略是：优先挑选 **0 回复且未解决** 的真实提问，生成针对性回答，把被采纳概率做到最高，状态如实记为「已尝试」。

**每周体验 AI 开发者空间（+30）—— 半自动**

能打开入口页并点击「立即体验」，但要注意两点：
1. `devstation.developer.huaweicloud.com` 是**独立 SSO**，`storageState` 不覆盖，可能被拦到登录页；
2. 继续操作会**真实创建 6 小时沙箱实例**（消耗配额），且实测走完一轮后任务状态仍可能为未完成（计分依赖服务端异步统计使用行为）。

因此脚本只把页面开到待操作处，**不擅自创建沙箱**。

**每周实践实验（+50）—— 不做自动化**

页面有硬指标「已完成 N%」，由实验手册章节**逐节勾选**推进，必须使用实验下发的 IAM 账号在控制台（需隐身窗口）真实操作。实测**只点「开始实验」进度仍是 0%**，不计分。

且频繁开启/退出实验（<1 分钟）极易被判为刷量，还会消耗「今日免费名额」。风险大于收益，故不做。

**每周微认证（+100）—— 不做自动化**

必须答题通过理论考试，且**只有 1 次考试机会**（浪费需重新激活）；前置还需完成 90 分钟配套实验；证书**次日**才发放，积分次日才到账。自动化会白白消耗考试机会，故不做。

### 会话与登录态

脚本使用 `storage/` 下的 `storageState` 复用登录态，**不需要每次扫码**。登录守护进程会定期保活，并在失效时通过状态页提示扫码。

保活链路有两个已知坑（已在代码中修复，改动时请注意不要退回去）：
- 华为云各子站（BBS / 学堂 / devstation）是**独立会话**，都依赖 `SSOTGC` 全局票据。保存登录态时必须合并新旧 cookie，**不能丢掉 `SSOTGC`/`SSOJTC`**，否则会出现「成长中心能查积分、BBS 却 not login」。
- 保活探针必须**同时检查子站**。只探成长中心会在 BBS 掉线时误报「登录有效」，导致任务静默失败。

---

## 🤖 自动执行任务（auto_run）

| task_id | 任务 | 积分 | 周期 | 模式 |
|---------|------|------|------|------|
| T_GROW_CHECKIN | 每日签到：在成长中心完成每日签到，获取积分奖励 | +5 | 每日 | 自动 |
| T_CODEARTS_SUBSCRIBE | 首次开通华为云码道：通过一键开通页完成 CodeArts 体验开通（一次性任务） | +50 | 一次性 | 自动 |
| T_CODEARTS_QA | 使用智能问答：启动码道 CLI TUI，提问 Python 日期格式化代码以完成智能问答任务 | +30 | 每日 | 自动 |
| T_DEVSPACE_TOUR | 体验开发者空间：登录开发者空间并浏览导航页面（每周一次） | +20 | 每周 | 自动 |
| T_DEVSPACE_CREATE_ENV | 创建云开发环境：在开发者空间中创建云开发环境；已有则跳过（一次性） | +50 | 一次性 | 自动 |

---

华为云开发者成长中心（[developer.huaweicloud.com/grow](https://developer.huaweicloud.com/grow)）的 **Agent 友好化** 开放仓库。

**Agent 主入口**：[https://github.com/Indigo1024/hwcloud-grow](https://github.com/Indigo1024/hwcloud-grow) — 克隆后阅读 `skill/SKILL.md`，在 `runner/` 执行即可，**无需每次下载 zip**。

## 仓库结构

| 路径 | 说明 |
|------|------|
| [skill/SKILL.md](skill/SKILL.md) | Agent 执行契约（主文档） |
| [manifest.json](manifest.json) | 任务清单（构建自 `portal/src/data/tasks.json`） |
| [.well-known/grow-agents.json](.well-known/grow-agents.json) | Agent 发现协议 |
| [runner/](runner/) | Playwright + 码道 CLI 执行器 |
| [portal/](portal/) | 静态介绍页构建与部署脚本 |
| [docs/](docs/) | PRD、Manifest 规范 |

## 架构

```
Agent 克隆 Indigo1024/hwcloud-grow
    → 阅读 skill/SKILL.md
    → cd runner && npm run agent
    → 读取 ../manifest.json（本地，无需访问门户）

门户网站（可选）
    → <你的门户主机>/grow-portal/  仅静态 HTML 介绍页
```

## 维护任务数据

编辑 `portal/src/data/tasks.json`，然后：

```bash
cd portal && npm run build   # 重新生成 manifest.json、skill、静态页
```

## 安装 Skill（Cursor 等）

```bash
npx skills add Indigo1024/hwcloud-grow
```

## 相关链接

- 成长中心官网：https://developer.huaweicloud.com/grow
- 开放仓库：<YOUR_REPO_URL>

## 许可证

MIT
