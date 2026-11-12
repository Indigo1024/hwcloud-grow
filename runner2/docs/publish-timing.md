# 展览馆发布 · 耗时实测数据

> 采集日期：2026-10-17　采集方式：`codearts run --auto` 全自动跑通一次完整发布
> 结果：作品「我的待办清单」发布成功，作品 ID `00633e2aa2c00000`，**+200 积分已即时到账**

## 总耗时

| 项目 | 数值 |
|---|---|
| **端到端总耗时** | **13 分 38 秒**（01:48:32 → 02:02:10） |
| 建议网站展示值 | 「约 14 分钟」 |
| 最快理论下限 | 约 10 分钟（跳过 preflight 可省 2~3 分钟） |

## 分阶段耗时（按产物写入时间反推）

| 阶段 | 内容 | 起始 | 结束 | 耗时 |
|---|---|---|---|---|
| Step 1 | 解析 Domain ID + 生成 STS 凭证 | 01:48:32 | 01:50:54 | **2m22s** |
| Step 2 | 启动项目服务 + 健康检查（8080 端口） | 01:50:54 | 01:51:54 | **1m00s** |
| Step 3 | git init + 推送到 GitCode | 01:51:54 | 01:54:02 | **2m08s** |
| Step 5 | 生成一句话简介（含 UTF-8 门禁） | 01:54:02 | 01:56:54 | **2m52s** |
| preflight | 环境预检（playwright 等依赖） | 01:54:02 | ~01:59 | **~5m**（与其他阶段并行） |
| Step 4 | 生成封面图（截图 + 后处理） | ~01:59 | 02:00 | **~1m** |
| Step 6 | 生成架构图 + 打包详情 zip | 02:00 | 02:01 | **~1m** |
| Step 7 | 选择投稿活动（闯关活动） | 02:01 | 02:01 | **<10s** |
| Step 8 | 调发布接口 + 领取积分 | 02:01 | 02:02:10 | **~1m** |

> 说明：Step 4/5/6 在模型侧是**并行**发起的，上表按产物落盘时刻归位，
> 实际关键路径 = Step1 → Step2 → Step3 → (preflight ∥ Step5) → Step4 → Step6 → Step7 → Step8。

## 各阶段耗时占比（网站画图可用）

```
Step 1  STS 凭证      ████████░░░░░░░░░░░░  17%
Step 2  启动服务      ███░░░░░░░░░░░░░░░░░   7%
Step 3  Git 推送      ███████░░░░░░░░░░░░░  16%
Step 4  封面图        ███░░░░░░░░░░░░░░░░░   7%
Step 5  简介生成      ██████████░░░░░░░░░░  21%
Step 6  图表 + zip    ███░░░░░░░░░░░░░░░░░   7%
Step 7  选活动        ░░░░░░░░░░░░░░░░░░░░  <1%
Step 8  发布 + 领分   ███░░░░░░░░░░░░░░░░░   7%
preflight 预检（并行）████████████░░░░░░░░  18%（与其他阶段重叠）
```

## 对网站设计有用的结论

1. **进度条按 14 分钟设计**，8 个步骤，前 3 步（凭证/启动/Git）已占 40%，要给足时间提示。
2. **preflight 是隐藏耗时**（约 5 分钟，装 playwright 依赖），但它与 Step 5 并行，用户感知不到；
   若机器上已装好依赖则会快很多——**首次运行慢、后续运行快**，网站可提示「首次约 14 分钟，后续约 8~10 分钟」。
3. **Step 7/8 极快**（<1 分钟），别做成漫长的"上传中"动画，会显得假。
4. **积分到账是即时的**（本次实测 1 分钟内 770→970），不需要写"1~3 小时延迟"——
   平台提示语虽这么说，但实际秒到。

## 复现命令

```bash
source /root/.codeartsdoer/.env.aksk
cd /root/.codeartsdoer/agent-workspace
script -qfc "/root/.codeartsdoer/installers/bin/codearts run --auto \
  -m huaweicloud-maas/GLM-5.2 '<发布口令>'" /dev/null
```

> 关键：`run` 子命令**必须有伪 tty**（`script -qfc`），否则不跑事件循环、零输出。
> 认证走永久 AK/SK（`CODEARTS_CLI_AK/SK`），不需要 OAuth 扫码。

## 自动化落地

| 组件 | 路径 | 说明 |
|---|---|---|
| 发布主脚本 | `runner/scripts/gallery-daily.sh` | 查重 → 发布 → 核验积分 → 更新看板 → 清理残留 |
| 积分核验 | `runner/scripts/gallery-bonus-check.mjs` | 退出码 0=已到账 / 1=未到账 / 2=查询失败 |
| 接入点 | `runner/scripts/daily-run.sh` 步骤 4.5 | 跟在 `npm run agent` 之后、`npm run report` 之前 |
| 定时 | crontab `30 9 * * *` | 复用既有 `daily-run.sh` 定时，不新增 timer |
| 日志 | `runner/logs/gallery-YYYYMMDD.log` | 保留 30 天 |

**幂等保护**：每日只给一次分，脚本启动时先查当日是否已到账，已到账则 10 秒内跳过，
不会白跑 14 分钟，也不会重复发布作品。

## 排查备忘（踩过的坑）

1. **零输出空转** → `codearts run` 必须有伪 tty，用 `script -qfc` 包裹。
2. **`serve` 没有对话端点** → 该版本 `serve` 只暴露管理类 API（skills/permission/config），
   没有 session/prompt 接口，不能靠 HTTP 发对话，只能用 `run`。
3. **AK/SK vs STS** → `run/serve` 必须用永久 AK/SK；STS 临时凭证权限域只覆盖 snap-access，
   `getUserInfo` 会 400。STS 只在 skill 的 Step 1/8 调展览馆接口时用。
4. **`bonusFlow` 首次 403** → 先调用一次 `bonusBeans()` 完成 csrf 轮换再重试。
5. **日期格式** → 积分明细是 `YYYY-MM-DD`，`shanghaiDate()` 返回 `YYYY/MM/DD`，比对前须统一。
6. **`systemd-run --collect`** → 失败时会把单元和日志一起删掉，排查时不要加。
