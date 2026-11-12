#!/usr/bin/env node
/**
 * 扫码登录（独立模块）—— 给面板的「＋ 加账号」用。
 *
 * 与 runner/scripts/login-daemon.mjs 的区别：
 *   · login-daemon 是**常驻保活**服务，绑定固定账号清单（accounts.mjs），
 *     服务端重启后要重新配置才能换账号
 *   · 本模块是**一次性**任务：拉一次二维码 → 等扫码 → 存入指定账号的登录态 → 退出。
 *     谁调用它、用哪个账号 id，完全由参数决定，不依赖账号注册表。
 *     这样"加账号"才能在**全新安装**（一个账号都没有）时也跑得通。
 *
 * 用法:
 *   node control/scan-login.mjs <accountId> [--data-dir DIR] [--timeout SEC]
 *
 * 产出:
 *   <数据目录>/scan-qr-<accountId>.png      二维码图片
 *   <数据目录>/scan-status-<accountId>.json 状态（waiting/done/expired/error）
 *   <登录态目录>/<accountId>.json           扫码成功后的 storageState
 *
 * 退出码: 0=登录成功  3=超时未扫  2=启动失败
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const args = process.argv.slice(2);
const accountId = args[0];
if (!accountId) {
  console.error("用法: node scan-login.mjs <accountId> [--data-dir DIR] [--timeout SEC]");
  process.exit(2);
}
function argVal(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}
// 二维码/状态写哪：默认与面板同目录（panel/），发布包和生产都能用
const DATA_DIR = resolve(argVal("--data-dir", process.env.PANEL_STATIC_DIR || join(PROJECT_ROOT, "panel")));
// 登录态存哪：按账号分目录，便于多账号隔离
const AUTH_DIR = resolve(argVal("--auth-dir", process.env.HWCLOUD_AUTH_DIR || join(PROJECT_ROOT, "storage", "accounts")));
const TIMEOUT_SEC = Number(argVal("--timeout", "600"));

// 命名规则必须与生产一致（见 runner/scripts/accounts.mjs 的 suffixFor）：
//   main  → scan-qr.png / scan-status.json          （无后缀，兼容旧页面）
//   其它  → scan-qr-<id>.png / scan-status-<id>.json
// 之前这里一律带后缀，导致「加账号」给 main 写出 scan-status-main.json，
// 而面板读的是 scan-status.json → 永远看不到进度（2026-11-11 发现）。
const isLegacyId = accountId === "main";
const QR_PATH = join(DATA_DIR, isLegacyId ? "scan-qr.png" : `scan-qr-${accountId}.png`);
const STATUS_PATH = join(DATA_DIR, isLegacyId ? "scan-status.json" : `scan-status-${accountId}.json`);
const AUTH_FILE = join(AUTH_DIR, `${accountId}.json`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[scan-login:${accountId}]`, ...a);

function writeStatus(patch) {
  let cur = {};
  try { if (existsSync(STATUS_PATH)) cur = JSON.parse(readFileSync(STATUS_PATH, "utf8")); } catch {}
  const next = { ...cur, ...patch, accountId, at: Date.now() };
  mkdirSync(DATA_DIR, { recursive: true });
  try { writeFileSync(STATUS_PATH, JSON.stringify(next, null, 2)); } catch {}
}

// 复用各 runner 里的 playwright（发布包与生产都是 node_modules 在 runner/ 下）
function findPlaywright() {
  for (const rel of ["runner", "runner2"]) {
    const p = join(PROJECT_ROOT, rel, "node_modules", "playwright", "index.mjs");
    if (existsSync(p)) return p;
  }
  return "playwright";
}
function findQRCode() {
  for (const rel of ["runner", "runner2"]) {
    for (const p of [
      join(PROJECT_ROOT, rel, "node_modules", "qrcode", "lib", "index.js"),
      join(PROJECT_ROOT, rel, "node_modules", "qrcode", "index.js"),
    ]) {
      if (existsSync(p)) return p;
    }
  }
  return "qrcode";
}

/**
 * 启动前检查依赖是否就位，缺了就给**可执行的指引**。
 *
 * 为什么单独查：新用户 clone 下来最常见的漏步就是"没跑 npm install"，
 * 而 Node 的原始报错是
 *   `Cannot find package 'playwright' imported from .../control/scan-login.mjs`
 * ——从 control/ 目录看这个错很费解（依赖其实在 runner/ 下）。
 * 直接告诉他去哪个目录装什么，比让他猜快得多。
 * （2026-11-11 发布包上实测踩到。）
 */
function assertDeps() {
  // 任一 runner 里装了 playwright 就够（findPlaywright 会依次查找）。
  // 要求"两个都装"是错的：只跑一个账号的用户可能只装了 runner。
  for (const rel of ["runner", "runner2"]) {
    const dir = join(PROJECT_ROOT, rel);
    if (existsSync(join(dir, "node_modules", "playwright"))) return null;
  }
  return (
    "依赖未安装（没找到 playwright）。请先执行：\n" +
    "    cd " + join(PROJECT_ROOT, "runner") + "\n" +
    "    npm install\n" +
    "    npx playwright install chromium\n" +
    "  （或直接跑 node control/doctor.mjs 查看完整环境检查）"
  );
}

const LOGIN_SERVICE = "https://developer.huaweicloud.com/grow";
const LOGIN_URL =
  "https://auth.huaweicloud.com/authui/login?service=" +
  encodeURIComponent(LOGIN_SERVICE) + "&locale=zh-cn";

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(AUTH_DIR, { recursive: true });
  writeStatus({ status: "starting", message: "正在打开登录页…" });

  // 依赖先查：缺了就不要走到浏览器启动那一步，给可执行的指引
  const depErr = assertDeps();
  if (depErr) {
    writeStatus({ status: "error", message: "依赖未安装：" + depErr.split("\n")[0] });
    console.error("[scan-login] " + depErr);
    return 2;
  }

  const { chromium } = await import(findPlaywright());
  const QRCodeMod = await import(findQRCode());
  const QRCode = QRCodeMod.default || QRCodeMod;

  const headless = process.env.HWCLOUD_SCAN_HEADLESS === "1";
  const browser = await chromium.launch({
    headless,
    args: headless
      ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run"]
      : ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--start-maximized"],
  });

  const deadline = Date.now() + TIMEOUT_SEC * 1000;
  let round = 0;

  try {
    const ctx = await browser.newContext({ locale: "zh-CN" });
    const page = await ctx.newPage();

    // 导航带重试：本机多网卡/代理时 Chromium 会抛 ERR_NETWORK_CHANGED
    for (let i = 1; i <= 5; i++) {
      try { await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 }); break; }
      catch (e) {
        if (i === 5) throw e;
        log(`导航抖动第 ${i} 次，重试…`);
        await sleep(4000 * i);
      }
    }

    for (;;) {
      if (Date.now() > deadline) {
        writeStatus({ status: "expired", ok: false, message: `等待扫码超过 ${Math.round(TIMEOUT_SEC / 60)} 分钟，已放弃` });
        log("超时未扫码");
        return 3;
      }
      round++;

      // 1) 取二维码内容
      const data = await page.evaluate(async () => {
        const r = await fetch("/authui/qrcode", {
          credentials: "include", cache: "no-store",
          headers: { accept: "application/json" },
        });
        return await r.json().catch(() => null);
      }).catch(() => null);

      if (!data?.qrcode_content) {
        writeStatus({ status: "error", message: "取二维码失败，重试中…" });
        await sleep(5000);
        continue;
      }

      // 2) 渲染成 PNG
      const png = await QRCode.toBuffer(data.qrcode_content, { width: 420, margin: 1 });
      writeFileSync(QR_PATH, png);
      writeStatus({ status: "waiting", ok: null, round, message: `等待扫码…（第 ${round} 轮）` });
      log(`第 ${round} 轮二维码已生成`);

      // 3) 轮询扫码状态
      const clientKey = data.client_key;
      const qrDeadline = Date.now() + 110_000; // 二维码约 2 分钟失效
      let scanned = false;
      while (Date.now() < qrDeadline) {
        await sleep(3000);
        const st = await page.evaluate(async ({ ck, service }) => {
          const qs = new URLSearchParams({ client_key: ck, service });
          const r = await fetch("/authui/qrcode/status?" + qs.toString(), {
            credentials: "include", cache: "no-store",
            headers: { accept: "application/json" },
          });
          return await r.json().catch(() => null);
        }, { ck: clientKey, service: LOGIN_SERVICE }).catch(() => null);

        const code = String(st?.status ?? st?.qrcode_status ?? "");
        if (/authorized|confirmed|success|scanned/i.test(code)) { scanned = true; break; }
        if (/expired|invalid/i.test(code)) break;
      }

      if (!scanned) {
        log(`第 ${round} 轮未扫或已过期，换新码`);
        continue;
      }

      // 4) 扫码通过 → 等跳转落定 → 抓登录态
      writeStatus({ status: "checking", message: "扫码成功，正在保存登录态…" });
      log("扫码已确认，等待会话落定…");
      await sleep(6000);
      // 打开成长中心，确保 SSO 换票完成、cookie 齐全
      await page.goto(LOGIN_SERVICE, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
      await sleep(5000);

      const state = await ctx.storageState();
      writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });

      // 5) 校验真的登录上了（不是只看 cookie 存在）
      const ok = await page.evaluate(() => /我的积分|积分明细/.test(document.body.innerText)).catch(() => false);
      if (ok) {
        writeStatus({ status: "done", ok: true, message: "✅ 登录成功", authFile: AUTH_FILE });
        log(`✅ 登录成功，登录态已保存到 ${AUTH_FILE}`);
        return 0;
      }
      writeStatus({ status: "error", ok: false, message: "已扫码但未进入登录态，请重试" });
      log("⚠️ 已扫码但校验失败");
      return 2;
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

main()
  .then((rc) => process.exit(rc ?? 0))
  .catch((e) => {
    writeStatus({ status: "error", message: "启动失败：" + String(e?.message || e).slice(0, 120) });
    console.error("异常:", e?.message || e);
    process.exit(2);
  });
