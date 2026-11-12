#!/usr/bin/env node
/**
 * 任务执行包装器：跑真正的任务命令，负责写状态、释放锁、收输出。
 *
 * 为什么需要这一层：
 *   面板点「运行」是短命请求，不能同步等一小时的 daily-run。
 *   所以真正干活的命令交给本包装器，它随任务存活到结束，负责收尾。
 *
 * 关键设计（都是踩坑换来的）：
 *   1) **pid 由本进程自己写**（process.pid），不靠父进程传。
 *      父进程怎么启动我都不影响探活——之前用 process.ppid 记到了命令替换
 *      子 shell 的死 pid，导致面板永远显示「空闲」。
 *   2) **输出重定向自己开**，不用 stdio 继承。
 *      它是被 systemd-run 拉起的，继承的 fd 不由我们控制。
 *   3) 被 systemd-run 放进独立 transient unit，**脱离面板服务的 cgroup**，
 *      这样 `systemctl restart hw-points-panel` 不会连带 SIGTERM 掉正在跑的任务
 *      （2026-11-10 实际踩到：部署面板把跑了半程的 daily-run 拦腰砍断）。
 *
 * 用法（由 runner.mjs 调用）：
 *   node exec-wrapper.mjs <acc> <runId> <runMetaFile> <latestMetaFile> <lockFile> <timeoutMs> <logFile> <cmd> [args...]
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, unlinkSync, existsSync, openSync } from "node:fs";

const [, , acc, runId, runMetaFile, latestMetaFile, lockFile, timeoutMsRaw, logFile, cmd, ...args] =
  process.argv;
const timeoutMs = Number(timeoutMsRaw) || 0;
const myPid = process.pid;

let child = null;
let finished = false;

/** 把「我（包装器）的 pid」写进各个状态文件，供面板探活 */
function claimPid() {
  for (const f of [runMetaFile, latestMetaFile, lockFile]) {
    if (!f) continue;
    try {
      const meta = JSON.parse(readFileSync(f, "utf8"));
      meta.pid = myPid;
      writeFileSync(f, JSON.stringify(meta, null, 2), "utf8");
    } catch {
      // 文件可能还没建/格式异常，补一个最小记录也比没有强
      try { writeFileSync(f, JSON.stringify({ runId, acc, pid: myPid }, null, 2), "utf8"); } catch {}
    }
  }
}

function finish(code, signal, extra = "") {
  if (finished) return;
  finished = true;
  const patch = { finishedAt: new Date().toISOString(), exitCode: code, signal: signal || null };
  for (const f of [runMetaFile, latestMetaFile]) {
    if (!f) continue;
    try {
      const meta = JSON.parse(readFileSync(f, "utf8"));
      writeFileSync(f, JSON.stringify({ ...meta, ...patch }, null, 2), "utf8");
    } catch {
      try { writeFileSync(f, JSON.stringify({ runId, acc, ...patch }, null, 2), "utf8"); } catch {}
    }
  }
  // 锁只在「还是自己这轮」时才删，避免误删后来者写的锁
  try {
    if (existsSync(lockFile)) {
      const cur = JSON.parse(readFileSync(lockFile, "utf8"));
      if (cur.runId === runId) unlinkSync(lockFile);
    }
  } catch {}
  if (extra && logFile) {
    try { appendFileSync(logFile, extra); } catch {}
  }
  process.exit(0);
}

claimPid();

// 硬超时：到点带走任务整棵进程树。
// 子进程自己也 detached（自成进程组），这样能只杀它那一组、
// 包装器本身活着把 finishedAt/退出码写回去。
let killer = null;
if (timeoutMs > 0) {
  killer = setTimeout(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    finish(-9, "SIGKILL", `\n[超时] 超过 ${Math.round(timeoutMs / 1000)}s，已强制结束\n`);
  }, timeoutMs);
  killer.unref?.();
}

// 自己开日志文件并把子进程输出接进去。
// 不用 stdio:"inherit"：本进程由 systemd-run 拉起，继承的 fd 不由我们控制。
let out = null;
try { out = openSync(logFile, "a"); } catch { out = "ignore"; }

child = spawn(cmd, args, { stdio: ["ignore", out, out], detached: true });
child.on("exit", (code, signal) => {
  if (killer) clearTimeout(killer);
  finish(code, signal);
});
child.on("error", (e) => finish(-1, null, `\n[包装器] 启动失败: ${e.message}\n`));

// 外部 SIGTERM（例如整机重启）时，先带走任务再收尾
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    try { child.kill(sig); } catch {}
  });
}
