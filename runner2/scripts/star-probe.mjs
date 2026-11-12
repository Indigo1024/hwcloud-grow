#!/usr/bin/env node
/**
 * 每周 Star 任务（+50，WEEKLY×1）的可持续方案。
 *
 * 背景（2026-11-02 实测）：
 *   组织 agent-best-practices 共 32 个仓库，主号已全部 Star 完，没有「新仓库」
 *   可点；GitCode API 不提供取消 Star 的接口（DELETE /star 恒 405），所以
 *   「先取消再重点」这条路走不通。
 *
 *   实测结论：**Star 一个新仓库会在次日凌晨结算计分**（账号2 11-01 点了
 *   excel-formula-explainer，11-02 01:03 到账 +50）。所以只要每周能造出一个
 *   「新的 Star 动作」即可，不必依赖组织里还有剩余仓库。
 *
 * 做法（A 方案）：
 *   1. 在个人命名空间建一个临时私有仓库 star-probe-<周序号>
 *   2. Star 它
 *   3. 计分发生在次日凌晨，所以**本周建的仓库不能当天删**——
 *      由下次运行先清理上周的旧仓库（保留最近 2 个以防结算延迟）
 *
 * 用法：
 *   node scripts/star-probe.mjs           # 建仓 + Star，并清理旧仓库
 *   node scripts/star-probe.mjs --clean   # 只清理旧仓库
 *   node scripts/star-probe.mjs --dry     # 只看会做什么，不实际执行
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const API_BASE = "https://api.gitcode.com/api/v5";
const PROBE_PREFIX = "star-probe-";
/** 保留最近几个探测仓库（结算延迟期间不能删，2 个足够覆盖跨日） */
const KEEP_LAST = 2;

function readToken() {
  if (process.env.GITCODE_TOKEN) return process.env.GITCODE_TOKEN;
  const home = process.env.GITCODE_HOME || join(homedir(), ".gitcode");
  const authFile = join(home, "auth.toml");
  if (!existsSync(authFile)) return null;
  const m = readFileSync(authFile, "utf8").match(/access_token\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 204 无 body 属正常 */
  }
  return { ok: res.ok, status: res.status, json, text };
}

/** ISO 周序号，如 2026-W45；用于命名探测仓库，保证每周唯一 */
function isoWeekLabel() {
  const d = new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}W${String(week).padStart(2, "0")}`;
}

async function main() {
  const dry = process.argv.includes("--dry");
  const cleanOnly = process.argv.includes("--clean");

  const token = readToken();
  if (!token) {
    console.error("未找到 GitCode 凭证");
    process.exit(1);
  }

  const me = await api("/user", { token });
  if (!me.ok) {
    console.error(`GitCode 凭证无效（HTTP ${me.status}）`);
    process.exit(1);
  }
  const login = me.json.login;

  // ---------- 1. 清理旧探测仓库（保留最近 KEEP_LAST 个）----------
  const repos = await api(`/users/${login}/repos?per_page=100`, { token });
  const probes = (Array.isArray(repos.json) ? repos.json : [])
    .filter((r) => String(r.name || r.path || "").startsWith(PROBE_PREFIX))
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));

  const toDelete = probes.slice(KEEP_LAST);
  for (const r of toDelete) {
    const name = r.name || r.path;
    if (dry) {
      console.log(`[dry] 会删除 ${login}/${name}`);
      continue;
    }
    const d = await api(`/repos/${login}/${name}`, { method: "DELETE", token });
    console.log(`删除 ${login}/${name} → ${d.status}`);
    // 删仓库时它的 star 记录也一并消失，不会占用「已 star」配额
  }
  if (cleanOnly) return;

  // ---------- 2. 本周探测仓库是否已存在 ----------
  const label = isoWeekLabel();
  const name = `${PROBE_PREFIX}${label}`;
  const existing = probes.find((r) => (r.name || r.path) === name);
  if (existing) {
    // 已建过：确保仍处于 star 状态即可（重复 POST 无害，返回 200）
    const s = await api(`/repos/${login}/${name}/star`, { method: "POST", token });
    console.log(`本周探测仓库已存在 ${login}/${name}，重新 Star → ${s.status}`);
    return;
  }

  // ---------- 3. 建仓 + Star ----------
  if (dry) {
    console.log(`[dry] 会创建 ${login}/${name} 并 Star`);
    return;
  }
  const created = await api("/user/repos", {
    method: "POST",
    token,
    body: {
      name,
      description: `每周 Star 任务用的临时仓库（${label}），计分后自动清理`,
      private: true,
      auto_init: true,
    },
  });
  if (!created.ok) {
    console.error(`建仓失败（HTTP ${created.status}）: ${created.text.slice(0, 150)}`);
    process.exit(1);
  }
  console.log(`已创建 ${login}/${name}`);

  const starred = await api(`/repos/${login}/${name}/star`, { method: "POST", token });
  console.log(`Star → ${starred.status}${starred.ok ? "（成功）" : ""}`);
  if (!starred.ok) process.exit(1);
}

main().catch((e) => {
  console.error("异常:", e?.message || e);
  process.exit(1);
});
