/**
 * 统一的路径解析：项目根、状态目录等。
 *
 * 为什么要单独抽一层：
 *   早先各文件都写死 `const ROOT = "/root/hwcloud-grow"`，导致
 *     ① 换目录部署就得挨个改
 *     ② 发布出去的包会去读写作者机器上的路径（2026-11-11 发布自检发现）
 *   现在统一按**本文件的位置**推导：control/ 的上一级就是项目根，
 *   无论项目放在 /root/hwcloud-grow 还是 /home/me/my-grow 都成立。
 *
 * 仍可用环境变量覆盖（部署到非常规布局时用）：
 *   HWCLOUD_ROOT       项目根
 *   HWCLOUD_STATE_DIR  状态目录（默认 <root>/state）
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 项目根：control/ 的上一级目录 */
export const ROOT = process.env.HWCLOUD_ROOT
  ? resolve(process.env.HWCLOUD_ROOT)
  : resolve(__dirname, "..");

/** 状态目录（运行记录、锁、开关） */
export const STATE_DIR = process.env.HWCLOUD_STATE_DIR || join(ROOT, "state");

export const RUNS_DIR = join(STATE_DIR, "runs");
export const LOCKS_DIR = join(STATE_DIR, "locks");

/** 按账号取部署目录（runner / runner2） */
export function runnerDirFor(acc) {
  return join(ROOT, acc === "main" ? "runner" : `runner${acc.replace(/^acct/, "")}`);
}

/** 确保目录存在 */
export function ensureDir(p) {
  try { if (!existsSync(p)) mkdirSync(p, { recursive: true }); } catch {}
  return p;
}
