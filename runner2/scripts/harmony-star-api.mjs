#!/usr/bin/env node
/**
 * 鸿蒙「Star 案例仓」任务的 API 实现。
 *
 * 为什么不用浏览器点 Star（原 harmony-daily.mjs 的做法）：
 *   那条路子要 ① 维持 GitCode 浏览器会话 ② 在 Vue 组件上点按钮 ③ 还要先绑对账号，
 *   任一步不满足就静默失败——2026-11-10 排查了一整轮（按钮是 DIV、有两份同名元素、
 *   组织页没有 Star、会话过期…），而且每天都可能因为会话过期重演。
 *   实际上 Star 就是一次 OpenAPI 调用：`POST /repos/{org}/{repo}/star`，
 *   用**访问令牌**（~/.gitcode/auth.toml）即可，稳定且与浏览器无关。
 *
 * 任务规则（服务端 /api/growth/tasks）：
 *   task_key=gitcode-star，orgs=["harmony-practice-center"]，match="any"
 *   —— 在该组织下 Star **任意一个**仓库即可（每天一次）。
 *   注意：/orgs/{org}/repos 对本 token 返回 403（实测），所以用内置候选仓列表。
 *
 * 用法: node harmony-star-api.mjs [main|acct2]
 * 退出码: 0 成功（已 Star 或刚 Star）；2 拿不到令牌；3 未能 Star（保留给上层判断）
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.gitcode.com/api/v5";
const acc = process.argv[2] || "main";
const log = (m) => console.log(`[star-api] ${m}`);

/** 凭证目录：与 accounts.mjs 的 gitcodeHome 约定一致 */
const GITCODE_HOME = acc === "acct2" ? "/root/.gitcode-acct2" : "/root/.gitcode";

/**
 * 候选目标仓（harmony-practice-center 组织下）。
 * /orgs/{org}/repos 403 拿不到列表，所以内置几个已知存在的；
 * 逐个尝试，任一成功即满足「match=any」。
 */
const CANDIDATES = [
  "HarmonyOS-AtomSer-AdventureWheel",
  "word-check-in",
  "HarmonyOS-APP-word-check-in",
];

function readToken() {
  if (process.env.GITCODE_TOKEN) return process.env.GITCODE_TOKEN;
  const f = join(GITCODE_HOME, "auth.toml");
  if (!existsSync(f)) return null;
  const m = readFileSync(f, "utf8").match(/access_token\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

async function api(path, { method = "GET", token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

async function main() {
  const token = readToken();
  if (!token) {
    log(`❌ 未找到 ${acc} 的 GitCode 令牌（${GITCODE_HOME}/auth.toml）`);
    process.exit(2);
  }

  // 先确认令牌身份（顺便证明有效）
  const me = await api("/user", { token });
  const login = me.json?.login || "?";
  log(`账号 ${acc} → GitCode ${login}`);

  // 已 star 的仓库集合（反向查询，避免对每个仓都问一遍 stargazers）
  const starred = new Set();
  for (let page = 1; page <= 10; page++) {
    const r = await api(`/user/starred?per_page=100&page=${page}`, { token });
    if (!r.ok || !Array.isArray(r.json) || r.json.length === 0) break;
    for (const x of r.json) if (x.full_name) starred.add(x.full_name);
    if (r.json.length < 100) break;
  }

  // 组织里已 star 过任意一个 → 今天的任务条件已满足
  const already = [...starred].filter((f) => f.startsWith("harmony-practice-center/"));
  if (already.length) {
    log(`✅ 已 Star 过该组织仓库：${already.join(", ")}（任务条件已满足）`);
    return 0;
  }

  // 逐个候选仓尝试 Star
  for (const repo of CANDIDATES) {
    const full = `harmony-practice-center/${repo}`;
    const r = await api(`/repos/${full}/star`, { method: "POST", token });
    if (r.ok) {
      log(`✅ 已 Star：${full}`);
      return 0;
    }
    log(`  ${full} → HTTP ${r.status}${r.json?.error_message ? " " + r.json.error_message.slice(0, 60) : ""}`);
  }

  log("❌ 所有候选仓都没能 Star 成功");
  return 3;
}

main()
  .then((rc) => process.exit(rc ?? 0))
  .catch((e) => { console.error("异常:", e?.message || e); process.exit(2); });
