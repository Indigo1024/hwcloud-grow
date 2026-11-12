// quick-check.mjs — 快速判断当前账号的登录态是否有效
//
// 多账号：登录态路径必须按账号派生。以前这里硬编码了
// storage/huaweicloud-auth.json，acct2 跑检查时读的是主号 Cookie，
// 结果「主号还活着」被当成「acct2 也活着」，实际新号早已掉线。
import { launchBrowser } from "./browser-utils.mjs";
import { openGrowAndCheckLogin, resolveAuthFile } from "./auth-utils.mjs";
import { resolveAccountId } from "./accounts.mjs";

const accountId = resolveAccountId(process.env.HWCLOUD_ACCOUNT);
const browser = await launchBrowser({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1400, height: 900 },
  locale: "zh-CN",
  storageState: resolveAuthFile(accountId),
});
const page = await context.newPage();
const t0 = Date.now();
const ok = await openGrowAndCheckLogin(page);
console.log(`登录检测: ok=${ok} 耗时=${((Date.now() - t0) / 1000).toFixed(1)}s 账号=${accountId}`);
await browser.close();
