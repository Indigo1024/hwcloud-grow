import { chromium } from "playwright";
import { resolveAuthFile } from "./auth-utils.mjs";
import { resolveAccountId } from "./accounts.mjs";

// 模拟 agent 的 headless 模式测试
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  locale: "zh-CN",
  // 必须按账号取：无参会恒走主号，带 HWCLOUD_ACCOUNT=acct2 跑等于拿主号 Cookie 冒充新号
  storageState: resolveAuthFile(resolveAccountId(process.env.HWCLOUD_ACCOUNT)),
});
const page = await context.newPage();
await page.goto("https://developer.huaweicloud.com/grow", { waitUntil: "domcontentloaded", timeout: 90000 });
await page.waitForTimeout(6000);
const text = await page.innerText("body").catch(() => "");
console.log("URL:", page.url());
console.log("含'我的积分':", text.includes("我的积分"));
console.log("含'积分明细':", text.includes("积分明细"));
console.log("含'登录/注册查看':", text.includes("登录/注册查看"));
await browser.close();
