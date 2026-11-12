# hwcloud-grow

华为云开发者「成长中心」的任务自动化。把每日签到、发文章、体验 DevSpace、鸿蒙案例浏览与 Star、
AI 办公中心的 Star 与提 Issue、作品展览馆发布这些事做成可定时运行的脚本，并配了一个 Web 面板
用来查看积分、手动触发任务、扫码登录。

也支持交给第三方 Agent 执行（读 `skill/SKILL.md` 即可）。

---

## 先说清楚一件事：登录态会掉，掉了要重新扫码

这是使用前最需要知道的一点，否则你会在第二天发现任务全失败，然后以为是脚本坏了。

华为云的登录会话由**服务端**控制有效期。客户端做什么都改变不了这一点：

- 改本地 cookie 的有效期没用。我们实测过，把有效期写到 2027 年，接口照样返回未登录。
- 平台也没承诺过长期会话。官方文档的原话是「信任环境会根据您的实际使用情况及使用时间发生变化」。
- 这是会话管理的通用做法——过期与否只由服务端说了算。

所以别指望部署一次就永久有效。能做到的是「掉得少、掉了能快速恢复」。

**实际频率**：我们两个账号连续跑了 9 天，平均一天掉 0~2 次。如果你一天掉十几次，
那通常不是平台的问题，而是有多个进程在抢同一个浏览器锁——日志里会出现「未取得浏览器互斥锁」，
`MAINTAINING.md` 里有排查方法。

### 服务器上怎么处理扫码

登录守护会自动生成二维码，你需要一个能从手机访问的地址去扫：

```
http://<服务器IP>:<面板端口>/scan.html
```

服务器没有公网 IP 的话，用 cloudflared、frp 之类做内网穿透把面板暴露出来就行。

掉线时你会从三个地方看到：面板顶部显示「等待扫码」、运行历史里连续出现失败、或者积分明细里该拿的分没到账。
扫完之后守护会自己接着跑，不用重启；任务本身是幂等的，已到账的会跳过，补跑不会重复发分。

### 想少扫几次

保持登录守护常驻会好一些（默认就是开着的）。真正能明显改善的是改用持久化浏览器 profile，
思路和改动清单写在 `docs/持久化改造备忘录.md` 里。两件不要做的事：提高保活频率（会被限流，
反而更糟）、延长 cookie 有效期（无效）。

---

## 装和跑

### 环境自检

```bash
git clone https://github.com/Indigo1024/hwcloud-grow.git
cd hwcloud-grow
node control/doctor.mjs
```

它会逐项检查 Node 版本、依赖、浏览器、显示环境、数据目录，缺什么会告诉你怎么装。

### 装依赖

```bash
cd runner
npm install
npx playwright install chromium
npx playwright install-deps chromium     # Debian/Ubuntu 上建议加这一步
```

第二步不能省。`npm install` 只会装 Node 依赖，不会下载浏览器。

### 显示环境

扫码登录需要真实浏览器窗口，所以要有 X server。有桌面环境的机器不用管，
Linux 服务器上装个 Xvfb：

```bash
apt install -y xvfb
Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +extension RENDER -noreset &
export DISPLAY=:99
```

如果只跑不需要扫码的部分（比如纯 API 的 GitCode 任务），可以跳过这步。

### 一键启动

```bash
bash control/bootstrap.sh          # 先自检，通过后拉起面板和登录守护
bash control/bootstrap.sh --check  # 只自检不启动
```

### 手动运行

```bash
bash runner/scripts/daily-run.sh    # 每日流程
bash runner/scripts/weekly-run.sh   # 每周任务
bash runner/scripts/refresh-points.sh   # 只刷新积分数据，不动任务
```

### 定时

```cron
30 0 * * *   /path/to/runner/scripts/daily-run.sh
0 9 * * 1    /path/to/runner/scripts/weekly-run.sh
7,37 * * * * /path/to/runner/scripts/refresh-points.sh
```

cron 默认按 UTC 算时间，注意换算，或者设 `CRON_TZ=Asia/Shanghai`。

---

## 环境要求

| 项 | 要求 |
|---|---|
| Node.js | 18 或更高（用到全局 fetch） |
| 浏览器 | Chromium，`npx playwright install chromium` |
| 系统库 | Linux 上建议 `npx playwright install-deps chromium` |
| 显示环境 | 扫码登录需要 X server；纯 API 任务不需要 |
| Python 3 | 面板服务用，只依赖标准库 |
| 磁盘 | 约 400MB（主要是浏览器） |

系统里如果装了 Chrome，脚本会优先用它，起不来再回退到自带的 Chromium。

---

## 面板能做什么

打开面板（默认 `http://127.0.0.1:4173`）可以看到：

- 积分看板：总分、今日与本周增量、每日增量图
- 任务列表：按每日/每周/每月分组，已完成的会标出来
- 运行控制：手动跑任一任务、查看实时日志与运行历史、按账号切换定时开关
- 扫码登录：登录态失效时在这里出二维码
- GitCode 授权：填访问令牌，自动检测是否已绑定华为云，没绑定就给出授权链接

---

## 任务覆盖

| 周期 | 任务 | 积分 |
|---|---|---|
| 每日 | 签到 | +10 |
| 每日 | 发布文章 | +60 |
| 每日 | 体验 AI DevSpace | +30 |
| 每日 | 浏览鸿蒙案例 | +10 |
| 每日 | Star 鸿蒙案例仓 | +30 |
| 每周 | Star Agent 代码仓 | +50 |
| 每周 | Agent 仓提 Issue | +60 |
| 每月 | 作品展览馆发布 | +200 |

几个说明：

- 发文章必须是真实内容，模板化的短文不计分
- 鸿蒙 Star 走 GitCode API（`POST /repos/{org}/{repo}/star`），不依赖浏览器会话，比点页面可靠
- Agent 仓 Star 这一项有上限：组织里的仓库点完后就没有新动作可做了，
  GitCode 也没有取消 Star 的接口，所以做满之后会如实报告"已全部 Star"而不是反复重试
- 每月作品按 workName 判重，同名会自动改名重发

有些任务是人工的，脚本不会碰：微认证、开发者赛事、建议被采纳等。

---

## 两个账号怎么跑

`runner/` 和 `runner2/` 是两套独立部署，各自有账号配置、登录态、日志和工作目录。

改代码时两边要一致，否则会出现"同一个脚本，一个账号成功另一个失败"这种难查的问题：

```bash
bash runner/scripts/code-sync.sh check   # 检查有没有漂移
bash runner/scripts/code-sync.sh apply   # 把主号那份同步到另一份
```

只有部署参数（路径、账号名、端口）允许不同，这些在脚本的白名单里。

---

## 常见问题

**面板能打开，点任务没反应 / 提示"运行依赖未安装"**
依赖没装齐，回到上面的「装依赖」三步。

**提示"未找到账号 xxx 的已保存登录态"**
还没登录，在面板点「加账号」扫码。

**扫码页打开是空白/占位图**
要么依赖没装，要么没有 X server（扫码要开有头浏览器）。跑 `node control/doctor.mjs` 能定位。

**任务跑起来了但很快失败**
看面板的运行日志，或者 `runner/logs/` 下当天的文件。

**要不要担心被平台封号**
不要用自动化刷不该刷的分。这个项目的定位是把自己本来就该做的日常任务自动化，
平台也明确禁止多账号刷分，风险自负。

---

## 目录结构

```
runner/          主号的完整部署（scripts/ 是任务实现）
runner2/         第二个账号的部署
control/         面板控制层：任务清单、执行器、状态、环境自检
panel/           面板前端页面
panel-server.py  面板服务（静态文件 + 控制接口）
docs/            技术文档
skill/           Agent 技能说明
spec/            任务清单格式规范
```

---

## 维护

`MAINTAINING.md` 是排错和维护手册，讲了三件事：坏了怎么定位、平时怎么养、改代码要注意什么。
建议动手改之前先看一眼。

---

## 致谢

改造自 [deli007/hwcloud-grow](https://gitcode.com/deli007/hwcloud-grow)，感谢原作者打的基础。

## 许可

MIT，见 `LICENSE`。
