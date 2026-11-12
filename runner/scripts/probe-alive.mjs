// 用相对路径导入，别写死 /root/hwcloud-grow/runner/…：
// 本文件在 runner 与 runner2 下各有一份，绝对路径会让账号2 那份去加载主号的
// 模块（连带用错账号解析），发布到别处也无法运行（2026-11-11 扫描发现）。
import { launchBrowser } from "./browser-utils.mjs";
import { resolveAuthFile } from "./auth-utils.mjs";
import { resolveAccountId } from "./accounts.mjs";

// 登录态探针：分别探测成长中心与 BBS 两个子站。
// 判据不能只看「不是 200 就算掉线」——成长中心在 csrf 未就绪时会返回
// 403 `no request_csrf found`，此时 cookie/登录态其实完好（BBS 同时返回 200），
// 旧探针对这种情形一律报 not login，造成「登录很不稳定」的错觉。
const b = await launchBrowser({ headless: true });
// 按账号取登录态：不传账号时恒探主号，acct2 掉线会被误报为有效
const accountId = resolveAccountId(process.env.HWCLOUD_ACCOUNT);
const ctx = await b.newContext({ storageState: resolveAuthFile(accountId), locale: "zh-CN" });
const page = await ctx.newPage();
let csrf = null;
page.on("request", (r) => {
  const t = r.headers()["csrf"];
  if (t && !csrf) csrf = t;
});
await page.goto("https://developer.huaweicloud.com/grow", {
  waitUntil: "domcontentloaded",
  timeout: 90000,
});
// 等待页面自身发出带 csrf 的请求（实测需要 10s 量级）
for (let i = 0; i < 25 && !csrf; i++) await page.waitForTimeout(1000);

const grow = await page.evaluate(async (csrf) => {
  const h = { accept: "application/json" };
  if (csrf) h.csrf = csrf;
  try {
    const r = await fetch(
      "https://devdata.huaweicloud.com/rest/developer/fwdu/rest/developer/user/hdcommunitysoservice/v1/growth/bonus-beans",
      { credentials: "include", headers: h },
    );
    return { status: r.status, body: (await r.text()).slice(0, 100) };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}, csrf);

const bbs = await page.evaluate(async (csrf) => {
  const h = { "content-type": "application/json" };
  if (csrf) h.csrf = csrf;
  try {
    const r = await fetch(
      "https://devdata.huaweicloud.com/rest/developer/fwdu/rest/developer/user/hdcnforumservice/v1/get-personal-info",
      { method: "POST", credentials: "include", headers: h, body: "{}" },
    );
    return { status: r.status, body: (await r.text()).slice(0, 100) };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}, csrf);

console.log("csrf:", csrf ? "已获取" : "未获取");
console.log("成长中心探针:", JSON.stringify(grow));
console.log("BBS   探针:", JSON.stringify(bbs));

// 结论：两者都 403 才是真掉线；只有成长中心报 csrf 错属于 csrf 未就绪，登录态仍有效
const loggedOut = grow.status === 403 && bbs.status !== 200;
console.log("登录检测: " + (loggedOut ? "ok=false" : "ok=true"));

await b.close();
