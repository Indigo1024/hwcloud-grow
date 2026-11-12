#!/usr/bin/env node
/** 轮询 storage/last-run-report.json，供 npm run report 在后台任务完成后使用 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAccountId, suffixFor } from "./accounts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const storageDir = join(__dirname, "..", "storage");
// 多账号：轮询各自账号的报告与日志文件
const accountId = resolveAccountId();
const sfx = (base, ext) => suffixFor(accountId, base, ext);
const REPORT = join(storageDir, sfx("last-run-report", ".json"));
const LOG = join(storageDir, sfx("agent-output", ".log"));
const TIMEOUT_MS = Number(process.env.HWCLOUD_REPORT_WAIT_MS || 10 * 60 * 1000);
const INTERVAL_MS = 5000;
const HEARTBEAT_EVERY = 3;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function lastLogHint() {
  if (!existsSync(LOG)) return "";
  try {
    const lines = readFileSync(LOG, "utf8").split(/\r?\n/).filter(Boolean);
    const pick = lines.filter((l) =>
      /--- T_|^\[(已尝试|跳过|已完成|失败)\]|码道|等待|报告已保存|开始执行/.test(l),
    );
    const line = pick.at(-1) || lines.at(-1) || "";
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  } catch {
    return "";
  }
}

async function main() {
  const start = Date.now();
  let ticks = 0;
  console.log("等待后台任务完成（通常 2–5 分钟，码道 TUI 排队时可能更久）…");

  while (Date.now() - start < TIMEOUT_MS) {
    if (existsSync(REPORT)) {
      try {
        const data = JSON.parse(readFileSync(REPORT, "utf8"));
        if (data.task_results?.length) {
          const elapsed = Math.round((Date.now() - start) / 1000);
          console.log(`\n报告已生成（等待 ${elapsed}s）`);
          return;
        }
      } catch {
        /* 文件写入中 */
      }
    }

    ticks += 1;
    if (ticks % HEARTBEAT_EVERY === 0) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      const hint = lastLogHint();
      console.log(hint ? `[${elapsed}s] ${hint}` : `[${elapsed}s] 运行中…`);
    }

    await sleep(INTERVAL_MS);
  }

  console.error("\n等待报告超时，请查看 storage/agent-output.log");
  process.exit(1);
}

main();
