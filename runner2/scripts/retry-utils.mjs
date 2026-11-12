export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 轮询直到 fn 返回 true 或超时；间隔指数退避（带上限）。
 */
export async function pollUntil(
  fn,
  { timeoutMs = 120_000, baseIntervalMs = 2_000, maxIntervalMs = 8_000 } = {},
) {
  const start = Date.now();
  let interval = baseIntervalMs;
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await sleep(interval);
    interval = Math.min(maxIntervalMs, Math.floor(interval * 1.5));
  }
  return false;
}
