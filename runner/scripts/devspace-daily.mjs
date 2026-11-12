#!/usr/bin/env node
/**
 * 每日体验 AI DevSpace +30
 *
 * 实现依据（朋友实测经验 + 官方任务定义）：
 *   - 任务本体：成长中心 mission「每日体验AI DevSpace」，behavior_code 6a45d034…，DAILY，+30
 *   - 不是 API 领的，是 CDP 真鼠标点出来的：
 *       新开 hands-on-agent.developer.huaweicloud.com/#tasks
 *       → 等 10s → 找 innerText 恰为「前往AI DevSpace实践」的 <a>
 *       → scrollIntoView 后重新取 rect，mouseMoved → mousePressed → mouseReleased
 *       → 落到 devstation.developer.huaweicloud.com/aidevspace?dc=…
 *   - 找不到该 tab 就兜底直开 developer.huaweicloud.com/devspace?utm_source=officeagent
 *     （utm_source=officeagent 是给分识别用的，不能省）
 *   - 出现「立即进入」时：先点「体验版」卡片，再真鼠标点按钮中心，sleep(12)
 *
 * 三个坑（务必遵守）：
 *   1. devspace_entered:false / devspace_still_open:true 不代表没发分——
 *      奖励在容器创建后延迟落账，别据此重跑（重跑纯浪费）。
 *   2. ok:true 会假阳性：登出时停在 auth.huaweicloud.com/...aidevspace...，
 *      判 "aidevspace" in url 就为真。真成功必须落在
 *      devstation.developer.huaweicloud.com/aidevspace。
 *   3. 所有点击必须 CDP 真鼠标；JS .click() 对 TinyUI/React 按钮常静默无效。
 *
 * 到账唯一判据：积分明细里出现「每日体验AI DevSpace +30」。
 *
 * 用法：
 *   node scripts/devspace-daily.mjs             # 跑一次（含幂等判断）
 *   node scripts/devspace-daily.mjs --force     # 跳过幂等，强制跑
 *   node scripts/devspace-daily.mjs --check     # 只查今天是否已到账
 */
import { chromium } from "playwright";
import { resolveAuthFile } from "./auth-utils.mjs";
import { GrowApi, shanghaiDate, isTodayShanghai } from "./grow-api.mjs";
import { resolveAccountId } from "./accounts.mjs";

const ACCOUNT_ID = resolveAccountId(process.env.HWCLOUD_ACCOUNT);
const POINTS = 30;
const KEYWORD = "每日体验AI DevSpace";

const TASKS_URL = "https://hands-on-agent.developer.huaweicloud.com/#tasks";
const FALLBACK_URL =
  "https://developer.huaweicloud.com/devspace?utm_source=officeagent";
const SUCCESS_HOST = "devstation.developer.huaweicloud.com";

const FORCE = process.argv.includes("--force");
const CHECK_ONLY = process.argv.includes("--check");

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-features=NetworkServiceInProcess,NetworkChangeNotifier",
  "--disable-background-networking",
  "--disable-component-update",
  "--no-first-run",
];

const log = (...a) =>
  console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}]`, ...a);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** CDP 真鼠标点击：JS .click() 对 TinyUI/React 常静默失效 */
async function realClick(page, selectorOrLocator) {
  let box;
  if (typeof selectorOrLocator === "string") {
    const el = await page.$(selectorOrLocator);
    if (!el) return false;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(300);
    box = await el.boundingBox();
  } else {
    await selectorOrLocator.scrollIntoViewIfNeeded().catch(() => {});
    await sleep(300);
    box = await selectorOrLocator.boundingBox();
  }
  if (!box) return false;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.bringToFront().catch(() => {});
  await page.mouse.move(x, y);
  await sleep(120);
  await page.mouse.down();
  await sleep(80);
  await page.mouse.up();
  return true;
}

/** 找 innerText 恰好等于指定文案的任意可点元素（a/button/span/div），真鼠标点击 */
async function clickAnyByExactText(page, text) {
  const handle = await page.evaluateHandle((t) => {
    const sel = "a,button,span,div[role=button],label";
    const list = [...document.querySelectorAll(sel)];
    // 优先最内层（文字完全等于目标、且没有同样文字的子元素）
    const cands = list.filter((el) => {
      if ((el.innerText || "").trim() !== t) return false;
      return true;
    });
    // 取最深的一个（子节点里没有同样文字的）
    cands.sort((a, b) => {
      const da = a.querySelectorAll("*").length;
      const db = b.querySelectorAll("*").length;
      return da - db;
    });
    return cands[0] || null;
  }, text);
  const el = handle.asElement();
  if (!el) return { clicked: false, popup: null };

  await el.evaluate((n) => n.scrollIntoView({ block: "center", inline: "center" }));
  await sleep(600);
  const box = await el.boundingBox();
  if (!box || box.width === 0 || box.height === 0) return { clicked: false, popup: null };

  await page.bringToFront().catch(() => {});
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(200);
  const isBlank = await el.evaluate((n) => n.tagName === "A" && (n.target === "_blank" || !!n.getAttribute("target")));

  let popup = null;
  if (isBlank) {
    const [p] = await Promise.all([
      page.waitForEvent("popup", { timeout: 15_000 }).catch(() => null),
      (async () => {
        await page.mouse.down();
        await sleep(100);
        await page.mouse.up();
      })(),
    ]);
    popup = p;
  } else {
    await page.mouse.down();
    await sleep(100);
    await page.mouse.up();
  }
  await sleep(1500);
  return { clicked: true, popup };
}

/**
 * 找 innerText 恰好等于给定文案的 <a>，用真鼠标点。
 *
 * 踩坑（2026-11-04）：页面上同名链接有 4 个，前 3 个在 y=-1278（视口外、
 * 属于隐藏的任务卡片），只有最后一个在可见区。原实现取候选里的第一个，
 * 点击落在视口外 → 没开新标签页 → 整轮 DevSpace 白跑（日志报
 * 「未捕获 popup」后停在 #tasks）。必须按「视口内可见」筛选后再点。
 */
async function clickLinkByExactText(page, text) {
  const handle = await page.evaluateHandle((t) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cands = [...document.querySelectorAll("a")].filter((a) => {
      if ((a.innerText || "").trim() !== t) return false;
      const r = a.getBoundingClientRect();
      // 必须在视口范围内且有实际尺寸
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw;
    });
    // 优先 target=_blank 且 href 指向 devstation 的（真正的实践入口）
    cands.sort((a, b) => {
      const score = (n) =>
        (/devstation/.test(n.href) ? 2 : 0) + (n.target === "_blank" ? 1 : 0);
      return score(b) - score(a);
    });
    return cands[0] || null;
  }, text);
  const el = handle.asElement();
  if (!el) {
    // 视口内没有，退而求其次：滚到第一个同名元素再点
    const alt = await page.evaluateHandle((t) => {
      const c = [...document.querySelectorAll("a")].filter((a) => (a.innerText || "").trim() === t);
      c.sort((a, b) => (/devstation/.test(a.href) ? -1 : 0) - (/devstation/.test(b.href) ? -1 : 0));
      return c[0] || null;
    }, text);
    const altEl = alt.asElement();
    if (!altEl) return { clicked: false, popup: null };
    await altEl.evaluate((n) => n.scrollIntoView({ block: "center", inline: "center" }));
    await sleep(900);
    return await doClick(page, altEl);
  }
  return await doClick(page, el);
}

/** 对已定位元素执行真鼠标点击，并接住 popup */
async function doClick(page, el) {
  await el.evaluate((n) => n.scrollIntoView({ block: "center", inline: "center" }));
  await sleep(700);
  const box = await el.boundingBox();
  if (!box || box.width === 0 || box.height === 0) return { clicked: false, popup: null };

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const view = page.viewportSize();
  if (view && (y < 0 || y > view.height)) return { clicked: false, popup: null };

  await page.bringToFront().catch(() => {});
  await page.mouse.move(x, y);
  await sleep(200);

  const isBlank = await el.evaluate(
    (n) => n.tagName === "A" && (n.target === "_blank" || !!n.getAttribute("target")),
  );

  let popup = null;
  if (isBlank) {
    const [p] = await Promise.all([
      page.waitForEvent("popup", { timeout: 25_000 }).catch(() => null),
      (async () => {
        await page.mouse.down();
        await sleep(100);
        await page.mouse.up();
      })(),
    ]);
    popup = p;
  } else {
    await page.mouse.down();
    await sleep(100);
    await page.mouse.up();
  }
  await sleep(2000);
  return { clicked: true, popup };
}


/** 真成功判据：必须落在 devstation 的 aidevspace 页（auth 页的 aidevspace 是假阳性） */
function isRealDevstation(url) {
  try {
    const u = new URL(url);
    return u.hostname === SUCCESS_HOST && u.pathname.includes("aidevspace");
  } catch {
    return false;
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const ctx = await browser.newContext({
    storageState: resolveAuthFile(ACCOUNT_ID),
    locale: "zh-CN",
    viewport: { width: 1440, height: 900 },
  });
  const api = new GrowApi(ctx);
  const today = shanghaiDate().replace(/\//g, "-");

  try {
    // 幂等：今天已到账就跳过（不靠「今天跑过没有」）
    if (!FORCE) {
      const flows = (await api.bonusFlow(30)) || [];
      const hit = flows.some(
        (f) =>
          isTodayShanghai(f.time) &&
          String(f.source || "").includes("DevSpace") &&
          Number(f.points) === POINTS,
      );
      if (hit) {
        log(`今日「${KEYWORD}」+${POINTS} 已到账，跳过`);
        return 0;
      }
      if (CHECK_ONLY) {
        log(`今日「${KEYWORD}」+${POINTS} 未到账`);
        return 1;
      }
    }

    const page = await ctx.newPage();

    // ---------- 1. 进 hands-on-agent #tasks ----------
    log("打开:", TASKS_URL);
    let ok = false;
    for (let i = 1; i <= 3; i++) {
      try {
        await page.goto(TASKS_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
        ok = true;
        break;
      } catch (e) {
        if (i === 3) throw e;
        log(`导航抖动（第${i}次）: ${e.message.split("\n")[0]}，重试…`);
        await sleep(3000 * i);
      }
    }
    if (!ok) return 2;
    log("等 10s 让任务区渲染…");
    await sleep(10_000);

    if (page.url().includes("auth.huaweicloud.com")) {
      log("❌ 登录态失效（被踢到 auth 页）");
      return 3;
    }

    // ---------- 2. 点「前往AI DevSpace实践」（target=_blank，需接 popup） ----------
    let { clicked, popup } = await clickLinkByExactText(page, "前往AI DevSpace实践");
    if (clicked) {
      log("已真鼠标点击「前往AI DevSpace实践」");
      if (popup) {
        log("已接住新开标签页");
        await popup.waitForLoadState("domcontentloaded").catch(() => {});
        await sleep(6000);
      } else {
        log("未捕获 popup，等待当前页跳转…");
        await sleep(6000);
      }
    } else {
      log("未找到该入口，兜底直开 devspace 页（utm_source=officeagent）");
      const np = await ctx.newPage();
      await np.goto(FALLBACK_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
      popup = np;
      await sleep(6000);
    }

    // 定位到实际活动页
    let work = page;
    for (const p of ctx.pages()) {
      if (isRealDevstation(p.url()) || /devspace|aidevspace/i.test(p.url())) {
        work = p;
        break;
      }
    }
    await work.bringToFront().catch(() => {});
    log("当前页:", work.url().slice(0, 110));

    // ---------- 3. 先点「体验版」卡片，再真点「立即进入」 ----------
    // 注意：页面上文案可能是「体验版」也可能内嵌在卡片里，失败不阻塞。
    let cur = popup || work;
    const trial = await clickAnyByExactText(cur, "体验版");
    if (trial.clicked) {
      log("已点「体验版」卡片");
      if (trial.popup) cur = trial.popup;
      await sleep(3000);
      await cur.waitForLoadState("domcontentloaded").catch(() => {});
    }

    const enter = await clickAnyByExactText(cur, "立即进入");
    if (enter.clicked) {
      log("已真鼠标点「立即进入」，等待容器拉起…");
      if (enter.popup) cur = enter.popup;
      await sleep(12_000);
      await cur.waitForLoadState("domcontentloaded").catch(() => {});
    } else {
      // 有些入口点完直接就是容器页，「立即进入」不存在属正常
      log("未找到「立即进入」（可能已直接进入容器，或页面结构变化）");
    }

    // ---------- 3.5 处理容器页的凭据授权弹窗（同意后才算真正进入）----------
    // 关键踩坑（2026-11-04）：弹窗里「同意」按钮的真实元素是
    //   button.tiny-button--primary（96×32）
    // 用「innerText 等于同意」筛元素会选中外层 600px 宽的大 div（tiny-dialog-box），
    // 点击打在容器上而非按钮 → 弹窗不消失 → 容器从未创建 → 积分永远不到账。
    // 必须优先取 button 元素的中心坐标，用鼠标坐标点击（boundingBox 在弹窗里可能为 null）。
    const clickAgreeButton = async (target) => {
      const pos = await target
        .evaluate(() => {
          for (const el of document.querySelectorAll("button")) {
            if ((el.innerText || "").trim() === "同意") {
              const r = el.getBoundingClientRect();
              if (r.width > 0 && r.height > 0) {
                return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
              }
            }
          }
          return null;
        })
        .catch(() => null);
      if (!pos) return false;
      await target.bringToFront().catch(() => {});
      await target.mouse.move(pos.x, pos.y);
      await sleep(300);
      await target.mouse.down();
      await sleep(120);
      await target.mouse.up();
      return true;
    };

    // 逐个候选页（含新开 tab）处理授权弹窗
    const seen = new Set();
    for (const cand of [cur, ...ctx.pages()]) {
      if (!cand || seen.has(cand)) continue;
      seen.add(cand);
      try {
        const t = await cand.evaluate(() => document.body.innerText.slice(0, 400));
        if (/是否同意|临时访问凭据|AK\/SK/.test(t) && /同意/.test(t)) {
          const done = await clickAgreeButton(cand);
          if (done) {
            log("已点「同意」按钮（凭据同步授权），等待容器创建…");
            await sleep(12_000);
          }
        }
      } catch {
        /* 页面已关闭等，忽略 */
      }
    }

    // 容器创建后的标志：页面出现「剩余时长」+ 体验版容器环境提示
    const waitContainer = async (target) => {
      for (let i = 0; i < 12; i++) {
        const s = await target.evaluate(() => document.body.innerText).catch(() => "");
        if (/剩余时长/.test(s) && /容器环境/.test(s)) {
          const left = (s.match(/剩余时长\s*\n?\s*([\d:]+)/) || [])[1] || "";
          log(`容器已创建${left ? `，剩余时长 ${left}` : ""}`);
          return true;
        }
        await sleep(8_000);
      }
      return false;
    };

    // ---------- 3.6 等容器真正创建（「剩余时长」出现才算成功）----------
    log("等待容器创建…");
    let containerUp = false;
    for (const cand of [cur, ...ctx.pages()]) {
      if (!cand) continue;
      if (await waitContainer(cand)) {
        containerUp = true;
        cur = cand;
        break;
      }
    }
    if (!containerUp) log("未检测到「剩余时长」，容器可能未创建（继续按延迟落账处理，不重跑）");

    // ---------- 4. 判据：看最终落在哪 ----------
    // 注意：这套流程 rewards 是延迟落账的。
    // entered=false 不代表失败，不能据此重跑。
    let finalUrl = work.url();
    await sleep(8000);
    for (const p of ctx.pages()) {
      if (isRealDevstation(p.url())) {
        finalUrl = p.url();
        break;
      }
    }

    const entered = isRealDevstation(finalUrl);
    log(`落点: ${finalUrl.slice(0, 120)}`);
    log(`devspace_entered=${entered}`);

    if (!entered && finalUrl.includes("auth.huaweicloud.com")) {
      log("❌ 停在 auth 页 = 登录态问题（这不是 DevSpace 失败的原因）");
      return 3;
    }

    // ---------- 5. 等奖励落账（容器创建后几分钟） ----------
    // 经验：daily_all 在 devspace 步骤后额外 sleep(60)，因为奖励延迟落账。
    log("按经验额外等 60s（容器创建后奖励延迟落账）…");
    await sleep(60_000);

    log("核查积分明细（最多 6 分钟，每 45s 一次）…");
    for (let i = 1; i <= 8; i++) {
      const flows = (await api.bonusFlow(30)) || [];
      const hit = flows.some(
        (f) =>
          isTodayShanghai(f.time) &&
          String(f.source || "").includes("DevSpace") &&
          Number(f.points) === POINTS,
      );
      if (hit) {
        log(`✅ 已到账：今日「${KEYWORD}」+${POINTS}`);
        return 0;
      }
      log(`  第${i}次核查：尚未到账`);
      await sleep(45_000);
    }

    log(
      `⚠️ 动作已执行但未在核验窗口内看到到账。奖励延迟落账属正常，` +
        `不要立刻重跑（重跑纯浪费）；稍后用 --check 复核。`,
    );
    return 1;
  } finally {
    await api.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main()
  .then((rc) => process.exit(rc ?? 0))
  .catch((e) => {
    console.error("异常:", e?.message || e);
    process.exit(2);
  });
