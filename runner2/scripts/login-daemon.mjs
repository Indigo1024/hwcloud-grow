#!/usr/bin/env node
/**
 * 常驻扫码登录服务
 *
 * 解决的问题：华为云登录态会在一段时间不活跃后被服务端回收，导致定时任务
 * 因「登录失败」中断，每次都要人肉找二维码重扫。
 *
 * 本脚本常驻运行，提供三件事：
 *   1. 保活：定时以已保存的登录态访问成长中心，维持会话活跃（降低被回收概率）
 *   2. 自检：登录失效时自动拉起二维码，并把状态写到 HTTP 可访问的 JSON
 *   3. 状态页：由同目录下的 scan-portal.html 呈现，随时查看/扫码/确认结果
 *
 * 状态文件（供 HTTP 服务托管）：
 *   /usr/share/novnc/scan-status.json   { status, round, ok, at, message, checkedAt }
 *   /usr/share/novnc/scan-qr.png        当前二维码图片
 *
 * 用法:
 *   node scripts/login-daemon.mjs              # 常驻
 *   node scripts/login-daemon.mjs --once       # 只做一次自检（供 cron 调用）
 */
import { launchBrowser } from "./browser-utils.mjs";
import { acquire, release } from "./browser-lock.mjs";
import QRCode from "qrcode";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";
import { GROW_URL } from "./auth-path.mjs";
import { ensureStorageDir, saveAuthState, resolveAuthFile,  dataDir } from "./auth-utils.mjs";
import { resolveAccountId, suffixFor } from "./accounts.mjs";

// 多账号：两个守护进程各写各的二维码与状态文件，互不覆盖。
// 主号沿用原文件名，新号带 -acct2 后缀。
const ACCOUNT_ID = resolveAccountId();
/**
 * 该账号的登录态文件。
 *
 * 踩坑记录：这里原来用 auth-path 导出的 AUTH_FILE，那是**默认账号**的固定路径，
 * 不随 HWCLOUD_ACCOUNT 变化。结果新号守护去读主号的登录态、判定「有效」，
 * 真扫码时又会把新号的 Cookie 写进主号文件、覆盖主号登录态。
 * 必须用 resolveAuthFile(ACCOUNT_ID) 按账号取。
 */
const AUTH_FILE = resolveAuthFile(ACCOUNT_ID);
const QR_PNG_PATH = `${dataDir()}/${suffixFor(ACCOUNT_ID, "scan-qr", ".png")}`;
const QR_STATUS_PATH = `${dataDir()}/${suffixFor(ACCOUNT_ID, "scan-status", ".json")}`;
const LOGIN_URL = `https://auth.huaweicloud.com/authui/login?service=${encodeURIComponent(GROW_URL)}&locale=zh-cn`;

const POLL_INTERVAL_MS = 3000;
/** 单个二维码的有效期（华为云侧约 2 分钟过期，到点即换新） */
const QR_TTL_MS = Number(process.env.HWCLOUD_QR_TTL_MS || 110_000);
/**
 * 扫码状态页地址（仅用于日志提示）。
 * 通过 HWCLOUD_SCAN_PORTAL 配置，例如 https://scan.example.com/scan.html；
 * 未配置时只提示本机端口，避免把具体部署地址写进公开仓库。
 */
const SCAN_PORTAL = process.env.HWCLOUD_SCAN_PORTAL || "http://127.0.0.1:6080/scan.html";
/** 保活间隔：默认 6 小时。会话有效期较短，间隔过长会在两次检查之间被回收。 */
const KEEPALIVE_MS = Number(process.env.HWCLOUD_KEEPALIVE_MS) || 6 * 3600 * 1000;

/**
 * 扫码成功后的首次复检间隔。
 *
 * 扫码后会话往往还需要几秒到几十秒才真正稳定（服务端票据下发、各子站换票）。
 * 若此时直接睡满一个保活间隔，一旦这期间票据没稳住，用户要等到下个间隔
 * 才会看到「又掉线了」，体感就是「刚扫完没多久又要扫」。
 * 因此扫码成功后先按这个短间隔复检一次，通过后才转入正常保活节奏。
 */
const POST_LOGIN_RECHECK_MS = Number(process.env.HWCLOUD_POST_LOGIN_RECHECK_MS) || 60_000;

/**
 * 保活判定容错次数：浏览器被其它任务占用（"browser has been closed"）
 * 属于环境冲突，不代表登录态失效，不应立即拉起扫码。
 */
const KEEPALIVE_MAX_ENV_ERRORS = Number(process.env.HWCLOUD_KEEPALIVE_MAX_ENV_ERRORS) || 3;

const once = process.argv.includes("--once");
/**
 * --force-scan：即使当前登录态有效，也立即拉起扫码。
 *
 * 用途：用户想主动换账号 / 重新登录时，不必等"失效了才会出码"。
 * 面板的「扫码登录」入口在登录有效时默认只读状态，配这个开关才能主动出码。
 * 注意：强制扫码会覆盖当前账号的登录态（扫码者是谁就是谁），
 * 所以只在用户明确点击时使用。
 */
const forceScan = process.argv.includes("--force-scan");

/**
 * 登录成功后要「顺带踩一遍」的子站，让 SSO 把各站点自己的会话票据种下来，
 * 再统一存进 storageState。
 *
 * 原因：华为云各子站是**独立会话**。只访问成长中心时，存下来的 storageState
 * 里没有 bbs.huaweicloud.com / devstation 的登录票据，
 * 表现为「成长中心能拿积分，但 BBS 提交建议、论坛回答一律跳登录页」
 * （get-personal-info 返回 403 not login）。
 * 在同一浏览器 context 内依次访问这些站点，SSO 会自动完成静默登录并种 cookie。
 */
const SSO_WARMUP_URLS = (process.env.HWCLOUD_SSO_WARMUP || [
  "https://bbs.huaweicloud.com/forum/",
  "https://devstation.developer.huaweicloud.com/",
  "https://edu.huaweicloud.com/",
].join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** 依次访问子站完成 SSO 落地；失败不影响主流程 */
async function warmupSubSites(page) {
  for (const url of SSO_WARMUP_URLS) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForTimeout(2500);
      log(`SSO 预置：${url} → ${page.url().slice(0, 80)}`);
    } catch (e) {
      log(`SSO 预置失败（忽略）：${url} ${String(e).slice(0, 80)}`);
    }
  }
}

/**
 * 子站登录态探针：BBS 的 get-personal-info 需要登录，
 * 未登录返回 403 {"note":"not login"}，已登录返回 200。
 *
 * 为什么必须单独探：成长中心的 bonus-beans 探针只代表开发者站会话活着，
 * 而 BBS 走的是另一套会话（devdata.huaweicloud.com）。
 * 实测出现过「成长中心 200、BBS 403 not login」的状态，
 * 此时建议提交与论坛回答都会静默跳登录页。
 */
async function probeSubSites(page) {
  try {
    await page.goto("https://bbs.huaweicloud.com/forum/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2500);
    let csrf = null;
    const onReq = (req) => {
      const t = req.headers()["csrf"];
      if (t && !csrf) csrf = t;
    };
    page.on("request", onReq);
    await page.goto("https://bbs.huaweicloud.com/forum/forum-0120157023154615007-1.html", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    }).catch(() => {});
    await page.waitForTimeout(4000);
    page.off("request", onReq);

    const r = await page.evaluate(async (csrf) => {
      const headers = { "content-type": "application/json" };
      if (csrf) headers.csrf = csrf;
      try {
        const res = await fetch(
          "https://devdata.huaweicloud.com/rest/developer/fwdu/rest/developer/user/hdcnforumservice/v1/get-personal-info",
          { method: "POST", credentials: "include", headers, body: "{}" },
        );
        return { status: res.status, body: (await res.text()).slice(0, 80) };
      } catch (e) {
        return { status: 0, body: String(e) };
      }
    }, csrf);

    if (r.status === 200) return { ok: true };
    if (/not login/i.test(r.body)) return { ok: false, detail: "BBS not login" };
    // 缺 csrf 的 403 说明会话在、只是没截到 token，不算掉线
    if (r.status === 403 && /csrf/i.test(r.body)) return { ok: true };
    // 探针本身失败（fetch 抛错=网络层问题）不算掉线
    if (r.status === 0) return { ok: true, detail: "probe-network-error(不计失效)" };
    return { ok: false, detail: `BBS 探针 HTTP ${r.status}` };
  } catch (e) {
    // page.goto 网络抖动（ERR_NETWORK_CHANGED 等）≠ 子站掉线，不下失效结论
    const msg = String(e?.message || e);
    if (/ERR_NETWORK_CHANGED|ERR_TIMED_OUT|ERR_CONNECTION_RESET|ERR_ABORTED|Timeout|timeout|net::/i.test(msg)) {
      return { ok: true, detail: `subsite-network-flap(不计失效):${msg.split("\n")[0].slice(0, 50)}` };
    }
    return { ok: false, detail: String(e).slice(0, 80) };
  }
}

const log = (...a) =>
  console.log(new Date().toISOString().slice(11, 19), ...a);

function writeStatus(patch) {
  let cur = {};
  try {
    if (existsSync(QR_STATUS_PATH)) {
      cur = JSON.parse(readFileSync(QR_STATUS_PATH, "utf8"));
    }
  } catch {
    /* ignore */
  }
  const next = { ...cur, ...patch, at: Date.now() };
  try {
    writeFileSync(QR_STATUS_PATH, JSON.stringify(next), "utf8");
  } catch {
    /* ignore */
  }
}

/** 用已保存登录态检查是否仍有效 */
async function checkSession() {
  if (!existsSync(AUTH_FILE)) {
    return { ok: false, reason: "no-auth-file" };
  }
  if (!(await acquireBrowserLock("保活探测"))) {
    // 另有进程正在访问华为云：不并发，本次不作结论（等下一轮）。
    // 并发访问会让 SSOTGC 被别处消费掉，反而制造「掉线」假象。
    return { ok: null, reason: "busy" };
  }
  try {
    return await checkSessionInner();
  } finally {
    releaseBrowserLock();
  }
}

/** 取浏览器互斥锁；拿不到返回 false（等不到就跳过本轮，不硬挤） */
async function acquireBrowserLock(note, timeoutMs = 120_000) {
  const got = await acquire(ACCOUNT_ID, { timeoutMs, note });
  if (got) _holdingBrowserLock = true;
  return got;
}
function releaseBrowserLock() {
  if (_holdingBrowserLock) {
    release(ACCOUNT_ID);
    _holdingBrowserLock = false;
  }
}
let _holdingBrowserLock = false;

async function checkSessionInner() {
  const browser = await launchBrowser({ headless: true });
  try {
    const ctx = await browser.newContext({
      storageState: AUTH_FILE,
      locale: "zh-CN",
    });
    const page = await ctx.newPage();
    await page.goto(GROW_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    // 判定口径：用需要登录态的 growth 接口做探针，比翻页面文案可靠
    // （SPA 渲染慢，且「我的积分」文案可能短暂出现导致假阳性）。
    // 未登录返回 403 {"note":"not login"}，已登录返回 200。
    //
    // csrf 说明：该接口要求 csrf 请求头，而这个值由前端 JS 持有、不在 cookie 里
    // （cookie 里的 csrf-eco 是另一个值，拿它请求只会得到 403 "CSRF unequal"）。
    // 所以先监听页面真实请求截获 csrf，再拿它发探针；截不到就退化为不带 csrf 探测，
    // 此时 403 "no request_csrf found" 说明会话是活的、只是缺 csrf，不应判为掉线。
    let csrfToken = null;
    const onReq = (req) => {
      const t = req.headers()["csrf"];
      if (t && !csrfToken) csrfToken = t;
    };
    page.on("request", onReq);

    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(3000);
      const probe = await page
        .evaluate(async (csrf) => {
          try {
            const headers = { accept: "application/json" };
            if (csrf) headers.csrf = csrf;
            const r = await fetch(
              "https://devdata.huaweicloud.com/rest/developer/fwdu/rest/developer/user/hdcommunitysoservice/v1/growth/bonus-beans",
              { credentials: "include", headers },
            );
            return { http: r.status, body: (await r.text()).slice(0, 120) };
          } catch (e) {
            return { http: 0, body: String(e) };
          }
        }, csrfToken)
        .catch(() => ({ http: 0, body: "" }));

      if (probe.http === 200) {
        // 保活成功后回写最新 cookie（服务端可能轮换了）。
        // 顺带滚一遍子站：BBS / devstation 的会话比成长中心短，
        // 不一起续的话会出现「积分能查、BBS 却提示 not login」。
        try {
          await warmupSubSites(page);
          await saveAuthState(ctx, AUTH_FILE);
          chmodSync(AUTH_FILE, 0o600);
        } catch {
          /* ignore */
        }
        page.off("request", onReq);
        // 补一刀子站检查：成长中心的探针只证明开发者站还活着，
        // 不能证明 BBS 等子站也活着。子站掉线时同样重建登录，
        // 否则「提交建议」「论坛回答」会静默失败在登录页上。
        const sub = await probeSubSites(page);
        if (!sub.ok) {
          return { ok: false, reason: `subsite-logged-out:${sub.detail}` };
        }
        return { ok: true };
      }
      if (probe.http === 403 && /not login/i.test(probe.body)) {
        // 单次 403 not login 不足以判失效：华为云会话由服务端回收，
        // 偶发一次「not login」（切节点、风控、并发探测抢 session）很常见。
        // 这里立刻复核一次，连着两次才认定掉线，避免把有效登录踢去扫码
        // ——用户看到的就是「明明还登着，页面上却让扫码」。
        await page.waitForTimeout(4000);
        const again = await page
          .evaluate(async (csrf) => {
            try {
              const headers = { accept: "application/json" };
              if (csrf) headers.csrf = csrf;
              const r = await fetch(
                "https://devdata.huaweicloud.com/rest/developer/fwdu/rest/developer/user/hdcommunitysoservice/v1/growth/bonus-beans",
                { credentials: "include", headers },
              );
              return { http: r.status, body: (await r.text()).slice(0, 120) };
            } catch (e) {
              return { http: 0, body: String(e) };
            }
          }, csrfToken)
          .catch(() => ({ http: 0, body: "" }));

        if (again.http === 200) {
          // 复核救回来了：会话仍在，按成功处理
          try {
            await warmupSubSites(page);
            await saveAuthState(ctx, AUTH_FILE);
            chmodSync(AUTH_FILE, 0o600);
          } catch {
            /* ignore */
          }
          const sub2 = await probeSubSites(page);
          page.off("request", onReq);
          if (!sub2.ok) {
            return { ok: false, reason: `subsite-logged-out:${sub2.detail}` };
          }
          return { ok: true };
        }
        if (again.http === 403 && /not login/i.test(again.body)) {
          page.off("request", onReq);
          return { ok: false, reason: "logged-out" };
        }
        // 复核结果拿不准（网络抖动/超时），当作会话未知，继续下一轮而不是判死
        continue;
      }
      // 缺 csrf 的 403：会话仍在，只是还没截到 token，继续等下一轮
      if (i === 3) {
        await page
          .reload({ waitUntil: "domcontentloaded", timeout: 60000 })
          .catch(() => {});
      }
    }
    page.off("request", onReq);

    // 兜底：12 轮都截不到 csrf 时，上面每轮拿到的都是
    // 403 "no request_csrf found"——这只说明缺 csrf，**不代表会话失效**。
    // 若不加区分地返回 timeout，主号明明登录着也会被踢去扫码。
    // 这里改用不依赖 csrf 的判据：看开发者站页面是否渲染出账号身份。
    try {
      const who = await page.evaluate(() => {
        const t = document.body.innerText || "";
        const m =
          t.match(/hid_[a-z0-9_]+/i) ||
          t.match(/yd_\d+/i) ||
          t.match(/\b[a-z]+\d{6,}\b/i);
        return m ? m[0] : null;
      });
      if (who) {
        // 页面已识别出登录身份，会话是活的：滚一遍子站并回写 cookie
        try {
          await warmupSubSites(page);
          await saveAuthState(ctx, AUTH_FILE);
          chmodSync(AUTH_FILE, 0o600);
        } catch {
          /* ignore */
        }
        const sub3 = await probeSubSites(page);
        if (!sub3.ok) {
          return { ok: false, reason: `subsite-logged-out:${sub3.detail}` };
        }
        return { ok: true };
      }
    } catch {
      /* 兜底判据失败就维持原判断 */
    }

    return { ok: false, reason: "timeout" };
  } catch (e) {
    // 关键（2026-11-04）：网络抖动 ≠ 登录失效。
    // 本机 16 个 tun 接口轮换出口，page.goto 会偶发 ERR_NETWORK_CHANGED /
    // ERR_TIMED_OUT / ERR_CONNECTION_RESET。之前这里把任何异常都当「失效」
    // 返回，守护立刻作废有效登录态拉起扫码——用户一天被逼扫 4~5 次。
    // 网络类错误必须按「会话未知」处理：本次保活视为未做，等下一轮再查。
    const msg = String(e?.message || e);
    if (/ERR_NETWORK_CHANGED|ERR_TIMED_OUT|ERR_CONNECTION_RESET|ERR_ABORTED|Timeout|timeout|net::/i.test(msg)) {
      return { ok: null, reason: `network-flap:${msg.split("\n")[0].slice(0, 80)}` };
    }
    return { ok: false, reason: String(e).slice(0, 120) };
  } finally {
    await browser.close();
  }
}

/**
 * 扫码/保活成功后自动跑当日任务。
 * 设计要点：
 *   - 用锁文件+运行标记防重入：一轮保活周期（acct2=30min）触发一次足矣；
 *   - daily-run.sh 自带幂等（签到/发文/DevSpace 均先查今日明细，已到账即跳过），
 *     所以「多跑」没有副作用，跑空了也只是几条「已到账，跳过」日志；
 *   - 不等待、不阻塞保活循环：后台执行，日志进 runner 自己的 logs 目录。
 */
let lastDailyRunAt = 0;
function triggerDailyRun() {
  const now = Date.now();
  // 至少间隔 5 小时才自动触发一次，避免每次保活都空跑一轮
  if (now - lastDailyRunAt < 5 * 3600 * 1000) return;
  lastDailyRunAt = now;
  const dir = process.cwd();
  const logFile = `${dir}/logs/auto-daily-${ACCOUNT_ID}-${new Date().toISOString().slice(0, 10)}.log`;
  try {
    const child = spawn("/bin/bash", ["scripts/daily-run.sh"], {
      cwd: dir,
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env },
    });
    child.unref();
    log(`🚀 已后台触发每日任务（daily-run.sh，日志: ${logFile}）`);
  } catch (e) {
    log(`⚠️ 触发每日任务失败: ${String(e).slice(0, 80)}`);
  }
}

/** 拉起扫码流程：无限刷新二维码，直到扫码成功（进程被终止才结束）
 *
 *  例外：--once（cron 的单次自检）下必须有上限。
 *  2026-11-07 踩坑：daily-run 调 `login-daemon.mjs --once` 自愈，登录态失效时
 *  这里的无限循环把整轮 daily-run 挂住了一整天——11-07 那轮一直等到 11-08
 *  用户扫码才继续，期间和 11-08 的正常轮次并发跑，重复发文。
 *  所以 once 模式只等 MAX_ONCE_SCAN_MS，超时即返回 false，让 daily-run 按
 *  「登录态仍失效」正常收尾（exit 2），而不是挂到天荒地老。
 *  常驻守护（非 once）不受影响，仍无限等待。
 */
async function runQrLogin() {
  ensureStorageDir();
  // 扫码要开有头浏览器，同样占用华为云会话，必须与其它组件串行。
  //
  // ⚠️ 2026-11-12 踩到的大坑：常驻守护的扫码流程是**无限等待**（用户可能睡觉后才扫），
  //   而它一直持着浏览器锁 → 每轮保活都拿不到锁 → 登录态无人维护 → 最终失效。
  //   主号因此 14 小时没保活、当天 0 分（账号2 恰好没触发扫码，所以正常）。
  //
  //   修法：
  //     ① 取锁改成短超时（拿不到就跳过本轮，绝不长等）；
  //     ② 用**外层循环**限制单次持锁时长，到点放锁让保活跑一轮，再重新来过。
  for (;;) {
    if (!(await acquireBrowserLock("扫码登录", 60_000))) {
      log("⚠️ 未能取得浏览器互斥锁（另有进程在访问华为云），本次不拉起扫码");
      return false;
    }
    try {
      const r = await runQrLoginInner();
      // "yield" = 该放锁让位给保活了，外层循环会重新取锁继续
      if (r === "yield") continue;
      return r;
    } finally {
      releaseBrowserLock();
    }
  }
}

async function runQrLoginInner() {
  // once 模式下最多等这么久就放弃；常驻守护为 Infinity
  const MAX_ONCE_SCAN_MS = Number(process.env.HWCLOUD_ONCE_SCAN_LIMIT_MS) || 8 * 60 * 1000;
  const deadline = once ? Date.now() + MAX_ONCE_SCAN_MS : Infinity;
  // 持锁时长上限：到点就**主动放锁并结束本轮**，让保活有机会跑一次。
  //
  // 为什么需要（2026-11-12 实际踩到）：常驻守护的扫码是无限等待的，
  // 若一直持锁，保活永远拿不到锁 → 登录态彻底没人维护 → 失效。
  // 主号因此掉了 14 小时、当天 0 分。
  // 折中：每持锁 10 分钟就放一次锁（二维码也顺带刷新），
  // 保活最多被推迟 10 分钟——远好过被无限期挡住。
  const LOCK_HOLD_MAX_MS = Number(process.env.HWCLOUD_LOCK_HOLD_MAX_MS) || 10 * 60 * 1000;
  const lockDeadline = Date.now() + LOCK_HOLD_MAX_MS;
  // 必须走 launchBrowser：它带 --disable-gpu。Xvfb 无 GPU，直接 chromium.launch
  // 会走 GPU 渲染，实测有头启动 211s 才超时、页面加载 27s，扫码流程跑不完。
  const browser = await launchBrowser({ headless: false });
  try {
    const ctx = await browser.newContext({ locale: "zh-CN" });
    const page = await ctx.newPage();
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });

    // 无限循环刷新二维码：直到扫码成功或进程被外部终止。
    // 不设轮次上限——用户可能隔很久才看到（例如睡觉/外出），
    // 旧实现 20 轮（约 37 分钟）后放弃并写 failed，导致「醒来二维码已过期」。
    let round = 0;
    for (;;) {
      // once 模式到达上限即放弃，避免把 daily-run 挂住（见函数头说明）
      if (Date.now() >= deadline) {
        log(`⏱ once 模式等待扫码超过 ${Math.round(MAX_ONCE_SCAN_MS / 60000)} 分钟，放弃本次自愈`);
        writeStatus({
          status: "need-scan",
          ok: false,
          message: "等待扫码超时（cron 单次自检已退出，常驻守护仍在等待）",
        });
        await browser.close().catch(() => {});
        return false;
      }
      round++;
      // 持锁超时 → 交给外层放锁，让保活有机会跑一轮，然后重新取锁继续。
      // 返回 "yield" 是本函数与 runQrLogin 约定的信号（见那里的外层循环）。
      if (Date.now() >= lockDeadline && !once) {
        log(`⏱ 持锁已达 ${Math.round(LOCK_HOLD_MAX_MS / 60000)} 分钟，放锁让保活跑一轮后继续`);
        writeStatus({
          status: "need-scan", ok: false,
          message: "已释放浏览器锁以执行保活，稍后自动恢复扫码",
        });
        return "yield";
      }
      const data = await page
        .evaluate(async () => {
          const r = await fetch("/authui/qrcode", {
            credentials: "include",
            cache: "no-store",
            headers: { accept: "application/json" },
          });
          return await r.json();
        })
        .catch((e) => ({ error: String(e) }));

      if (data?.error || !data?.qrcode_content) {
        log(`第 ${round} 轮取码失败: ${data?.error || "无 qrcode_content"}`);
        await page.waitForTimeout(5000);
        continue;
      }

      const png = await QRCode.toBuffer(data.qrcode_content, {
        width: 420,
        margin: 1,
      });
      writeFileSync(QR_PNG_PATH, png);
      writeStatus({
        status: "waiting",
        round,
        ok: null,
        qrAt: Date.now(),
        message: "等待扫码…",
      });
      log(`第 ${round} 轮二维码已生成，等待扫码…`);

      const clientKey = data.client_key;
      log(`第 ${round} 轮 client_key=${String(clientKey).slice(0, 8)}…`);
      writeFileSync(
        "/tmp/qr-current-key.txt",
        `${round}\t${clientKey}\t${Date.now()}\n`,
      );
      const qrDeadline = Date.now() + QR_TTL_MS; // 二维码有效期
      let lastCode = "";
      while (Date.now() < qrDeadline) {
        await page.waitForTimeout(POLL_INTERVAL_MS);
        const st = await page
          .evaluate(
            async ({ ck, service }) => {
              // ⚠️ 必须带 service 参数（与已验证可用的 qr-login.mjs 一致）：
              // 服务端据此判断登录成功后的跳转目标，缺了它状态永远停在 "new"，
              // 表现为「扫码了但一直显示等待/失效」。
              const qs = new URLSearchParams({ client_key: ck, service });
              const r = await fetch("/authui/qrcode/status?" + qs.toString(), {
                credentials: "include",
                cache: "no-store",
                headers: { accept: "application/json" },
              });
              return await r.json();
            },
            { ck: clientKey, service: GROW_URL },
          )
          .catch(() => null);

        const code = st?.status ?? st?.qrcode_status ?? "";
        // 状态变化时记日志，便于排查「扫了但没反应」
        if (code && code !== lastCode) {
          log(`  轮询状态变化: ${lastCode || "(初始)"} → ${code}`);
          lastCode = code;
        }
        // ⚠️ 接口实际返回的状态名是小写的 authorizing/authorized/expired，
        // 与 qr-login.mjs 保持一致；大写写法永远匹配不上（曾导致「扫码不认」）。
        if (code === "authorizing") {
          writeStatus({ status: "scanned", message: "已扫描，请在手机上确认" });
        } else if (code === "authorized") {
          writeStatus({ status: "confirmed", message: "已确认，正在登录…" });
          // 关键：必须跳转到接口给出的 redirect_url 才能完成换票，
          // 少了这步即使手机上点了确认也登不进去。
          if (st?.redirect_url) {
            await page
              .goto(st.redirect_url, {
                waitUntil: "domcontentloaded",
                timeout: 90000,
              })
              .catch((e) => log("跳转 redirect_url 异常:", String(e).slice(0, 120)));
            await page.waitForTimeout(4000);
          } else {
            log("⚠️ authorized 但未返回 redirect_url");
          }
          await page.goto(GROW_URL, {
            waitUntil: "domcontentloaded",
            timeout: 90000,
          }).catch(() => {});
          await page.waitForTimeout(4000);
          // 判定与保存顺序完全沿用 qr-login.mjs（已验证可用）：
          // 先 storageState 落盘，再翻页面文案判定，避免「判失败就不存」导致
          // 明明登录成功却丢登录态。
          // 落盘前先滚一遍子站，让 BBS / devstation / edu 的会话票据也进 storageState。
          await warmupSubSites(page);
          // 保存失败不能把守护整个炸掉：以前异常会一路冒到 main，systemd 重启后
          // 状态页又回到「等待扫码」，用户看到的就是「扫了、确认了，却毫无反应」。
          // 现在改为就地兜住、写清状态，然后继续换新码让用户重试。
          try {
            await saveAuthState(ctx, AUTH_FILE);
            chmodSync(AUTH_FILE, 0o600);
          } catch (e) {
            const msg = String(e?.message || e).slice(0, 160);
            log(`❌ 登录态保存失败：${msg}`);
            writeStatus({
              status: "error",
              ok: false,
              message: `手机已确认，但登录态保存失败：${msg}。请重新扫码。`,
            });
            // 不 break：break 会结束扫码让 main 返回、systemd 重启，状态随之被
            // 覆盖成「等待扫码」，用户完全看不出刚才失败过。这里稍等后继续换新码。
            await page.waitForTimeout(3000);
            continue;
          }
          const body = await page.innerText("body").catch(() => "");
          const ok = body.includes("我的积分") || body.includes("积分明细");
          if (ok) {
            writeStatus({
              status: "done",
              ok: true,
              message: "登录成功",
              loginAt: Date.now(),
            });
            log("✅ 登录成功，登录态已保存");
            return true;
          }
          // 文案没读到不代表失败（SPA 渲染慢）：登录态已落盘，再补一次接口确认。
          // csrf 由前端 JS 持有、不在 cookie 里，需从页面真实请求头截获。
          const alive = await page
            .evaluate(async () => {
              try {
                const headers = { accept: "application/json" };
                const r = await fetch(
                  "https://devdata.huaweicloud.com/rest/developer/fwdu/rest/developer/user/hdcommunitysoservice/v1/growth/bonus-beans",
                  { credentials: "include", headers },
                );
                return { status: r.status, body: (await r.text()).slice(0, 80) };
              } catch {
                return { status: 0, body: "" };
              }
            })
            .catch(() => ({ status: 0, body: "" }));
          // 403 "no request_csrf found" / "CSRF unequal" 只说明缺 csrf，会话是活的；
          // 只有 "not login" 才是真的没登录上。
          const aliveOk = alive.status === 200 || !/not login/i.test(alive.body);
          if (aliveOk) {
            writeStatus({
              status: "done",
              ok: true,
              message: "登录成功",
              loginAt: Date.now(),
            });
            log("✅ 登录成功（接口确认），登录态已保存");
            return true;
          }
          log(`⚠️ 已确认但登录态未生效（页面文案未命中，探针 HTTP ${alive}），换新码重试`);
          writeStatus({ status: "waiting", message: "授权未生效，请重新扫码" });
          break;
        } else if (code === "expired") {
          writeStatus({ status: "expired", message: "二维码已过期，正在刷新" });
          log("二维码已过期，换新");
          break;
        }
      }
      // 本轮二维码到期未扫：不再写 failed（那会让用户以为要重来），
      // 直接进入下一轮生成新码，状态页继续显示 waiting。
      log(`第 ${round} 轮二维码超时未扫，自动换新`);
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  log("登录守护启动");

  // --force-scan：用户主动要求重新登录，跳过"先查是否有效"直接出码
  if (forceScan) {
    log("⏩ --force-scan：直接拉起扫码（忽略当前登录态）");
    writeStatus({ status: "need-scan", ok: false, message: "已按请求拉起扫码，请扫码登录" });
    const okScan = await runQrLogin();
    log(okScan ? "✅ 扫码登录成功" : "⚠️ 扫码未完成");
    return;
  }

  writeStatus({ status: "checking", message: "正在检查登录态…" });

  let { ok, reason } = await checkSession();
  if (ok) {
    log("✅ 登录态有效");
    writeStatus({
      status: "valid",
      ok: true,
      message: "登录态有效",
      checkedAt: Date.now(),
    });
    // 启动时登录态就有效也触发一次当日任务（5 小时节流，幂等安全）
    if (!once) triggerDailyRun();
  } else if (ok === null || ok === undefined) {
    // 网络抖动：不下失效结论，进入常驻循环按当前「未知」状态处理。
    // 下一轮保活（或复检）会重新判定；期间不拉扫码，避免误伤有效登录。
    log(`⚠️ 启动自检遇网络抖动（${reason}），暂不下结论`);
    writeStatus({ status: "checking", ok: false, message: "网络抖动，稍后自动复检" });
    ok = false;
    if (once) return;
  } else {
    log(`❌ 登录态失效（${reason}），拉起扫码…`);
    log(`   状态页: ${SCAN_PORTAL}`);
    writeStatus({ status: "need-scan", ok: false, message: `登录已失效（${reason}），请扫码` });
    ok = await runQrLogin();
  }

  if (once) return;

  // 常驻保活。
  // 刚扫码成功后**不能**干等一整个保活间隔——那段时间里任何一次会话劣化都会
  // 被拖到间隔结束才发现，用户看到的就是「刚扫完没多久又失效、又要扫」。
  // 因此扫码后先做一次快速复检，确认票据真的稳住了，再进入长期间隔。
  let netFlapCount = 0;
  let busyCount = 0;
  for (;;) {
    const waitMs = ok ? KEEPALIVE_MS : POST_LOGIN_RECHECK_MS;
    await new Promise((r) => setTimeout(r, waitMs));

    log(ok ? "定期保活检查…" : "扫码后快速复检…");
    const r = await checkSession();
    if (r.ok === false) {
      ok = false;
      busyCount = 0;
      log(`❌ 保活时发现失效（${r.reason}），拉起扫码`);
      log(`   状态页: ${SCAN_PORTAL}`);
      writeStatus({ status: "need-scan", ok: false, message: `登录已失效（${r.reason}），请扫码` });
      ok = await runQrLogin();
    } else if (r.ok === null && r.reason === "busy") {
      // 「拿不到浏览器锁」与「网络抖动」是**两回事**，必须分开统计与提示。
      // 2026-11-12 踩坑：这里原本把 busy 也归到"网络抖动"分支，
      // 于是主号锁被占死 14 小时，日志一直打印"本机网络异常，请检查 tun 接口"
      // ——把排查方向带到了网络上，真凶（锁泄漏）完全被掩盖。
      busyCount++;
      netFlapCount = 0;
      log(`⚠️ 未取得浏览器互斥锁（另有进程持锁），本轮跳过（连续 ${busyCount} 次）`);
      writeStatus({
        status: ok ? "valid" : "need-scan",
        ok,
        message: ok ? "登录态有效（未取得浏览器锁，未复检）" : "等待扫码（未取得浏览器锁）",
        checkedAt: Date.now(),
      });
      if (busyCount === 6) {
        // 连续多轮拿不到锁 = 极可能有进程持锁不放（锁泄漏）。
        // 这时候要主动查一次持锁者是否真的还活着，并给出可操作的提示。
        const holder = describeLockHolder(ACCOUNT_ID);
        log(`⚠️ 连续 6 轮未取得浏览器锁，持锁者：${holder}`);
        writeStatus({
          status: ok ? "valid" : "need-scan",
          ok,
          message: `连续多轮未取得浏览器锁，持锁者：${holder}。若非本机正在扫码，可执行 node scripts/browser-lock.mjs release ${ACCOUNT_ID} 清理`,
          checkedAt: Date.now(),
        });
        busyCount = 0;
      }
    } else if (r.ok === null) {
      // 网络抖动：会话未知，绝不能当失效处理（2026-11-04 根因修复）。
      // 保持当前 ok 状态不变，等下一轮保活再查；连续多次网络失败才降级报警。
      netFlapCount = (netFlapCount || 0) + 1;
      busyCount = 0;
      log(`⚠️ 保活因网络抖动未完成（${r.reason}），不下结论，等下一轮（连续${netFlapCount}次）`);
      writeStatus({
        status: ok ? "valid" : "need-scan",
        ok,
        message: ok ? "登录态有效（网络抖动，未复检）" : "等待扫码（网络抖动）",
        checkedAt: Date.now(),
      });
      if (netFlapCount >= 6) {
        log("⚠️ 连续 6 轮网络抖动，本机网络异常，请检查 tun 接口/出口");
        netFlapCount = 0;
      }
    } else {
      netFlapCount = 0;
      busyCount = 0;
      ok = true;
      log("✅ 保活成功");
      writeStatus({ status: "valid", ok: true, message: "登录态有效（保活）", checkedAt: Date.now() });
      // 扫码成功/保活成功后自动跑任务：daily-run 自带幂等（已到账会跳过），
      // 重复跑只是多几次「跳过」日志，不会重复发分。
      triggerDailyRun();
    }
  }
}

/** 描述当前持锁者（pid 是否还活着），用于诊断锁泄漏 */
function describeLockHolder(acc) {
  try {
    const f = `/tmp/.huaweicloud-browser-${acc}.lock`;
    if (!existsSync(f)) return "无锁文件";
    const j = JSON.parse(readFileSync(f, "utf8"));
    let alive = false;
    try {
      process.kill(j.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    const mins = j.at ? Math.round((Date.now() - j.at) / 60000) : null;
    return `pid=${j.pid} note=${j.note || "-"} 存活=${alive ? "是" : "否"} 持有${mins != null ? mins + "分钟" : ""}`;
  } catch (e) {
    return "读取失败: " + String(e).slice(0, 60);
  }
}

main().catch((e) => {
  console.error(e);
  writeStatus({ status: "error", ok: false, message: String(e).slice(0, 200) });
  process.exit(1);
});
