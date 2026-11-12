# Task Manifest 字段规范

| 属性 | 值 |
|------|-----|
| 版本 | 1.0.0 |
| 状态 | 草案 |
| 消费方 | 浏览器 Agent、Cursor/Codex Skill、自动化脚本 |
| 产出方 | 成长中心前端（HDGrowthPortal） |
| 约束 | 由现有 API 映射生成，不新增后端字段 |

---

## 1. 概述

Task Manifest 是成长中心页面暴露给 Agent 的**只读任务契约**，通过两种方式提供：

1. **全局对象**：`window.__GROW_AGENT_MANIFEST__`
2. **DOM 属性**：任务卡片/行为行的 `data-*`（见第 5 节）

Agent 应优先读取 Manifest；DOM 属性用于浏览器自动化精确定位。

---

## 2. 顶层结构

```jsonc
{
  "spec_version": "1.0.0",
  "generated_at": "2026-07-02T10:30:00+08:00",
  "portal": {
    "name": "华为云开发者成长中心",
    "url": "https://developer.huaweicloud.com/grow",
    "well_known": "https://developer.huaweicloud.com/.well-known/grow-agents.json"
  },
  "user": { /* §3 */ },
  "checkin": { /* §4 */ },
  "tasks": [ /* §5 */ ],
  "rewards": [ /* §6 */ ],
  "agent_hints": { /* §7 */ }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `spec_version` | string | 是 | 规范版本，当前 `1.0.0` |
| `generated_at` | string (ISO 8601) | 是 | Manifest 生成时间 |
| `portal` | object | 是 | 门户元信息 |
| `user` | object | 是 | 用户状态（未登录时 `authenticated: false`） |
| `checkin` | object | 否 | 签到状态 |
| `tasks` | array | 是 | 任务列表 |
| `rewards` | array | 否 | 积分兑换商品（可选） |
| `agent_hints` | object | 否 | Agent 全局提示 |

---

## 3. user 对象

```jsonc
{
  "authenticated": true,
  "points": 120,
  "points_detail_url": "/grow/points/detail",
  "redeem_history_url": "/grow/points/redeem"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `authenticated` | boolean | 是 | 是否已登录 |
| `points` | number | 否 | 当前积分（登录后） |
| `points_detail_url` | string | 否 | 积分明细页 |
| `redeem_history_url` | string | 否 | 兑换记录页 |

---

## 4. checkin 对象

```jsonc
{
  "enabled": true,
  "streak_days": 3,
  "today_checked_in": false,
  "daily_reward_points": 5,
  "weekly_rewards": [5, 5, 5, 5, 5, 5, 35]
}
```

---

## 5. tasks 数组

### 5.1 Task 对象

```jsonc
{
  "task_id": "T_CODEARTS_QA",
  "title": "使用智能问答",
  "description": "在华为云码道（CodeArts）代码智能体中使用智能问答功能",
  "points": 30,
  "difficulty": 1,
  "type": "recurring",
  "recurrence": "daily",
  "status": "available",
  "risk_level": "low",
  "human_required": false,
  "estimated_minutes": 3,
  "completed_at": null,
  "next_available_at": null,
  "behaviors": [ /* Behavior 对象 */ ],
  "entry_url": "https://...",
  "guide_url": null,
  "agent_prompt": "请帮我在码道发送一次智能问答...",
  "agent_steps": [ /* AgentStep 对象 */ ],
  "tags": ["codearts", "daily"]
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `task_id` | string | 是 | 任务唯一 ID，稳定不变 |
| `title` | string | 是 | 任务标题 |
| `description` | string | 是 | 任务描述 |
| `points` | number | 是 | 完成奖励积分 |
| `difficulty` | number | 否 | 难度 1~5 |
| `type` | enum | 是 | `one_time` \| `recurring` |
| `recurrence` | enum | 否 | `once` \| `daily` \| `weekly` \| `per_event` |
| `status` | enum | 是 | 见 §5.3 |
| `risk_level` | enum | 是 | `low` \| `medium` \| `high` |
| `human_required` | boolean | 否 | 是否必须人工参与（审核/赛事等） |
| `estimated_minutes` | number | 否 | 预计耗时 |
| `completed_at` | string | 否 | 最近完成时间 ISO 8601 |
| `next_available_at` | string | 否 | 循环任务下次可完成时间 |
| `behaviors` | array | 是 | 行为列表，至少 1 项 |
| `entry_url` | string | 否 | 默认入口（首个未完成行为） |
| `guide_url` | string | 否 | 任务指南锚点 |
| `agent_prompt` | string | 否 | 预生成 Prompt，供一键复制 |
| `agent_steps` | array | 否 | 结构化步骤 |
| `tags` | array | 否 | 分类标签 |

### 5.2 Behavior 对象

```jsonc
{
  "behavior_id": "BEH_CODEARTS_SEND_MSG",
  "description": "在码道对话框发送一次对话",
  "product": "codearts",
  "status": "pending",
  "reported_at": null,
  "completed_at": null,
  "entry_url": "https://codearts.example.com/chat?grow_task=T_CODEARTS_QA&grow_behavior=BEH_CODEARTS_SEND_MSG&grow_source=developer-grow"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `behavior_id` | string | 是 | 行为唯一 ID，与后端上报 ID 一致 |
| `description` | string | 是 | 行为描述 |
| `product` | string | 否 | 所属产品：`codearts` `devspace` `forum` `community` 等 |
| `status` | enum | 是 | 见 §5.4 |
| `reported_at` | string | 否 | 行为上报时间 |
| `completed_at` | string | 否 | 行为确认完成时间 |
| `entry_url` | string | 否 | 带深链参数的入口 URL |

### 5.3 Task status 枚举

| 值 | 含义 | 前端展示 |
|----|------|----------|
| `available` | 可做 | 去完成 |
| `in_progress` | 部分行为已完成 | 继续完成 |
| `pending_settlement` | 行为已齐，等待积分结算 | 结算中 |
| `completed` | 已完成（一次性）或今日已完成（循环） | 已完成 |
| `exhausted` | 循环任务本期次数已用完 | 明日再来 |
| `locked` | 前置条件未满足 | 未解锁 |
| `under_review` | 待审核 | 审核中 |

### 5.4 Behavior status 枚举

| 值 | 含义 |
|----|------|
| `pending` | 未完成 |
| `reported` | 已上报，待后台确认 |
| `completed` | 已确认完成 |

### 5.5 DOM data-* 映射

任务卡片根元素：

| 属性 | 对应字段 |
|------|----------|
| `data-task-id` | `task_id` |
| `data-task-type` | `type` |
| `data-recurrence` | `recurrence` |
| `data-points` | `points` |
| `data-status` | `status` |
| `data-risk-level` | `risk_level` |

行为行：

| 属性 | 对应字段 |
|------|----------|
| `data-behavior-id` | `behavior_id` |
| `data-behavior-status` | `status` |

---

## 6. rewards 数组（积分兑换）

```jsonc
{
  "reward_id": "R_VOUCHER_50",
  "title": "50元代金券",
  "points_cost": 500,
  "stock": 11649,
  "status": "available"
}
```

---

## 7. agent_hints 对象

```jsonc
{
  "settlement_delay_minutes": 10,
  "polling_interval_seconds": 30,
  "safety_rules": [
    "不要重复完成今日已做的循环任务",
    "遇到付费、实名、审核类任务请询问用户",
    "使用用户已登录的浏览器会话，不要索要密码"
  ],
  "skill_install": "npx skills add developer-ecosystem/hwcloud-grow"
}
```

---

## 8. AgentStep 对象

```jsonc
{
  "order": 1,
  "action": "open_url",
  "title": "打开码道对话页",
  "params": {
    "url": "https://..."
  }
}
```

### action 类型

| action | 说明 | params |
|--------|------|--------|
| `open_url` | 打开 URL | `url` |
| `send_message` | 在产品内发送消息 | `product`, `hint` |
| `click` | 点击元素 | `selector`, `text` |
| `fill_form` | 填写表单 | `fields` |
| `wait_settlement` | 等待积分结算 | `timeout_minutes` |
| `human_confirm` | 需用户确认 | `reason` |

---

## 9. 任务指南解析约定

运营在任务指南富文本中使用以下 Markdown 结构，前端解析为 `agent_steps`：

```markdown
## Agent 步骤

### Step 1: open_url
打开码道对话页：https://example.com/chat

### Step 2: send_message
在对话框发送一条技术问题

### Step 3: wait_settlement
等待成长中心积分结算，最长 10 分钟
```

### 解析规则

1. 以 `## Agent 步骤` 为段首；之前内容为人类指南
2. 每个 `### Step N: {action}` 解析为一个 `AgentStep`
3. 步骤正文第一行若为 URL，填入 `params.url`
4. 解析失败时 `agent_steps` 为空数组，不影响人类指南展示

---

## 10. 深链 Query 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `grow_task` | 是 | task_id |
| `grow_behavior` | 是 | behavior_id |
| `grow_source` | 是 | 固定值 `developer-grow` |

---

## 11. 事件

Manifest 更新后派发：

```javascript
window.dispatchEvent(new CustomEvent('grow:manifest-ready', {
  detail: window.__GROW_AGENT_MANIFEST__
}));
```

Agent 可监听此事件做轮询替代。

---

## 12. 完整示例

见 [examples/manifest.example.json](../examples/manifest.example.json)。

---

## 13. 版本演进

| 版本 | 变更 |
|------|------|
| 1.0.0 | 初始版本：tasks、behaviors、agent_hints、深链 |

向后兼容：新增字段均为可选；`spec_version` 主版本变更时 Agent 应检查兼容性。
