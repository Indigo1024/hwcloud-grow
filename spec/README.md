# 部署说明：grow-agents.json

本目录下的 `grow-agents.json` 应部署到成长中心站点：

```
https://developer.huaweicloud.com/.well-known/grow-agents.json
```

## 部署步骤（前端/DevOps）

1. 将 `spec/grow-agents.json` 复制到 HDGrowthPortal 静态资源目录的 `.well-known/` 下
2. 配置 CDN/网关允许 `/.well-known/*` 路径公开访问
3. 设置 `Content-Type: application/json`
4. 版本更新时同步修改 `updated_at` 与 `spec_version`

## 验证

```bash
curl -s https://developer.huaweicloud.com/.well-known/grow-agents.json | jq .spec_version
```

## 与页面 Manifest 的关系

| 文件/对象 | 作用 |
|-----------|------|
| `/.well-known/grow-agents.json` | Agent **发现**协议：skill 地址、DOM 选择器、安全规则 |
| `window.__GROW_AGENT_MANIFEST__` | Agent **执行**数据：当前用户任务列表与进度 |

Agent 先读 well-known 了解如何接入，再在 `/grow` 页面读 Manifest 执行任务。
