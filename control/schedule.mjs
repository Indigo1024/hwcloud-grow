/**
 * 定时开关：控制两账号的每日/每周 cron 是否生效。
 *
 * 实现方式：不直接改 crontab 文本（容易和用户手工编辑打架、也可能把
 * 别的条目一起改坏），而是把「开关状态」写进 state/schedule.json，
 * 再由 cron 调用的 daily-run.sh / weekly-run.sh 开头读一次：
 *   关闭 → 打印一行原因后 exit 0。
 *
 * 好处：
 *   - crontab 里那几行永远不动，随时能恢复；
 *   - 状态是数据不是代码，面板读写都安全；
 *   - 即使面板服务挂了，cron 仍按最后写入的状态执行。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEPLOYMENTS } from "./tasks.mjs";

import { STATE_DIR } from "./paths.mjs";
const FILE = join(STATE_DIR, "schedule.json");
mkdirSync(STATE_DIR, { recursive: true });

/** 默认全开：之前的行为是全部自动跑，不能让面板一上线就把定时关了 */
const DEFAULTS = {
  main: { daily: true, weekly: true },
  acct2: { daily: true, weekly: true },
};

export function readSchedule() {
  if (!existsSync(FILE)) return structuredClone(DEFAULTS);
  try {
    const j = JSON.parse(readFileSync(FILE, "utf8"));
    const out = structuredClone(DEFAULTS);
    for (const acc of Object.keys(DEFAULTS)) {
      if (j[acc]) {
        out[acc].daily = j[acc].daily !== false;
        out[acc].weekly = j[acc].weekly !== false;
      }
    }
    return out;
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function setSchedule(acc, field, value) {
  if (!DEPLOYMENTS[acc]) return { ok: false, reason: `未知账号 ${acc}` };
  if (field !== "daily" && field !== "weekly") return { ok: false, reason: `未知开关 ${field}` };
  const cur = readSchedule();
  cur[acc][field] = !!value;
  writeFileSync(FILE, JSON.stringify(cur, null, 2), "utf8");
  return { ok: true, schedule: cur };
}

/** 供 shell 脚本调用：node schedule-gate.mjs <acc> <daily|weekly>，关闭时退出码 3 */
export function gate(acc, field) {
  const s = readSchedule();
  const on = s[acc]?.[field];
  return on !== false;
}
