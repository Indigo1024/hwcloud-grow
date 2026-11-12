#!/usr/bin/env node
/**
 * GitCode 令牌与绑定状态管理（给面板的 GitCode 授权页用）。
 *
 * 三件事：
 *   1. status  —— 该账号是否已配置令牌、令牌对应哪个 GitCode 账号、是否已绑定华为云
 *   2. set     —— 校验令牌有效性后写入凭证文件（权限 600）
 *   3. clear   —— 清除令牌
 *
 * 为什么要有这个模块：
 *   面板要成为「一站式」，用户不该去手改 ~/.gitcode/auth.toml。
 *   而"是否已绑定华为云"必须**现查**（不能只信本地文件）——绑定关系在华为云侧，
 *   本地无从得知；绑定是 Star/Issue 计分的硬前置。
 *
 * 用法:
 *   node control/gitcode-token.mjs status <acc> [--bind-url]
 *   node control/gitcode-token.mjs set    <acc> <token>
 *   node control/gitcode-token.mjs clear  <acc>
 *
 * 输出: JSON（单行）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const API = "https://api.gitcode.com/api/v5";
const [, , cmd, acc, ...rest] = process.argv;
const out = (o) => process.stdout.write(JSON.stringify(o));

/** 账号 → GitCode 凭证目录（与 runner/scripts/accounts.mjs 的约定一致） */
function gitcodeHome(id) {
  // 主号用 ~/.gitcode，其余 ~/.gitcode-<id>
  if (id === "main") return process.env.GITCODE_HOME_MAIN || join(homedir(), ".gitcode");
  return process.env[`GITCODE_HOME_${id.toUpperCase()}`] || join(homedir(), `.gitcode-${id}`);
}
const authPath = (id) => join(gitcodeHome(id), "auth.toml");

function readToken(id) {
  const f = authPath(id);
  if (!existsSync(f)) return null;
  try {
    const m = readFileSync(f, "utf8").match(/access_token\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  } catch { return null; }
}

async function api(path, token, { method = "GET" } = {}) {
  try {
    const r = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch {}
    return { ok: r.ok, status: r.status, json: j, text: t };
  } catch (e) {
    return { ok: false, status: 0, json: null, text: String(e) };
  }
}

// ── 找可用的 playwright（各 runner 下都有 node_modules）────────────
function findPlaywright() {
  for (const rel of ["runner", "runner2"]) {
    const p = join(PROJECT_ROOT, rel, "node_modules", "playwright", "index.mjs");
    if (existsSync(p)) return p;
  }
  return "playwright";
}
function authFileFor(id) {
  for (const rel of ["runner", "runner2"]) {
    for (const p of [
      join(PROJECT_ROOT, rel, "storage", "accounts", id, "huaweicloud-auth.json"),
      join(PROJECT_ROOT, rel, "storage", "huaweicloud-auth.json"),
    ]) {
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * 探测「当前华为云账号是否已绑定此 GitCode 账号」。
 * 走鸿蒙实践中心的任务接口（它带 git_bound / git_login 字段）——这是能直接
 * 反映绑定关系的接口；取不到时返回 null（未知，不臆断）。
 */
async function probeBinding(id, gitcodeLogin) {
  const authFile = authFileFor(id);
  if (!authFile) return { bound: null, reason: "no-auth-file" };
  let browser;
  try {
    const { chromium } = await import(findPlaywright());
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run"],
    });
    const ctx = await browser.newContext({ storageState: authFile, locale: "zh-CN" });
    const page = await ctx.newPage();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    await page.goto("https://developer.huaweicloud.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(3500);
    const cks = await ctx.cookies("https://developer.huaweicloud.com");
    await ctx.addCookies(
      cks.filter((c) => /SessionID|HWWAFSESID|SSOTGC|_frid|vk|cbc-sid|locale/.test(c.name))
        .map((c) => ({
          name: c.name, value: c.value, domain: ".huaweicloud.com", path: "/",
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
        })),
    );
    await page.goto("https://harmonybp.developer.huaweicloud.com/#practice-tasks", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await sleep(9000);

    const r = await page.evaluate(async () => {
      try {
        const t = await (await fetch("/api/growth/tasks", { credentials: "include" })).json();
        const bd = await (await fetch("/api/growth/bindings", { credentials: "include" })).json().catch(() => ({}));
        const st = (t.tasks || []).find((x) => x && /star/i.test(x.task_key || ""));
        return {
          loggedIn: !!t.logged_in,
          gitBound: !!st?.git_bound,
          gitLogin: st?.git_login || null,
          bindings: Array.isArray(bd.bindings) ? bd.bindings : [],
        };
      } catch { return null; }
    }).catch(() => null);

    if (!r) return { bound: null, reason: "probe-failed" };
    if (!r.loggedIn) return { bound: null, reason: "hw-not-logged-in" };

    // 绑定列表里能直接看到绑了哪个 GitCode 账号
    const hit = r.bindings.find((b) => (b.provider || "") === "gitcode");
    if (hit) {
      return {
        bound: !!gitcodeLogin ? hit.login === gitcodeLogin : true,
        boundLogin: hit.login || null,
        hwLogin: r.gitLogin || null,
      };
    }
    return { bound: false, boundLogin: null };
  } catch (e) {
    return { bound: null, reason: String(e?.message || e).slice(0, 80) };
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function main() {
  if (!cmd || !acc) { out({ ok: false, error: "用法: gitcode-token.mjs status|set|clear <acc> [token]" }); return; }

  if (cmd === "status") {
    const token = readToken(acc);
    if (!token) return out({ ok: true, hasToken: false, acc });

    const me = await api("/user", token);
    if (!me.ok) {
      return out({ ok: true, hasToken: true, tokenValid: false, acc,
                   error: `令牌无效（HTTP ${me.status}）` });
    }
    const login = me.json?.login || null;

    // 绑定探测较慢（要开浏览器），仅在实际需要时才做
    let bind = { bound: null };
    if (!rest.includes("--no-bind")) {
      bind = await probeBinding(acc, login);
    }
    return out({
      ok: true, acc, hasToken: true, tokenValid: true, login,
      bound: bind.bound === null ? false : bind.bound,
      bindKnown: bind.bound !== null,
      bindReason: bind.reason || null,
      boundLogin: bind.boundLogin || null,
      boundAccount: bind.hwLogin || null,
    });
  }

  if (cmd === "set") {
    const token = String(rest[0] || "").trim();
    if (!token) return out({ ok: false, error: "缺少令牌" });

    // 先校验令牌有效且权限够（能读到 /user 与 /user/starred）
    const me = await api("/user", token);
    if (!me.ok) {
      return out({ ok: false, tokenValid: false,
                   error: `令牌无效（HTTP ${me.status}）：${me.text.slice(0, 100)}` });
    }
    const login = me.json?.login || null;
    const starred = await api("/user/starred?per_page=1", token);
    const tokenValid = me.ok && starred.ok;

    // 写入（权限 600）。目录先行，避免后续写入失败。
    const dir = gitcodeHome(acc);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = authPath(acc);
    writeFileSync(f, `# GitCode 访问令牌（个人访问令牌 / PAT）\n# 由面板写入，权限 600\naccess_token = "<YOUR_GITCODE_TOKEN>"\n`, { mode: 0o600 });
    try { const { chmodSync } = await import("node:fs"); chmodSync(f, 0o600); } catch {}

    // 顺带探测绑定关系，让前端一次拿到结论（否则要再等一轮）
    const bind = await probeBinding(acc, login);
    const bound = bind.bound === true;

    // 未绑定时现取一条授权链接（10 分钟有效）
    let bindUrl = null;
    if (!bound) {
      try {
        const { spawnSync } = await import("node:child_process");
        const r = spawnSync(process.execPath, [join(__dirname, "harmony-oauth.mjs"), "get", acc], {
          encoding: "utf8", timeout: 180000, cwd: __dirname,
        });
        const j = JSON.parse((r.stdout || "{}").trim());
        if (j.ok && j.url) bindUrl = j.url;
      } catch { /* 取不到链接不影响保存令牌 */ }
    }
    return out({ ok: true, acc, tokenValid, login, bound,
                 boundAccount: bind.hwLogin || null, bindReason: bind.reason || null, bindUrl });
  }

  if (cmd === "clear") {
    const f = authPath(acc);
    try { if (existsSync(f)) unlinkSync(f); } catch (e) {
      return out({ ok: false, error: String(e).slice(0, 100) });
    }
    return out({ ok: true, acc, cleared: true });
  }

  out({ ok: false, error: `未知命令 ${cmd}` });
}

main().catch((e) => out({ ok: false, error: String(e?.message || e).slice(0, 150) }));
