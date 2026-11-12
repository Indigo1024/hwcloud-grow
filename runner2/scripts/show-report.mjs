#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAccountId, suffixFor } from "./accounts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerRoot = join(__dirname, "..");
// 多账号：按 HWCLOUD_ACCOUNT 选择对应账号的报告与 PID 文件
const accountId = resolveAccountId();
const sfx = (base, ext) => suffixFor(accountId, base, ext);
const reportPath = join(runnerRoot, "storage", sfx("last-run-report", ".json"));
const pidPath = join(runnerRoot, "storage", sfx("agent-background", ".pid"));

if (!existsSync(reportPath) && existsSync(pidPath)) {
  console.log("检测到后台任务，等待报告生成…");
  spawnSync(process.execPath, [join(__dirname, "wait-report.mjs")], {
    cwd: runnerRoot,
    stdio: "inherit",
    env: process.env,
  });
}

if (!existsSync(reportPath)) {
  console.error("暂无运行报告，请先执行: npm run agent");
  process.exit(1);
}

const data = JSON.parse(readFileSync(reportPath, "utf8"));
console.log(data.report_text || JSON.stringify(data, null, 2));
