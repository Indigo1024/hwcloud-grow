# 成长中心 Agent 视图 PRD

| 属性 | 值 |
|------|-----|
| 版本 | v1.0 |
| 状态 | 草案 |
| 目标页面 | https://developer.huaweicloud.com/grow |
| 前端应用 | HDGrowthPortal（Vue SPA） |
| 约束 | **后端 API 不改动**，仅改前端展示与页面内嵌数据 |
| 关联规范 | [task-manifest-spec.md](./task-manifest-spec.md)、[grow-agents.json](../spec/grow-agents.json) |

---

## 1. 背景与问题

### 1.1 后端业务模型（已存在，不改）

```
运营配置任务(Task) → 含 1~N 个行为(Behavior, behavior_id)
    ↓
用户在产品侧完成动作 → 产品上报 { user_id, behavior_id }
    ↓
成长中心定时任务扫描 → 任务下全部行为完成 → 发放积分
```

任务分两类：

- **一次性**：实名认证、首次开通 CodeArts 等
- **循环型**：码道智能问答，每日可重复积分一次

### 1.2 当前前端设计

成长中心页面（人类视图）包含：

| 模块 | 现状 |
|------|------|
| 积分资产区 | 我的积分、连续签到、积分明细、兑换记录 |
| 引导区 | STEP1~3 三步说明 |
| 任务中心 | 任务卡片：标题、描述、积分、难度、「去完成」「任务指南」 |
| 积分兑换 | 代金券商品列表 |

用户路径：**成长中心 → 点击去完成 → 跳转产品页 → 完成行为 → 回成长中心看积分**。

### 1.3 核心问题

后端有 `task_id`、`behavior_id`、行为进度、周期类型，但前端只展示自然语言，导致：

1. Agent 无法稳定识别任务与行为（只能靠 OCR/按钮文案）
2. 多行为任务无法展示子进度
3. 行为上报与积分到账存在异步延迟，用户/Agent 无法感知中间态
4. 跨产品跳转无上下文参数，Agent 难以串联多页面
5. 无官方 Agent 发现入口与标准 Prompt

---

## 2. 产品目标

### 2.1 总目标

在**保留现有人类视图**的前提下，新增 **Agent 视图**，使成长中心成为「人看 + Agent 读」的任务编排台。

### 2.2 成功指标

| 指标 | 目标 |
|------|------|
| Agent 可读性 | 页面加载后 1 次读取即可获得完整任务清单（Manifest） |
| 任务识别准确率 | Agent 通过 `task_id`/`behavior_id` 定位任务，不依赖按钮文案 |
| 用户驱动 Agent | 提供「复制给 Agent」按钮，用户粘贴即可触发本地 Agent |
| 后端改动 | 0 |
| 人类体验回归 | 经典视图功能与布局无破坏性变更 |

### 2.3 非目标（本期不做）

- 新增后端 API 或修改积分发放逻辑
- Agent 代登录、OAuth 新协议
- 全自动刷分/绕过风控
- 产品侧（码道、开发者空间等）页面改造（仅定深链规范，协调后续）

---

## 3. 用户故事

| 角色 | 故事 | 验收 |
|------|------|------|
| 开发者 | 我想让 Cursor Agent 帮我把今天能做的成长任务做完 | 一键复制 Prompt，Agent 能解析并执行 |
| 开发者 | 我想知道码道问答任务做到哪一步了 | Agent 视图展示行为级进度 |
| 运营 | 新任务上线后 Agent 能自动发现 | Manifest 随任务列表 API 自动更新 |
| 前端研发 | 不改后端也能实现 | 仅复用现有任务/进度/积分 API |

---

## 4. 方案概述

### 4.1 双视图架构

```
成长中心页面
├── 经典视图（默认，现有 UI 保留）
└── Agent 视图（新增 Tab）
    ├── 今日可做任务列表
    ├── 行为级进度
    ├── 结算状态时间线
    ├── 复制 Prompt / 导出 JSON
    └── Agent 接入指引
```

顶部增加视图切换：**经典 | Agent 助手**。

### 4.2 数据透出层（两通道）

| 通道 | 用途 | 实现 |
|------|------|------|
| `window.__GROW_AGENT_MANIFEST__` | Agent 一次性批量读取 | 任务列表 API 响应映射后注入 |
| DOM `data-*` 属性 | 浏览器自动化定位元素 | 任务卡片/行为行渲染时写入 |

详细字段见 [task-manifest-spec.md](./task-manifest-spec.md)。

### 4.3 深链规范

「去完成」跳转 URL 追加 query（前端拼接，产品侧可选读取）：

```
?grow_task={task_id}&grow_behavior={behavior_id}&grow_source=developer-grow
```

示例：

```
https://codearts.example.com/chat?grow_task=T_CODEARTS_QA&grow_behavior=BEH_CODEARTS_SEND_MSG&grow_source=developer-grow
```

---

## 5. 功能需求

### 5.1 P0 — 结构化数据透出

#### F-001 DOM 语义化属性

每个任务卡片根元素必须包含：

```html
<article
  class="grow-task-card"
  data-task-id="T_CODEARTS_QA"
  data-task-type="recurring"
  data-recurrence="daily"
  data-points="30"
  data-status="available"
  data-risk-level="low"
>
```

每个行为行（多行为任务）：

```html
<div
  class="grow-behavior-row"
  data-behavior-id="BEH_CODEARTS_SEND_MSG"
  data-behavior-status="pending"
/>
```

`data-status` 枚举：`available` | `in_progress` | `completed` | `pending_settlement` | `exhausted`（今日已完成）

`data-behavior-status` 枚举：`pending` | `reported` | `completed`

#### F-002 页面 Manifest 注入

任务列表加载完成后，向 `window` 注入：

```javascript
window.__GROW_AGENT_MANIFEST__ = { /* 见 task-manifest-spec.md */ };
```

- 登录态：含用户积分、任务列表、行为进度
- 未登录：仅公开任务元数据（无个人进度），`user.authenticated: false`

#### F-003 Meta 标签

```html
<meta name="grow-agent-manifest" content="window.__GROW_AGENT_MANIFEST__" />
<link rel="alternate" type="application/json" href="/.well-known/grow-agents.json" />
```

### 5.2 P0 — 「复制给 Agent」

每个任务卡片提供按钮 **「复制给 Agent」**，生成标准 Prompt：

```text
请帮我完成华为云开发者成长中心任务：

- 成长中心: https://developer.huaweicloud.com/grow
- task_id: T_CODEARTS_QA
- 任务名称: 使用智能问答
- 积分: +30（每日一次）
- 风险等级: low

待完成行为:
1. [BEH_CODEARTS_SEND_MSG] 在码道对话框发送一次对话
   入口: https://...?grow_task=T_CODEARTS_QA&grow_behavior=BEH_CODEARTS_SEND_MSG&grow_source=developer-grow

完成后请回到成长中心刷新状态，确认积分到账。
注意：不要重复刷分；遇到付费/实名/审核类操作请暂停并询问我。
```

点击后 Toast 提示「已复制到剪贴板」。

### 5.3 P1 — Agent 视图

#### F-010 视图切换

- 位置：任务中心标题旁
- 默认：经典视图
- 切换后记住用户偏好（localStorage `grow_view_mode`）

#### F-011 Agent 任务列表

每张卡片展示：

| 字段 | 说明 |
|------|------|
| task_id | 可复制 |
| 标题 + 积分 + 周期标签 | 如「每日」「一次性」 |
| 行为清单 | 每项含 behavior_id、描述、状态图标 |
| 风险标签 | `免费` `需登录` `可能付费` `需人工审核` |
| 预计耗时 | 运营配置或默认估算（如 5 分钟） |
| 操作 | 复制 Prompt、打开入口、刷新状态 |

#### F-012 排序与筛选

- 默认排序：可做 > 进行中 > 已完成；同优先级按积分降序
- 筛选：今日可做 / 一次性 / 循环 / 低风险

#### F-013 结算状态时间线

展示异步扫描过程（数据来自现有进度 API）：

```
14:32  BEH_CODEARTS_SEND_MSG 行为已上报
14:33  等待积分结算（通常 10 分钟内）
14:35  任务完成，+30 积分
```

无新 API：前端对已有行为状态 + 任务状态做时间线聚合展示。

#### F-014 自动刷新

Agent 视图下，每 30 秒轮询任务状态（可关闭）；行为上报后自动开启轮询，任务完成或超时 10 分钟后停止。

### 5.4 P1 — 跳转深链

#### F-020 去完成链接

所有「去完成」按钮的 `href` 或 `window.open` URL 必须追加：

```
grow_task={task_id}&grow_behavior={behavior_id}&grow_source=developer-grow
```

多行为任务：跳转到**第一个未完成行为**的入口 URL。

#### F-021 任务指南结构化

任务指南弹窗增加 **「Agent 步骤」** Tab（与人类指南并列）：

- 数据来源：现有指南富文本按 Markdown 模板解析（见 5.5）
- 展示为有序步骤列表，每步含 `action` 类型

### 5.5 P2 — 任务指南 Markdown 约定

运营在任务指南中按以下模板编写，前端自动解析为 `agent_steps`：

```markdown
## Agent 步骤

### Step 1: open_url
打开码道对话页：{entry_url}

### Step 2: send_message
在对话框发送一条技术问题

### Step 3: wait_settlement
等待成长中心积分结算，最长 10 分钟
```

解析规则见 [task-manifest-spec.md#指南解析](./task-manifest-spec.md#6-任务指南解析约定)。

### 5.6 P2 — Agent 接入区块

页面底部新增 **「Agent 接入」** 模块：

| 内容 | 说明 |
|------|------|
| 安装 Skill | `npx skills add developer-ecosystem/hwcloud-grow` |
| 发现协议 | 链接 `/.well-known/grow-agents.json` |
| Manifest 说明 | 链接本仓库规范文档 |
| 安全边界 | 不代登录、不刷分、付费操作需用户确认 |

### 5.7 P3 — 静态发现文件部署

将 [spec/grow-agents.json](../spec/grow-agents.json) 部署至：

```
https://developer.huaweicloud.com/.well-known/grow-agents.json
```

---

## 6. 交互原型（文字版）

### 6.1 经典视图（无变化）

保持现有：积分区 + 三步引导 + 任务卡片 + 积分兑换。

### 6.2 Agent 视图

```
┌─────────────────────────────────────────────────────────┐
│  我的积分: 120    今日签到: ✅ +5                        │
│  [经典视图] [Agent 助手 ●]              [刷新] [导出JSON] │
├─────────────────────────────────────────────────────────┤
│  今日可做 (3)                                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │ T_CODEARTS_QA · 使用智能问答 · +30 · 每日        │  │
│  │ 风险: 免费 · 预计 3 分钟                           │  │
│  │ ○ BEH_CODEARTS_SEND_MSG 在码道发送一次对话 [待完成]  │  │
│  │ [复制给 Agent]  [打开入口]                         │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ T_DEVSPACE_TOUR · 体验开发者空间 · +20 · 一次性     │  │
│  │ ✅ 已完成 · 2026-07-01                             │  │
│  └───────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────┤
│  Agent 接入                                              │
│  安装 Skill · 查看协议 · 安全说明                        │
└─────────────────────────────────────────────────────────┘
```

---

## 7. 技术实现要点

### 7.1 数据来源（现有 API，不新增）

| 数据 | 来源 |
|------|------|
| 任务列表 | 现有任务中心 API |
| 行为进度 | 现有用户任务/行为状态 API |
| 积分 | 现有积分 API |
| 签到 | 现有签到 API |
| 任务指南 | 现有指南 API / 富文本字段 |

### 7.2 Manifest 构建时机

```javascript
// 伪代码
async function buildManifest() {
  const [tasks, points, checkin] = await Promise.all([
    fetchTaskList(),
    fetchUserPoints(),
    fetchCheckinStatus(),
  ]);
  window.__GROW_AGENT_MANIFEST__ = mapToManifest(tasks, points, checkin);
  dispatchEvent(new CustomEvent('grow:manifest-ready'));
}
```

任务列表刷新、签到、兑换后重新构建。

### 7.3 风险等级映射（前端配置表）

| 条件 | risk_level |
|------|------------|
| 纯浏览/问答/签到 | `low` |
| 需创建云资源（免费额度内） | `medium` |
| 付费订阅/实名/赛事/审核采纳 | `high` |

映射表放前端配置文件，运营可为 `task_id` 覆盖。

### 7.4 兼容性

- 经典视图 DOM 结构不变，仅追加 `data-*`
- 未登录用户可切换 Agent 视图，但隐藏个人进度
- 移动端 Agent 视图响应式布局

---

## 8. 安全与合规

1. **不鼓励刷分**：循环任务显示「今日已完成」，Agent Prompt 含防重复说明
2. **高风险任务**：`risk_level: high` 默认不纳入「一键复制」的批量 Prompt
3. **审核类任务**：状态标为 `human_required`，Agent 视图显示「需人工参与」
4. **登录态**：Agent 使用用户已有浏览器会话，页面不传输密码
5. **Manifest 不暴露**：其他用户 PII、内部运营配置 ID（除 task_id/behavior_id）

---

## 9. 排期建议

| 阶段 | 内容 | 工期估算 |
|------|------|----------|
| P0 | F-001~F-003 + F-020 + 复制 Prompt | 1~2 周 |
| P1 | Agent 视图 F-010~F-014 | 2~3 周 |
| P2 | 指南解析 F-021 + Agent 接入区块 F-026 | 1~2 周 |
| P3 | well-known 部署 + 联调 Skill | 1 周 |

---

## 10. 验收标准

- [ ] 登录用户打开 `/grow`，控制台可读到完整 `__GROW_AGENT_MANIFEST__`
- [ ] 每个任务卡片有 `data-task-id`，每个行为有 `data-behavior-id`
- [ ] 「复制给 Agent」生成含 task_id、behavior_id、入口 URL 的 Prompt
- [ ] 「去完成」链接含 `grow_task` / `grow_behavior` 参数
- [ ] Agent 视图展示行为级进度与结算时间线
- [ ] `/.well-known/grow-agents.json` 可访问
- [ ] 经典视图功能无回归
- [ ] 使用 [skill/SKILL.md](../skill/SKILL.md) 的 Agent 可仅凭 Manifest 完成低风险任务

---

## 11. 附录

### A. 参考任务示例（来自线上页面）

| 任务 | 积分 | 周期 | 建议 risk_level |
|------|------|------|-----------------|
| 使用智能问答 | +30 | 每日 | low |
| 体验开发者空间 | +20 | 一次性 | low |
| 创建云开发环境 | +50 | 一次性 | medium |
| 首次开通 CodeArts | +50 | 一次性 | high |
| 回答问题且被采纳 | +60 | 每日 | high |
| 参与开发者赛事 | +100 | 每次 | high |

### B. 相关仓库

- 本规范仓库：https://gitcode.com/developer-ecosystem/hwcloud-grow
- 成长中心前端：HDGrowthPortal（内部）
