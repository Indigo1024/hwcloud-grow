import { writeFileSync } from "node:fs";
import { GROW_URL, STORAGE_DIR } from "./auth-path.mjs";
import { isTodayShanghai } from "./grow-api.mjs";
import { resolveAccountId, suffixFor } from "./accounts.mjs";
import { isGrowLoggedIn } from "./auth-utils.mjs";
import { mkdirSync } from "node:fs";
import { openGrowAndWait } from "./wait-utils.mjs";
import { GROW } from "./selectors.mjs";

const AGENT_TASK_TITLES = [
  "每日签到",
  "首次开通华为云码道",
  "开通华为云码道",
  "使用智能问答",
  "体验开发者空间",
  "创建云开发环境",
];

/** @param {import('playwright').Page} page */
export async function gotoGrow(page) {
  await openGrowAndWait(page);
}

/** @param {import('playwright').Page} page */
async function closeTopModal(page) {
  const closeBtn = page.locator(".tiny-modal__close-btn").first();
  if ((await closeBtn.count()) > 0) {
    await closeBtn.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

/** 成长中心积分明细日期格式：YYYY/MM/DD（上海时区） */
export function todayShanghaiDatePrefix() {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" })
    .format(new Date())
    .split("-");
  return `${y}/${m}/${d}`;
}

/** @param {Array<{source?: string, time?: string, points?: number}> | undefined} records */
export function findTodayCheckinRecord(records) {
  const today = todayShanghaiDatePrefix();
  return records?.find((r) => isTodayShanghai(r.time) && /签到/.test(r.source || ""));
}

/** @param {import('playwright').Page} page */
export async function readPointsDetailModal(page) {
  try {
    const link = page.locator(`text=${GROW.pointsDetailLink}`).first();
    if ((await link.count()) === 0) return { error: "未找到积分明细入口" };
    await link.click({ timeout: 5000 });
    const modal = page.locator(".tiny-modal__wrapper").filter({ hasText: GROW.pointsDetailLink }).first();
    await modal.waitFor({ state: "visible", timeout: 8000 });

    const data = await modal.evaluate((el) => {
      const text = el.innerText || "";
      const currentMatch = text.match(/当前积分\s*(\d+)/);
      const records = [];
      const rowRe =
        /([^\n]+?)\s+(获得|支出)\s+([+-]?\d+)\s+(\d+)\s+(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2})/g;
      let m;
      while ((m = rowRe.exec(text)) !== null) {
        records.push({
          source: m[1].trim(),
          type: m[2],
          points: Number(m[3]),
          balance: Number(m[4]),
          time: m[5],
        });
      }
      const totalMatch = text.match(/总条数[：:]\s*(\d+)/);
      return {
        current_points: currentMatch ? Number(currentMatch[1]) : null,
        total_records: totalMatch ? Number(totalMatch[1]) : records.length,
        recent_records: records.slice(0, 10),
      };
    });

    await closeTopModal(page);
    return data;
  } catch (err) {
    await closeTopModal(page).catch(() => {});
    return { error: String(err) };
  }
}

/** @param {import('playwright').Page} page */
async function readRedeemRecords(page) {
  try {
    const link = page.locator("text=兑换记录").first();
    if ((await link.count()) === 0) return null;
    await link.click({ timeout: 5000 });
    await page.waitForTimeout(2500);

    const modal = page.locator(".tiny-modal__wrapper").filter({ hasText: "兑换记录" }).first();
    await modal.waitFor({ state: "visible", timeout: 8000 });

    const items = await modal.evaluate((el) => {
      const text = el.innerText || "";
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 4 && !/^(兑换记录|总条数|跳至)/.test(l));
      return lines.slice(0, 5);
    });

    await closeTopModal(page);
    return items;
  } catch {
    await closeTopModal(page).catch(() => {});
    return null;
  }
}

/** @param {import('playwright').Page} page */
async function readAgentTaskStatuses(page) {
  await gotoGrow(page);
  try {
    await page.locator("text=展开全部任务").first.click({ timeout: 3000 });
    await page.waitForTimeout(1500);
  } catch {
    /* optional */
  }

  return page.evaluate((titles) => {
    const seen = new Set();
    const res = [];
    for (const btn of document.querySelectorAll("button.tiny-button.btn-c")) {
      let p = btn.parentElement;
      for (let i = 0; i < 12; i++) {
        if (!p) break;
        const t = (p.innerText || "").replace(/\s+/g, " ").trim();
        if (!t.includes("积分+")) {
          p = p.parentElement;
          continue;
        }
        const title = titles.find((x) => t.includes(x));
        if (!title || seen.has(title)) break;
        seen.add(title);
        const pts = (t.match(/积分\+(\d+)/) || [])[1];
        const status = t.includes("已完成")
          ? "已完成"
          : t.includes("去完成")
            ? "未完成"
            : "未知";
        res.push({ title, points: pts ? Number(pts) : null, status });
        break;
      }
    }
    return res;
  }, AGENT_TASK_TITLES);
}

/** 单个快照子步骤的上限：超过即放弃该步、走降级分支，不让整条流程被拖死 */
const SNAPSHOT_STEP_MS = Number(process.env.HWCLOUD_SNAPSHOT_STEP_MS) || 45_000;

/** 给 promise 套一个上限，超时返回 fallback（不抛异常，调用方继续走） */
function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** @param {import('playwright').Page} page */
export async function captureGrowSnapshot(page, { includeRedeem = false } = {}) {
  // 分步打点：2026-11-10 主号卡在这一整个函数里，但外面完全看不出停在哪一步，
  // 排查耗了很久。保留这几行日志（写 stderr，不干扰正常输出格式），
  // 下次再卡能直接从日志定位。
  const step = (m) => process.stderr.write(`[snapshot] ${m}\n`);
  step("gotoGrow");
  await gotoGrow(page);
  step("isGrowLoggedIn");
  const loggedIn = await isGrowLoggedIn(page);
  step(`loggedIn=${loggedIn}`);

  const header = await page.evaluate(() => {
    const text = document.body.innerText;
    // 页面 DOM 排布是「数值在上、标签在下」：1030 \n 我的积分 \n 2 \n 已连续签到（天）
    // 所以积分取「我的积分」紧邻的前一个数字，向后取会误抓到签到期数。
    const streakMatch = text.match(/(\d+)\s*\n\s*我的积分/);
    // 排布同上：连续天数也是「数值在上、标签在下」—— 2 \n 已连续签到（天）\n +10 \n 1天…
    const streakDays = text.match(/(\d+)\s*\n\s*已连续签到/);
    return {
      display_points: streakMatch ? Number(streakMatch[1]) : null,
      streak_days: streakDays ? Number(streakDays[1]) : null,
      signed_today: text.includes("已签到"),
    };
  });
  step("header ok");

  let points = null;
  let redeem = null;
  if (loggedIn) {
    step("readPointsViaApi");
    // 给这一步一个总上限：接口层已各自带 30s 超时，但调用链里还有
    // page.evaluate / csrf 轮询等环节，整体仍可能远超预期（2026-11-10 主号
    // 这一步卡了 300s 把整条 daily-run 拖死，账号2 同一步只要 8s）。
    // 超时不当异常抛出，而是返回 null 走下面的降级分支，让流程继续。
    points = await withTimeout(readPointsViaApi(page), SNAPSHOT_STEP_MS, null);
    step(`readPointsViaApi -> ${points ? "ok" : "null/超时"}`);
    if (!points || points.current_points == null) {
      // API 不可用（csrf 未就绪等）时回退到弹窗 DOM 抓取
      step("readPointsDetailModal(回退)");
      points = await withTimeout(readPointsDetailModal(page), SNAPSHOT_STEP_MS, { error: "timeout" });
      step("readPointsDetailModal ok");
    }
    if (includeRedeem) {
      await gotoGrow(page);
      redeem = await readRedeemRecords(page);
    }
  }

  step("readAgentTaskStatuses");
  const tasks = loggedIn
    ? await withTimeout(readAgentTaskStatuses(page), SNAPSHOT_STEP_MS, [])
    : [];
  step("readAgentTaskStatuses ok");

  return {
    captured_at: new Date().toISOString(),
    logged_in: loggedIn,
    grow_url: GROW_URL,
    header,
    points,
    redeem,
    tasks,
  };
}

/**
 * 通过成长中心接口读取积分与明细。
 *
 * 优先于弹窗 DOM 抓取：弹窗渲染不稳定，常出现「暂无记录」「积分 2」这类假数据，
 * 导致无法判断任务是否真正到账。接口口径与页面一致且返回明确。
 * @param {import('playwright').Page} page
 */
async function readPointsViaApi(page) {
  try {
    const { GrowApi } = await import("./grow-api.mjs");
    const api = new GrowApi(page.context(), { page });
    const [beans, flow] = await Promise.all([api.bonusBeans(), api.bonusFlow(20)]);
    if (beans == null && !flow) return null;
    return {
      current_points: beans,
      total_records: flow ? flow.length : 0,
      recent_records: (flow || []).map((r) => ({
        source: r.source,
        // 接口 type/flag：flag=in 表示获得，余额差为正
        type: r.flag === "in" ? "获得" : r.flag === "out" ? "支出" : "",
        points: r.points,
        balance: r.balance,
        // 页面口径是 YYYY/MM/DD HH:mm，这里统一成同样格式
        time: String(r.time || "").replace(/-/g, "/").slice(0, 16),
      })),
    };
  } catch {
    return null;
  }
}

export function diffSnapshots(before, after) {
  const newRecords = [];
  if (before?.points?.recent_records && after?.points?.recent_records) {
    const beforeKeys = new Set(
      before.points.recent_records.map((r) => `${r.source}|${r.time}|${r.points}`)
    );
    for (const r of after.points.recent_records) {
      if (!beforeKeys.has(`${r.source}|${r.time}|${r.points}`)) {
        newRecords.push(r);
      }
    }
  }
  return {
    header_points_delta:
      before?.header?.display_points != null && after?.header?.display_points != null
        ? after.header.display_points - before.header.display_points
        : null,
    current_points_delta:
      before?.points?.current_points != null && after?.points?.current_points != null
        ? after.points.current_points - before.points.current_points
        : null,
    new_records: newRecords,
  };
}

export function formatTaskSummaryZh(taskResults = []) {
  const lines = [];
  lines.push("========== Agent 任务执行摘要 ==========");
  lines.push(`时间：${new Date().toISOString()}`);
  lines.push("");
  if (!taskResults.length) {
    lines.push("本次未执行任务。");
  } else {
    for (const t of taskResults) {
      lines.push(`- ${t.task_id}: ${t.status} — ${t.detail}`);
    }
  }
  lines.push("======================================");
  return lines.join("\n");
}

export function formatReportZh(before, after, taskResults = []) {
  const diff = diffSnapshots(before, after);
  const lines = [];
  lines.push("========== 成长中心运行报告 ==========");
  lines.push(`时间：${after?.captured_at || new Date().toISOString()}`);
  lines.push("");

  lines.push("【积分概览】");
  if (after?.points?.current_points != null) {
    lines.push(`- 当前可兑换积分：${after.points.current_points}`);
    if (diff.current_points_delta != null && diff.current_points_delta !== 0) {
      lines.push(
        `  本次变化：${diff.current_points_delta > 0 ? "+" : ""}${diff.current_points_delta}`
      );
    }
  } else if (after?.points?.error) {
    lines.push(`- 积分明细读取失败：${after.points.error}`);
  }
  if (after?.header?.display_points != null) {
    lines.push(`- 成长中心展示积分：${after.header.display_points}`);
    if (diff.header_points_delta != null && diff.header_points_delta !== 0) {
      lines.push(
        `  本次变化：${diff.header_points_delta > 0 ? "+" : ""}${diff.header_points_delta}`
      );
    }
  }
  if (after?.header?.streak_days != null) {
    lines.push(
      `- 连续签到：${after.header.streak_days} 天${after.header.signed_today ? "（今日已签）" : ""}`
    );
  }
  lines.push("");

  if (taskResults.length) {
    lines.push("【本次任务执行】");
    for (const t of taskResults) {
      lines.push(`- ${t.task_id}: ${t.status} — ${t.detail}`);
    }
    lines.push("");
  }

  if (after?.tasks?.length) {
    lines.push("【成长中心任务状态】");
    for (const t of after.tasks) {
      lines.push(`- ${t.title}（+${t.points}）: ${t.status}`);
    }
    lines.push("");
  }

  lines.push("【最新积分明细（前 8 条）】");
  const records = after?.points?.recent_records || [];
  if (!records.length) {
    lines.push("- 暂无记录，请在成长中心点击「积分明细」查看");
  } else {
    for (const r of records.slice(0, 8)) {
      lines.push(
        `- ${r.time} | ${r.source} | ${r.type} ${r.points > 0 ? "+" : ""}${r.points} | 余额 ${r.balance}`
      );
    }
  }

  if (diff.new_records.length) {
    lines.push("");
    lines.push("【本次新增积分记录】");
    for (const r of diff.new_records) {
      lines.push(
        `- ${r.time} | ${r.source} | ${r.type} ${r.points > 0 ? "+" : ""}${r.points}`
      );
    }
  }

  lines.push("");
  lines.push(`验证地址：${GROW_URL}`);
  lines.push("======================================");
  return lines.join("\n");
}

export function saveLastReport(payload) {
  mkdirSync(STORAGE_DIR, { recursive: true });
  // 多账号：报告按账号分别落盘，避免两个账号互相覆盖
  const path = `${STORAGE_DIR}/${suffixFor(resolveAccountId(), "last-run-report", ".json")}`;
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  return path;
}
