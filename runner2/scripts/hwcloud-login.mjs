#!/usr/bin/env node
/**
 * 打开有界面浏览器，提示用户扫码登录华为云，保存 Cookie 供后续 Agent 复用。
 *
 * 用法: npm run login
 */
import { authPathsFor } from "./auth-path.mjs";
import { resolveAccountId } from "./accounts.mjs";
import {
  ensureStorageDir,
  hasSavedAuth,
  navigateToLogin,
  openGrowAndCheckLogin,
  resolveAuthFile,
  saveAuthState,
  saveSessionMeta,
  waitForLogin,
  restrictStorageFilePermissions,
} from "./auth-utils.mjs";
import { launchBrowser } from "./browser-utils.mjs";
import { captureGrowSnapshot, formatReportZh } from "./grow-report.mjs";

async function main() {
  // 按账号取路径：直接用 auth-path 的 AUTH_FILE 恒为主号文件，
  // 给 acct2 扫码会把新号 Cookie 写进主号登录态，主号当场掉线。
  const accountId = resolveAccountId(process.env.HWCLOUD_ACCOUNT);
  const AUTH_FILE = authPathsFor(accountId).authFile;
  ensureStorageDir(accountId);

  if (hasSavedAuth(accountId)) {
    console.log("检测到已保存的登录态，将先验证是否仍然有效…");
  }

  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: null,
    locale: "zh-CN",
    ...(hasSavedAuth(accountId) ? { storageState: resolveAuthFile(accountId) } : {}),
  });
  const page = await context.newPage();

  let loggedIn = await openGrowAndCheckLogin(page);

  if (!loggedIn) {
    await navigateToLogin(page);
    loggedIn = await waitForLogin(page);
  }

  if (!loggedIn) {
    console.error("登录超时或未完成，未保存 Cookie。请重新运行: npm run login");
    await browser.close();
    process.exit(1);
  }

  await page.goto("https://developer.huaweicloud.com/grow", {
    waitUntil: "networkidle",
    timeout: 90000,
  }).catch(() => page.goto("https://developer.huaweicloud.com/grow", {
    // 兜底那次也必须带 timeout：不带的话页面卡住就永久挂起，
    // 整个登录流程没有下文（2026-11-11 扫描发现）。
    waitUntil: "domcontentloaded",
    timeout: 90000,
  }));
  await page.waitForTimeout(2000);

  const pointsSnippet = await captureGrowSnapshot(page);
  await saveAuthState(context, AUTH_FILE);
  restrictStorageFilePermissions(AUTH_FILE);
  // 注意参数顺序：extra 在前、accountId 在后，传反会把账号当成 extra 丢掉
  saveSessionMeta(
    {
      points_snippet: pointsSnippet.points?.current_points ?? pointsSnippet.header?.display_points,
      status: "active",
    },
    accountId,
  );

  console.log("✓ 登录成功，Cookie 已保存到:");
  console.log(" ", AUTH_FILE);
  if (pointsSnippet.points?.current_points != null) {
    console.log(`  当前可兑换积分：${pointsSnippet.points.current_points}`);
  }
  if (pointsSnippet.header?.display_points != null) {
    console.log(`  成长中心展示积分：${pointsSnippet.header.display_points}`);
  }
  const preview = formatReportZh(pointsSnippet, pointsSnippet, []);
  console.log("\n" + preview.split("【本次任务执行】")[0].trim());
  console.log("\n后续执行任务请运行: npm run agent");

  await page.waitForTimeout(1500);
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
