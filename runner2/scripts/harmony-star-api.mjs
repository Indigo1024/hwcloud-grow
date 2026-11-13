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
 * 目标仓发现：优先用搜索接口动态拿该组织的仓库列表，拿不到才回落内置名单。
 *
 * 为什么要动态发现（2026-11-13）：
 *   这是**每日**任务，每天都要产生一个"新的 Star 动作"。
 *   内置名单只有十几个，两个账号每天各点一个，十几天就点完，
 *   之后又会回到"每天假成功、积分不到账"的老问题。
 *   实测搜索接口 `?q=harmony-practice-center` 能返回该组织 19~20 个仓库，
 *   用它动态列举，只要组织还在更新仓库就永远不会耗尽。
 */
const FALLBACK_CANDIDATES = [
  "HarmonyOS-AtomSer-AdventureWheel",
  "HarmonyOS-APP-Inspiration-Note",
  "HarmonyOS-APP-Moonlight-Post",
  "HarmonyOS-APP-OBSCloudAlbum",
  "HarmonyOS-APPTMPL-Weather",
  "HarmonyOS-AtomSerTMPL-MuseumTicket",
  "HarmonyOS-AtomSerTMPL-Parking",
  "HarmonyOS-AtomSerTMPL-ReservationQueue",
  "HarmonyOS-AtomSerTMPL-SchoolLife",
  "HarmonyOS-AtomSerTMPL-ShoppingMall",
  "HarmonyOS-AtomSerTMPL-SocialDating",
  "HarmonyOS-AtomSerTMPL-TouristAttraction",
  "HarmonyOS-AtomSerTMPL-news",
  "2048",
  "Recipes",
];

const ORG = "harmony-practice-center";

/** 动态发现该组织下的仓库；失败则返回内置名单 */
async function discoverCandidates(token) {
  const found = new Set();
  for (const q of [ORG, "HarmonyOS-AtomSer", "HarmonyOS-APP", "HarmonyOS-APPTMPL"]) {
    for (let page = 1; page <= 3; page++) {
      const r = await api(
        `/search/repositories?q=${encodeURIComponent(q)}&per_page=50&page=${page}`,
        { token },
      );
      if (!r.ok) break;
      const items = Array.isArray(r.json) ? r.json : (r.json?.items || []);
      if (!items.length) break;
      for (const x of items) {
        const fn = x.full_name || "";
        if (fn.startsWith(`${ORG}/`)) found.add(fn.slice(ORG.length + 1));
      }
      if (items.length < 50) break;
    }
  }
  if (found.size) {
    log(`动态发现该组织 ${found.size} 个仓库`);
    return [...found];
  }
  log("搜索接口没返回结果，改用内置名单");
  return FALLBACK_CANDIDATES;
}

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

  // 该组织下已 star 的
  const already = [...starred].filter((f) => f.startsWith("harmony-practice-center/"));
  log(`已 Star 该组织仓库 ${already.length} 个：${already.join(", ") || "（无）"}`);

  // 找候选列表里还没 star 的（每天需要一个新动作）
  const candidates = await discoverCandidates(token);
  const toTry = candidates
    .map((name) => `${ORG}/${name}`)
    .filter((full) => !starred.has(full));

  if (toTry.length === 0) {
    log(`❌ 发现到的 ${candidates.length} 个仓库全部已 Star，暂时没有新动作可做`);
    return 3;
  }
  log(`其中 ${toTry.length} 个尚未 Star，开始尝试…`);

  // 逐个尝试 Star
  for (const full of toTry) {
    const r = await api(`/repos/${full}/star`, { method: "POST", token });
    if (r.ok) {
      log(`✅ 已 Star：${full}（今日新动作）`);
      return 0;
    }
    log(`  ${full} → HTTP ${r.status}${r.json?.error_message ? " " + r.json.error_message.slice(0, 60) : ""}`);
  }

  log("❌ 所有未 Star 的候选仓都没能成功");
  return 3;
}

main()
  .then((rc) => process.exit(rc ?? 0))
  .catch((e) => { console.error("异常:", e?.message || e); process.exit(2); });
