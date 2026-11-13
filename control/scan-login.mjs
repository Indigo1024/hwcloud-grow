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
/**
 * 登录态写哪 —— **必须与 runner/scripts/auth-path.mjs 的规则完全一致**，
 * 否则扫码成功了任务却读不到（表现："显示登录成功但不加账号"）。
 *
 * auth-path.mjs 的规则（2026-11-13 逐行核对）：
 *   main  → <项目根>/runner/storage/huaweicloud-auth.json        （legacy 路径）
 *   其它  → <项目根>/runner/storage/accounts/<id>/huaweicloud-auth.json
 *
 * ⚠️ 注意"其它账号"也放在 **runner** 下（不是 runner2）。
 *   早先本函数按 `runnerN` 推目录（acct2→runner2、acct3→runner3），
 *   那是错的：发布包里根本没有 runner3，用户加第三个账号必然写到不存在的目录。
 *   正确的理解是——runner2 是"第二套独立部署"，只跑 acct2 一个账号；
 *   而"在面板上继续加账号"属于**同一套部署的多账号模式**，
 *   登录态都收在 runner/storage/accounts/<id>/ 下。
 */
function authFileFor(id) {
  const env = process.env.HWCLOUD_AUTH_FILE;
  if (env) return resolve(env);
  const storageRoot = join(PROJECT_ROOT, "runner", "storage");
  if (id === "main") return join(storageRoot, "huaweicloud-auth.json");
  return join(storageRoot, "accounts", id, "huaweicloud-auth.json");
}
const TIMEOUT_SEC = Number(argVal("--timeout", "600"));

// 命名规则必须与生产一致（见 runner/scripts/accounts.mjs 的 suffixFor）：
//   main  → scan-qr.png / scan-status.json          （无后缀，兼容旧页面）
//   其它  → scan-qr-<id>.png / scan-status-<id>.json
// 之前这里一律带后缀，导致「加账号」给 main 写出 scan-status-main.json，
// 而面板读的是 scan-status.json → 永远看不到进度（2026-11-11 发现）。
const isLegacyId = accountId === "main";
const QR_PATH = join(DATA_DIR, isLegacyId ? "scan-qr.png" : `scan-qr-${accountId}.png`);
const STATUS_PATH = join(DATA_DIR, isLegacyId ? "scan-status.json" : `scan-status-${accountId}.json`);
const AUTH_FILE = authFileFor(accountId);
const AUTH_DIR = dirname(AUTH_FILE);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[scan-login:${accountId}]`, ...a);

function writeStatus(patch) {
  let cur = {};
  try { if (existsSync(STATUS_PATH)) cur = JSON.parse(readFileSync(STATUS_PATH, "utf8")); } catch {}
  const next = { ...cur, ...patch, accountId, at: Date.now() };
  mkdirSync(DATA_DIR, { recursive: true });
  try { writeFileSync(STATUS_PATH, JSON.stringify(next, null, 2)); } catch {}
}

/**
 * 把账号登记进面板的账号清单（points-index.json）。
 *
 * 为什么必须做：面板顶部的账号切换条只读这个文件的 accountOrder/accounts，
 * 而它平时由积分采集脚本维护。扫码登录是独立路径 —— 不在这里登记，
 * 用户就会看到"扫码显示登录成功，但面板里还是'还没有添加账号'"。
 *
 * 写法与 points-snapshot.mjs 一致：**增量合并**，不整体覆盖
 * （多个部署共用同一份文件，覆盖会把对方的账号抹掉）。
 */
function registerAccount(id) {
  const file = join(DATA_DIR, "points-index.json");
  let idx = { accounts: {}, accountOrder: [] };
  try {
    if (existsSync(file)) idx = JSON.parse(readFileSync(file, "utf8"));
  } catch { /* 文件损坏就重建 */ }
  if (!idx.accounts || typeof idx.accounts !== "object") idx.accounts = {};
  if (!Array.isArray(idx.accountOrder)) idx.accountOrder = [];

  // 账号名（nickname）这里拿不到 —— 它在华为云侧，要调接口才知道，
  // 由积分采集脚本负责写入（points-snapshot.mjs 的 readNickname）。
  // 这里先给个占位标签，采集跑过一次后会自动更新成真实账号名。
  const label = id === "main" ? "账号 1" : `账号 ${id}`;
  idx.accounts[id] = {
    ...(idx.accounts[id] || {}),
    label,
    nickname: (idx.accounts[id] || {}).nickname || label,
  };
  if (!idx.accountOrder.includes(id)) idx.accountOrder.push(id);
  idx.updatedAt = new Date().toISOString();
  try {
    writeFileSync(file, JSON.stringify(idx, null, 2), "utf8");
    log(`已登记到面板账号清单：${id}`);
  } catch (e) {
    log(`⚠️ 登记账号清单失败：${String(e).slice(0, 60)}`);
  }
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
        // 6) **登记到面板账号清单**（关键一步）
        //
        // 2026-11-13 修：此前只写登录态文件就结束了，账号不会出现在面板里 ——
        // 因为面板的账号列表来自 points-index.json，而那个文件只由积分采集脚本写，
        // 且它的账号清单 = 注册表 ∪ 索引里已有的，新账号两边都不在，
        // 于是"扫完码显示登录成功、但账号加不进去"。
        // 这里主动把新账号写进索引，扫码成功即刻可见。
        registerAccount(accountId);

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
