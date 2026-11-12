#!/usr/bin/env node
/**
 * 积分快照采集：把成长中心的余额 + 明细落盘成看板可读的数据。
 *
 * 产出（都被 http://<主机>:6080/ 直接托管）：
 *   /usr/share/novnc/points-data.json   看板数据（当前总分、每日增量、明细、兑换入口）
 *   runner/data/points-history.jsonl    每次采集的历史（追加一行，用于回溯）
 *
 * 用法：
 *   node scripts/points-snapshot.mjs          # 采集一次
 *   node scripts/points-snapshot.mjs --quiet  # 静默（供定时任务用）
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAuthFile,  dataDir } from "./auth-utils.mjs";
import { GrowApi, shanghaiDate } from "./grow-api.mjs";
import { resolveAccountId, suffixFor, getAccount, ACCOUNT_IDS } from "./accounts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = join(ROOT, "data");

/**
 * 把积分明细里的 time（UTC，「YYYY-MM-DD HH:mm:ss」）换算成上海日期「YYYY-MM-DD」。
 *
 * 为什么必须换算：接口的 time 是 UTC，而"今天"用的是上海时区。
 * 直接拿 UTC 日期跟上海日期比，凌晨 0~8 点（上海）的记录会被算进前一天，
 * 表现为「明明签到了，面板今日却是 +0」（2026-11-10 实际踩到）。
 */
function utcToShanghaiDate(timeStr) {
  const s = String(timeStr || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return s.slice(0, 10);
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  return fmt.format(new Date(utc));
}

// 多账号：每个账号写自己的看板文件与历史，互不覆盖。
// 主号沿用 points-data.json（旧页面仍可直接读），新号写 points-data-<id>.json。
const ACCOUNT_ID = resolveAccountId();
const ACCOUNT = getAccount(ACCOUNT_ID);
const HISTORY_FILE = join(DATA_DIR, `points-history-${ACCOUNT_ID}.jsonl`);
const DASHBOARD_FILE = `${dataDir()}/${suffixFor(ACCOUNT_ID, "points-data", ".json")}`;
/**
 * 汇总索引：所有账号的最新数据都写进这一个文件，供页面一次性拉取后切换。
 * 页面不必知道有哪些账号文件，读索引即可。
 */
const INDEX_FILE = `${dataDir()}/points-index.json`;

const QUIET = process.argv.includes("--quiet");
const log = (...a) => !QUIET && console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/** 兑换/入口链接（看板顶部按钮） */
const LINKS = {
  grow: "https://developer.huaweicloud.com/grow",
  console: "https://console.huaweicloud.com", // 华为云控制台
  gallery: "https://gallery.developer.huaweicloud.com/gallery/submit-guide",
  bbs: "https://bbs.huaweicloud.com/blogs/article",
  scan: "/scan.html",
};

/** 明细按「来源」归并，便于看板按任务统计 */
function groupBySource(flows) {
  const map = new Map();
  for (const f of flows) {
    const key = f.source || "其他";
    const cur = map.get(key) || { source: key, total: 0, count: 0, lastTime: "" };
    cur.total += f.points;
    cur.count += 1;
    if (f.time > cur.lastTime) cur.lastTime = f.time;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function readHistory() {
  if (!existsSync(HISTORY_FILE)) return [];
  return readFileSync(HISTORY_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-features=NetworkServiceInProcess,NetworkChangeNotifier", "--disable-background-networking", "--disable-component-update", "--no-first-run"] });
  // 多账号：storageState 按账号取，未登录时给出明确提示而不是静默失败
  const authFile = resolveAuthFile(ACCOUNT_ID);
  if (!existsSync(authFile)) {
    console.error(`❌ [${ACCOUNT_ID}] 尚未登录（缺少 ${authFile}），请先扫码登录该账号`);
    process.exit(3);
  }
  const ctx = await browser.newContext({ storageState: authFile, locale: "zh-CN" });
  const api = new GrowApi(ctx);

  let payload;
  try {
    const beans = await api.bonusBeans();

    if (beans === null) {
      // 区分「未登录」与「真的没有数据」：掉线时接口返回登录页 HTML，
      // 旧代码会当成 todayGain=0 写进看板，看着像「任务没跑」——
      // 2026-11-11 实际踩到，排查方向被带偏很久。
      // 这里直接报错退出（退出码 3），并保留上一次的有效数据。
      console.error(`❌ [${ACCOUNT_ID}] 登录态失效（接口返回登录页），本次不更新看板。请先扫码登录。`);
      log(`❌ [${ACCOUNT_ID}] 登录态失效，跳过采集（保留上次数据）`);
      try { await browser.close(); } catch {}
      process.exit(3);
    }    const flows = (await api.bonusFlow(60)) || [];
    const mine = await api.myMissions();
    const nickname = await readNickname(api);
    const today = shanghaiDate();
    const todayStr = today.replace(/\//g, "-");

    if (beans === null) {
      log("❌ 未登录或接口异常，余额拿不到");
      process.exitCode = 2;
      return;
    }

    // 今日增量：明细里今天的加分之和。
    //
    // ⚠️ 接口返回的 time 是 **UTC**，必须换算成上海时间再比日期。
    // 2026-11-10 踩到：主号凌晨 03:28（上海）签的到，接口给的是
    // 「2026-11-09 19:28」（UTC），直接跟"上海今天"比会算进昨天，
    // 面板整天显示今日 +0，看起来像"任务压根没跑"。
    const todayFlows = flows.filter((f) => utcToShanghaiDate(f.time) === todayStr);
    const todayGain = todayFlows.reduce((s, f) => s + f.points, 0);

    // 按天汇总明细：delta 一律以「当天明细入账合计」为准。
    // 早期版本用余额差 (beams - prev.beans) 做 delta，同一天多次采集、
    // 或中间某天没采集时会把差额算到错误的日子上，导致增量为负/虚高。
    const flowByDate = new Map();
    for (const f of flows) {
      // 同样要换算时区：明细的 time 是 UTC，按 UTC 日期分组会和
      // 「上海日期」的历史快照对不齐（凌晨的记录落到前一天）。
      const d = utcToShanghaiDate(f.time);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      flowByDate.set(d, (flowByDate.get(d) || 0) + f.points);
    }

    // 历史快照：同一天只保留最后一条（余额取最新），不再直接丢弃旧记录
    const histMap = new Map();
    for (const h of readHistory()) {
      if (h?.date) histMap.set(h.date, h);
    }
    // 用明细回填历史里缺失的日期（明细带 balance，可还原当天收盘余额）。
    // 老版本「同一天只留一条」曾把中间日期删掉，导致增量序列断档。
    for (const [d, gain] of flowByDate) {
      if (histMap.has(d)) continue;
      // 该日最后一条流水的 balance 即当天收盘余额
      const lastOfDay = flows
        .filter((f) => String(f.time || "").startsWith(d))
        .sort((a, b) => (a.time < b.time ? -1 : 1))
        .pop();
      if (lastOfDay && typeof lastOfDay.balance === "number") {
        histMap.set(d, { date: d, at: `${d}T23:59:59.000Z`, beans: lastOfDay.balance, backfilled: true });
      } else {
        // 没有 balance 时按增量倒推当天余额（次日余额已知，此处仅占位）
        histMap.set(d, { date: d, at: `${d}T23:59:59.000Z`, beans: null, gain, backfilled: true });
      }
    }
    histMap.set(todayStr, { date: todayStr, at: new Date().toISOString(), beans });
    const hist = [...histMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    writeFileSync(HISTORY_FILE, hist.map((h) => JSON.stringify(h)).join("\n") + "\n", "utf8");

    // 每日增量序列：优先用明细合计；明细查不到的日期才退回余额差
    const daily = hist.map((h, i) => {
      const fromFlow = flowByDate.get(h.date);
      const prev = i > 0 ? hist[i - 1].beans : null;
      const byBalance = prev !== null && h.beans !== null && prev !== null ? h.beans - prev : null;
      const delta = fromFlow !== undefined ? fromFlow : byBalance;
      return {
        date: h.date,
        beans: h.beans,
        delta,
        // 明细可覆盖的日期最准；余额差在「缺采样的下一天」会失真
        source: fromFlow !== undefined ? "flow" : byBalance !== null ? "balance" : "none",
      };
    });

    // 周增量：本周（周一至今）的明细合计
    const weekStart = (() => {
      const d = new Date(`${todayStr}T00:00:00+08:00`);
      const wd = (d.getUTCDay() + 6) % 7; // 周一=0
      d.setUTCDate(d.getUTCDate() - wd);
      return d.toISOString().slice(0, 10);
    })();
    const weekGain = [...flowByDate.entries()]
      .filter(([d]) => d >= weekStart && d <= todayStr)
      .reduce((s, [, v]) => s + v, 0);

    const missions = mine?.missions || [];
    payload = {
      updatedAt: new Date().toISOString(),
      updatedAtLocal: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      beans,
      todayDate: todayStr,
      todayGain,
      weekStart,
      weekGain,
      todayFlows: todayFlows.map((f) => ({ time: f.time, points: f.points, source: f.source })),
      daily,
      recentFlows: flows.slice(0, 30),
      bySource: groupBySource(flows),
      missions: {
        total: missions.length,
        finished: missions.filter((m) => m.isFinish).length,
        pending: missions
          .filter((m) => !m.isFinish)
          .map((m) => ({ title: m.title, bonus: m.bonus, period: m.period, url: m.url })),
        done: missions
          .filter((m) => m.isFinish)
          .map((m) => ({ title: m.title, bonus: m.bonus, period: m.period })),
      },
      links: LINKS,
      // 账号标识：页面据此区分是谁的数据，并显示昵称
      account: {
        id: ACCOUNT_ID,
        label: ACCOUNT.label,
        nickname: nickname || ACCOUNT.label,
        legacy: ACCOUNT.legacy,
      },
      ok: true,
    };

    writeFileSync(DASHBOARD_FILE, JSON.stringify(payload, null, 2), "utf8");
    updateIndex(payload);
    log(`✅ [${ACCOUNT_ID}] 已更新看板：总分 ${beans} | 今日 +${todayGain} | 本周 +${weekGain} | 任务 ${payload.missions.finished}/${payload.missions.total}`);
    log(`   看板数据 → ${DASHBOARD_FILE}`);
  } finally {
    await api.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * 从成长中心页面读昵称。
 *
 * 页面里有两个身份：
 *   - .header-user          → 华为云登录账号，如 hw_account_main
 *   - .user-message-view-userValue → 社区昵称，如 yd_main
 * 页面上要和社区对应，取后者更直观；取不到再回退到账号名、最后回退到配置里的 label。
 *
 * @param {GrowApi} api
 * @returns {Promise<string|null>}
 */
async function readNickname(api) {
  try {
    // bonusBeans() 内部会确保页面已加载到成长中心，之后 api.page 即可读 DOM。
    // 不直接调 #page()（私有方法，外部访问不到）。
    if (!api.page || api.page.isClosed()) return null;
    const page = api.page;
    const nick = await page.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        const t = (el?.innerText || "").trim().split("\n")[0].trim();
        return t || null;
      };
      return (
        pick(".user-message-view-userValue") ||
        pick(".user-message-view-userValue-item-text") ||
        pick(".header-user") ||
        pick(".bottom-username")
      );
    });
    return nick;
  } catch {
    return null;
  }
}

/**
 * 把本次采集结果合并进汇总索引，供页面一次拉取所有账号。
 *
 * 单独成文而不是让页面分别请求：页面要能「切到还没采集过的账号」时给出
 * 明确的「尚未采集」提示，而不是 404 让前端一脸茫然。
 *
 * @param {object} payload 当前账号的看板数据
 */
function updateIndex(payload) {
  let index = { updatedAt: null, accounts: {} };
  if (existsSync(INDEX_FILE)) {
    try {
      index = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
    } catch {
      /* 索引损坏就重建，不影响主流程 */
    }
  }
  index.accounts = index.accounts || {};
  index.accounts[ACCOUNT_ID] = {
    label: payload.account.label,
    nickname: payload.account.nickname,
    beans: payload.beans,
    todayGain: payload.todayGain,
    weekGain: payload.weekGain,
    missions: {
      total: payload.missions.total,
      finished: payload.missions.finished,
    },
    collectedAt: payload.updatedAt || payload.collectedAt || new Date().toISOString(),
  };
  // 账号顺序固定按注册表来，避免对象键序随采集先后漂移。
  // 但只把「本部署认识的账号」写进 order 是不够的：runner 和 runner2 各自维护
  // 同一份 points-index.json，runner2 只认 acct2，一写就把 main 从切换条里抹掉，
  // 看板上只剩一个新号。所以 order = 注册表 ∪ 索引里已有的账号。
  const ordered = {};
  for (const id of Object.keys(index.accounts).sort()) {
    if (index.accounts[id]) ordered[id] = index.accounts[id];
  }
  index.accounts = ordered;
  const known = new Set(ACCOUNT_IDS);
  for (const id of Object.keys(index.accounts)) known.add(id);
  index.accountOrder = [...known];
  index.updatedAt = new Date().toISOString();
  writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf8");
}

main().catch((e) => {
  console.error("异常:", e);
  process.exit(1);
});
