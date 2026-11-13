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

  // 用 locator.click() 而不是 CDP 的 mouse.down/up。
  // 原因：这个页面是 Vue 组件，CDP 合成事件点不动（表现为 clicked=false 但元素可见）。
  // 2026-11-13 实测：主号连续多天 clicked=false，任务却报"已执行"，实际没计分。
  // locator.click() 会走真实的元素点击链路（含内核级 hit-test），对 Vue 有效。
  let popup = null;
  const useMouse = process.env.HWCLOUD_CLICK_WITH_MOUSE === "1";
  try {
    if (!useMouse) {
      const loc = page.locator(
        `button:has-text("${matcher.replace(/^re:/, "")}"), a:has-text("${matcher.replace(/^re:/, "")}"), [role=button]:has-text("${matcher.replace(/^re:/, "")}")`,
      ).first();
      if (pos.target === "_blank") {
        const [p] = await Promise.all([
          page.waitForEvent("popup", { timeout: 20_000 }).catch(() => null),
          loc.click({ timeout: 8000 }).catch(() => {}),
        ]);
        popup = p;
      } else {
        await loc.click({ timeout: 8000 });
      }
      await sleep(1500);
      return { clicked: true, popup, pos };
    }
  } catch {
    // locator 失败时回落旧的鼠标点击（保留兜底，便于页面大改后仍有机会）
  }

  await page.mouse.move(pos.x, pos.y);
  await sleep(250);
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

    // ----- 任务1: 浏览案例 +10 -----
    //
    // 任务定义（来自 /api/growth/tasks）：
    //   description "打开任意案例详情页并保持浏览 30 秒"
    //   evaluator   "dwell"，need_seconds=30，max_gap_ms=15000
    // 也就是说**判据是"在案例详情页停留够 30 秒"**，并不要求先点某个按钮。
    //
    // 2026-11-13 改：此前实现是"在任务页点「去浏览案例」按钮 → 进案例中心 → 点第一个案例"，
    // 但任务页改版后该按钮已不在（实测页面是鸿蒙首页，没有这个按钮），
    // 于是 clicked=false，脚本却仍报"动作已执行" —— 连续多日假成功。
    // 现在直接走可靠路径：案例列表 → 打开任一详情页 → 停留够时长。
    // 是否已完成：查官方任务接口，而不是解析页面按钮文案。
    // 任务页改版后按钮文案不再可靠（页面已不是任务列表，见下方说明）。
    let browseDone = false;
    try {
      const st = await page.evaluate(async () => {
        const t = await (await fetch("/api/growth/tasks", { credentials: "include" })).json();
        const task = (t.tasks || []).find((x) => x.task_key === "case-view-daily");
        return task ? { status: task.today_status, elapsed: task.elapsed_seconds || 0 } : null;
      }).catch(() => null);
      if (st) {
        browseDone = st.status === "done";
        log(`浏览任务状态: ${st.status}（已浏览 ${st.elapsed || 0}s / 需 30s）`);
      }
    } catch { /* 拿不到就按未完成处理，下面会去执行 */ }
    log("浏览任务已完成?", browseDone);
    // 本次是否真的打开了案例详情页并停留够时长（用于末尾如实汇报）
    let browseVisited = false;
    if (browseDone) {
      log("  任务页显示已完成，跳过浏览");
    } else {
      log("打开案例列表…");
      await page.goto(CASES_URL, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
      await sleep(8000);

      // 找任一案例详情链接（页面上有"查看案例"链接与卡片链接，取第一个可用的）
      const first = await page.evaluate(() => {
        const as = [...document.querySelectorAll("a")]
          .filter((a) => /\/cases\/[0-9a-zA-Z]{8,}/.test(a.href));
        return as[0] ? { href: as[0].href } : null;
      }).catch(() => null);

      if (first) {
        log(`  打开案例: ${first.href.slice(-20)}`);
        await page.goto(first.href, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
        await sleep(3000);
        log(`  当前: ${page.url().slice(0, 100)}`);
        // 官方要求"保持浏览 30 秒"（need_seconds=30，间隔超 15s 会重置），
        // 多停一会儿留余量，且期间做点轻量滚动，避免被判为挂机。
        log("  停留 40s 满足浏览时长…");
        for (let i = 0; i < 8; i++) {
          await page.mouse.wheel(0, 300).catch(() => {});
          await sleep(5000);
        }
        browseVisited = true;
        log("  ✅ 已在案例详情页停留足够时长");
      } else {
        log("  ❌ 案例列表里没找到详情链接");
      }
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
    // 查今日积分明细，看鸿蒙相关是否到账 —— 这是唯一可信的判据
    const flows = (await api.bonusFlow(20).catch(() => [])) || [];
    const todayHits = flows.filter(f => String(f.time || "").startsWith(today) && /鸿蒙|harmony|浏览|Star/i.test(f.source || ""));
    if (todayHits.length) todayHits.forEach(f => log(`✅ ${f.time} +${f.points} ${f.source}`));

    // 结论要如实：以「积分是否到账」为准，而不是「我们跑过没有」。
    // 2026-11-13 修：此前无论点击成功与否都打印"动作已执行"并 return 0，
    // 导致面板显示成功、实际没计分（主号连续多日如此）。
    const browseGot = todayHits.some((f) => /浏览/.test(f.source || ""));
    const starGot = todayHits.some((f) => /Star|star/.test(f.source || ""));
    if (browseGot || starGot) {
      log(`✅ 已到账：${[browseGot && "浏览", starGot && "Star"].filter(Boolean).join("、")}`);
      return 0;
    }
    if (!browseVisited && !browseDone) {
      log("❌ 鸿蒙浏览未执行（未能打开案例详情页），且今日无到账记录");
      return 2;
    }
    if (browseVisited) {
      log("⚠️ 已执行浏览动作，但今日积分尚未到账（平台有延迟，次日再看）");
      return 0;
    }
    log("⚠️ 本次未产生新的浏览动作（可能今日已完成或页面结构变化）");
    return 0;
  } finally {
    await api.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}
main().then(rc => process.exit(rc ?? 0)).catch(e => { console.error("异常:", e?.message || e); process.exit(2); });
