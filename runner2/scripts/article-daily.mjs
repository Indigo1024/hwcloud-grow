#!/usr/bin/env node
/**
 * 每日发布一篇文章（成长中心「每日发布文章」+60，每日一次）
 *
 * 为什么走码道 TUI 而不是直接调 HTTP：
 *   发文章要在 BBS 编辑页里填标题、正文、产品标签、勾免责声明，接口还带
 *   前端持有的 csrf；用 TUI 让模型按页面真实交互去发，比逆向接口稳。
 *   展览馆发布（gallery-publish.mjs）同理，两者共用这套 TUI 驱动。
 *
 * 用法：
 *   node scripts/article-daily.mjs                # 发文 + 核实到账
 *   node scripts/article-daily.mjs --check-only   # 只核实今天是否已到账（不发文）
 *   node scripts/article-daily.mjs --dry-run      # 只做前置检查，不发口令
 *
 * 环境变量：
 *   ARTICLE_TOPIC        指定主题（默认按日期轮换，避免文章重复）
 *   ARTICLE_TUI_TIMEOUT  TUI 等待毫秒（默认 600000）
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveAccountId } from "./accounts.mjs";
import { authPathsFor } from "./auth-path.mjs";
import { GrowApi, hasBonusToday, shanghaiDate } from "./grow-api.mjs";
import {
  codeartsEnvNoBrowser,
  codeartsExe,
  ensureCodeartsFolderTrusted,
  ensureCodeartsPermissionsForAgent,
  augmentedPath,
} from "./codearts-cli.mjs";

const ACCOUNT_ID = resolveAccountId(process.env.HWCLOUD_ACCOUNT);
// main 号的目录没有后缀（历史遗留），不能一律拼 agent-workspace-<id>：
// 拼出来是 agent-workspace-main，而实际目录叫 agent-workspace。
// 该目录不存在时 spawn 会报 ENOENT，错误信息只提可执行文件，
// 极易误判成 codearts 装丢了（2026-10-21 旧号发文卡在这）。
const AGENT_WORKSPACE =
  process.env.HWCLOUD_AGENT_WORKSPACE ||
  (ACCOUNT_ID === "main"
    ? join(homedir(), ".codeartsdoer", "agent-workspace")
    : join(homedir(), ".codeartsdoer", `agent-workspace-${ACCOUNT_ID}`));

const WORKSPACE = process.env.ARTICLE_WORKSPACE || AGENT_WORKSPACE;
const TUI_TIMEOUT_MS = Number(process.env.ARTICLE_TUI_TIMEOUT) || 600_000;

/** 成长中心「每日发布文章」的流水关键字与分值 */
const ARTICLE_BONUS_KEYWORD = "每日发布文章";
const ARTICLE_BONUS = 60;

const CHECK_ONLY = process.argv.includes("--check-only");
const DRY_RUN = process.argv.includes("--dry-run");

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

/**
 * 文章主题轮换表。
 * 同一主题连发会被判重（标题近似），按天索引轮换能错开较长时间。
 */
const TOPICS = [
  "如何用 Playwright 稳定地做企业控制台自动化",
  "TUI 应用在非交互环境下的自动化实践",
  "多账号系统的凭据隔离与文件锁设计",
  "用 Node.js 做浏览器自动化任务调度时的踩坑记录",
  "把重复的日常运营任务交给脚本：我的经验",
  "前端状态持久化的几种方案对比",
  "如何给自动化脚本加可靠的失败重试与断点续跑",
  "云服务积分任务的自动化边界在哪里",
  "systemd 托管 Node 脚本的实践要点",
  "从零搭一个轻量看板：数据采集与展示",
];

/** 按今年第几天取主题，保证同一天多次调用得到同一主题 */
function pickTopic() {
  if (process.env.ARTICLE_TOPIC) return process.env.ARTICLE_TOPIC;
  const now = new Date();
  const dayOfYear = Math.floor(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      Date.UTC(now.getFullYear(), 0, 0)) /
      86400000,
  );
  return TOPICS[dayOfYear % TOPICS.length];
}

/**
 * TUI 里发的发文口令。
 * 明确点名页面与关键交互点，避免模型自己去摸索导致漏勾免责声明发不出去。
 */
function articlePrompt() {
  const topic = pickTopic();
  return [
    `请帮我到华为云社区发布一篇技术文章，标题围绕「${topic}」。`,
    `页面：https://bbs.huaweicloud.com/blogs/article`,
    `要求：正文用 Markdown 写 600 字以上、有真实代码或步骤细节，不要空话；`,
    `产品标签任选一个相关的；`,
    `注意「文章不需要评论」是 toggle，先读状态再点；`,
    `发布前必须勾选「已知晓」免责声明（span#agreementBox），否则发表按钮是禁用的；`,
    `最后点 a#submit-btn 发表，并回报文章标题与链接。`,
  ].join("");
}

/** 判断当前缓冲是否出现了「等待用户输入」的界面特征 */
function looksLikePrompt(buf) {
  if (/Asked \d+ question/i.test(buf)) return true;
  if (/Allow once|Allow always/i.test(buf)) return true;
  if (/⇆\s*select|↑\/↓/.test(buf)) return true;
  return false;
}

/** 从提问文本里挑出要选的选项序号（1 起），没配就选第 1 项 */
function pickAnswerIndex() {
  const forced = Number(process.env.ARTICLE_AUTO_ANSWER || 0);
  return forced > 0 ? forced : 1;
}

const ANSWER_KEYS = {
  enter: "\r",
  down: "\x1b[B",
};

/** 启动码道 TUI 并发出口令，等待它跑完（自动应答交互提问） */
function runArticleTui() {
  const model = process.env.HWCLOUD_CODEARTS_MODEL || "huaweicloud-maas/GLM-5.2";
  ensureCodeartsFolderTrusted();
  // 不放开权限的话，TUI 会卡在 "Permission required" 弹窗直到超时
  ensureCodeartsPermissionsForAgent();
  const exe = codeartsExe();
  const prompt = articlePrompt();
  log(`启动码道 TUI（模型 ${model}）…`);
  log(`主题: ${pickTopic()}`);

  const proc = spawn(exe, ["-m", model, "--prompt", prompt], {
    env: {
      ...codeartsEnvNoBrowser(),
      PATH: augmentedPath(),
      CODEARTS_SKILLS_DIR:
        process.env.CODEARTS_SKILLS_DIR || join(homedir(), ".codeartsdoer", "skills"),
    },
    cwd: WORKSPACE,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
  });

  let sawFinish = false;
  let answering = false;
  let tail = "";

  // spawn 失败（ENOENT 等）必须显式捕获：不监听 'error' 会让整个 node 进程崩栈，
  // 上层只看到「发文退出码=1」，真正的失败原因被埋在堆栈里。
  proc.on("error", (e) => {
    log(`❌ 码道进程启动失败: ${e.code} ${e.message}`);
    log(`   可执行文件: ${exe}`);
    log(`   工作目录:   ${WORKSPACE}（存在=${existsSync(WORKSPACE)}）`);
  });

  const flush = (chunk) => {
    const text = chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    tail = (tail + text).slice(-4000);
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      if (/^[⬝■⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s|+━─│▣▄●◆▲]+$/.test(t)) continue;
      console.log(`[码道] ${t.slice(0, 200)}`);
      if (/发布成功|发表成功|blog\.huaweicloud\.com\/blogs\/\d|已提交|完成/i.test(t)) {
        sawFinish = true;
      }
    }
    scheduleAnswer();
  };
  proc.stdout?.on("data", flush);
  proc.stderr?.on("data", flush);

  function scheduleAnswer() {
    if (answering || proc.exitCode !== null) return;
    if (!looksLikePrompt(tail)) return;
    answering = true;
    setTimeout(() => {
      if (proc.exitCode !== null || !proc.stdin?.writable) {
        answering = false;
        return;
      }
      const idx = pickAnswerIndex();
      const keys = ANSWER_KEYS.down.repeat(Math.max(idx - 1, 0)) + ANSWER_KEYS.enter;
      try {
        proc.stdin.write(keys);
        log(`⌨️  检测到交互提问，模拟选择第 ${idx} 项`);
      } catch (e) {
        log("⚠️ 应答写入失败:", e.message.slice(0, 80));
      }
      tail = "";
      setTimeout(() => {
        answering = false;
      }, 3000);
    }, 1500);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log(`⏱ TUI 等待超时（${TUI_TIMEOUT_MS / 1000}s），终止`);
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      resolve({ ok: sawFinish, detail: "TUI 超时" });
    }, TUI_TIMEOUT_MS);

    proc.on("exit", (code) => {
      clearTimeout(timer);
      try {
        proc.stdin?.end();
      } catch {
        /* ignore */
      }
      log(`码道 TUI 退出，code=${code}`);
      resolve({ ok: sawFinish || code === 0, detail: `code=${code}` });
    });
  });
}

/** 用积分明细核实今天是否已拿到发文 +60 */
async function verifyBonus(api) {
  const today = shanghaiDate();
  const hit = await hasBonusToday(api, ARTICLE_BONUS_KEYWORD, ARTICLE_BONUS, today);
  const beans = await api.bonusBeans();
  return { hit, today, beans };
}

async function main() {
  log(`===== 每日发文（账号 ${ACCOUNT_ID}）=====`);
  const paths = authPathsFor(ACCOUNT_ID);

  if (CHECK_ONLY) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-features=NetworkServiceInProcess,NetworkChangeNotifier", "--disable-background-networking", "--disable-component-update", "--no-first-run"] });
    const ctx = await browser.newContext({
      storageState: paths.authFile,
      locale: "zh-CN",
    });
    const api = new GrowApi(ctx);
    const r = await verifyBonus(api);
    log(`今日(${r.today})「${ARTICLE_BONUS_KEYWORD}」+${ARTICLE_BONUS} 到账: ${r.hit ? "✅" : "❌"} | 当前总分 ${r.beans}`);
    await browser.close();
    process.exit(r.hit ? 0 : 1);
  }

  if (DRY_RUN) {
    log(`【dry-run】workspace=${WORKSPACE}`);
    log(`【dry-run】凭证=${paths.authFile} 存在=${existsSync(paths.authFile) ? "是" : "否"}`);
    log(`【dry-run】主题=${pickTopic()}`);
    log(`【dry-run】口令=${articlePrompt()}`);
    return;
  }

  const r = await runArticleTui();
  log(`TUI 结果: ok=${r.ok} detail=${r.detail}`);
  log("发文流程结束。积分发放可能有延迟，稍后可用 --check-only 核实。");
}

main().catch((e) => {
  console.error("发文失败:", e.message);
  process.exit(1);
});
