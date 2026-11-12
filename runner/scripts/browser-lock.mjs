#!/usr/bin/env node
/**
 * 浏览器互斥锁：同一账号同时只允许一个进程开浏览器访问华为云。
 *
 * 为什么必须这么做（2026-11-11 调研结论）：
 *   华为云 SSO 的 `SSOTGC`（auth.huaweicloud.com 上的会话级 cookie）**每换一次票
 *   就会被消费一次**。而本机有 4 个组件在各自开浏览器、共用同一份 cookie 快照：
 *     ① 登录守护（每 30 分钟保活）
 *     ② 积分采集 refresh-points（每 30 分钟）
 *     ③ 鸿蒙授权链接预热（每 5 分钟）
 *     ④ 面板的状态查询 / 手动任务
 *   它们互不协调 → 谁都可能把 TGC 用掉 → 别的组件再访问就回落成「登录/注册」，
 *   日志表现为莫名其妙的 `logged-out`、必须人工重扫。这就是「老被踢」的机制。
 *
 * 做法：给每个账号一把 `.huaweicloud-browser-<acc>.lock`。
 *   所有要开浏览器访问华为云的流程，开始前先 acquire、结束 release。
 *   - 拿不到锁时：默认**等待**（带超时）；等不到就放弃本次（保活/采集这类可跳过，
 *     不该因为抢不到锁而报错，更不该并发硬上）。
 *
 * 用法（脚本里）:
 *   import { withBrowserLock } from "./browser-lock.mjs";
 *   await withBrowserLock("main", async () => { ...开浏览器的逻辑... });
 *
 * 命令行（供 shell 脚本用）:
 *   node browser-lock.mjs acquire main [timeoutSec]   # 退出码 0=拿到, 3=超时
 *   node browser-lock.mjs release main
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_DIR = "/tmp";

export function lockPath(acc) {
  return join(LOCK_DIR, `.huaweicloud-browser-${acc}.lock`);
}

/** 持有者是否还活着（死进程留下的锁要能自动回收，否则一次异常就永久卡住） */
function holderAlive(acc) {
  const f = lockPath(acc);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (!j.pid) return null;
    process.kill(j.pid, 0); // 活着则不抛
    return j;
  } catch {
    // 进程不在（或文件损坏）→ 视为无主锁
    try { unlinkSync(f); } catch {}
    return null;
  }
}

/**
 * 尝试拿锁（非阻塞）。
 * @returns {boolean} 是否拿到
 */
export function tryAcquire(acc, note = "") {
  const held = holderAlive(acc);
  if (held) return false;
  try {
    writeFileSync(
      lockPath(acc),
      JSON.stringify({ pid: process.pid, acc, note, at: Date.now() }, null, 2),
      { flag: "w" },
    );
    return true;
  } catch {
    return false;
  }
}

export function release(acc) {
  try {
    const f = lockPath(acc);
    if (!existsSync(f)) return;
    const j = JSON.parse(readFileSync(f, "utf8"));
    if (j.pid === process.pid) unlinkSync(f);
  } catch {}
}

/**
 * 等到拿到锁为止。
 * @param {string} acc
 * @param {{timeoutMs?:number, note?:string, pollMs?:number}} opts
 * @returns {Promise<boolean>}
 */
export async function acquire(acc, { timeoutMs = 180_000, note = "", pollMs = 1500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryAcquire(acc, note)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/**
 * 包一层：拿锁 → 执行 → 释放。
 * 拿不到锁时不执行 fn，直接返回 { ok:false, reason:"busy" }。
 */
export async function withBrowserLock(acc, fn, { timeoutMs = 180_000, note = "" } = {}) {
  const got = await acquire(acc, { timeoutMs, note });
  if (!got) return { ok: false, reason: "busy" };
  try {
    return { ok: true, value: await fn() };
  } finally {
    release(acc);
  }
}

// ---- 命令行入口（供 shell 脚本）----
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , cmd, acc, sec] = process.argv;
  if (!acc) { console.error("用法: browser-lock.mjs acquire|release <acc> [timeoutSec]"); process.exit(2); }
  if (cmd === "acquire") {
    const ok = await acquire(acc, { timeoutMs: (Number(sec) || 180) * 1000, note: "cli" });
    if (!ok) { console.error(`[browser-lock] ${acc} 等待超时（另有进程在访问）`); process.exit(3); }
    process.stdout.write("locked");
    process.exit(0);
  }
  if (cmd === "release") { release(acc); process.exit(0); }
  console.error(`未知命令 ${cmd}`);
  process.exit(2);
}
