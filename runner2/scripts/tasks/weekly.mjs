#!/usr/bin/env node
/**
 * 每日体验 AI DevSpace（+30，DAILY×1）
 *
 * 2026-11-01 按用户提供的已验证流程（hw-task/devspace.py）重写：
 *   ① 新开 hands-on-agent.developer.huaweicloud.com/#tasks，等 10s
 *   ② 找 innerText 恰为「前往AI DevSpace实践」的 <a>，scrollIntoView 后
 *      取新 rect，CDP 真鼠标点中心 → 落到 devstation.../aidevspace?dc=…
 *   ③ 找不到该链接就兜底直开 developer.huaweicloud.com/devspace?utm_source=officeagent
 *      （utm_source=officeagent 是给分识别用的，别省）
 *   ④ 页面出现「立即进入」时：先点「体验版」卡片，再真鼠标点「立即进入」中心，
 *      sleep(12)；之后额外等 60s（奖励在容器创建后延迟落账）
 *   ⑤ 到账唯一判据：积分明细里出现「每日体验AI DevSpace +30」。
 *      容器状态 / is_finish / devspace_entered 都不代表发分。
 *
 * 已知坑（用户实证）：
 *   - JS .click() 对 TinyUI/React 按钮经常静默无效，必须真鼠标事件；
 *   - 登出时会停在 auth.huaweicloud.com/...service=...aidevspace...，
 *     判 "aidevspace" in url 会假阳性，必须严格校验 host 是 devstation；
 *   - 结尾报 entered:false 不代表没发分，以明细为准，别盲目重跑。
 */
import { TaskStatus } from "../task-status.mjs";

/** 实践中心任务页：签名入口只能从这里点出来 */
const HANDS_ON_TASKS_URL = "https://hands-on-agent.developer.huaweicloud.com/#tasks";
/** 兜底直开页（utm_source=officeagent 是给分识别用的，别省） */
const FALLBACK_URL = "https://developer.huaweicloud.com/devspace?utm_source=officeagent";

export async function tryDevspaceAiShell(page, task, report) {
  const push = (status, detail) => {
    report.push({ task_id: task.task_id, status, detail });
    console.log(`  [${status}] ${detail}`);
  };

  try {
    // ---- 0. 幂等：今日明细已有 +30 就跳过（以明细为准，不猜状态）----
    const already = await checkDevspaceBonusToday(page);
    if (already === true) {
      push(TaskStatus.SKIP, "今日 每日体验AI DevSpace +30 已到账，跳过");
      return;
    }

    // ---- 1. 打开实践中心任务页，等页面渲染 ----
    await page.goto(HANDS_ON_TASKS_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(10_000);

    // ---- 2. 真鼠标点「前往AI DevSpace实践」----
    // 注意：该链接 target=_blank，点击后 opens 新标签页，签名 dc= 在新页里生成。
    // 必须先注册 waitForEvent('page') 再点击，否则新页接不住。
    const newPagePromise = page.context().waitForEvent("page", { timeout: 20_000 }).catch(() => null);
    const clickedEntry = await realClickByText(page, "前往AI DevSpace实践");
    let target = null;
    if (clickedEntry) {
      target = await newPagePromise;
      if (target) {
        await target.waitForLoadState("domcontentloaded").catch(() => {});
        await target.waitForTimeout(8000);
      }
    }
    if (!clickedEntry || !target) {
      // 兜底：直开版本选择页（utm_source=officeagent 是给分识别用的，别省）。
      // 注意这不是错误路径：入口链接本身就指向这个页面，选完版本后
      // 会自动 302 到 devstation/aidevspace。
      await page.goto(FALLBACK_URL, { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
      await page.waitForTimeout(10_000);
      target = page;
    }

    // ---- 3. 落在 devstation/aidevspace？没有则可能停在版本选择页，继续往下走 ----
    const landed = await waitForUrl(target, 30_000);
    if (!landed) {
      // 版本选择页（developer.huaweicloud.com/devspace）是正常中间态，
      // 由第 4 步选「体验版」+「立即进入」进入 devstation，不算失败。
      if (!/developer\.huaweicloud\.com\/devspace/.test(target.url())) {
        push(TaskStatus.FAIL, `既不在 aidevspace 也不在版本选择页（当前 ${target.url().slice(0, 70)}）`);
        return;
      }
    }

    // ---- 4. 出现「立即进入」时：先点「体验版」，再点「立即进入」----
    const hasEnter = await textVisible(target, "立即进入");
    if (hasEnter) {
      await realClickByText(target, "体验版");
      await target.waitForTimeout(1500);
      await realClickByText(target, "立即进入");
      await target.waitForTimeout(12_000); // 用户流程：点完 sleep(12)
    }

    // ---- 5. 凭据授权框「同意」（真鼠标）----
    await realClickButton(target, 'button.tiny-button--primary:has-text("同意")');

    // ---- 6. 等奖励落账（容器创建后延迟几分钟，先等 60s 再查明细）----
    await target.waitForTimeout(60_000);
    const arrived = await checkDevspaceBonusToday(page);
    if (arrived === true) {
      push(TaskStatus.TRIED, "已拉起容器且积分明细确认 +30 到账");
      return;
    }
    // 明细还没落：按用户实证，容器起来了就是对的，奖励会延迟落账
    push(
      TaskStatus.TRIED,
      `已按流程拉起容器（${target.url().slice(0, 55)}），奖励延迟落账，以稍后明细 +30 为准`,
    );
  } catch (e) {
    push(TaskStatus.FAIL, `体验 AI DevSpace 失败：${String(e).slice(0, 120)}`);
  }
}

/** CDP 真鼠标点击：bringToFront → mouseMoved → mousePressed → mouseReleased */
async function realClick(page, x, y) {
  await page.bringToFront().catch(() => {});
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.up();
}

/** 找 innerText 恰为 text 的元素，scrollIntoView 后取新 rect，真鼠标点中心 */
async function realClickByText(page, text) {
  try {
    // DOM 里精确匹配（innerText 恰为 text）。页面里同名链接有多个
    //（视口外的、视口内的），优先选已在视口内的；没有就 scrollIntoView
    // 第一个并稍候，滚动稳定后取**当时**的坐标直接点击。
    let rect = await page
      .evaluate((t) => {
        const els = [...document.querySelectorAll("a,button,div,span,li")].filter(
          (e) => (e.innerText || "").trim() === t,
        );
        if (!els.length) return null;
        let el = els.find((e) => {
          const r = e.getBoundingClientRect();
          return r.y >= 0 && r.bottom <= window.innerHeight && r.width > 0;
        });
        if (!el) {
          el = els[0];
          el.scrollIntoView({ block: "center" });
        }
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }, text)
      .catch(() => null);
    if (!rect || rect.w === 0) return false;

    // scrollIntoView 触发平滑滚动时坐标会漂移：等 400ms 再重取一次
    await page.waitForTimeout(400);
    const rect2 = await page
      .evaluate((t) => {
        const els = [...document.querySelectorAll("a,button,div,span,li")].filter(
          (e) => (e.innerText || "").trim() === t,
        );
        if (!els.length) return null;
        const inView = els.find((e) => {
          const r = e.getBoundingClientRect();
          return r.y >= 0 && r.bottom <= window.innerHeight && r.width > 0;
        });
        const el = inView || els[0];
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }, text)
      .catch(() => null);
    const final = rect2 && rect2.w > 0 ? rect2 : rect;
    await realClick(page, final.x + final.w / 2, final.y + final.h / 2);
    return true;
  } catch {
    return false;
  }
}

/** 真鼠标点击选择器命中的按钮（TinyUI 按钮必须真鼠标，JS click 无效） */
async function realClickButton(page, selector) {
  for (let i = 0; i < 5; i++) {
    const rect = await page.locator(selector).first().boundingBox().catch(() => null);
    if (rect) {
      await realClick(page, rect.x + rect.width / 2, rect.y + rect.height / 2);
      return true;
    }
    await page.waitForTimeout(3000);
  }
  return false;
}

/** 页面文本是否包含（用于探测「立即进入」等） */
async function textVisible(page, text) {
  const txt = await page.evaluate(() => document.body.innerText).catch(() => "");
  return (txt || "").includes(text);
}

/** 严格校验落在 devstation.developer.huaweicloud.com/aidevspace（auth 页不算） */
async function waitForUrl(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const u = new URL(page.url());
      if (
        u.hostname === "devstation.developer.huaweicloud.com" &&
        u.pathname.startsWith("/aidevspace")
      ) {
        return true;
      }
    } catch {
      /* URL 解析失败继续等 */
    }
    await page.waitForTimeout(1500);
  }
  return false;
}

/**
 * 今日积分明细里是否已有「每日体验AI DevSpace +30」。
 * 到账唯一判据（用户实证），其余状态均不可信。
 * @returns {Promise<boolean|null>} null = 查询失败
 */
async function checkDevspaceBonusToday(page) {
  try {
    const { GrowApi, shanghaiDate } = await import("../grow-api.mjs");
    // 独立页面查明细，不影响主流程页面
    const api = new GrowApi(page.context());
    const flow = await api.bonusFlow(30);
    await api.close().catch(() => {});
    if (!flow) return null;
    const today = shanghaiDate().replace(/\//g, "-");
    return flow.some(
      (r) =>
        String(r.source || "").includes("每日体验AI DevSpace") &&
        Number(r.points) === 30 &&
        String(r.time || "").startsWith(today),
    );
  } catch {
    return null;
  }
}

export async function tryWeeklyLab(_page, task, report) {
  report.push({
    task_id: task.task_id,
    status: TaskStatus.SKIP,
    detail: [
      "需人工：实验进度按手册章节逐节勾选（「已完成 N%」），",
      "必须用实验下发的 IAM 账号在控制台真实操作才能推进；",
      "且频繁开启/退出实验会被判刷量并消耗每日免费名额，不做自动化。",
    ].join(""),
  });
  console.log("  [跳过] 实验任务需人工操作");
}

/** [100] 微认证：明确不自动化，只如实报告 */
export async function tryWeeklyCert(_page, task, report) {
  report.push({
    task_id: task.task_id,
    status: TaskStatus.SKIP,
    detail: [
      "需人工：微认证必须答题通过理论考试（仅 1 次机会，浪费需重新激活），",
      "前置还要完成 90 分钟配套实验；证书次日发放，积分次日才到账。",
    ].join(""),
  });
  console.log("  [跳过] 微认证需人工考试");
}
