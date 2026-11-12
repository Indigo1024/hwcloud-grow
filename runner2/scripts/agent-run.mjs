#!/usr/bin/env node
/**
 * 使用已保存的 Cookie 执行 Manifest 中的 Agent 任务。
 *
 * 用法:
 *   npm run agent          # 统一入口（环境自动识别）
 *   npm run agent:headless # 高级：直接前台 headless
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANIFEST_URL,
  DEFAULT_MANIFEST_FILE,
  PORTAL_DEV_MANIFEST,
  REPO_MANIFEST,
} from "./auth-path.mjs";
import {
  hasSavedAuth,
  openGrowAndCheckLogin,
  loadSessionMeta,
  resolveAuthFile,
} from "./auth-utils.mjs";
import { resolveAccountId } from "./accounts.mjs";
import {
  captureGrowSnapshot,
  diffSnapshots,
  formatReportZh,
  saveLastReport,
  readPointsDetailModal,
  findTodayCheckinRecord,
} from "./grow-report.mjs";
import {
  ensureCodeartsCli,
  sendHiViaCodeartsCli,
  CODEARTS_CLI_INSTALL_DOC,
  dumpCodeArtsIdeDiagnostics,
} from "./codearts-cli.mjs";
import { tryOfficeStar, tryOfficeIssue } from "./gitcode-tasks.mjs";
import { TaskStatus } from "./task-status.mjs";
import { GrowApi } from "./grow-api.mjs";
import { runSuggestionTask } from "./tasks/suggestion.mjs";
import { runForumAnswerTask } from "./tasks/bbs-answer.mjs";
import {
  tryDevspaceAiShell,
  tryWeeklyLab,
  tryWeeklyCert,
} from "./tasks/weekly.mjs";
import { pollUntil } from "./retry-utils.mjs";
import { launchBrowser } from "./browser-utils.mjs";
import { openGrowAndWait } from "./wait-utils.mjs";
import {
  GROW,
  CODEARTS_SUBSCRIBE,
  DEVSPACE,
  DEVSPACE_TOUR_NAV,
} from "./selectors.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_VERSION = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8"),
).version;

/** 码道 TUI：发送提问后最多等待 90 秒（可用 HWCLOUD_QA_TIMEOUT_MS 延长），无 finish:stop 则放弃 */
const CODEARTS_QA_TIMEOUT_MS = Number(process.env.HWCLOUD_QA_TIMEOUT_MS) || 90_000;
const headless = process.argv.includes("--headless");
const runAll = process.argv.includes("--all");
const taskFilter = process.argv.find((a) => a.startsWith("--task="))?.split("=")[1];
const manifestPath = process.argv.find((a) => a.startsWith("--manifest="))?.split("=")[1];

async function fetchManifest() {
  if (manifestPath && existsSync(manifestPath)) {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  }

  for (const localPath of [REPO_MANIFEST, DEFAULT_MANIFEST_FILE, PORTAL_DEV_MANIFEST]) {
    if (existsSync(localPath)) {
      return JSON.parse(readFileSync(localPath, "utf8"));
    }
  }

  for (const url of [process.env.GROW_MANIFEST_URL, MANIFEST_URL].filter(Boolean)) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const manifest = await res.json();
        try {
          mkdirSync(dirname(DEFAULT_MANIFEST_FILE), { recursive: true });
          writeFileSync(DEFAULT_MANIFEST_FILE, JSON.stringify(manifest, null, 2), "utf8");
          console.log(`Manifest 已缓存: ${DEFAULT_MANIFEST_FILE}`);
        } catch {
          /* cache optional */
        }
        return manifest;
      }
    } catch {
      /* try next */
    }
  }

  throw new Error(
    `无法读取 Manifest。请克隆 hwcloud-grow 仓库（含 manifest.json）或设置 GROW_MANIFEST_URL`,
  );
}

function log(report, taskId, status, detail) {
  report.push({ task_id: taskId, status, detail });
  console.log(`[${status}] ${taskId}: ${detail}`);
}

async function tryCheckin(page, task, report) {
  await openGrowAndWait(page);

  // 签到状态区是 SPA 异步渲染的：openGrowAndWait 返回时这块常常还没挂上来，
  // 直接读 innerText 会误判成「既没签到、也没有签到按钮」（实测偶发）。
  // 这里轮询等签到状态区出现，出现后立刻据此判定。
  let uiSigned = false;
  for (let i = 0; i < 12; i++) {
    uiSigned = await page
      .evaluate(
        (signedText) =>
          document.body.innerText.includes(signedText) ||
          !!document.querySelector(".user-message-view-userValue-item-button"),
        GROW.signedInText,
      )
      .catch(() => false);
    if (uiSigned) break;
    await page.waitForTimeout(2000);
  }
  if (uiSigned) {
    log(report, task.task_id, TaskStatus.SKIP, "今日已签到（成长中心显示「已签到」）");
    return;
  }

  // 签到按钮：必须用 CDP 真鼠标点。
  // 踩坑：原来用 el.click()（JS 点击），对 React/TinyUI 按钮常静默无效——
  // 脚本报「已尝试」，页面却仍显示「立即签到」，积分不到账。
  let clicked = null;
  for (const txt of GROW.checkinButtonTexts) {
    const handle = await page.evaluateHandle((t) => {
      const all = [...document.querySelectorAll("a,button,span,div,label")];
      const c = all.filter((e) => (e.innerText || "").trim() === t);
      // 取最内层（子节点最少），避免点到外层容器
      c.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
      return c[0] || null;
    }, txt);
    const el = handle.asElement();
    if (!el) continue;
    await el.evaluate((n) => n.scrollIntoView({ block: "center", inline: "center" }));
    await page.waitForTimeout(700);
    const box = await el.boundingBox();
    if (!box || box.width === 0) continue;
    await page.bringToFront().catch(() => {});
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(150);
    await page.mouse.down();
    await page.waitForTimeout(90);
    await page.mouse.up();
    clicked = txt;
    break;
  }

  if (clicked) {
    // 点击后必须复核页面真的变成「已签到」，否则不算成功。
    // 原来直接报 TRIED 会出现「脚本说已尝试、页面仍是立即签到」的假成功。
    let verified = false;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1500);
      verified = await page
        .evaluate((signedText) => document.body.innerText.includes(signedText), GROW.signedInText)
        .catch(() => false);
      if (verified) break;
    }
    if (verified) {
      log(report, task.task_id, TaskStatus.TRIED, `签到成功（真鼠标点击「${clicked}」，页面已显示「已签到」）`);
    } else {
      log(
        report,
        task.task_id,
        TaskStatus.PENDING,
        `已点击「${clicked}」但页面未变为「已签到」，需复核`,
      );
    }
    return;
  }

  const pointsDetail = await readPointsDetailModal(page);
  const todayCheckin = findTodayCheckinRecord(pointsDetail?.recent_records);
  if (todayCheckin) {
    log(
      report,
      task.task_id,
      TaskStatus.SKIP,
      `今日已签到（积分明细：${todayCheckin.source} ${todayCheckin.time} +${todayCheckin.points}）`,
    );
    return;
  }

  log(
    report,
    task.task_id,
    TaskStatus.PENDING,
    pointsDetail?.error
      ? `未找到签到按钮；积分明细未打开（${pointsDetail.error}）`
      : "未找到签到按钮，且积分明细中无今日签到记录",
  );
}

/** 开发者空间弹窗处理：关闭促销弹窗 + 签署服务协议（不签会导致核时=0 且按钮被遮挡） */
async function dismissDevspaceOverlays(page) {
  // 1. 关闭促销类弹窗（「下次不再提示」）
  for (let round = 0; round < 3; round++) {
    const closed = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll("a, span, button, div").forEach((el) => {
        const t = (el.innerText || "").trim();
        if (t === "下次不再提示" || t === "下次不再显示" || t === "我知道了") {
          el.click();
          n++;
        }
      });
      return n;
    });
    await page.waitForTimeout(800);
    if (!closed) break;
  }

  // 2. 签署服务协议弹窗（勾选 checkbox + 点「同意」）
  const agreed = await page.evaluate(() => {
    const wrappers = [
      ...document.querySelectorAll(".tiny-dialog-box__wrapper, [class*=dialog]"),
    ].filter((el) => el.offsetParent !== null && (el.innerText || "").includes("服务协议"));
    let done = false;
    for (const w of wrappers) {
      w.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        if (!cb.checked) {
          cb.click();
          const label = cb.closest("label") || cb.parentElement;
          if (label && !cb.checked) label.click();
        }
      });
      for (const b of w.querySelectorAll("button")) {
        if ((b.innerText || "").trim() === "同意") {
          b.click();
          done = true;
          break;
        }
      }
      if (done) break;
    }
    return done;
  });
  if (agreed) {
    console.log("已签署开发者空间服务协议");
    await page.waitForTimeout(2000);
  }
  return agreed;
}

async function tryCodeartsSubscribe(page, task, report) {
  await page.goto(task.entry_url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
  if (page.url().includes("auth.huaweicloud.com")) {
    log(report, task.task_id, TaskStatus.SKIP, "一键开通页需重新登录");
    return;
  }
  const alreadyOpened = await page.evaluate(() =>
    /您已开通|已开通华为云码道|开通成功/.test(document.body?.innerText || ""),
  );
  if (alreadyOpened) {
    log(report, task.task_id, TaskStatus.SKIP, "已开通华为云码道（页面显示「您已开通」）");
    return;
  }
  const patternSources = CODEARTS_SUBSCRIBE.buttonPatterns.map((p) => p.source);
  const clicked = await page.evaluate((patterns) => {
    const reList = patterns.map((s) => new RegExp(s));
    for (const el of document.querySelectorAll("button, a, span, div")) {
      const t = (el.innerText || "").trim();
      if (!t || t.length > 20) continue;
      if (reList.some((p) => p.test(t))) {
        el.click();
        return t;
      }
    }
    return null;
  }, patternSources);
  if (clicked) {
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  }
  const paidHint = await page.evaluate((patternSource) => {
    const body = document.body?.innerText || "";
    return new RegExp(patternSource).test(body);
  }, CODEARTS_SUBSCRIBE.paidHintPattern.source);
  log(
    report,
    task.task_id,
    clicked ? TaskStatus.TRIED : TaskStatus.PENDING,
    `开通按钮=${clicked ?? "未找到"}${paidHint ? "；页面含付费提示，请人工确认" : ""}`,
  );
}

async function tryCodeartsQa(page, task, report) {
  if (process.env.HWCLOUD_SKIP_CODEARTS_QA === "1") {
    log(report, task.task_id, TaskStatus.SKIP, "HWCLOUD_SKIP_CODEARTS_QA=1，跳过智能问答");
    return;
  }
  console.log(`码道 CLI 安装指南: ${CODEARTS_CLI_INSTALL_DOC}`);
  const install = ensureCodeartsCli();
  if (!install.installed) {
    log(report, task.task_id, TaskStatus.FAIL, install.detail);
    return;
  }
  console.log(install.detail);
  console.log("码道 CLI 使用 TUI 提问并等待回复（须检测到 assistant finish:stop 才算成功）");
  console.log(`码道 TUI 等待超时: ${CODEARTS_QA_TIMEOUT_MS / 1000}s`);
  const result = await sendHiViaCodeartsCli(page.context(), {
    headedAuth: headless,
    tuiTimeoutMs: CODEARTS_QA_TIMEOUT_MS,
  });
  if (!result.ok && /超时/.test(result.detail || "")) {
    log(
      report,
      task.task_id,
      TaskStatus.SKIP,
      `智能问答超时（${CODEARTS_QA_TIMEOUT_MS / 1000}秒），已跳过`,
    );
    return;
  }
  log(report, task.task_id, result.ok ? TaskStatus.TRIED : TaskStatus.PENDING, result.detail);
}

async function browseDevspaceNav(page, label) {
  const loc = page.getByText(label, { exact: true }).first();
  if ((await loc.count()) === 0) return null;
  await loc.click({ timeout: 12000 }).catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  if (page.url().includes("auth.huaweicloud.com")) return "login";
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
  await page.waitForTimeout(1500);
  return page.url().slice(0, 96);
}

async function tryDevspaceTour(page, task, report) {
  const labels = task.tour_nav_labels?.length ? task.tour_nav_labels : DEVSPACE_TOUR_NAV;
  await page.goto(task.entry_url, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
  if (page.url().includes("auth.huaweicloud.com")) {
    log(report, task.task_id, TaskStatus.SKIP, "开发者空间需登录");
    return;
  }
  await dismissDevspaceOverlays(page);

  const visited = [`入口:${page.url().slice(0, 80)}`];
  for (const label of labels) {
    const url = await browseDevspaceNav(page, label);
    if (url === "login") {
      log(report, task.task_id, TaskStatus.SKIP, `浏览「${label}」时需重新登录`);
      return;
    }
    if (url) visited.push(`${label}:${url}`);
  }
  if (visited.length <= 1) {
    log(report, task.task_id, TaskStatus.PENDING, `未找到导航项（已访问 ${page.url().slice(0, 80)}）`);
    return;
  }
  log(report, task.task_id, TaskStatus.TRIED, `浏览导航: ${visited.join(" | ")}`);
}

async function gotoDevEnvironmentPage(page, entryUrl) {
  await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
  if (page.url().includes("auth.huaweicloud.com")) return false;

  // 该页为 SPA，环境列表常在 12s 后才渲染完成；过早判定会误认为「无环境」
  // 而走进创建流程（表单未填 → 报「选择不能为空」）。此处轮询等待列表/空态。
  for (let i = 0; i < 12; i++) {
    const ready = await page
      .evaluate(() => {
        const t = document.body.innerText || "";
        return (
          t.includes("总条数") ||
          t.includes("已就绪") ||
          t.includes("运行中") ||
          t.includes("创建中") ||
          t.includes("暂无数据") ||
          t.includes("暂无环境")
        );
      })
      .catch(() => false);
    if (ready) return true;
    await page.waitForTimeout(2500);
  }
  return true;
}

async function hasDevEnvironment(page) {
  if ((await page.getByRole("button", { name: DEVSPACE.moreButton }).count()) > 0) return true;
  if ((await page.getByText(DEVSPACE.moreButton, { exact: true }).count()) > 0) return true;
  if ((await page.getByText(DEVSPACE.readyPattern).count()) > 0) return true;
  // 兜底：列表为空态或表格已渲染
  const txt = await page
    .evaluate(() => document.body.innerText || "")
    .catch(() => "");
  if (txt.includes("总条数")) return true;
  if (DEVSPACE.readyPattern.test(txt)) return true;
  return false;
}

function devEnvName() {
  return `ge_${Date.now().toString(36).slice(-6)}`;
}

async function waitForDevEnvironment(page, entryUrl, timeoutMs = 120_000) {
  return pollUntil(
    async () => {
      if (await hasDevEnvironment(page)) return true;
      await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
      return hasDevEnvironment(page);
    },
    { timeoutMs, baseIntervalMs: 3_000, maxIntervalMs: 8_000 },
  );
}

async function tryDevspaceCreateEnv(page, task, report) {
  const loggedIn = await gotoDevEnvironmentPage(page, task.entry_url);
  if (!loggedIn) {
    log(report, task.task_id, TaskStatus.SKIP, "开发者空间需登录");
    return;
  }

  if (await hasDevEnvironment(page)) {
    log(report, task.task_id, TaskStatus.SKIP, "已有云开发环境，无需创建");
    return;
  }

  // 关键：先关闭促销弹窗并签署服务协议（不签核时显示 0 且「创建」被遮挡）
  await dismissDevspaceOverlays(page);

  // 二次确认：再查一次环境列表（页面可能刚渲染完），避免误判后空提交表单
  if (await hasDevEnvironment(page)) {
    log(report, task.task_id, TaskStatus.SKIP, "已有云开发环境，无需创建");
    return;
  }

  // 点「创建」按钮（类名 baseBtn 的精确「创建」按钮）
  const opened = await page
    .locator("button.baseBtn")
    .filter({ hasText: /^创建$/ })
    .first()
    .click({ timeout: 12000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) {
    log(report, task.task_id, TaskStatus.PENDING, "未找到「创建」按钮");
    return;
  }
  await page.waitForTimeout(2500);

  // 选「Python 开发环境」模板（自动化最稳的免费模板）
  const templatePicked = await page.evaluate(() => {
    for (const el of document.querySelectorAll("*")) {
      const t = (el.innerText || "").trim();
      if (t === "Python 开发环境" && el.children.length === 0) {
        el.click();
        return true;
      }
    }
    for (const el of document.querySelectorAll("[class*=card], [class*=item], [class*=template]")) {
      const t = (el.innerText || "").trim();
      if (t.includes("Python 开发环境") && t.length < 200) {
        el.click();
        return true;
      }
    }
    return false;
  });
  if (!templatePicked) console.log("未找到 Python 模板，尝试直接确定");
  await page.waitForTimeout(1500);

  // 点「确定」进入配置表单
  const proceed = await page.evaluate(() => {
    const wrappers = [
      ...document.querySelectorAll(".tiny-dialog-box__wrapper, [class*=dialog]"),
    ].filter((el) => el.offsetParent !== null);
    for (const w of wrappers) {
      for (const b of w.querySelectorAll("button")) {
        if ((b.innerText || "").trim() === "确定") {
          b.click();
          return true;
        }
      }
    }
    return false;
  });
  if (!proceed) {
    log(report, task.task_id, TaskStatus.PENDING, "模板选择弹窗未出现「确定」按钮");
    return;
  }
  await page.waitForTimeout(2500);

  // 找到「开发环境名称」输入框（页面已自动填默认名，如 DevEnvC_xxx）
  const nameInput = page.locator("input[placeholder='请输入']").first();
  const hasInput = (await nameInput.count()) > 0;
  if (!hasInput) {
    log(report, task.task_id, TaskStatus.PENDING, "未找到「开发环境名称」输入框");
    return;
  }
  const existing = await nameInput.inputValue().catch(() => "");
  if (!existing || existing.length < 3) {
    await nameInput.fill(devEnvName());
  } else {
    console.log(`沿用页面默认环境名: ${existing}`);
  }

  // 提交「创建开发环境」
  const submit = page.getByRole("button", { name: DEVSPACE.createEnvSubmit });
  if ((await submit.count()) === 0) {
    log(report, task.task_id, TaskStatus.PENDING, "未找到「创建开发环境」提交按钮");
    return;
  }
  await submit.first().click({ timeout: 12000 });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});

  const formError = page.locator(".tiny-form-item__error, [class*='error-message']").first();
  if ((await formError.count()) > 0) {
    const msg = await formError.innerText().catch(() => "表单校验失败");
    log(report, task.task_id, TaskStatus.FAIL, msg.trim());
    return;
  }

  const created = await waitForDevEnvironment(page, task.entry_url);
  if (created) {
    log(report, task.task_id, TaskStatus.TRIED, "云开发环境已出现在列表");
    return;
  }

  log(report, task.task_id, TaskStatus.PENDING, "已提交创建，120s 内列表仍未出现环境");
}

async function verifyGrow(page) {
  return captureGrowSnapshot(page);
}

/**
 * 每日提交建议（+30）
 *
 * 成长中心侧「提交建议」的 is_finish 由服务端人工/规则评估（页面注明 2 个工作日内），
 * 提交后当天不会立刻变 true，所以判定口径是「本次确实提交成功」，到账由后续快照核验。
 * 已提交过则跳过，避免一天灌多条被视为刷分。
 */
async function trySuggestion(page, task, report) {
  const api = new GrowApi(page.context(), { page });
  try {
    const before = await api.myMissions();
    const t = before.missions?.find((x) => /提交建议/.test(x.title));
    if (t?.isFinish) {
      log(report, task.task_id, TaskStatus.SKIP, "今日建议任务已完成（成长中心已标记 is_finish）");
      return;
    }
  } catch {
    /* 查不到就继续尝试提交 */
  } finally {
    await api.close();
  }

  const r = await runSuggestionTask(page);
  if (r.ok) {
    log(report, task.task_id, TaskStatus.TRIED, r.detail);
  } else {
    log(report, task.task_id, TaskStatus.FAIL, r.detail || "提交建议失败");
  }
}

/**
 * 每日回答 BBS 问题（+60）
 *
 * 能力边界：成长中心这条要求「回答问题 **且被采纳**」，采纳按钮只有楼主可见，
 * 回答者页面上没有该入口，所以无法自动拿满。这里把「回答」做到确定性成功，
 * 并通过「优先挑 0 回复 + 未解决的帖子」提高被采纳概率。
 * 因此状态记为「已尝试」而非「已完成」，到账结果由后续快照核验。
 */
async function tryForumAnswer(page, task, report) {
  const r = await runForumAnswerTask(page);
  if (r.ok) {
    log(report, task.task_id, TaskStatus.TRIED, r.detail);
  } else {
    log(report, task.task_id, TaskStatus.FAIL, r.detail || "回答 BBS 问题失败");
  }
}

const HANDLERS = {
  T_GROW_CHECKIN: tryCheckin,
  T_CODEARTS_SUBSCRIBE: tryCodeartsSubscribe,
  T_CODEARTS_QA: tryCodeartsQa,
  T_DEVSPACE_TOUR: tryDevspaceTour,
  T_DEVSPACE_CREATE_ENV: tryDevspaceCreateEnv,
  T_AI_OFFICE_STAR: tryOfficeStar,
  T_AI_OFFICE_ISSUE: tryOfficeIssue,
  T_BBS_SUGGESTION: trySuggestion,
  T_BBS_FORUM_ANSWER: tryForumAnswer,
  T_DEVSPACE_AI_SHELL: tryDevspaceAiShell,
  T_WEEKLY_LAB: tryWeeklyLab,
  T_WEEKLY_CERT: tryWeeklyCert,
};

/** 固定串行顺序：码道开通须在智能问答之前；智能问答放最后（易卡住，60s 超时跳过） */
const TASK_ORDER = [
  "T_GROW_CHECKIN",
  "T_CODEARTS_SUBSCRIBE",
  "T_DEVSPACE_TOUR",
  "T_DEVSPACE_CREATE_ENV",
  "T_DEVSPACE_AI_SHELL",
  "T_WEEKLY_LAB",
  "T_WEEKLY_CERT",
  "T_AI_OFFICE_STAR",
  "T_AI_OFFICE_ISSUE",
  "T_BBS_SUGGESTION",
  "T_BBS_FORUM_ANSWER",
  "T_CODEARTS_QA",
];

function sortTasks(tasks) {
  const rank = new Map(TASK_ORDER.map((id, i) => [id, i]));
  return [...tasks].sort(
    (a, b) => (rank.get(a.task_id) ?? 999) - (rank.get(b.task_id) ?? 999),
  );
}

async function main() {
  // 🔍 诊断模式：HWCLOUD_DIAGNOSE_IDE=1 时打印全部 IDE 检测原始数据
  dumpCodeArtsIdeDiagnostics();

  const handlerIds = Object.keys(HANDLERS).join(", ");
  console.log(`hwcloud-grow-runner v${RUNNER_VERSION}`);
  console.log(`任务处理器: ${handlerIds}`);
  console.log("【运行环境】统一模式 — 含 Playwright 页面操作与码道 CLI TUI（问答最多等待 90 秒）\n");

  // 账号要先定下来：后面的登录态判定、storageState、任务上报都按它走。
  // 不传账号时这些函数恒看主号文件，会把「acct2 没登录」误判成「主号没登录」。
  const accountId = resolveAccountId(process.env.HWCLOUD_ACCOUNT);

  if (!hasSavedAuth(accountId)) {
    console.error(`未找到账号 ${accountId} 的已保存登录态。请先运行扫码登录。`);
    process.exit(1);
  }

  const meta = loadSessionMeta(accountId);
  if (meta?.saved_at) {
    console.log(`使用登录态（保存于 ${meta.saved_at}）\n`);
  }

  const manifest = await fetchManifest();
  const report = [];

  const browser = await launchBrowser({ headless });
  const context = await browser.newContext({
    storageState: resolveAuthFile(accountId),
    viewport: headless ? { width: 1400, height: 900 } : null,
    locale: "zh-CN",
  });
  const page = await context.newPage();

  if (!(await openGrowAndCheckLogin(page))) {
    console.error("已保存的 Cookie 已失效，请重新运行: npm run login");
    await browser.close();
    process.exit(1);
  }

  console.log("读取运行前积分与任务状态…");
  const snapshotBefore = await captureGrowSnapshot(page);

  let tasks = manifest.tasks;
  if (taskFilter) {
    tasks = tasks.filter((t) => t.task_id === taskFilter);
  } else if (!runAll) {
    tasks = tasks.filter((t) => t.auto_run !== false);
  }
  tasks = sortTasks(tasks);
  console.log(`开始执行 ${tasks.length} 个任务…\n`);
  if (taskFilter && tasks.length === 0) {
    console.error(`未找到任务: ${taskFilter}`);
    await browser.close();
    process.exit(1);
  }
  for (const task of tasks) {
    console.log(`--- ${task.task_id}: ${task.title} (+${task.points}) ---`);
    const fn = HANDLERS[task.task_id];
    if (fn) {
      try {
        await fn(page, task, report);
      } catch (e) {
        log(report, task.task_id, TaskStatus.FAIL, String(e));
      }
    } else {
      log(report, task.task_id, TaskStatus.SKIP, "无处理器");
    }
  }

  console.log("\n等待积分明细同步…");
  let snapshotAfter;
  await pollUntil(
    async () => {
      snapshotAfter = await verifyGrow(page);
      const diff = diffSnapshots(snapshotBefore, snapshotAfter);
      return (
        (diff.current_points_delta != null && diff.current_points_delta !== 0) ||
        (diff.header_points_delta != null && diff.header_points_delta !== 0) ||
        diff.new_records.length > 0
      );
    },
    { timeoutMs: 15_000, baseIntervalMs: 3_000, maxIntervalMs: 5_000 },
  );
  if (!snapshotAfter) {
    snapshotAfter = await verifyGrow(page);
  }

  console.log("\n--- 成长中心积分与记录 ---");
  const reportText = formatReportZh(snapshotBefore, snapshotAfter, report);
  console.log("\n" + reportText);

  const reportPath = saveLastReport({
    before: snapshotBefore,
    after: snapshotAfter,
    task_results: report,
    report_text: reportText,
  });
  console.log(`\n报告已保存: ${reportPath}`);

  if (!headless) {
    console.log("\n按 Enter 关闭浏览器…");
    await new Promise((r) => process.stdin.once("data", r));
  }

  await browser.close();
}

main()
  .then(() => {
    // 显式退出：browser.close() 后仍可能有残留句柄（定时器/异步资源）
    // 挂住事件循环，导致进程变成孤儿常驻，进而长期占用浏览器锁。
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
