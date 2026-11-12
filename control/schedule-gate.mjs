#!/usr/bin/env node
/**
 * 定时开关闸门，供 shell 脚本调用。
 *   node schedule-gate.mjs main daily
 * 退出码 0 = 允许运行；3 = 开关已关闭，调用方应直接跳过。
 *
 * 单独做成进程而不是 source 一个 shell 变量：状态是 JSON，
 * 交给 node 解析避免在 shell 里手写解析逻辑。
 */
import { gate } from "./schedule.mjs";

const [, , acc, field] = process.argv;
if (!acc || !field) {
  console.error("用法: node schedule-gate.mjs <account> <daily|weekly>");
  process.exit(2);
}
if (gate(acc, field)) {
  process.exit(0);
}
console.log(`[定时开关] ${acc} 的 ${field} 定时已关闭，跳过本次自动运行`);
process.exit(3);
