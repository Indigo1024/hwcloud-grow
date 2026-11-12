#!/usr/bin/env node
/**
 * T_WEEKLY_LAB 每周实践一个实验 (+50)
 * 入口: https://lab.huaweicloud.com/koolabs/experimentalStudy_2325
 *   （10分钟入门装载国产操作系统的ECS，经典实验，环境容易起）
 * 行为: 打开详情页 → 等环境准备 → 点开始/进入实验 → 停留 90s
 * 判据: 成长中心积分明细「每周实践一个实验」+50（可能次日结算）
 * 注意: 环境启动失败换 3992 DeepSeek；不要频繁开退（防刷量）
 */
import { chromium } from "playwright";
import { resolveAuthFile } from "./auth-utils.mjs";
import { resolveAccountId } from "./accounts.mjs";

const ACCOUNT_ID = resolveAccountId(process.env.HWCLOUD_ACCOUNT);
const LAB_URL = "https://lab.huaweicloud.com/koolabs/experimentalStudy_2325";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}]`, ...a);

async function main() {
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--disable-features=NetworkChangeNotifier","--no-first-run"] });
  const ctx = await browser.newContext({ storageState: resolveAuthFile(ACCOUNT_ID), locale: "zh-CN", viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  let nav = false;
  for (let i = 1; i <= 5; i++) {
    try { await p.goto(LAB_URL, { waitUntil: "domcontentloaded", timeout: 90000 }); nav = true; break; }
    catch (e) { if (i === 5) throw e; log("抖动重试", i); await sleep(5000 * i); }
  }
  if (!nav) return 2;
  await sleep(12000);
  log("URL:", p.url().slice(0, 110));
  const status = await p.evaluate(() => (document.body.innerText.match(/实验环境[^\n]{0,25}|开始实验|进入实验|运行中|准备中|失败[^\n]{0,15}|剩余时间[^\n]{0,12}/g) || []).join(" | "));
  log("状态:", status);
  async function cdpTxt(re) {
    const pos = await p.evaluate((re) => {
      for (const e of document.querySelectorAll("button,a")) {
        if (new RegExp(re).test((e.innerText || "").trim())) { const r = e.getBoundingClientRect(); if (r.width > 0 && r.top > 0) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), t: e.innerText.trim().slice(0, 15) }; }
      }
      return null;
    }, re);
    if (!pos) return false;
    await p.bringToFront(); await p.mouse.move(pos.x, pos.y); await sleep(250); await p.mouse.down(); await sleep(130); await p.mouse.up();
    log("点了", pos.t);
    return true;
  }
  for (const re of ["重新进入实验", "开始实验", "进入实验"]) {
    if (await cdpTxt(re)) { await sleep(15000); break; }
  }
  // 停留 90s
  log("停留 90s…");
  await sleep(90000);
  const st2 = await p.evaluate(() => (document.body.innerText.match(/实验环境[^\n]{0,25}|运行中|剩余时间[^\n]{0,12}|失败/g) || []).join(" | "));
  log("结束状态:", st2);
  await browser.close();
  return 0;
}
main().then((rc) => process.exit(rc ?? 0)).catch((e) => { console.error("异常:", e?.message || e); process.exit(2); });
