#!/usr/bin/env node
/**
 * 鸿蒙 GitCode 授权链接：带缓存 + 后台自动续期。
 *
 * 为什么不能"真·永久刷新"：
 *   链接里的 state 由鸿蒙服务端签发（含 domain_id + expires_at），有效期约 10 分钟，
 *   而且**绑定的前提就是用户点开当次签发的链接完成 OAuth**。
 *   服务端不提供"续期"接口，只能重新走一次「点任务卡 → 弹授权窗」拿到新链接——
 *   每次都要开一次真浏览器（约 30~60 秒）。
 *   所以「自动刷新」的合理形态是：**后台预先备好一条新鲜的**，用户要时立刻拿到，
 *   而不是让用户在页面上干等 40 秒、或者拿到一条快过期的。
 *
 * 做法：
 *   - `get <acc>`  ：取链接。若缓存里那条剩余寿命够（>120s）直接返回；
 *                    否则现取一条、写缓存、返回。
 *   - `refresh <acc>`：强制现取并写缓存（供定时任务后台预热）。
 *   - `status <acc>` ：只看缓存，不触发浏览器（面板刷新用，零成本）。
 *
 * 缓存文件：state/harmony-oauth-<acc>.json
 *   { url, at, expiresAt, login, bound }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { ROOT } from "./paths.mjs";
const CACHE_DIR = join(ROOT, "state");
mkdirSync(CACHE_DIR, { recursive: true });

const [, , cmd = "get", who = "main"] = process.argv;
const cacheFile = join(CACHE_DIR, `harmony-oauth-${who}.json`);

/** 剩余寿命低于这个值就当缓存失效，避免给用户一条马上过期的链接 */
const MIN_LEFT_MS = 120 * 1000;

const out = (o) => process.stdout.write(JSON.stringify(o));

function readCache() {
  if (!existsSync(cacheFile)) return null;
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 从 state（base64url 的 JSON）里解出过期时间 */
function parseExpiry(url) {
  try {
    const m = decodeURIComponent(url).match(/state=([^&]+)/);
    if (!m) return null;
    const payload = decodeURIComponent(m[1]).split(".")[0];
    const pad = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const j = JSON.parse(Buffer.from(pad, "base64url").toString("utf8"));
    return typeof j.expires_at === "number" ? j.expires_at * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * 实时查该账号在鸿蒙侧的绑定状态。
 *
 * 为什么不只信缓存：缓存里的 bound 是「上次取链接那一刻」的快照。
 * 用户扫完授权后，缓存不会自己更新，面板就会一直显示"未绑定"——
 * 用户明明绑好了却看到要再绑（2026-11-10 实际反馈）。
 * 所以读状态必须以服务端为准，走一次轻量请求（不开浏览器点页面，几秒内返回）。
 *
 * @returns {{bound:boolean, login:string|null}|null} null=查询失败（网络/未登录）
 */
async function probeBound(acc) {
  const RUNNER_DIR = runnerDirFor(acc);
  const { chromium } = await import(`${RUNNER_DIR}/node_modules/playwright/index.mjs`);
  const { resolveAuthFile } = await import(`${RUNNER_DIR}/scripts/auth-utils.mjs`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run"],
  });
  try {
    const ctx = await browser.newContext({
      storageState: resolveAuthFile(acc), locale: "zh-CN",
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();
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
        const st = (t.tasks || []).find((x) => x && /star/i.test(x.task_key || ""));
        return { logged_in: !!t.logged_in, bound: !!st?.git_bound, login: st?.git_login || null, status: st?.today_status || null };
      } catch { return null; }
    }).catch(() => null);
    return r;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function fetchFresh() {
  // 动态 import：本脚本在 control/ 下，playwright 与 auth-utils 在各 runner 里
  const RUNNER_DIR = runnerDirFor(who);
  const { chromium } = await import(`${RUNNER_DIR}/node_modules/playwright/index.mjs`);
  const { resolveAuthFile } = await import(`${RUNNER_DIR}/scripts/auth-utils.mjs`);
  const { withBrowserLock } = await import(`${RUNNER_DIR}/scripts/browser-lock.mjs`);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 与登录守护、积分采集串行：华为云 SSO 的 SSOTGC 换一次票消费一次，
  // 并发访问会让别的组件回落成「未登录」（2026-11-11 调研结论）。
  // 预热每 5 分钟一轮，拿不到锁就跳过这轮，不影响功能（缓存里通常已有链接）。
  const locked = await withBrowserLock(
    who,
    async () => {
      return await fetchFreshInner({ chromium, resolveAuthFile, sleep });
    },
    { timeoutMs: 120_000, note: "鸿蒙授权链接预热" },
  );
  if (!locked.ok) return { ok: false, error: "busy（另有进程在访问华为云）" };
  return locked.value;
}

async function fetchFreshInner({ chromium, resolveAuthFile, sleep }) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run"],
  });
  try {
    const ctx = await browser.newContext({
      storageState: resolveAuthFile(who), locale: "zh-CN",
      viewport: { width: 1440, height: 900 },
    });
    const page = await ctx.newPage();

    // 鸿蒙站经常判未登录：先预热 SSO 再注入 uni 域 cookie
    await page.goto("https://developer.huaweicloud.com/", { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    await sleep(4000);
    const cks = await ctx.cookies("https://developer.huaweicloud.com");
    await ctx.addCookies(
      cks.filter((c) => /SessionID|HWWAFSESID|SSOTGC|_frid|vk|cbc-sid|locale/.test(c.name))
        .map((c) => ({
          name: c.name, value: c.value, domain: ".huaweicloud.com", path: "/",
          secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite,
        })),
    );
    await page.goto("https://harmonybp.developer.huaweicloud.com/#practice-tasks", { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    await sleep(10000);

    // 先看是否已绑定
    const pre = await page.evaluate(async () => {
      try {
        const r = await fetch("/api/growth/tasks", { credentials: "include" });
        const j = await r.json();
        const t = (j.tasks || []).find((x) => x && /star/i.test(x.task_key || ""));
        return t ? { bound: t.git_bound, login: t.git_login, status: t.today_status } : null;
      } catch { return null; }
    }).catch(() => null);
    if (pre?.bound) {
      return { ok: true, alreadyBound: true, login: pre.login, bound: true, url: null };
    }

    await page.evaluate(() => {
      const el = [...document.querySelectorAll("button")].find((b) => /Star/i.test(b.innerText || ""));
      el?.scrollIntoView({ block: "center" });
    }).catch(() => {});
    await sleep(2000);
    await page.bringToFront();
    await page.mouse.click(720, 450);
    await sleep(4000);

    const auth = await page.evaluate(() => {
      for (const e of document.querySelectorAll("button")) {
        if (/前往 GitCode 授权/.test(e.innerText || "")) {
          const r = e.getBoundingClientRect();
          if (r.width > 0) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        }
      }
      return null;
    });
    if (!auth) {
      // 区分「鸿蒙站未登录」与「页面结构变了」——前者要引导用户先去登录华为云。
      // 这正是面板鸿蒙区与「加账号」联动的关键：登录态没建立时，
      // 用户点"获取授权链接"会拿到一条无用的报错，不如直接告诉他先去登录。
      const pageTxt = await page.evaluate(() => document.body.innerText.slice(0, 400)).catch(() => "");
      const notLoggedIn = /登录\/注册查看|请登录|登录后查看/.test(pageTxt);
      return {
        ok: false,
        needLogin: notLoggedIn,
        error: notLoggedIn
          ? "华为云登录态失效，请先扫码登录，再回来获取授权链接"
          : "没找到「前往 GitCode 授权」按钮（可能鸿蒙站未登录）",
      };
    }

    const [pop] = await Promise.all([
      page.waitForEvent("popup", { timeout: 20000 }).catch(() => null),
      (async () => {
        await page.mouse.move(auth.x, auth.y);
        await sleep(200);
        await page.mouse.down();
        await sleep(120);
        await page.mouse.up();
      })(),
    ]);
    await sleep(8000);
    if (!pop) return { ok: false, error: "点授权后未抓到链接（可能已绑定或弹窗被拦）" };
    return { ok: true, url: pop.url(), bound: false };
  } finally {
    await browser.close().catch(() => {});
  }
}

function writeCache(obj) {
  const rec = { ...obj, at: Date.now(), expiresAt: obj.url ? parseExpiry(obj.url) : null };
  writeFileSync(cacheFile, JSON.stringify(rec, null, 2), "utf8");
  return rec;
}

async function main() {
  if (cmd === "status") {
    // 面板定时调用，既要反映真实绑定状态，又不能每次都开浏览器（约 18s）。
    // 折中：60 秒内复用上次查询结果；超过才真查一次。
    const c = readCache();
    const lastProbe = c?.probedAt || 0;
    const PROBE_TTL = 60 * 1000;

    // 缓存里 alreadyBound=true 与 bound=false 同时存在，是历史写入不一致留下的
    // （2026-11-11 修过一个把已绑定写成未绑定的 bug）。这里按"绑定过就算绑定"取值，
    // 避免旧缓存让面板一直显示未绑定。
    if (c && c.bound === false && c.alreadyBound === true && c.login) {
      c.bound = true;
      try { writeCache(c); } catch {}
    }

    if (c?.bound && Date.now() - lastProbe < PROBE_TTL) {
      // 刚查过且已绑定：直接回，不再开浏览器
      return out({ ok: true, bound: true, login: c.login, cached: true, message: `已绑定 GitCode：${c.login || "—"}` });
    }

    let live = null;
    try { live = await probeBound(who); } catch { live = null; }

    if (live?.bound) {
      // 查实已绑定 → 写回缓存（含 probedAt），60 秒内不再重复查
      writeCache({ ...(c || {}), bound: true, login: live.login, url: null, probedAt: Date.now() });
      return out({ ok: true, bound: true, login: live.login, status: live.status, message: `已绑定 GitCode：${live.login || "—"}` });
    }

    if (live && !live.logged_in) {
      return out({ ok: true, bound: false, cached: !!c?.url, loggedIn: false, message: "华为云登录态失效，请先扫码" });
    }

    // 探测没拿到结果（null）或明确未绑定，这里要**区分对待**：
    //   · live === null  → 探测失败（网络抖动/超时），**不能**据此覆盖已有的"已绑定"结论，
    //                       否则会短暂显示成"未绑定"（2026-11-11 实际发生：
    //                       缓存里 alreadyBound/login 都在，bound 却被写成 false，
    //                       面板因此显示"未绑定"而实际早已绑定）。
    //   · live 存在且 bound=false → 确实未绑定，可以更新缓存。
    const previousBound = !!(c?.bound || c?.alreadyBound);
    if (!live && previousBound) {
      // 探测失败：沿用上次结论，只提示"暂时无法确认"
      return out({
        ok: true, bound: true, login: c.login || null, cached: true, stale: true,
        message: `已绑定 GitCode：${c.login || "—"}（暂时无法复核，沿用上次结果）`,
      });
    }


    if (!c) {
      writeCache({ bound: false, probedAt: Date.now() });
      return out({ ok: true, cached: false, bound: false, message: "尚未生成授权链接" });
    }
    // 未绑定：顺带刷新 probedAt，避免每次都真查。
    // 仅在**探测确实给出结论**（live 非 null）时才写 bound:false，
    // 探测失败时保留原值，避免把已绑定误标成未绑定。
    if (live && Date.now() - lastProbe > PROBE_TTL) {
      writeCache({ ...c, bound: false, probedAt: Date.now() });
    } else if (Date.now() - lastProbe > PROBE_TTL) {
      writeCache({ ...c, probedAt: Date.now() });
    }
    const left = c.expiresAt ? Math.round((c.expiresAt - Date.now()) / 1000) : null;
    return out({
      ok: true, cached: true, url: c.url, bound: false, login: null,
      at: c.at, expiresAt: c.expiresAt, leftSec: left,
      fresh: left === null ? false : left * 1000 > MIN_LEFT_MS,
    });
  }

  if (cmd === "refresh") {
    // 后台预热用：强制现取一条
    try {
      const r = await fetchFresh();
      if (!r.ok) return out(r);
      const c = writeCache(r);
      return out({ ok: true, refreshed: true, url: c.url, bound: c.bound, expiresAt: c.expiresAt });
    } catch (e) {
      return out({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
  }

  // get：优先吃缓存，快过期才现取
  const c = readCache();
  if (c?.bound) return out({ ok: true, alreadyBound: true, cached: true, login: c.login || null, note: `已绑定 GitCode：${c.login || "—"}` });
  if (c?.url && c.expiresAt && c.expiresAt - Date.now() > MIN_LEFT_MS) {
    return out({ ok: true, cached: true, url: c.url, expiresAt: c.expiresAt, leftSec: Math.round((c.expiresAt - Date.now()) / 1000) });
  }
  try {
    const r = await fetchFresh();
    if (!r.ok) return out(r);
    const rec = writeCache(r);
    if (rec.alreadyBound) return out({ ok: true, alreadyBound: true, login: rec.login, note: `已绑定 GitCode：${rec.login || "—"}` });
    return out({ ok: true, cached: false, url: rec.url, expiresAt: rec.expiresAt, leftSec: Math.round((rec.expiresAt - Date.now()) / 1000) });
  } catch (e) {
    return out({ ok: false, error: String(e?.message || e).slice(0, 200) });
  }
}

main();
