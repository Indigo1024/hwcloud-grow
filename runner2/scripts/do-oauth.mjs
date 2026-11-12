/**
 * 手动完成 codearts OAuth：用正确的（最新）授权链接打开页面并点击「确认授权」
 * 回调服务器已由 codearts 进程在 127.0.0.1:42439 监听
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolveAuthFile } from "./auth-utils.mjs";

// 从最新 kernel 日志解析当前有效的授权链接
const logDir = "/root/.codeartsdoer/cli-data/log";
const latest = execSync(`ls -t ${logDir}/kernel-*.log | head -1`).toString().trim();
const content = readFileSync(latest, "utf8");
const urlMatch = content.match(/url=(https:\/\/codearts\.huaweicloud\.com\/portal\/authorize\?[^\s]+)/g);
if (!urlMatch) { console.error("未找到授权链接"); process.exit(1); }
const authUrl = urlMatch[urlMatch.length - 1].replace(/^url=/, '');
console.log("使用授权链接:", authUrl.slice(0, 120) + "...");

const browser = await chromium.launch({ headless: false, channel: "chrome", args: ["--start-maximized"] });
const context = await browser.newContext({ locale: "zh-CN", viewport: null, storageState: resolveAuthFile() });
const page = await context.newPage();
await page.goto(authUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
console.log("页面已打开:", page.url().slice(0, 100));
await page.waitForTimeout(3000);

// 找「确认授权」按钮
const selectors = [
  () => page.getByRole("button", { name: "确认授权" }),
  () => page.getByRole("button", { name: /确认授权|同意授权|授权登录|Authorize|确认/i }),
  () => page.locator('button:has-text("确认授权")'),
  () => page.locator('button:has-text("授权")'),
  () => page.locator('a:has-text("确认授权")'),
];
let clicked = null;
for (const pick of selectors) {
  try {
    const btn = pick();
    if (await btn.count() > 0) {
      await btn.first().waitFor({ state: "visible", timeout: 10000 });
      await btn.first().click({ timeout: 10000 });
      clicked = await btn.first().innerText().catch(() => "?");
      console.log("已点击:", clicked);
      break;
    }
  } catch { /* next */ }
}
if (!clicked) {
  console.log("未找到按钮，等待 5s 看页面是否自动跳转...");
  await page.waitForTimeout(5000);
  console.log("当前 URL:", page.url().slice(0, 120));
  console.log("页面文本:", (await page.innerText("body").catch(() => "")).slice(0, 300).replace(/\s+/g, " "));
}
await page.waitForTimeout(5000);
console.log("最终 URL:", page.url().slice(0, 150));
await browser.close();
console.log("完成");
