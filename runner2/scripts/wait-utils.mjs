import { GROW_URL } from "./auth-path.mjs";
import { GROW } from "./selectors.mjs";
import { gotoWithRetry } from "./auth-utils.mjs";

/**
 * 打开成长中心并等待关键区域出现。
 *
 * 用 gotoWithRetry 而不是裸 page.goto：本机有多个 tun 代理接口，
 * 网络切换会让 Chromium 抛 ERR_NETWORK_CHANGED 直接打断导航。
 * 2026-11-10 因此让主号 daily-run 在第一步就失败（当天 0 分），故统一重试。
 */
export async function openGrowAndWait(page, { timeout = 90_000 } = {}) {
  await gotoWithRetry(page, GROW_URL, { timeout });
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
  const points = page.locator(`text=${GROW.pointsHeader}`).first();
  if ((await points.count()) > 0) {
    await points.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  } else {
    await page.waitForTimeout(2_000);
  }
}
