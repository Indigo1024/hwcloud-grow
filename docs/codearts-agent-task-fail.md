# CodeArts Agent 任务执行失败记录

> 记录日期：2026-07-03

## 概述

使用 `hwcloud-grow-runner` 执行器（Playwright + CodeArts CLI）在 headless 模式下串行运行成长中心自动任务时，部分任务执行失败或结果待确认。本文档记录失败原因及排查建议。

## 任务执行结果

| task_id | 标题 | 积分 | 状态 | 详情 |
|---------|------|------|------|------|
| T_GROW_CHECKIN | 每日签到 | +5 | 待确认 | 未找到签到按钮（可能今日已完成签到） |
| T_CODEARTS_SUBSCRIBE | 首次开通码道 | +50 | 已尝试 | 页面显示"您已开通"，点击了"立即体验" |
| T_CODEARTS_QA | 使用智能问答 | +30 | **失败** | 码道 CLI OAuth 授权页超时，未找到"确认授权"按钮 |
| T_DEVSPACE_TOUR | 体验开发者空间 | +20 | 已尝试 | 已访问开发者空间页面 |

## 失败详情

### T_CODEARTS_QA — 使用智能问答

**错误类型**：`TimeoutError`

**错误信息**：

```
locator.waitFor: Timeout 30000ms exceeded.
- waiting for getByRole('button', { name: '确认授权' }) to be visible
```

**执行流程**：

1. 码道 CLI（v1.0.0）已安装并启动
2. CLI 生成 OAuth 授权链接：`https://codearts.huaweicloud.com/portal/authorize?client_id=CodeArts_Tui&...`
3. Playwright 在 headless 模式下打开授权页
4. 尝试点击「确认授权」按钮，但 30 秒内未找到该按钮

**根因分析**：

- **Headless 模式限制**：OAuth 授权页面可能需要用户交互（如登录态确认），headless 浏览器无法完成此类需要人工确认的流程
- **授权页渲染差异**：headless 模式下页面渲染可能与有界面模式不同，导致按钮选择器无法匹配
- **登录态传递问题**：虽然浏览器 context 已加载 `huaweicloud-auth.json` 的 Cookie，但 OAuth 授权页可能需要额外的登录态或交互

### T_GROW_CHECKIN — 每日签到

**现象**：`签到操作=未找到按钮`

**可能原因**：

- 当日已完成签到，按钮文案已变为"已签到"或按钮已隐藏
- 页面 DOM 结构变更，现有选择器 `["签到", "立即签到", "去签到"]` 未覆盖实际按钮文案

## 排查建议

### 针对 T_CODEARTS_QA

1. **使用有界面模式执行**：`npm run agent`（非 headless），手动在弹出的授权页点击「确认授权」
2. **增加授权超时时间**：修改 `codearts-cli.mjs` 中 `waitFor` 的超时参数（默认 30s → 60s+）
3. **预授权方案**：先在有界面模式下完成一次 OAuth 授权，后续 CLI 可复用 token
4. **检查授权页 DOM**：在有界面模式下打开授权页，检查「确认授权」按钮的实际 role/name 属性

### 针对 T_GROW_CHECKIN

1. **扩展按钮匹配词**：在 `agent-run.mjs` 的 `tryCheckin` 函数中增加 `"已签到"` 等文案匹配
2. **增加签到状态检测**：先判断是否已签到，若已签到则直接标记为"已完成"
3. **截图辅助排查**：在签到页执行 `page.screenshot()` 保存截图，分析实际页面状态

## 环境信息

| 项目 | 值 |
|------|-----|
| 操作系统 | Windows (win32) |
| Node.js | v22.x |
| Playwright | ^1.51.0 |
| 浏览器 | Chrome (channel: chrome, 系统安装) |
| 执行模式 | headless |
| 码道 CLI | 1.0.0 |
| 执行器版本 | hwcloud-grow-runner 1.0.0 |

## 相关文件

- 执行器入口：`scripts/agent-run.mjs`
- 登录脚本：`scripts/hwcloud-login.mjs`
- 码道 CLI 集成：`scripts/codearts-cli.mjs`
- 认证工具：`scripts/auth-utils.mjs`
- 任务清单：`manifest.json`