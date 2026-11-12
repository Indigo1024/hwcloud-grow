#!/usr/bin/env node
/**
 * 记录 cron 触发的一轮运行，让它也出现在面板「运行历史」里。
 *
 * 为什么需要：面板触发走 runner.mjs（自动记账），而 cron 直接调 daily-run.sh /
 * weekly-run.sh，不经过那一层。不补这一笔，历史里就只有手动运行的记录，
 * 用户看不出「定时到底有没有按时跑」——恰恰是他最关心的。
 *
 * 用法（由 daily-run.sh / weekly-run.sh 调用）：
 *   node record.mjs begin <acc> <key> <title>      输出 runId 到 stdout
 *   node record.mjs end   <acc> <runId> <exitCode>
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { ROOT, RUNS_DIR as RUNS_DIR_FROM_PATHS } from "./paths.mjs";
const RUNS_DIR = RUNS_DIR_FROM_PATHS;
const LOCK_DIR = join(ROOT, "state", "locks");
mkdirSync(RUNS_DIR, { recursive: true });
mkdirSync(LOCK_DIR, { recursive: true });

const [, , cmd, ...args] = process.argv;

/** 该账号的锁文件：与面板执行器共用，避免 cron 与手动任务并发跑同一账号 */
function lockPath(acc) {
  return join(LOCK_DIR, `${acc}.lock`);
}

/**
 * 锁是否被别人持有（进程还活着才算）。
 * 与 runner.mjs 的 readLock 同源逻辑：死 pid 视为未持有，
 * 否则一次异常退出就会把该账号永久锁死、再也不自动跑。
 */
function lockHeldByOther(acc) {
  const f = lockPath(acc);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (!j.pid) return null;
    process.kill(j.pid, 0); // 活着 → 抛不出错
    return j;
  } catch {
    return null;
  }
}

if (cmd === "begin") {
  const [acc, key, title] = args;

  // 并发闸门：本轮要么由面板执行器负责（它已占锁），要么由本脚本占锁。
  // 无论哪种，都要先确认没有别的轮次在跑同一个账号。
  //
  // 2026-11-09 踩坑：原实现只写锁、不检查锁。结果 cron 的 00:50 轮次
  // 在面板手动触发的 00:46 轮次还在跑时照样启动，两个 daily-run 并发
  // 抢浏览器 → 互相把对方挤掉、还可能重复发文（11-08 就是重复发文）。
  if (process.env.HWCLOUD_PANEL_RUN !== "1") {
    const held = lockHeldByOther(acc);
    if (held) {
      // 退出码 4：与 run.sh 里判断用的约定值，让调用方直接跳过本轮
      process.stderr.write(
        `[record] 跳过：账号 ${acc} 已有任务在运行（${held.title || held.key}，pid=${held.pid}）\n`,
      );
      process.exit(4);
    }
  }

  const runId = `${Date.now()}-${key}`;
  const startedAt = new Date().toISOString();
  // pid 必须是那个**真正活着的**进程，面板的 readLock 靠 kill(pid,0) 探活。
  //
  // 踩过的坑（2026-11-09）：原来写 process.ppid，但本脚本是被
  //   RUN_REC_ID=$(node record.mjs begin ...)
  // 这种命令替换调用的——$( ) 会 fork 一个子 shell，其 pid 就是 ppid，
  // 而它拿完输出立刻退出。于是锁里存的是一个死 pid，面板永远判成「空闲」，
  // 明明任务在跑却显示空闲、还能被重复触发。
  //
  // 正解：由调用方（run.sh / 面板执行器）把「该被监测的存活进程 pid」传进来。
  const alivePid = Number(process.env.HWCLOUD_ALIVE_PID || 0) || null;
  const rec = {
    runId,
    acc,
    key,
    title: title || key,
    desc: process.env.HWCLOUD_RUN_DESC || "cron 定时触发",
    startedAt,
    finishedAt: null,
    exitCode: null,
    trigger: process.env.HWCLOUD_RUN_TRIGGER || "cron",
    logFile: null,
    pid: alivePid,
  };
  writeFileSync(join(RUNS_DIR, `run-${acc}-${runId}.json`), JSON.stringify(rec, null, 2), "utf8");
  // 同时占锁：面板点「运行」时会看到该账号已有任务在跑而拒绝，
  // 避免 cron 与手动触发并发抢浏览器（11-08 曾因并发跑出重复发文）。
  writeFileSync(lockPath(acc), JSON.stringify(rec), "utf8");
  prune(acc);
  process.stdout.write(runId);
} else if (cmd === "end") {
  const [acc, runId, code] = args;
  const f = join(RUNS_DIR, `run-${acc}-${runId}.json`);
  const patch = { finishedAt: new Date().toISOString(), exitCode: Number(code) };
  if (!existsSync(f)) process.exit(0);
  try {
    const rec = JSON.parse(readFileSync(f, "utf8"));
    Object.assign(rec, patch);
    writeFileSync(f, JSON.stringify(rec, null, 2), "utf8");
  } catch {}
  // 锁只在还是自己这轮时才删，避免误删后来者写的锁
  try {
    const cur = JSON.parse(readFileSync(lockPath(acc), "utf8"));
    if (cur.runId === runId) unlinkSync(lockPath(acc));
  } catch {}
} else {
  process.stderr.write("用法: record.mjs begin|end ...\n");
  process.exit(2);
}

/** 与 runner.mjs 一致的保留上限，防止 state/ 无限增长 */
function prune(acc) {
  try {
    const files = readdirSync(RUNS_DIR)
      .filter((f) => f.startsWith(`run-${acc}-`) && f.endsWith(".json"))
      .map((f) => ({ f, t: JSON.parse(readFileSync(join(RUNS_DIR, f), "utf8")).startedAt || "" }))
      .sort((a, b) => String(b.t).localeCompare(String(a.t)));
    for (const { f } of files.slice(200)) {
      try { unlinkSync(join(RUNS_DIR, f)); } catch {}
    }
  } catch {}
}
