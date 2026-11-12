#!/usr/bin/env node
/**
 * 核验「在开发者作品展览馆中发布作品」(+200, MONTHLY×1) 本月是否已计分。
 *
 * 2026-11-01 重写：原判据是积分明细接口（growth/bonus-flow），但该接口已被
 * 华为云下线（返回 200 + HTML 404 页），导致核验恒失败。改用成长中心任务
 * 列表接口的 is_finish 字段——任务按月完成后服务端会置 1，口径与官方
 * guide「任务周期：每月一次」一致，且与积分明细同样权威。
 *
 * 退出码：0 = 本月已计分；1 = 未计分（可发布）；2 = 查询失败（不可判断）。
 */
import { chromium } from "playwright";
import { resolveAccountId } from "./accounts.mjs";
import { resolveAuthFile, shanghaiDate } from "./grow-api.mjs";

/** 与 gallery-daily.sh 中的 BONUS_KEYWORD / BONUS_POINTS 保持一致 */
const KEYWORD = "展览馆";

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-features=NetworkServiceInProcess,NetworkChangeNotifier", "--disable-background-networking", "--disable-component-update", "--no-first-run"] });
  try {
    const accountId = resolveAccountId(process.env.HWCLOUD_ACCOUNT);
    const ctx = await browser.newContext({
      storageState: resolveAuthFile(accountId),
      locale: "zh-CN",
      viewport: { width: 1600, height: 1000 },
    });
    const page = await ctx.newPage();

    // 任务列表走页面自己的请求（自带正确 csrf/头），这里只监听响应：
    // self-fetch 带不上 csrf 会被 403，而页面加载时必然请求此接口。
    let best = null;
    page.on("response", (r) => {
      if (/query-mission-list-by-condition/.test(r.url())) {
        r.json().then((j) => {
          const n = j?.QueryMissionDtoList?.length || 0;
          if (n > (best?.n || 0)) best = { n, j };
        }).catch(() => {});
      }
    });

    await page.goto("https://developer.huaweicloud.com/grow", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForTimeout(14_000);

    // 页面默认只拉 DAILY（8 条），点击「每周/每月」类目把展览馆任务刷出来
    for (const kw of ["每周", "每月"]) {
      await page.evaluate((k) => {
        const e = [...document.querySelectorAll("*")].find(
          (x) => x.children.length === 0 && k === (x.textContent || "").trim(),
        );
        e?.click();
      }, kw).catch(() => {});
      await page.waitForTimeout(4_000);
    }

    if (!best) {
      console.log("查询失败：未捕获到成长中心任务列表接口响应（登录态可能失效）");
      process.exitCode = 2;
      return;
    }

    const task = best.j.QueryMissionDtoList.find((m) => (m.title || "").includes(KEYWORD));
    if (!task) {
      console.log(`查询失败：任务列表(${best.n}条)中未找到「${KEYWORD}」任务`);
      process.exitCode = 2;
      return;
    }

    const month = shanghaiDate().replace(/\//g, "-").slice(0, 7);
    if (task.is_finish === 1) {
      console.log(`✅ ${month} ${KEYWORD} +${task.bonus} 已计分（is_finish=1），无需再发布`);
      process.exitCode = 0;
    } else {
      console.log(`⏳ ${month} ${KEYWORD} +${task.bonus} 未计分（is_finish=0，周期 MONTHLY×1）`);
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("核验异常:", e?.message || e);
  process.exitCode = 2;
});
