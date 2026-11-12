#!/usr/bin/env node
/**
 * 登录态自愈探针
 *
 * 目的：验证「只靠已保存的 storageState 能否自动恢复登录」，以及
 * 把 session cookie 显式续期（持久化 expires）后效果是否更好。
 *
 * 用法: node scripts/auth-doctor.mjs
 */
import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { authPathsFor, GROW_URL } from "./auth-path.mjs";
import { resolveAccountId } from "./accounts.mjs";

// 按账号操作：auth-doctor 会把续期后的 Cookie 写回原文件，
// 用固定的 AUTH_FILE（= 主号路径）对 acct2 跑，等于拿主号 Cookie 探测、
// 又把结果回写进主号文件，主号当场被污染。
const ACCOUNT_ID = resolveAccountId(process.env.HWCLOUD_ACCOUNT);
const AUTH_FILE = authPathsFor(ACCOUNT_ID).authFile;

/** 会话 cookie 的续期天数：SSOTGC 等本是长期票，Playwright 抓下来丢了 expires */
const SESSION_COOKIE_TTL_DAYS = 30;
const PERSIST_NAMES = new Set(["SSOTGC", "SSOJTC", "SessionID", "koocdp_sid"]);

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a);
}

function load() {
  return JSON.parse(readFileSync(AUTH_FILE, "utf8"));
}

function analyze(state) {
  const now = Date.now() / 1000;
  const cookies = state.cookies || [];
  const session = cookies.filter((c) => !c.expires || c.expires <= 0);
  const expired = cookies.filter((c) => c.expires > 0 && c.expires < now);
  const persistable = session.filter((c) => PERSIST_NAMES.has(c.name));
  return { cookies, session, expired, persistable };
}

/** 把关键 session cookie 显式续期，写回文件 */
function persistSessionCookies(state) {
  const ttl = SESSION_COOKIE_TTL_DAYS * 86400;
  let n = 0;
  for (const c of state.cookies || []) {
    if ((!c.expires || c.expires <= 0) && PERSIST_NAMES.has(c.name)) {
      c.expires = Math.floor(Date.now() / 1000) + ttl;
      n++;
    }
  }
  return n;
}

async function probe(label, statePath) {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-features=NetworkServiceInProcess,NetworkChangeNotifier", "--disable-background-networking", "--disable-component-update", "--no-first-run"] });
  const ctx = await browser.newContext({
    storageState: statePath,
    locale: "zh-CN",
  });
  const page = await ctx.newPage();
  let ok = false;
  try {
    await page.goto(GROW_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(2500);
      const t = await page.innerText("body").catch(() => "");
      if (t.includes("我的积分") || t.includes("积分明细")) {
        ok = true;
        break;
      }
      if (t.includes("登录/注册查看您的积分")) break;
      if (i === 4) await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
    const url = page.url();
    log(`  [${label}] 登录=${ok ? "✅ 有效" : "❌ 失效"}  url=${url.slice(0, 70)}`);
  } catch (e) {
    log(`  [${label}] 探测异常: ${String(e).slice(0, 120)}`);
  }
  await browser.close();
  return ok;
}

async function main() {
  if (!existsSync(AUTH_FILE)) {
    console.error("❌ 未找到登录态文件，请先 npm run login");
    process.exit(1);
  }

  const backup = `${AUTH_FILE}.bak`;
  copyFileSync(AUTH_FILE, backup);
  log(`已备份到 ${backup}`);

  let state = load();
  let info = analyze(state);
  log(
    `cookie 总数=${info.cookies.length}  会话型=${info.session.length}  已过期=${info.expired.length}  可续期=${info.persistable.map((c) => c.name).join(",") || "无"}`,
  );

  log("\n【探测 1】原样使用已保存登录态（headless 全新浏览器）");
  const ok1 = await probe("原始", AUTH_FILE);

  if (ok1) {
    log("\n结论：登录态本身有效，无需续期。");
    return;
  }

  log(`\n【续期】把 session cookie 显式设为 ${SESSION_COOKIE_TTL_DAYS} 天有效`);
  state = load();
  const n = persistSessionCookies(state);
  log(`  已续期 ${n} 个 cookie`);
  const tmp = `${AUTH_FILE}.persisted`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");

  log("\n【探测 2】使用续期后的登录态");
  const ok2 = await probe("续期后", tmp);

  if (ok2) {
    writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2), "utf8");
    log("\n✅ 续期生效，已写回原文件。SSOTGC 确实可长期复用。");
  } else {
    log("\n❌ 续期也无效 —— SSOTGC 已被服务端作废，必须重新扫码。");
    log("   （这解释了为何每次都需扫码：华为云侧主动失效了会话）");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
