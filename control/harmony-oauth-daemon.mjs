#!/usr/bin/env node
/**
 * 鸿蒙授权链接「预热守护」：让用户点开面板时永远有一条新鲜的链接可用。
 *
 * 为什么需要：
 *   授权链接里的 state 由鸿蒙服务端签发，有效期约 10 分钟，且没有续期接口——
 *   只能重新走一次「点任务卡 → 弹授权窗」才能拿到新链接（每次约 30~60 秒）。
 *   用户要的时候现取，就得干等；现成缓存又可能刚好过期。
 *
 * 实测确认（2026-11-10）：**多次生成不会作废旧链接**，服务端不维护"仅有最后一条有效"，
 *   所以可以放心在后台反复预热——旧链接仍能用，新链接随时备好。
 *
 * 2026-11-10 踩的两个坑（据此改版）：
 *   1) 原先只靠 cron 每 30 分钟跑 `--once`：跑完就退，而链接只活 10 分钟，
 *      中间 20 分钟缓存是空的 → 用户点开就"没链接"。现在默认**常驻**。
 *   2) 两个账号**串行**预热，每个要开一次浏览器（35s+），前一个卡住会把后一个
 *      一起拖过超时。现在改成**并行**，且每次预热独立超时。
 *
 * 用法：
 *   node harmony-oauth-daemon.mjs          # 常驻（推荐，由 systemd 拉起）
 *   node harmony-oauth-daemon.mjs --once   # 只检查一轮（cron 兜底用）
 */
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { STATE_DIR as CACHE_DIR } from "./paths.mjs";
const SCRIPT = join(__dirname, "harmony-oauth.mjs");

/** 检查间隔：5 分钟（链接活 10 分钟，这个频率能保证随时有货） */
const CHECK_MS = Number(process.env.HARMONY_CHECK_MS) || 5 * 60 * 1000;
/** 剩余寿命低于这个值就预热新的（留足一次预热的时间，35~60s） */
const REFRESH_BEFORE_MS = Number(process.env.HARMONY_REFRESH_BEFORE_MS) || 4 * 60 * 1000;
/** 单次 preheat 的超时：给足一次浏览器启动 + 点页面的时间 */
const PREHEAT_TIMEOUT_MS = Number(process.env.HARMONY_PREHEAT_TIMEOUT_MS) || 150 * 1000;

const ONCE = process.argv.includes("--once");
const LOG = `${CACHE_DIR}/harmony-oauth-daemon.log`;

function log(msg) {
  const line = `[${new Date().toLocaleString("zh-CN", { hour12: false })}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG, line + "\n"); } catch {}
}

function readCache(acc) {
  const f = join(CACHE_DIR, `harmony-oauth-${acc}.json`);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}

/** 跑一次 get（它会自己决定吃缓存还是现取），带独立超时，失败不抛 */
function runGet(acc) {
  return new Promise((resolve) => {
    execFile("node", [SCRIPT, "get", acc], { timeout: PREHEAT_TIMEOUT_MS }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: String(err.message).slice(0, 120) });
      try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, error: "bad output" }); }
    });
  });
}

async function checkOne(acc) {
  const c = readCache(acc);
  if (c?.bound) {
    log(`${acc}: 已绑定（${c.login || "—"}），跳过预热`);
    return;
  }
  const left = c?.expiresAt ? c.expiresAt - Date.now() : 0;
  if (c?.url && left > REFRESH_BEFORE_MS) {
    log(`${acc}: 缓存仍新鲜（剩 ${Math.round(left / 1000)}s），不动`);
    return;
  }
  log(`${acc}: 缓存${c?.url ? "将过期" : "不存在"}，预热新链接…`);
  const t0 = Date.now();
  const r = await runGet(acc);
  const dt = Math.round((Date.now() - t0) / 1000);
  if (r.ok && r.alreadyBound) log(`${acc}: ✅ 已绑定（${r.login || "—"}）`);
  else if (r.ok) log(`${acc}: ✅ 已备好新链接（剩 ${r.leftSec ?? "?"}s，耗时 ${dt}s）`);
  else log(`${acc}: ⚠️ 预热失败（耗时 ${dt}s）${r.error || ""}`);
}

async function loop() {
  log("鸿蒙授权链接预热守护启动");
  for (;;) {
    // 并行跑两个账号：串行时前一个的 35s+ 会把后一个顶到超时（11-10 实际踩到）
    await Promise.all(
      ["main", "acct2"].map((acc) =>
        checkOne(acc).catch((e) => log(`${acc}: 异常 ${String(e).slice(0, 80)}`)),
      ),
    );
    if (ONCE) return;
    await new Promise((r) => setTimeout(r, CHECK_MS));
  }
}

loop().then(() => process.exit(0)).catch((e) => {
  log("守护异常退出: " + String(e).slice(0, 150));
  process.exit(1);
});
