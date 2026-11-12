import { chromium } from "playwright";

// Xvfb 虚拟显示没有可用 GPU，Chrome 默认尝试走 GPU 渲染会严重退化：
// 实测同一页面 headless 1.3s，有头却要 27s（自带 chromium 甚至启动耗时 211s 才超时），
// 表现为扫码登录在 180s 内跑不完、报 "browserType.launch: Timeout"。
// 加 --disable-gpu 后回落到软件渲染，有头模式恢复到 2s 内启动、1.8s 加载。
const GPU_OFF_ARGS = ["--disable-gpu", "--disable-software-rasterizer", "--disable-dev-shm-usage"];

/** @param {{ headless?: boolean }} opts */
export async function launchBrowser({ headless = false } = {}) {
  const launchOpts = {
    headless,
    args: headless ? [] : ["--start-maximized", ...GPU_OFF_ARGS],
  };
  try {
    return await chromium.launch({ ...launchOpts, channel: "chrome" });
  } catch {
    return await chromium.launch(launchOpts);
  }
}
