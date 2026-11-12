#!/usr/bin/env node
/**
 * 统一 Agent 入口：Cursor / Claude Code / 码道 IDE 均使用 npm run agent。
 * 一律后台启动任务并立即返回，避免 Agent 终端工具超时误判为卡住。
 * 完成后由 npm run report 等待并展示结果。
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerRoot = join(__dirname, "..");

const result = spawnSync(process.execPath, [join(__dirname, "agent-background.mjs")], {
  cwd: runnerRoot,
  stdio: "inherit",
  env: process.env,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("\n【agent】任务已在后台运行（含 Playwright 与码道 TUI，约 2–5 分钟）");
console.log("本命令已结束，请**立即**执行: npm run report（将自动等待任务完成）");
