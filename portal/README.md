# 成长中心 Agent 介绍页

静态 HTML 介绍页，指向开放仓库 [Indigo1024/hwcloud-grow](https://github.com/Indigo1024/hwcloud-grow.git)。

**Agent 无需访问本网站** — Skill、Manifest、执行器均在 GitCode 仓库。

## 构建与部署

```bash
cd portal
npm install
npm run build    # 生成 dist/index.html + 同步 manifest/skill 到仓库根目录
npm run deploy   # 需 DEPLOY_PASSWORD
```

## Agent 入口（GitCode）

| 资源 | 路径 |
|------|------|
| 仓库 | https://github.com/Indigo1024/hwcloud-grow.git |
| Skill | `skill/SKILL.md` |
| Manifest | `manifest.json` |
| 执行器 | `runner/` |

## 本地预览

```bash
npm run preview   # http://localhost:4173
```

## 维护任务

编辑 `src/data/tasks.json` 后 `npm run build`，提交仓库根目录的 `manifest.json` 与 `skill/SKILL.md`。
