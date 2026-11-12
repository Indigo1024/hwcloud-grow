#!/usr/bin/env node
/**
 * CLI：把控制层能力暴露成「一行命令 → 一段 JSON」，
 * 供 Python 侧的 panel-server 调用。
 *
 * 分成 state / tasks / log / start / schedule 几个子命令而不是各自一个文件，
 * 是为了让 panel-server.py 只依赖一个固定入口，加减字段不用两边对表。
 *
 * 用法：
 *   node control-cli.mjs state
 *   node control-cli.mjs tasks  <acc>
 *   node control-cli.mjs log    <acc>
 *   node control-cli.mjs start  <acc> <taskKey>
 *   node control-cli.mjs schedule get
 *   node control-cli.mjs schedule set <acc> <daily|weekly> <0|1>
 */
import { readSchedule, setSchedule } from "./schedule.mjs";
import { DEPLOYMENTS, TASKS, FULL_DAILY } from "./tasks.mjs";
import { startTask, lastRun, tailRunLog, activeRun, history } from "./runner.mjs";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.mjs";

const [cmd, ...args] = process.argv.slice(2);

function out(o) {
  process.stdout.write(JSON.stringify(o));
}

/** 从面板数据里取该账号今日已到账的积分来源，用于给任务标「已完成」 */
/**
 * 取该账号「按周期划分」的已到账明细。
 *
 * 面板的任务按钮有每日/每周/每月三档，判定"是否已完成"必须对应各自的周期：
 *   - 每日任务看今天（今日流水）
 *   - 每周任务看本周（周一起）
 *   - 每月任务看本月（1 号起）
 * 只存在 todayFlows 里的话，周/月任务会被误判成"未完成"，
 * 于是明明做过还显示未做、还可能被重复触发。
 *
 * 数据来源：points-data*.json 的 recentFlows（含最近 30 条，够覆盖一周/一月内的
 * 关键任务）；daily 数组用于兜底推算更早的日期（周任务在周一触发时，最近 30 条
 * 通常已包含）。
 */
function flowsForPeriod(acc, period) {
  // 数据文件位置：与 auth-utils.mjs 的 dataDir() 保持同一套解析顺序
  //   环境变量 HWCLOUD_DATA_DIR / PANEL_STATIC_DIR > <项目根>/panel > /usr/share/novnc
  // 早先这里写死 /usr/share/novnc，导致换目录部署（含发布包）读不到数据、
  // 面板任务状态会全部误报"未完成"（2026-11-12 发布前扫描发现）。
  const fileName = acc === "main" ? "points-data.json" : `points-data-${acc}.json`;
  const candidates = [
    process.env.HWCLOUD_DATA_DIR,
    process.env.PANEL_STATIC_DIR,
    join(ROOT, "panel"),
    "/usr/share/novnc",
  ].filter(Boolean);
  let file = null;
  for (const d of candidates) {
    const p = join(d, fileName);
    if (existsSync(p)) { file = p; break; }
  }
  if (!file) return [];
  let d;
  try {
    d = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }

  // 周期起止（上海时区）
  const shFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const todaySh = shFmt.format(new Date());
  let startDash = null;
  if (period === "daily") {
    startDash = todaySh;
  } else if (period === "weekly") {
    const d0 = new Date(`${todaySh}T00:00:00+08:00`);
    const wd = (d0.getUTCDay() + 6) % 7; // 周一=0
    d0.setUTCDate(d0.getUTCDate() - wd);
    startDash = d0.toISOString().slice(0, 10);
  } else if (period === "monthly") {
    startDash = `${todaySh.slice(0, 7)}-01`;
  }

  const rows = [];
  // ① 明细流水（最细，但只有最近 30 条）
  const seen = new Set();
  for (const f of [...(d.recentFlows || []), ...(d.todayFlows || [])]) {
    const k = `${f.time}|${f.points}|${f.source}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({ source: f.source, time: f.time, points: f.points });
  }
  // ② bySource 聚合（含每个来源的**最后入账时间**，能覆盖到比 30 条更早的记录）。
  //    没有它的话，本周一入账、但已被后续流水挤出前 30 条的周任务会被误判成未完成
  //    （2026-11-11 主号「Star Agent 代码仓」「展览馆作品」就是这个原因）。
  for (const s of d.bySource || []) {
    if (!s?.source || !s?.lastTime) continue;
    rows.push({ source: s.source, time: s.lastTime, points: s.total || 1, fromAggregate: true });
  }

  if (!startDash) return rows; // utility 等不做周期限制
  return rows.filter((f) => {
    const dSh = utcToShanghaiDate(f.time);
    return dSh >= startDash && dSh <= todaySh;
  });
}

/** 这条流水是否属于上海时间的今天 */
function isTodayShanghai(timeStr) {
  const want = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return utcToShanghaiDate(timeStr) === want;
}

/** 积分明细里的 time 是 UTC，换算成上海日期 YYYY-MM-DD */
function utcToShanghaiDate(timeStr) {
  const s = String(timeStr || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return s.slice(0, 10);
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(utc));
}

/** 每个任务对应「已到账」的明细来源关键字（跟积分明细里的中文名对上） */
const DONE_HINTS = {
  checkin: /签到/,
  article: /发布文章/,
  devspace: /DevSpace/i,
  "harmony-view": /鸿蒙案例|浏览一个案例/,
  // 鸿蒙 Star：必须带「鸿蒙」，否则会误匹配到 Agent 的 Star
  "harmony-star": /Star一个鸿蒙|鸿蒙.*Star/i,
  // Agent 中心两个周任务：明细名是「每周Star一个Agent开发实践中心代码仓」
  // 与「每周给Agent开发实践中心代码仓提 Issue」，两者都必须带 Agent 才算，
  // 否则「每日Star一个鸿蒙案例代码仓」会被误判成 Agent 的 Star（2026-11-11 发现）。
  "agent-star": /Agent.*Star|Star.*Agent/i,
  "agent-issue": /Agent.*Issue|提 ?Issue/i,
  "lab-weekly": /实验/,
  gallery: /展览馆|作品/,
  refresh: null,
};

/**
 * 该任务在其周期内是否已完成（以官方积分明细实际到账为准）。
 * @param {string} key 任务键
 * @param {string} period 任务周期（daily/weekly/monthly/utility）
 * @param {string} acc 账号
 */
function isDone(key, period, acc) {
  const hint = DONE_HINTS[key];
  if (!hint) return null;
  const flows = flowsForPeriod(acc, period);
  return flows.some((f) => hint.test(f.source || "") && Number(f.points) > 0);
}

function stateCmd() {
  const schedule = readSchedule();
  const accounts = {};
  for (const acc of Object.keys(DEPLOYMENTS)) {
    const run = activeRun(acc);
    const last = lastRun(acc);
    accounts[acc] = {
      id: acc,
      label: DEPLOYMENTS[acc].label,
      running: !!run && !run.released,
      current: run && !run.released ? { key: run.key, title: run.title, startedAt: run.startedAt, pid: run.pid } : null,
      last: last
        ? {
            key: last.key,
            title: last.title,
            startedAt: last.startedAt,
            finishedAt: last.finishedAt,
            exitCode: last.exitCode,
            signal: last.signal,
          }
        : null,
      tail: tailRunLog(acc, 12),
      history: history(acc, 30),
      schedule: schedule[acc],
    };
  }
  out({ ok: true, at: new Date().toISOString(), accounts });
}

function tasksCmd(acc) {
  if (!DEPLOYMENTS[acc]) return out({ ok: false, error: `未知账号 ${acc}` });
  const list = [FULL_DAILY, ...TASKS]
    // hidden 的任务不在面板展示（如每周实验：平台侧长期故障，留着会误导），
    // 但脚本仍在 weekly-run.sh 里尝试，平台恢复后自动生效。
    .filter((t) => !t.hidden)
    // hiddenFor：仅对指定账号隐藏（如「每周 Star Agent 仓」对主号已做完，
    // 对账号2 仍可用）。这样两个账号看到的是各自真实可做的任务。
    .filter((t) => !(t.hiddenFor || []).includes(acc))
    .map((t) => ({
      key: t.key,
      title: t.title,
      desc: t.desc,
      period: t.period,
      points: t.points,
      // 按各自周期判定：每日看今天、每周看本周、每月看本月。
      // 只按"今天"判会把周/月任务误报成未完成（2026-11-11 用户反馈）。
      done: isDone(t.key, t.period, acc),
      full: t.key === FULL_DAILY.key,
    }));
  out({ ok: true, acc, tasks: list });
}

function logCmd(acc) {
  if (!DEPLOYMENTS[acc]) return out({ ok: false, error: `未知账号 ${acc}` });
  out({ ok: true, acc, lines: tailRunLog(acc, 40), last: lastRun(acc) });
}

function startCmd(acc, key) {
  const r = startTask(acc, key);
  out(r);
}

function scheduleCmd() {
  const [sub, ...rest] = args;
  if (sub === "set") {
    const [acc, field, val] = rest;
    const r = setSchedule(acc, field, val === "1" || val === "true");
    return out(r);
  }
  out({ ok: true, schedule: readSchedule() });
}

switch (cmd) {
  case "state": stateCmd(); break;
  case "tasks": tasksCmd(args[0]); break;
  case "log": logCmd(args[0]); break;
  case "start": startCmd(args[0], args[1]); break;
  case "schedule": scheduleCmd(); break;
  default:
    out({ ok: false, error: `未知命令 ${cmd}` });
    process.exit(2);
}
