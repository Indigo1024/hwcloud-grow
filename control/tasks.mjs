/**
 * 任务目录：面板「手动运行」按钮可触发的任务清单。
 *
 * 设计要点：
 *   1) 每个任务声明自己的入口命令、超时、日志文件与「今日是否已完成」判据，
 *      面板只认这份声明，不在前端硬编码命令，避免两处漂移。
 *   2) 命令统一以 runner / runner2 目录为 cwd 执行，账号通过 HWCLOUD_ACCOUNT
 *      传给脚本——runner2 的脚本固定 acct2，漏传也不会退回主号。
 *   3) 单项任务之间互不依赖，可单独补跑；「完整每日流程」走 daily-run.sh。
 */

/** 两个部署（账号）共用的目录映射 */
import { runnerDirFor } from "./paths.mjs";

/**
 * 部署（账号）注册表。
 *
 * 路径按项目位置推导（见 paths.mjs），不再写死：
 * 早先写死 /root/hwcloud-grow 导致发布包会读写作者机器的路径
 * （2026-11-11 发布自检发现）。
 *
 * 可用 HWCLOUD_DEPLOYMENTS（JSON）覆盖，适配非常规布局。
 */
function discoverDeployments() {
  if (process.env.HWCLOUD_DEPLOYMENTS) {
    try {
      const j = JSON.parse(process.env.HWCLOUD_DEPLOYMENTS);
      const out = {};
      for (const [id, v] of Object.entries(j)) {
        out[id] = {
          id,
          label: v.label || id,
          runnerDir: v.runnerDir,
          logDir: v.logDir || `${v.runnerDir}/logs`,
          env: { HWCLOUD_ACCOUNT: id, ...(v.env || {}) },
        };
      }
      if (Object.keys(out).length) return out;
    } catch { /* 配置坏了就回退自动发现 */ }
  }
  const out = {};
  for (const id of ["main", "acct2"]) {
    const dir = runnerDirFor(id);
    out[id] = {
      id,
      label: id === "main" ? "账号 1" : "账号 2",
      runnerDir: dir,
      logDir: `${dir}/logs`,
      env: { HWCLOUD_ACCOUNT: id },
    };
  }
  return out;
}

export const DEPLOYMENTS = discoverDeployments();

/**
 * 单项任务定义。
 *   key        面板上的标识，同时作为状态文件名
 *   title      显示名
 *   desc       一句话说明
 *   script     入口（bash 或 node），相对 runnerDir
 *   timeoutMs  硬超时
 *   period     daily / weekly / monthly / once
 *   points     预计积分（展示用）
 *   probe      可选：判定「今日已完成」的方式（见 tasks.mjs 的 isDone）
 */
export const TASKS = [
  {
    key: "checkin",
    title: "每日签到",
    desc: "成长中心签到，每日 +10",
    script: ["node", "scripts/agent-run.mjs", "--headless", "--task=T_GROW_CHECKIN"],
    timeoutMs: 300000,
    period: "daily",
    points: 10,
  },
  {
    key: "article",
    title: "发布文章",
    desc: "BBS 发布技术长文，每日 +60",
    script: ["node", "scripts/tasks/bbs-article.mjs"],
    timeoutMs: 600000,
    period: "daily",
    points: 60,
  },
  {
    key: "devspace",
    title: "体验 AI DevSpace",
    desc: "CDP 真鼠标点开 DevSpace 并进入容器，每日 +30",
    script: ["node", "scripts/devspace-py-style.mjs"],
    timeoutMs: 900000,
    period: "daily",
    points: 30,
  },
  {
    key: "harmony-view",
    title: "鸿蒙浏览案例",
    desc: "打开案例详情页浏览 30 秒，每日 +10",
    script: ["node", "harmony-daily.mjs"],
    timeoutMs: 420000,
    period: "daily",
    points: 10,
  },
  {
    key: "harmony-star",
    title: "鸿蒙 Star 仓库",
    desc: "绑定 GitCode 并 Star 案例仓，每日 +30",
    // harmony-daily.mjs 一个脚本同时做「浏览案例 +10」与「Star 仓库 +30」，
    // 两步各自判重，所以这里复用同一入口，只是单独触发时也把浏览一起做掉。
    script: ["node", "harmony-daily.mjs"],
    timeoutMs: 420000,
    period: "daily",
    points: 30,
  },
  {
    key: "agent-star",
    title: "Star Agent 代码仓",
    desc: "每周 Star 一个 Agent 开发实践中心代码仓，每周 +50",
    script: ["node", "scripts/agent-run.mjs", "--headless", "--task=T_AI_OFFICE_STAR"],
    timeoutMs: 300000,
    period: "weekly",
    points: 50,
    // 仅对**尚未点完组织仓库**的账号显示。
    // 主号已把 agent-best-practices 组织 32 个仓库全部 Star 完（未 Star 的为 0），
    // GitCode 又不提供取消 Star 的接口 —— 对该账号这是一次性任务，已完成，
    // 面板不该再摆一个永远"未完成"的按钮（2026-11-11 用户确认）。
    // 账号2 只用了 11/32，仍能继续拿分，所以对它保留。
    hiddenFor: ["main"],
  },
  {
    key: "agent-issue",
    title: "Agent 仓提 Issue",
    desc: "每周给 Agent 开发实践中心代码仓提 Issue，每周 +60",
    script: ["node", "scripts/agent-run.mjs", "--headless", "--task=T_AI_OFFICE_ISSUE"],
    timeoutMs: 600000,
    period: "weekly",
    points: 60,
  },
  {
    key: "lab-weekly",
    title: "每周实验",
    desc: "打开 ECS 入门实验并保持，每周 +50",
    script: ["node", "scripts/lab-weekly.mjs"],
    timeoutMs: 300000,
    period: "weekly",
    points: 50,
    // 2026-11-11 用户要求从面板移除：华为云实验平台长期报
    // 「实验环境启动失败，请联系管理员或稍后重试」，脚本点了「重新进入实验」
    // 也无济于事——是平台侧故障，不是我们的问题。留着按钮只会让人以为
    // 「点了却没做」，所以从 UI 隐藏。weekly-run.sh 仍会尝试（平台恢复后自动生效）。
    hidden: true,
  },
  {
    key: "gallery",
    title: "展览馆作品",
    desc: "月度作品发布（本月已计分则跳过），每月 +200",
    script: ["bash", "scripts/gallery-daily.sh"],
    timeoutMs: 900000,
    period: "monthly",
    points: 200,
  },
  {
    key: "refresh",
    title: "刷新积分数据",
    desc: "只读采集一次积分明细，更新看板",
    script: ["bash", "scripts/refresh-points.sh"],
    timeoutMs: 300000,
    period: "utility",
    points: 0,
  },
];

/**
 * 整套每日流程（与 cron 跑的是同一条链路）。
 * 单独列出，因为它的入口是 daily-run.sh 而不是某个单项脚本。
 */
export const FULL_DAILY = {
  key: "full-daily",
  // 完整流程现在也覆盖周任务与月任务（都带幂等，已做过会自己跳过）：
  //   签到/发文/DevSpace/鸿蒙 → 展览馆（月）→ Agent Star/Issue（周）→ 报告
  // 这样只要这个按钮/定时开关一开，当天该做的全套都会处理。
  title: "完整每日流程",
  desc: "登录自愈 → 签到 → 发文 → DevSpace → 鸿蒙 → 展览馆(月) → Agent(周) → 报告",
  script: ["bash", "scripts/daily-run.sh"],
  timeoutMs: 3600000,
  period: "daily",
  points: 0,
};

export function taskByKey(key) {
  if (key === FULL_DAILY.key) return FULL_DAILY;
  return TASKS.find((t) => t.key === key) || null;
}
