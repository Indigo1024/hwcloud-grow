#!/usr/bin/env node
/**
 * 鸿蒙每日任务：
 *   1. 每日浏览一个鸿蒙案例 +10  → 点「去浏览案例」→ 打开一个案例停留
 *   2. 每日 Star 一个鸿蒙案例代码仓 +30 → 点「绑定并去 Star」
 *
 * 入口: https://harmonybp.developer.huaweicloud.com/#practice-tasks
 * 判据: 成长中心 mission is_finish=1 或积分明细
 */
import { chromium } from "playwright";
import { resolveAuthFile } from "./scripts/auth-utils.mjs";
import { GrowApi, shanghaiDate } from "./scripts/grow-api.mjs";
import { resolveAccountId } from "./scripts/accounts.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ACCOUNT_ID = resolveAccountId(process.env.HWCLOUD_ACCOUNT);
const TASKS_URL = "https://harmonybp.developer.huaweicloud.com/#practice-tasks";
const CASES_URL = "https://harmonybp.developer.huaweicloud.com/cases";
const FORCE = process.argv.includes("--force");
const CHECK_ONLY = process.argv.includes("--check");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}]`, ...a);
const LAUNCH_ARGS = ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--disable-features=NetworkServiceInProcess,NetworkChangeNotifier","--disable-background-networking","--no-first-run"];

/** 真鼠标点击可见按钮，返回是否点到 */
async function clickVisibleButton(page, matcher) {
  // matcher: "re:xxx" 用正则；"cls:xxx" 按 class；否则精确等于 innerText
  //
  // 2026-11-10 修：原判断要求按钮 getBoundingClientRect().top > -200，
  // 但任务卡渲染在页面很靠上的位置（实测 scrollY=3651、按钮 top=-1484），
  // 于是「按钮明明在、点不到」——主号鸿蒙浏览与 Star 一直 clicked=false。
  // 正解：先 scrollIntoView 把目标滚进视口，再取坐标点击。
  const found = await page.evaluate((test) => {
    const els = [...document.querySelectorAll("button, a, [role=button], .hmp-action")];
    for (const el of els) {
      const t = (el.innerText || "").trim();
      const cls = (el.className || "").toString();
      let hit = false;
      if (test.startsWith("re:")) hit = new RegExp(test.slice(3)).test(t);
      else if (test.startsWith("cls:")) hit = cls.includes(test.slice(4)) && /浏览案例|Star|案例中心/.test(t);
      else hit = t === test;
      if (!hit) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        // 先滚进视口中心，避免被页面滚动位置挤到屏幕外
        el.scrollIntoView({ block: "center", behavior: "instant" });
        return { found: true, txt: t.slice(0, 20) };
      }
    }
    return { found: false };
  }, matcher).catch(() => ({ found: false }));

  if (!found.found) return { clicked: false, popup: null, pos: null };
  await sleep(600); // 等滚动落定，坐标才准

  // 滚动后再取一次坐标（此时应已在视口内）
  const pos = await page.evaluate((test) => {
    const els = [...document.querySelectorAll("button, a, [role=button], .hmp-action")];
    for (const el of els) {
      const t = (el.innerText || "").trim();
      const cls = (el.className || "").toString();
      let hit = false;
      if (test.startsWith("re:")) hit = new RegExp(test.slice(3)).test(t);
      else if (test.startsWith("cls:")) hit = cls.includes(test.slice(4)) && /浏览案例|Star|案例中心/.test(t);
      else hit = t === test;
      if (!hit) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName, target: el.target || "", txt: t.slice(0, 20) };
      }
    }
    return null;
  }, matcher).catch(() => null);

  if (!pos) return { clicked: false, popup: null, pos: null };
  await page.bringToFront().catch(() => {});
  await page.mouse.move(pos.x, pos.y);
  await sleep(250);
  let popup = null;
  if (pos.target === "_blank") {
    const [p] = await Promise.all([
      page.waitForEvent("popup", { timeout: 20_000 }).catch(() => null),
      (async () => { await page.mouse.down(); await sleep(120); await page.mouse.up(); })(),
    ]);
    popup = p;
  } else {
    await page.mouse.down(); await sleep(120); await page.mouse.up();
  }
  await sleep(1500);
  return { clicked: true, popup, pos };
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const ctx = await browser.newContext({ storageState: resolveAuthFile(ACCOUNT_ID), locale: "zh-CN", viewport: { width: 1440, height: 900 } });
  const api = new GrowApi(ctx);
  const today = shanghaiDate().replace(/\//g, "-");
  try {
    if (!FORCE && !CHECK_ONLY) {
      // 幂等看 mission is_finish（朋友经验：不靠跑没跑过）
      // 这里先不查，跑完再看；已有积分也照跑，平台会去重
    }
    if (CHECK_ONLY) {
      log("check 模式：仅打开任务页看按钮");
    }

    const page = await ctx.newPage();
    // 鸿蒙站经常判定未登录（看不到任务卡）。先去 developer 激活 SSO，
    // 再把 .huaweicloud.com 的会话 cookie 显式写到 harmonybp 域。
    log("预热 SSO（developer.huaweicloud.com）…");
    await page.goto("https://developer.huaweicloud.com/", { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    await sleep(5000);
    const ssoCks = await ctx.cookies("https://developer.huaweicloud.com");
    const pick = ssoCks.filter((c) => /SessionID|HWWAFSESID|SSOTGC|_frid|vk|cbc-sid|locale/.test(c.name));
    if (pick.length) {
      await ctx.addCookies(pick.map((c) => ({
        name: c.name, value: c.value, domain: ".huaweicloud.com", path: "/",
        secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
      })));
      log("SSO cookie 注入:", pick.map((c) => c.name).join(","));
    }
    log("打开:", TASKS_URL);
    let ok = false;
    for (let i = 1; i <= 5; i++) {
      try { await page.goto(TASKS_URL, { waitUntil: "domcontentloaded", timeout: 90000 }); ok = true; break; }
      catch (e) { if (i === 5) throw e; log(`导航抖动第${i}次`); await sleep(5000 * i); }
    }
    if (!ok) return 2;
    log("等任务区渲染…");
    // 页面是 SPA，任务卡由接口数据渲染，固定 sleep 不够稳（2026-11-10 出现过
    // 「按钮: []」——页面上一个 hmp-action 都没有，后面全落空）。
    // 改为轮询等待任务按钮出现，最多 40 秒；等到就继续，超时也不硬失败。
    let waited = 0;
    for (; waited < 40; waited += 2) {
      const n = await page.evaluate(() => document.querySelectorAll(".hmp-action").length).catch(() => 0);
      if (n > 0) break;
      await sleep(2000);
    }
    log(`任务区就绪（${waited}s，按钮 ${await page.evaluate(() => document.querySelectorAll(".hmp-action").length).catch(() => 0)} 个）`);
    await sleep(2000);
    if (page.url().includes("auth.huaweicloud.com")) { log("❌ 登录态失效"); return 3; }
    // 滚到实践任务卡（页面很长，不滚按钮不在视口）
    await page.evaluate(() => window.scrollTo(0, 600)).catch(() => {});
    await sleep(2500);

    // ---- 任务1: 浏览案例 +10 ----
    // 已完成就跳过（按钮变灰「已完成」）。没完成才点。
    const cardTxt = await page.evaluate(() => document.body.innerText).catch(() => "");
    const browseDone = cardTxt.includes("已完成") && !/去浏览案例/.test(cardTxt);
    log("浏览任务已完成?", browseDone);
    let r1 = { clicked: false, popup: null, pos: null };
    if (!browseDone) {
      log("点「去浏览案例」…");
      // 不能用 cls:hmp-action 兜底——任务页上「绑定并去 Star」也是 hmp-action，会先点错。
      r1 = await clickVisibleButton(page, "去浏览案例");
      if (!r1.clicked) r1 = await clickVisibleButton(page, "re:去浏览案例|去浏览");
      log(`  clicked=${r1.clicked} pos=${JSON.stringify(r1.pos)}`);
    }
    let browsePage = r1.popup || page;
    if (r1.popup) await r1.popup.waitForLoadState("domcontentloaded").catch(() => {});
    await sleep(8000);
    log("  当前:", browsePage.url().slice(0, 100));

    // 进案例中心后，打开第一个案例停留（任务要求：打开详情页并保持浏览 30 秒）
    if (/\/cases/.test(browsePage.url())) {
      log("在案例中心，打开第一个案例…");
      const first = await browsePage.evaluate(() => {
        const as = [...document.querySelectorAll("a")].filter((a) => /\/cases\/[0-9a-f]{16,}/.test(a.href));
        return as[0] ? { href: as[0].href, t: (as[0].innerText || "").slice(0, 30) } : null;
      }).catch(() => null);
      if (first) {
        log(`  打开: ${first.t}`);
        await browsePage.goto(first.href, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
        log("  案例页:", browsePage.url().slice(0, 100));
        // 任务卡：打开任意案例详情页并保持浏览 30 秒。提前离开可能不计。
        log("  停留 32s 满足浏览时长…");
        await sleep(32000);
        const go = await clickVisibleButton(browsePage, "re:开始实践|进入|立即体验|去完成");
        log(`  实践入口: ${go.clicked}`);
        await sleep(8000);
      } else {
        log("  未找到案例链接");
      }
      await sleep(5000);
    }

    // ---- 任务2: Star +30 ----
    //
    // 改用 **GitCode OpenAPI**，不再走浏览器点按钮。
    //
    // 原因：浏览器那套要同时满足「GitCode 会话没过期 + 点得动 Vue 组件的 DIV
    //   + 已绑定的是本账号」，任一条不满足就静默失败。2026-11-10 为此排查了
    //   一整轮（Star 是 DIV 不是 button、页面上有两份同名元素、组织页根本没有
    //   Star、会话过期……），而且每天都会因会话过期重演。
    //   而 Star 本质就是一次 `POST /repos/{org}/{repo}/star`，用访问令牌即可，
    //   稳定、无需浏览器、也不会和别的任务抢浏览器。
    //   （浏览器方式保留在 harmony-star-browser.mjs.bak，需要时参考。）
    log("Star 任务改用 GitCode API…");
    {
      const { spawnSync } = await import("node:child_process");
      const script = join(__dirname, "scripts", "harmony-star-api.mjs");
      const r = spawnSync(process.execPath, [script, ACCOUNT_ID], { encoding: "utf8", timeout: 120000 });
      const out = ((r.stdout || "") + (r.stderr || "")).trim();
      out.split("\n").forEach((l) => l && log("  " + l));
      if (r.status === 0) log("✅ Star 动作已完成（积分以明细为准）");
      else log(`⚠️ Star 未完成（退出码 ${r.status}）`);
    }


    // 汇报 mission 状态
    log("查任务完成状态…");
    // 简单打一下 bonus flow 今日鸿蒙相关
    const flows = (await api.bonusFlow(20).catch(() => [])) || [];
    const todayHits = flows.filter(f => String(f.time || "").startsWith(today) && /鸿蒙|harmony|浏览|Star/i.test(f.source || ""));
    if (todayHits.length) todayHits.forEach(f => log(`✅ ${f.time} +${f.points} ${f.source}`));
    else log("今日暂无鸿蒙相关积分（可能有延迟）");
    return 0;
  } finally {
    await api.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
main().then(rc => process.exit(rc ?? 0)).catch(e => { console.error("异常:", e?.message || e); process.exit(2); });
