# 成长中心扩展任务调研（作品展览馆 / 每日发文）

> 调研日期：2026-10-16
> 数据来源：成长中心任务中心实测 + 官方提交指南页

## 一、成长中心任务全景（实测）

`https://developer.huaweicloud.com/grow` 任务中心「展开全部任务」后共 **14 个任务**，
当前 manifest.json 仅覆盖 5 个（签到/开通/问答/空间浏览/创建环境）。其余 9 个任务：

| 任务 | 积分 | 周期 | 可自动化程度 |
|------|------|------|--------------|
| 在开发者作品展览馆中发布作品 | +200 | 每日一次 | ⭐⭐⭐ 高（有官方 Skill） |
| 每日发布文章 | +60 | 每日 | ⭐⭐ 中（需 bbs 登录态+发文） |
| 每日回答问题且被采纳 | +60 | 每日 | ⭐ 低（需人工采納） |
| 每周通过一项微认证 | +100 | 每周 | ⭐ 低（需学习+考试） |
| 每周实践一个实验 | +50 | 每周 | ⭐⭐ 中（需实验环境） |
| 给AI办公实践中心代码仓提 Issue | +60 | — | ⭐⭐ 中（GitCode API） |
| Star AI办公实践中心代码仓 | +50 | — | ⭐⭐⭐ 高（GitCode API） |
| 每周体验AI 开发者空间 | +30 | 每周 | ⭐⭐ 中（访问页面） |
| 提交建议（云声） | +30 | — | ⭐⭐ 中（表单提交） |

## 二、作品展览馆发布（+200）

### 入口
- 成长中心点「去完成」→ 新标签打开 `https://gallery.developer.huaweicloud.com/gallery/submit-guide`

### 官方三步流程
1. **生成并验收作品**：在 AI 对话中描述需求，让 AI 生成可运行作品
2. **发布作品**：AI 对话中安装 Skill，发出发布口令：
   ```bash
   npx skills add https://gitcode.com/Lingxi-HandsOn/gallery.git --skill huawei-cloud-publish-work-to-gallery -y
   ```
   然后说「请将当前项目发布至开发者作品展览馆。」
3. **发布朋友圈**：作品详情页点「分享作品」→ 微信扫码

### 发布 Skill 关键信息
- 技能仓库：`https://gitcode.com/Lingxi-HandsOn/gallery.git`
- 技能名：`huawei-cloud-publish-work-to-gallery`（v2026.10.15.002）
- 发布必须提供 **Git 仓库地址 + 分支**（支持 GitHub/GitCode/Gitee 公开仓）
- 平台鉴权：通过 `hcloud` CLI 拿到 Domain ID + STS 临时凭证（900s 有效）
- 作品名提取顺序：frontmatter → H1 → manifest → title → 目录名
- 封面生成用 Playwright 截图（首次运行 preflight 需 2~10 分钟装依赖+字体）
- 发布成功返回 workId + workUrl，**Skill 自动申领成长积分**（每日仅一次）
- 官方页面：`https://gallery.developer.huaweicloud.com/gallery/submit-guide`

### 自动化可行性评估
- 适合在**码道 TUI 会话内**执行（码道可调用 Skill）
- 前置依赖：本地 git 仓库 + 推送到远端（GitCode OAuth 由 Skill 内置脚本引导）
- 本项目 `runner` 侧的接入点：可在 `T_CODEARTS_QA` 之后增加 T_GALLERY_PUBLISH 任务，
  走码道 TUI 发送发布口令

## 三、每日发布文章（+60）

### 入口
- 成长中心点「去完成」→ 新标签打开 `https://bbs.huaweicloud.com/blogs?utm_source=grow`
- 发文页：`https://bbs.huaweicloud.com/blogs/article`

### 现状与障碍
- **bbs 与 developer.huaweicloud.com 登录态不共享**：用 runner 现有 storageState 访问 bbs 显示「未登录」
- Cookie 复用方案：`bbs.huaweicloud.com` 域 cookie 需单独获取（`auth.huaweicloud.com` 域统一认证后 bbs 会种自己的会话）
- 可能需要单独的扫码登录流程（复用 `scripts/qr-login.mjs` 思路）

### 自动化可行性评估
- 发文接口有编辑器（富文本/Markdown），curl 直发需逆向接口
- 建议路径：单独写 `scripts/publish-blog.mjs`，复用登录态 + 模拟发文表单
- 或：bbs 站内可能有 API（需抓包确认）

## 四、后续接入建议

1. **短期**（本轮已做）：文档沉淀 + SKILL.md 附录说明
2. **中期**：实现 `T_GALLERY_PUBLISH`（码道 TUI 调 Skill）+ `T_BBS_BLOG`（独立发文脚本）
3. **长期**：扩展 manifest.json 覆盖全部 14 个任务，评估微认证/赛事的可行性

## 五、关键链接汇总

| 用途 | URL |
|------|-----|
| 成长中心 | https://developer.huaweicloud.com/grow |
| 作品展览馆提交指南 | https://gallery.developer.huaweicloud.com/gallery/submit-guide |
| 作品发布 Skill 仓库 | https://gitcode.com/Lingxi-HandsOn/gallery.git |
| 华为云博客 | https://bbs.huaweicloud.com/blogs |
| 博客发文页 | https://bbs.huaweicloud.com/blogs/article |
