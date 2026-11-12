# 维护说明

这份文档讲的是：这东西以后坏了怎么修，平时要不要管。

自动化脚本的本质是替你跟网站的页面和接口打交道。平台改个按钮、接口换个字段，脚本就断了。
所以没有"写完就不用管"的一天。这份文档的重点不是加功能，而是在它出问题时能快速定位。

---

## 它靠什么活着

整个项目只依赖三样东西，出问题一定是其中之一：

**登录态** —— 华为云的 SSO 会话，存成 cookie 文件。掉了所有任务全失败。

**页面和接口结构** —— 华为云、GitCode、鸿蒙站的实际 DOM 和 API。变了的话个别任务失败，其它正常。

**本地环境** —— Node、Playwright 浏览器、Xvfb。缺了会启动就报错，或者点了没反应。

排错顺序就按这个来：登录态、环境、最后才是具体任务。别一上来就翻代码。

---

## 三种典型症状

### 面板显示"登录态失效"

先别改代码。这不是 bug，是华为云把会话作废了。面板点「加账号」扫码就行。

为什么会这样，README 开头讲过了。补充一句：如果你觉得掉得太频繁（一天十几次），
那要看日志里有没有「未取得浏览器互斥锁」。有的话说明有多个进程在抢浏览器，
通常是部署时重复启动了守护进程——`ps aux | grep login-daemon` 看是不是有两个。

### 某个任务一直失败

看日志，在 `runner/logs/` 下按日期存着。

常见的几种：

| 日志里看到 | 意思 | 怎么办 |
|---|---|---|
| `未找到...按钮` 或 `clicked=false` | 页面改版了，选择器失效 | 打开页面看现在的 DOM，改对应脚本 |
| 接口返回 HTML 而不是 JSON | 登录态掉了 | 扫码 |
| `ERR_NETWORK_CHANGED` | 网络抖动（多网卡或代理切换） | 已经内置重试，频繁出现就查网络 |
| `HTTP 403` / `404` | 接口变了或者权限变了 | 对着浏览器的开发者工具改 |

改之前有个原则：先确认"到底到没到账"。很多"任务失败"其实是平台延迟入账，
不是脚本的问题。面板的积分明细是唯一可信的判据。

### 启动就报错，或者点了没反应

跑一次 `node control/doctor.mjs`，它会告诉你是哪一项的问题。

---

## 平时要不要管

推荐只做两件事：

一是每天扫一眼面板的「运行历史」。连续几天"成功"就正常，出现"失败"就点进去看日志。

二是留意积分明细。面板顶部有今日和本周增量，该拿的分没到账就说明有问题。

不用做的：不用定时重启服务（systemd 配了崩溃自愈），不用手动清日志（脚本保留最近 30 天），
不用管 `state/` 目录（运行记录会自己滚删）。

---

## 改代码要注意的

这几条都是踩过坑总结的。

### 两套部署必须同步

`runner/` 和 `runner2/` 的业务逻辑改一边就要同步另一边，不然会出现
"同样的脚本，一个账号成功另一个失败"——这种问题很难查，因为现象像偶发故障。

```bash
bash runner/scripts/code-sync.sh check
bash runner/scripts/code-sync.sh apply
```

### 别写死绝对路径

项目里已经有现成的解析方式：Node 脚本用 `auth-utils.mjs` 的 `dataDir()` 和 `paths.mjs` 的 `ROOT`，
Shell 用 `BASH_SOURCE` 推导（各脚本头部有写法）。写死了换台机器就读不到数据。

### 判断"今天"要用上海时区

华为云积分明细接口返回的时间是 UTC，但"今天"得按北京时间算。
用 `grow-api.mjs` 里的 `utcToShanghaiDate` / `isTodayShanghai`，别自己写 `startsWith`——
那样凌晨 0 点到 8 点的记录会被算到前一天。

### 页面操作有两个坑

CDP 的 `mouse.down/up` 点不动 Vue 或 React 组件，得用 `locator.click()`。
元素可能在视口外，要先 `scrollIntoView` 再点。

### 改完要验证真到账

脚本报"已尝试"不代表成功。以积分明细为准。

---

## 加新任务

1. 看 `spec/task-manifest-spec.md` 了解清单格式
2. 在 `manifest.json` 里加一条
3. 在 `runner/scripts/agent-run.mjs` 里挂上处理函数
4. 做成幂等的：先查今天是否已到账，到账了就跳过。所有任务都该这样
5. 面板会自动显示新任务，按钮定义在 `control/tasks.mjs`

---

## 什么时候该动架构

出现下面这些情况，说明当前做法到瓶颈了，再改脚本也没用：

登录态掉得越来越频繁，而且确认不是锁冲突——那要考虑持久化 profile，
`docs/持久化改造备忘录.md` 里有完整方案。

平台开始识别自动化——需要让行为更接近真人，而不是提高频率。提高频率只会更快被限制。

任务数量翻几倍——现在是一个账号一个进程，内存吃得多，得改成任务队列。

---

## 改完之后跑这几步

```bash
node control/doctor.mjs                  # 环境没问题
bash control/deploy-panel.sh             # 改了页面时，部署一下
bash runner/scripts/code-sync.sh check   # 两套代码没漂移
```

然后手动跑一次改动的那个任务，看积分明细到没到账。

---

## 常用命令

```bash
node control/doctor.mjs                  # 环境自检
bash control/bootstrap.sh                # 自检 + 启动
bash runner/scripts/daily-run.sh         # 手动跑每日流程
bash runner/scripts/weekly-run.sh        # 手动跑每周任务
bash runner/scripts/refresh-points.sh    # 只刷新积分
bash runner/scripts/code-sync.sh check   # 检查两套代码漂移

systemctl status hw-points-panel         # 面板服务
systemctl status hwcloud-login-daemon@main   # 登录守护

node runner/scripts/browser-lock.mjs release main   # 清理卡住的浏览器锁（确认没任务在跑）
```
