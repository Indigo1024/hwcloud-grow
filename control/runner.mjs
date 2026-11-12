/**
 * 任务执行器：把面板点下的任务跑起来，并把运行状态写进 state/。
 *
 * 为什么单独一个进程而不是在 HTTP 服务里同步跑：
 *   daily-run.sh 最长要跑一小时，HTTP 请求不能挂那么久。
 *   面板点「运行」→ 服务端 spawn 一个独立进程组 → 立即返回 runId，
 *   前端轮询 /api/status 看进度。任务进度由各任务的日志尾部推断。
 *
 * 并发控制：同一账号同时只允许一个任务在跑。抢浏览器/Xvfb 会互相干扰，
 * 之前两个 daily-run 并发跑出过重复发文（2026-11-08 实际踩到）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync, openSync } from "node:fs";
import { join } from "node:path";
import { DEPLOYMENTS, taskByKey } from "./tasks.mjs";

import { ROOT, STATE_DIR, RUNS_DIR } from "./paths.mjs";
const LOCK_DIR = join(STATE_DIR, "locks");

for (const d of [STATE_DIR, RUNS_DIR, LOCK_DIR]) mkdirSync(d, { recursive: true });

/** 每个账号一把锁：写 pid + 启动时间，进程没了即视为锁失效 */
function lockPath(acc) {
  return join(LOCK_DIR, `${acc}.lock`);
}

function readLock(acc) {
  const f = lockPath(acc);
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8"));
    // 进程还活着才算持有锁；否则是上次异常退出留下的死锁
    try {
      process.kill(j.pid, 0);
      return j;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export function activeRun(acc) {
  return readLock(acc);
}

/** 判断某任务的入口脚本是否存在于该部署 */
function resolveScript(acc, task) {
  const dep = DEPLOYMENTS[acc];
  if (!dep) return { ok: false, reason: `未知账号 ${acc}` };
  const [bin, ...rest] = task.script;
  const main = join(dep.runnerDir, rest[0]);
  if (!existsSync(main)) {
    return { ok: false, reason: `缺少入口文件 ${rest[0]}` };
  }
  return { ok: true, bin, args: rest, cwd: dep.runnerDir, dep };
}

/**
 * 运行一个任务。
 * @returns {{ok:boolean, runId?:string, pid?:number, reason?:string}}
 */
export function startTask(acc, key) {
  const task = taskByKey(key);
  if (!task) return { ok: false, reason: `未知任务 ${key}` };

  const running = readLock(acc);
  if (running) {
    return { ok: false, reason: `该账号已有任务在运行（${running.title}，pid=${running.pid}）` };
  }

  const r = resolveScript(acc, task);
  if (!r.ok) return { ok: false, reason: r.reason };

  const runId = `${Date.now()}-${key}`;
  const runLog = join(RUNS_DIR, `${acc}-${runId}.log`);
  const startedAt = new Date().toISOString();

  // 记录本次运行：面板据此显示「上次结果」
  const meta = {
    runId,
    acc,
    key,
    title: task.title,
    desc: task.desc,
    startedAt,
    finishedAt: null,
    exitCode: null,
    logFile: runLog,
    pid: null,
  };

  const env = {
    ...process.env,
    ...r.dep.env,
    PATH: `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ""}`,
    DISPLAY: process.env.DISPLAY || ":99",
    // 告诉被启动的 run.sh「本轮由面板执行器负责记账与占锁」，
    // 让它不要再记一条历史 / 再占一次锁（否则历史重复、锁互相覆盖）。
    HWCLOUD_PANEL_RUN: "1",
  };

  // detached + setsid：让任务脱离本服务进程组，
  // 这样服务重启不会把正在跑的任务一起带走（之前 daily-run 被工具超时杀过）。
  //
  // 2026-11-10 踩到大坑：仅靠 detached 还不够！
  //   任务虽脱离进程组，但仍在 **panel-server 的 systemd cgroup** 里，
  //   而 hw-points-panel.service 是 KillMode=control-group —— 于是
  //   `systemctl restart hw-points-panel`（部署面板就会触发）会把 cgroup 内
  //   所有进程一起 SIGTERM，正在跑的任务被拦腰砍断（表现为 exitCode=null、
  //   signal=SIGTERM、日志停在半路）。
  //   正解：用 systemd-run 把任务放进**独立的 transient unit**，
  //   既脱离本服务 cgroup，又能被 systemctl/日志单独管理。
  //   见 spawnDetached()。
  const metaFile = join(RUNS_DIR, `latest-${acc}.json`);
  // 每次运行单独存一份 meta：latest-<acc>.json 只保留最近一次（面板显示「上次结果」用），
  // 历史列表要靠 per-run 文件，否则一跑新任务就把上一条记录冲掉了。
  const runMetaFile = join(RUNS_DIR, `run-${acc}-${runId}.json`);
  appendFileSync(runLog, `[${new Date().toISOString()}] ▶ ${task.title}（账号 ${acc}）\n`);
  appendFileSync(runLog, `命令: ${r.bin} ${r.args.join(" ")}  (cwd=${r.cwd})\n\n`);
  const logFd = openSync(runLog, "a");

  // 启动方式：用 systemd-run 把任务放进独立的 transient unit，
  // 让它脱离面板服务的 cgroup —— 否则 `systemctl restart hw-points-panel`
  // （部署面板就会触发）会把 cgroup 内的任务一起 SIGTERM（2026-11-10 实际踩到）。
  //
  // 用 service 模式（异步）而不是 --scope：scope 会让 systemd-run 前台阻塞、
  // 拿不到稳定 pid；service 模式立即返回，任务由 systemd 托管，
  // 且 `systemctl status hwcloud-task-<acc>-<runId>` 可直接排查。
  // systemd-run 不可用时回落到普通 detached spawn（功能一样，只是重启面板会打断任务）。
  const launchArgs = [
    join(ROOT, "control", "exec-wrapper.mjs"),
    acc, runId, runMetaFile, metaFile, lockPath(acc), String(task.timeoutMs), runLog,
    r.bin, ...r.args,
  ];
  const unitName = `hwcloud-task-${acc}-${runId}`;
  let pid = null;
  try {
    // 注意：systemd-run **不继承**调用方的环境（它用自己的 manager 环境），
    // 关键变量必须用 --setenv 显式传入。漏传的后果很实际：
    // 2026-11-10 漏了 HWCLOUD_PANEL_RUN，daily-run.sh 以为自己是 cron 触发，
    // 于是 record.mjs 又去抢锁、报「已有任务在运行」把自己拦下——任务秒退。
    // 只挑必要的传（全量传可能超出命令行长度，且没必要）。
    const KEEP_ENV = [
      "PATH", "HOME", "LANG", "DISPLAY",
      "HWCLOUD_ACCOUNT", "HWCLOUD_PANEL_RUN", "HWCLOUD_SKIP_CODEARTS_QA",
      "HWCLOUD_QA_TIMEOUT_MS", "HWCLOUD_API_TIMEOUT_MS", "HWCLOUD_SNAPSHOT_STEP_MS",
      "CODEARTS_HOME", "CODEARTS_WORKSPACE_HOME", "CODEARTS_CLI_AK", "CODEARTS_CLI_SK",
      "HUAWEICLOUD_SDK_AK", "HUAWEICLOUD_SDK_SK", "HCLOUD_PROFILE", "ENV_FILE",
    ];
    const setenv = KEEP_ENV
      .filter((k) => env[k] != null && env[k] !== "")
      .map((k) => `--setenv=${k}=${env[k]}`);
    const c = spawn(
      "systemd-run",
      [
        "--collect", "--quiet", `--unit=${unitName}`,
        `--working-directory=${r.cwd}`,
        ...setenv,
        "--", process.execPath, ...launchArgs,
      ],
      { cwd: r.cwd, env, detached: true, stdio: ["ignore", logFd, logFd] },
    );
    pid = c.pid;
    c.unref();
  } catch {
    const c = spawn(process.execPath, launchArgs, {
      cwd: r.cwd, env, detached: true, stdio: ["ignore", logFd, logFd],
    });
    pid = c.pid;
    c.unref();
  }

  // 注意：这里写的 pid 只是「启动器」的 pid，随时会变。
  // 真正的「任务是否在跑」由 exec-wrapper **自己**把它 process.pid 写回
  // 这三个文件（见 exec-wrapper.mjs 的 claimPid），面板以那份为准。
  meta.pid = pid;
  const rec = { ...meta, runMetaFile, unit: unitName };
  writeFileSync(lockPath(acc), JSON.stringify(meta), "utf8");
  writeFileSync(metaFile, JSON.stringify(meta, null, 2), "utf8");
  writeFileSync(runMetaFile, JSON.stringify(rec, null, 2), "utf8");
  pruneHistory(acc);

  return { ok: true, runId, pid };
}

/** 运行历史只留最近 N 条（含日志），避免 state/ 无限膨胀 */
const HISTORY_KEEP = 200;
function pruneHistory(acc) {
  try {
    const runs = listRunRecords(acc);
    for (const r of runs.slice(HISTORY_KEEP)) {
      try { unlinkSync(r.metaPath); } catch {}
      if (r.logFile) { try { unlinkSync(r.logFile); } catch {} }
    }
  } catch {}
}

/** 读出该账号全部 per-run 记录，按开始时间倒序 */
function listRunRecords(acc) {
  try {
    return readdirSync(RUNS_DIR)
      .filter((f) => f.startsWith(`run-${acc}-`) && f.endsWith(".json"))
      .map((f) => {
        const metaPath = join(RUNS_DIR, f);
        try {
          const j = JSON.parse(readFileSync(metaPath, "utf8"));
          return { ...j, metaPath };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
  } catch {
    return [];
  }
}

/** 读最近一次运行结果 */
export function lastRun(acc) {
  const f = join(RUNS_DIR, `latest-${acc}.json`);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return null;
  }
}

/** 日志尾部若干行，供面板显示实时进度 */
export function tailRunLog(acc, lines = 12) {
  const last = lastRun(acc);
  if (!last?.logFile || !existsSync(last.logFile)) return [];
  try {
    const txt = readFileSync(last.logFile, "utf8");
    const all = txt.trimEnd().split("\n");
    return all.slice(-lines);
  } catch {
    return [];
  }
}

/** 运行历史（最近 N 次），面板「运行历史」区用 */
export function history(acc, limit = 30) {
  return listRunRecords(acc).slice(0, limit).map((r) => ({
    runId: r.runId,
    key: r.key,
    title: r.title,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt || null,
    exitCode: r.exitCode,
    signal: r.signal || null,
  }));
}
