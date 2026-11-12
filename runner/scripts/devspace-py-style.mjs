#!/usr/bin/env node
/**
 * DevSpace +30 —— 严格按用户提供的 hw-task/devspace.py 经验实现
 *
 * 链路:
 *   1. 新开 hands-on-agent.developer.huaweicloud.com/#tasks
 *   2. 等 10s
 *   3. 找 innerText 恰为「前往AI DevSpace实践」的 <a>
 *   4. scrollIntoView 后取新 rect
 *   5. CDP: mouseMoved → mousePressed → mouseReleased
 *   6. 落到 devstation.developer.huaweicloud.com/aidevspace?dc=…
 *   7. 找不到该 tab 就兜底直开 developer.huaweicloud.com/devspace?utm_source=officeagent
 *   8. 页面出现「立即进入」: 先点「体验版」卡片 → 真鼠标点按钮中心 → sleep(12)
 *   9. 再额外 sleep(60)（奖励是容器创建后延迟落账）
 *  10. 到账唯一判据: 积分明细「每日体验AI DevSpace +30」
 *
 * 坑:
 *   - ok:true 假阳性: 登出停在 auth...service=...aidevspace 也含 aidevspace
 *     真成功必须落在 devstation.developer.huaweicloud.com/aidevspace
 *   - devspace_entered:false 不代表没发分，不要重跑
 *   - 所有点击必须 CDP 真鼠标，JS .click() 对 TinyUI/React 静默无效
 */
import { chromium } from "playwright";
import { resolveAuthFile } from "./auth-utils.mjs";
import { GrowApi, shanghaiDate, isTodayShanghai } from "./grow-api.mjs";
import { resolveAccountId } from "./accounts.mjs";

const ACCOUNT_ID = resolveAccountId(process.env.HWCLOUD_ACCOUNT);
const TASKS_URL = "https://hands-on-agent.developer.huaweicloud.com/#tasks";
const FALLBACK_URL = "https://developer.huaweicloud.com/devspace?utm_source=officeagent";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}]`, ...a);
const ARGS = ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--disable-features=NetworkServiceInProcess,NetworkChangeNotifier","--disable-background-networking","--no-first-run"];

/** CDP 真鼠标三段式: move → down → up */
async function cdpClick(page, x, y) {
  await page.bringToFront().catch(() => {});
  await page.mouse.move(x, y);
  await sleep(200);
  await page.mouse.down();
  await sleep(120);
  await page.mouse.up();
}

/** 找 innerText 恰为 text 的 <a>，scrollIntoView 后取新 rect，CDP 点 */
async function clickExactAnchor(page, text) {
  // 1. 找
  const found = await page.evaluate((text) => {
    const as = [...document.querySelectorAll("a")];
    const hits = as.filter((a) => (a.innerText || "").trim() === text);
    if (!hits.length) return { n: 0 };
    // 经验: scrollIntoView 后取新 rect
    const a = hits.find((x) => /devstation/.test(x.href)) || hits[hits.length - 1];
    a.scrollIntoView({ block: "center" });
    return { n: hits.length, href: a.href.slice(0, 90), target: a.target || "" };
  }, text).catch(() => ({ n: 0 }));
  log(`找到「${text}」链接 ${found.n} 个，选 ${found.href || "?"}`);
  if (!found.n) return { clicked: false, popup: null };
  await sleep(1000);
  // 2. scrollIntoView 后重新取 rect
  const rect = await page.evaluate(() => {
    const hits = [...document.querySelectorAll("a")].filter((a) => (a.innerText || "").trim() === "前往AI DevSpace实践");
    const a = hits.find((x) => /devstation/.test(x.href)) || hits[hits.length - 1];
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };
  });
  if (!rect) return { clicked: false, popup: null };
  log(`新 rect 中心: (${rect.x},${rect.y})`);
  // 3. CDP 真鼠标 + 接 popup
  let popup = null;
  if (found.target === "_blank") {
    const [p] = await Promise.all([
      page.waitForEvent("popup", { timeout: 25_000 }).catch(() => null),
      cdpClick(page, rect.x, rect.y),
    ]);
    popup = p;
  } else {
    await cdpClick(page, rect.x, rect.y);
  }
  return { clicked: true, popup };
}

/** 页面上出现指定文字的可见元素，CDP 点中心 */
async function clickWhenVisible(page, text, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const pos = await page.evaluate((text) => {
      for (const el of document.querySelectorAll("a,button,div,span")) {
        if ((el.innerText || "").trim() === text) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight) {
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: el.tagName };
          }
        }
      }
      return null;
    }, text).catch(() => null);
    if (pos) {
      log(`「${text}」可见 (${pos.tag} @ ${pos.x},${pos.y})，CDP 点`);
      await cdpClick(page, pos.x, pos.y);
      return true;
    }
    await sleep(1500);
  }
  log(`30s 内未出现「${text}」`);
  return false;
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ARGS });
  const ctx = await browser.newContext({
    storageState: resolveAuthFile(ACCOUNT_ID),
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
  });
  const api = new GrowApi(ctx);
  const today = shanghaiDate().replace(/\//g, "-");
  try {
    // ---------- 1. #tasks 页 ----------
    log("新开 #tasks…");
    const page = await ctx.newPage();
    let nav = false;
    for (let i = 1; i <= 5; i++) {
      try { await page.goto(TASKS_URL, { waitUntil: "domcontentloaded", timeout: 90_000 }); nav = true; break; }
      catch (e) { if (i === 5) throw e; log(`导航抖动 ${i}`); await sleep(5000 * i); }
    }
    if (!nav) return 2;
    // ---------- 2. 等 10s ----------
    log("等 10s…");
    await sleep(10_000);
    if (page.url().includes("auth.huaweicloud.com")) { log("❌ 未登录"); return 3; }

    // ---------- 3-5. 找链接 + scrollIntoView + CDP 点 ----------
    let dp = null;
    const r = await clickExactAnchor(page, "前往AI DevSpace实践");
    log(`点击结果 clicked=${r.clicked} popup=${r.popup ? "有" : "无"}`);
    if (r.popup) {
      await r.popup.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(8000);
      dp = r.popup;
    } else if (r.clicked) {
      await sleep(8000);
      dp = page.url().includes("devstation") || page.url().includes("devspace") ? page : null;
    }

    // ---------- 7. 兜底直开（utm_source=officeagent 别省）----------
    if (!dp || !/devstation\.developer\.huaweicloud\.com\/aidevspace|developer\.huaweicloud\.com\/devspace/.test(dp.url())) {
      log("兜底直开 devspace?utm_source=officeagent");
      if (!page.isClosed()) await page.close().catch(() => {});
      dp = await ctx.newPage();
      for (let i = 1; i <= 5; i++) {
        try { await dp.goto(FALLBACK_URL, { waitUntil: "domcontentloaded", timeout: 90_000 }); break; }
        catch (e) { if (i === 5) throw e; await sleep(5000 * i); }
      }
      await sleep(10_000);
    }
    log("落地:", dp.url().slice(0, 110));
    // 假阳性判据：必须落在 devstation/aidevspace 或 developer/devspace，不能停在 auth
    if (/auth\.huaweicloud\.com/.test(dp.url())) {
      log("❌ 落在 auth 页（假阳性陷阱），登录态问题");
      return 3;
    }

    // ---------- 7.5 确认页面上真有「体验版」；没有就换成首页 ----------
    //
    // 2026-11-11 踩坑：从任务卡点进来的 devstation/aidevspace?dc=... 是**容器内页**，
    // 实测上面没有「体验版」也没有「立即进入」（日志里两个都 false），
    // 后续步骤全部落空，DevSpace 一直拿不到分。
    // 而直开 developer.huaweicloud.com/devspace?utm_source=officeagent 是**选版本首页**，
    // 「体验版 / 立即进入」都在。所以这里先探测一次，没有就切到首页。
    const hasExpHere = await dp.evaluate(() => /体验版/.test(document.body.innerText)).catch(() => false);
    if (!hasExpHere) {
      log("当前页没有「体验版」，改直开选版本首页…");
      for (let i = 1; i <= 5; i++) {
        try { await dp.goto(FALLBACK_URL, { waitUntil: "domcontentloaded", timeout: 90_000 }); break; }
        catch (e) { if (i === 5) throw e; await sleep(5000 * i); }
      }
      await sleep(10_000);
      log("  改开后:", dp.url().slice(0, 110));
      if (/auth\.huaweicloud\.com/.test(dp.url())) {
        log("❌ 落到 auth 页，登录态问题");
        return 3;
      }
    }

    // ---------- 8. 体验版 → 立即进入 → sleep 12 ----------
    // 体验版卡片
    const hasExp = await clickWhenVisible(dp, "体验版", 20_000);
    log(`体验版: ${hasExp}`);
    await sleep(2000);
    const hasEnter = await clickWhenVisible(dp, "立即进入", 25_000);
    log(`立即进入: ${hasEnter}`);
    log("sleep(12)…");
    await sleep(12_000);

    // 协议更新弹窗：勾两个 por-native checkbox 才能点「进入」
    // 「进入」不是 <button>，是 DIV.eco-protocol-footer，innerText 恰为「进入」
    const boxes = await dp.evaluate(() => {
      const out = [];
      document.querySelectorAll("input[type=checkbox]").forEach((e) => {
        const r = e.getBoundingClientRect();
        if (r.width > 0) out.push({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), checked: e.checked });
      });
      return out;
    }).catch(() => []);
    for (const bx of boxes) {
      if (!bx.checked) { await cdpClick(dp, bx.x, bx.y); await sleep(1200); }
    }
    log(`协议勾选: ${boxes.length} 个`);
    await sleep(1500);
    const enter = await dp.evaluate(() => {
      for (const e of document.querySelectorAll("*")) {
        if ((e.innerText || "").trim() === "进入") {
          const r = e.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: e.tagName };
        }
      }
      return null;
    }).catch(() => null);
    log(`进入元素: ${JSON.stringify(enter)}`);
    if (enter) await cdpClick(dp, enter.x, enter.y);
    else await cdpClick(dp, 720, 505); // 截图坐标兜底

    // 同意弹窗（容器创建的前提；经验里没写但实测必须有，精确 button）
    const agree = await dp.evaluate(() => {
      for (const b of document.querySelectorAll("button")) {
        if ((b.innerText || "").trim() === "同意") {
          const r = b.getBoundingClientRect();
          if (r.width > 0) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
      }
      return null;
    }).catch(() => null);
    if (agree) {
      log(`「同意」可见，CDP 点 (${agree.x},${agree.y})`);
      await cdpClick(dp, agree.x, agree.y);
    } else {
      log("无「同意」弹窗");
    }

    // ---------- 9. sleep(60) + 盯积分 ----------
    log("sleep(60) 等奖励延迟落账…");
    await sleep(60_000);
    log("容器页剩余时长?", (await dp.evaluate(() => (document.body.innerText.match(/剩余时长[^\n]{0,20}/) || ["无"])[0])));

    // 盯 8 分钟
    for (let i = 1; i <= 8; i++) {
      await sleep(60_000);
      const flows = (await api.bonusFlow(20).catch(() => [])) || [];
      const hit = flows.find((f) => isTodayShanghai(f.time) && String(f.source || "").includes("DevSpace") && Number(f.points) === 30);
      if (hit) {
        log(`✅ 到账! ${hit.time} +${hit.points} ${hit.source}`);
        return 0;
      }
      log(`  ${i}min 未到账`);
    }
    log("8 分钟内积分明细未见 +30（devspace_entered 不代表失败，不要立刻重跑）");
    return 0;
  } finally {
    await api.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
main().then((rc) => process.exit(rc ?? 0)).catch((e) => { console.error("异常:", e?.message || e); process.exit(2); });
