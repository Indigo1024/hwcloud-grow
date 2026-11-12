#!/usr/bin/env node
/**
 * 在开发者作品展览馆发布作品（成长中心「在开发者作品展览馆中发布作品」+200，每日一次）
 *
 * 官方流程要求用「发布 Skill」，无法直接调 HTTP 接口，因此这里走码道 TUI：
 *   1. 确保码道 CLI 已授权（token 约 2h 过期，靠 refresh token 静默续期）
 *   2. 在码道 workspace 里安装发布 Skill（幂等，已装则跳过）
 *   3. 向 TUI 发送发布口令
 *   4. 用成长中心积分明细核实「在开发者作品展览馆中发布作品 +200」今天是否到账
 *
 * 用法：
 *   node scripts/gallery-publish.mjs                # 发布 + 核实
 *   node scripts/gallery-publish.mjs --check-only   # 只核实今天是否已到账（不发布）
 *   node scripts/gallery-publish.mjs --dry-run      # 只做前置检查，不发口令
 *
 * 环境变量：
 *   GALLERY_WORKSPACE   作品目录（默认码道 agent-workspace）
 *   GALLERY_TUI_TIMEOUT TUI 等待毫秒（默认 600000，发布含装依赖/生成封面，比问答慢）
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { chromium } from "playwright";
import { resolveAuthFile } from "./auth-utils.mjs";
import { authPathsFor } from "./auth-path.mjs";
import { resolveAccountId } from "./accounts.mjs";
import { GrowApi, hasBonusToday, shanghaiDate } from "./grow-api.mjs";
import {
  ensureCodeartsBrowserAuth,
  isCodeartsCliAuthenticated,
  ensureCodeartsPermissionsForAgent,
  codeartsEnvNoBrowser,
  augmentedPath,
  codeartsExe,
  ensureCodeartsFolderTrusted,
} from "./codearts-cli.mjs";

const GALLERY_BONUS = 200;
const GALLERY_BONUS_KEYWORD = "开发者作品展览馆";
const SKILL_REPO = "https://gitcode.com/Lingxi-HandsOn/gallery.git";
const SKILL_NAME = "huawei-cloud-publish-work-to-gallery";

/**
 * 发布源目录（按账号）。
 *
 * 码道 CLI 会把工作目录固定在 ~/.codeartsdoer/agent-workspace，传 cwd 无效，
 * 所以作品与 skill 软链都要放在该目录下——但「该目录」必须按账号区分，
 * 否则 acct2 会把主号的作品推到新号名下（仓库来自该目录的 git remote）。
 */
const AGENT_WORKSPACE = (() => {
  const id = process.env.HWCLOUD_ACCOUNT || "main";
  const base = join(homedir(), ".codeartsdoer");
  return id === "main" ? join(base, "agent-workspace") : join(base, `agent-workspace-${id}`);
})();
const WORKSPACE = process.env.GALLERY_WORKSPACE || AGENT_WORKSPACE;
const TUI_TIMEOUT_MS = Number(process.env.GALLERY_TUI_TIMEOUT) || 600_000;

const CHECK_ONLY = process.argv.includes("--check-only");
const DRY_RUN = process.argv.includes("--dry-run");
/** 强制重发（手工排查用）：node ... --force 时忽略今日发布记录 */
const FORCE_PUBLISH = process.argv.includes("--force");
const ACCOUNT_ID = resolveAccountId(process.env.HWCLOUD_ACCOUNT);

/**
 * 发布记录文件（按账号、按日）——防止「积分延迟到账」被误判成「还没发」而重复发布。
 *
 * 背景：展览馆任务是 DAILY×1，平台侧一天只认一次，但积分入账常延迟 1~3 小时。
 * 只看积分明细判断「今天发没发」会把「已发但没入账」当成「没发」，
 * 于是再发一次：轻则白等十几分钟毫无收益，重则触发平台限流/重复投稿。
 * 所以发布动作一成功就先落盘记录，积分到没到账都以此为准。
 */
function publishRecordFile(accountId) {
  const paths = authPathsFor(accountId);
  return join(paths.storageDir, "gallery-published.json");
}

/** 读今天的发布记录；返回 null 表示今天没发过 */
function readTodayRecord(accountId) {
  const f = publishRecordFile(accountId);
  if (!existsSync(f)) return null;
  try {
    const rec = JSON.parse(readFileSync(f, "utf8"));
    const today = shanghaiDate().replace(/\//g, "-");
    return rec.date === today ? rec : null;
  } catch {
    return null;
  }
}

/** 发布成功后写记录（原子写，失败不影响主流程） */
function writeTodayRecord(accountId, rec) {
  const f = publishRecordFile(accountId);
  try {
    const today = shanghaiDate().replace(/\//g, "-");
    writeFileSync(
      f,
      JSON.stringify({ date: today, at: new Date().toISOString(), ...rec }, null, 2),
      "utf8",
    );
  } catch (e) {
    log(`⚠️ 发布记录写入失败（不影响发布）: ${e.message.slice(0, 80)}`);
  }
}

/**
 * TUI 输出会打到本进程 stdout， galleries 日志里 `workId=` / `workUrl=` 行；
 * 这里从今天同账号的 gallery 日志尾部解析最近一次发布结果。
 * TUI 输出格式（实测）：
 *   #status=201
 *   workId=00664cce6c800000
 *   workUrl=https://gallery.developer.huaweicloud.com/gallery/00664cce6c800000
 */
function parseWorkFromLog(accountId) {
  const logDir = join(authPathsFor(accountId).storageDir, "..", "logs");
  const candidates = [
    join(logDir, `gallery-${shanghaiDate().replace(/\//g, "-")}.log`),
    join(logDir, `gallery-acct2-${shanghaiDate().replace(/\//g, "")}.log`),
    join(logDir, `gallery-${shanghaiDate().replace(/\//g, "")}.log`),
  ];
  const lines = [];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    try {
      lines.push(...readFileSync(f, "utf8").split(/\r?\n/).slice(-500));
    } catch {
      /* ignore */
    }
  }
  const out = {};
  for (const line of lines) {
    let m = line.match(/workId=([0-9a-fA-F]+)/);
    if (m) out.workId = m[1];
    m = line.match(/workUrl=(\S+)/);
    if (m) out.workUrl = m[1];
    m = line.match(/workName=(.+)/);
    if (m) out.workName = m[1].trim();
  }
  return Object.keys(out).length ? out : null;
}

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

/**
 * TUI 里发的发布口令。明确点名 skill，避免模型自行去翻 CodeArts 文档走弯路。
 * 中途的 question 提问由脚本模拟按键回答（见 runPublishTui 的 scheduleAnswer），
 * 因此这里不需要把答案写进口令。
 */
function publishPrompt() {
  return [
    `使用 skill "${SKILL_NAME}" 将当前项目发布至开发者作品展览馆。`,
    `当前目录（${WORKSPACE}）就是作品目录，请直接按 skill 步骤执行，不要额外研究展览馆是什么。`,
  ].join("");
}

/** Skill 是否已安装（实测码道把 skill 装在 ~/.codeartsdoer/skills/ 下，符号链接） */
function skillInstalled() {
  const candidates = [
    join(homedir(), ".codeartsdoer", "skills", SKILL_NAME),
    join(WORKSPACE, ".codeartsdoer", "skills", SKILL_NAME),
    join(WORKSPACE, ".claude", "skills", SKILL_NAME),
    join(WORKSPACE, ".agents", "skills", SKILL_NAME),
  ];
  return candidates.some((p) => existsSync(p));
}

/** 安装发布 Skill（幂等） */
function installSkill() {
  log("安装发布 Skill…");
  try {
    execSync(
      `npx -y skills add ${SKILL_REPO} --skill ${SKILL_NAME} -y`,
      {
        cwd: WORKSPACE,
        stdio: "inherit",
        timeout: 300_000,
        env: { ...process.env, PATH: augmentedPath(), DISPLAY: process.env.DISPLAY || ":99" },
      },
    );
    return true;
  } catch (e) {
    log("⚠️ Skill 安装命令非零退出:", e.message.slice(0, 160));
    return skillInstalled();
  }
}

/**
 * 模拟用户应答：TUI 用 question 工具提问时会停在交互界面等人点选项，
 * 非交互环境下必须由我们把按键喂进 stdin。
 *
 * 应答策略：检测到提问就发回车（选中默认/第一项，通常即「是/同意/继续」）；
 * 若提问带编号选项，则按 promptAnswer 里配置的序号选择。
 * 可用 GALLERY_AUTO_ANSWER=n 指定优先选第 n 项（1 起）。
 */
const ANSWER_KEYS = {
  enter: "\r",
  yes: "y\r",
  down: "\x1b[B",
  up: "\x1b[A",
};

/**
 * 判断当前缓冲是否出现了「等待用户输入」的界面特征。
 * 必须收紧：启动横幅（兼容性提示 / 正在启动中）不算提问——
 * 早先误判会提前送回车，TUI 收不到正常输入直接 code=1 退出。
 */
function looksLikePrompt(buf) {
  if (/Asked \d+ question/i.test(buf)) return true; // question 工具
  if (/Allow once|Allow always/i.test(buf)) return true; // 权限弹窗兜底
  if (/⇆\s*select|↑\/↓/.test(buf)) return true; // 选项选择界面
  return false;
}

/** 从提问文本里挑出要选的选项序号（1 起），没配就选第 1 项 */
function pickAnswerIndex() {
  const forced = Number(process.env.GALLERY_AUTO_ANSWER || 0);
  return forced > 0 ? forced : 1;
}

/** 启动码道 TUI 并发出口令，等待它跑完（自动应答交互提问） */
function runPublishTui() {
  const model = process.env.HWCLOUD_CODEARTS_MODEL || "huaweicloud-maas/GLM-5.2";
  ensureCodeartsFolderTrusted();
  const exe = codeartsExe();
  const prompt = publishPrompt();
  log(`启动码道 TUI（模型 ${model}）…`);
  log(`口令: ${prompt}`);

  const proc = spawn(exe, ["-m", model, "--prompt", prompt], {
    env: {
      ...codeartsEnvNoBrowser(),
      // 让 TUI 能找到用户级 skill（软链接在 ~/.codeartsdoer/skills/）
      CODEARTS_SKILLS_DIR: process.env.CODEARTS_SKILLS_DIR || join(homedir(), ".codeartsdoer", "skills"),
    },
    cwd: WORKSPACE,
    // stdin 必须是 pipe：TUI 的 question 提问要由我们模拟按键回答
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: false,
  });

  let sawFinish = false;
  let answering = false;
  /** 累积输出，用于识别「正在等用户输入」 */
  let tail = "";

  const flush = (chunk) => {
    const text = chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    tail = (tail + text).slice(-4000);
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      // TUI 大量画框字符，只保留有信息量的行
      if (/^[⬝■⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s|+━─│▣▄●◆▲]+$/.test(t)) continue;
      console.log(`[码道] ${t.slice(0, 200)}`);
      if (/发布成功|workId|workUrl|已申领|完成/i.test(t)) sawFinish = true;
    }
    scheduleAnswer();
  };
  proc.stdout?.on("data", flush);
  proc.stderr?.on("data", flush);

  /**
   * 模拟用户回答提问：检测到等待输入就按选项序号送键。
   * 问答界面通常用 ↑/↓ 选项 + Enter 确认，选第 N 项即按 (N-1) 次 ↓ 再回车。
   */
  function scheduleAnswer() {
    if (answering || proc.exitCode !== null) return;
    if (!looksLikePrompt(tail)) return;
    answering = true;
    // 稍等界面渲染稳定，再送键
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
      // 应答后清掉特征，避免对同一提问重复送键
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

/** 用积分明细核实今天是否已拿到展览馆 +200 */
async function verifyBonus(api) {
  const today = shanghaiDate();
  const hit = await hasBonusToday(api, GALLERY_BONUS_KEYWORD, GALLERY_BONUS, today);
  const beans = await api.bonusBeans();
  return { hit, today, beans };
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-features=NetworkServiceInProcess,NetworkChangeNotifier", "--disable-background-networking", "--disable-component-update", "--no-first-run"] });
  const ctx = await browser.newContext({
    // 按账号取登录态：不传账号时恒为主号文件，acct2 会算错「今日是否已到账」
    storageState: resolveAuthFile(resolveAccountId(process.env.HWCLOUD_ACCOUNT)),
    locale: "zh-CN",
  });
  const api = new GrowApi(ctx);

  try {
    // 0. 先看今天是否已经拿过（避免重复跑，白等十几分钟）
    const before = await verifyBonus(api);
    log(`今日（${before.today}）展览馆 +200 已到账: ${before.hit ? "是" : "否"} | 当前积分: ${before.beans}`);

    if (before.hit) {
      log("✅ 今日展览馆积分已到账，跳过发布");
      return 0;
    }

    // 积分没到账时，再看今天是否已经「发过」：
    // 平台发放有 1~3 小时延迟，已发布未入账是常态，不能当成没发过再发一遍。
    const rec = readTodayRecord(ACCOUNT_ID);
    if (rec && rec.workId && !FORCE_PUBLISH) {
      log(`⏭ 今日已发布过作品（workId=${rec.workId}，${rec.at}），仅为积分延迟，不重复发布`);
      log(`   作品地址: ${rec.workUrl || "(未记录)"}`);
      return 0;
    }

    if (CHECK_ONLY) {
      log("（--check-only）仅核实，不发布");
      return 0;
    }

    // 1. 码道授权
    log("检查码道 CLI 授权…");
    if (!isCodeartsCliAuthenticated()) {
      const a = await ensureCodeartsBrowserAuth(ctx);
      log(`授权结果: ${a.detail}`);
      if (!a.ok) {
        log("❌ 码道未授权，无法发布");
        return 2;
      }
    } else {
      log("码道 CLI OAuth 有效 ✓");
    }

    // 2. 放开权限（否则 TUI 卡在 Permission required）
    const perm = ensureCodeartsPermissionsForAgent();
    if (perm.changed.length) log(`已放开权限: ${perm.changed.join(", ")}`);

    // 3. 装 Skill
    if (skillInstalled()) {
      log("发布 Skill 已安装 ✓");
    } else if (!installSkill()) {
      log("⚠️ Skill 未装上，仍尝试直接发口令（码道可能自行安装）");
    }

    if (DRY_RUN) {
      log("（--dry-run）前置检查通过，未发送发布口令");
      return 0;
    }

    // 4. 发发布口令
    const run = await runPublishTui();
    log(`TUI 执行结束: ${run.detail}`);

    // 4.5 从 TUI 输出里解析 workId/作品名，落盘今日发布记录。
    // 积分入账有 1~3 小时延迟，「已发布」与「已入账」之间隔着一段空窗，
    // 不落盘的话明天会被误判成「还没发」而重复发布（DAILY×1 任务一天只认一次）。
    const published = parseWorkFromLog(ACCOUNT_ID);
    if (published?.workId) {
      writeTodayRecord(ACCOUNT_ID, published);
      log(`📝 已记录今日发布: workId=${published.workId} name=${published.workName || "-"}`);
    }

    // 5. 核实到账（积分发放可能有延迟，重试几次）
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 20_000));
      const after = await verifyBonus(api);
      log(`核实第 ${i + 1} 次: 到账=${after.hit} 积分=${after.beans}`);
      if (after.hit) {
        log(`✅ 展览馆 +${GALLERY_BONUS} 已到账，当前积分 ${after.beans}`);
        return 0;
      }
    }

    log("⚠️ 未在积分明细中查到本次到账（发布可能仍在处理，或需要人工确认作品信息）");
    return 1;
  } finally {
    await api.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error("异常:", e);
    process.exit(1);
  });
