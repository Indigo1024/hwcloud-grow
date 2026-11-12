#!/usr/bin/env node
/**
 * 后台启动 agent:headless（不杀任何 codearts 进程）。
 * 由 npm run agent 统一调用；Agent 禁止自行写 Start-Process。
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dumpCodeArtsIdeDiagnostics } from "./codearts-cli.mjs";
import { resolveAccountId, suffixFor } from "./accounts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runnerRoot = join(__dirname, "..");
const storageDir = join(runnerRoot, "storage");
// 多账号：日志/报告/PID 都按账号派生，否则两个账号同时跑会互相覆盖，
// 表现为「报告里只有后一个账号的结果」。
const ACCOUNT_ID = resolveAccountId();
const sfx = (base, ext) => suffixFor(ACCOUNT_ID, base, ext);
const logFile = join(storageDir, sfx("agent-output", ".log"));
const errFile = join(storageDir, sfx("agent-error", ".log"));
const reportFile = join(storageDir, sfx("last-run-report", ".json"));
const pidFile = join(storageDir, sfx("agent-background", ".pid"));

mkdirSync(storageDir, { recursive: true });

if (existsSync(reportFile)) unlinkSync(reportFile);

// 🔍 诊断模式
dumpCodeArtsIdeDiagnostics();

const env = { ...process.env };

const outFd = openSync(logFile, "w");
const errFd = openSync(errFile, "w");

const child = spawn(process.execPath, ["scripts/agent-run.mjs", "--headless"], {
  cwd: runnerRoot,
  env,
  detached: true,
  stdio: ["ignore", outFd, errFd],
  windowsHide: true,
});

child.unref();
writeFileSync(pidFile, String(child.pid));

console.log(`已在后台启动任务（pid=${child.pid}）`);
console.log(`实时日志: ${logFile}`);
