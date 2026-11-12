import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, renameSync, openSync, closeSync, unlinkSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_FILE, LEGACY_AUTH_FILE, SESSION_META_FILE, STORAGE_DIR, GROW_URL, authPathsFor } from "./auth-path.mjs";
import { resolveAccountId } from "./accounts.mjs";

/** 项目根（本文件在 <root>/runner/scripts/ 下，往上三级） */
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function ensureStorageDir(accountId) {
  mkdirSync(accountId ? authPathsFor(accountId).storageDir : STORAGE_DIR, { recursive: true });
}

/**
 * 「对外数据目录」：面板要读的 JSON/PNG（积分看板、二维码、扫码状态…）写在哪。
 *
 * 之所以要单独一层：
 *   生产环境把这些文件放在 Web 服务器目录（/usr/share/novnc），
 *   而刚 clone 下来的用户机器上并没有这个目录，写进去会直接崩
 *   （2026-11-11 在干净目录实测：login-daemon 报
 *   "no such file or directory, open '/usr/share/novnc/scan-qr.png'"）。
 *
 * 解析顺序：
 *   1. 环境变量 HWCLOUD_DATA_DIR / PANEL_STATIC_DIR（部署到 Web 目录时用）
 *   2. <项目根>/panel（本仓库自带的存放位置，clone 下来即可用）
 *   3. /usr/share/novnc（老部署的兜底）
 * 并保证目录存在，避免调用方还得自己 mkdir。
 */
export function dataDir() {
  const env = process.env.HWCLOUD_DATA_DIR || process.env.PANEL_STATIC_DIR;
  if (env) {
    try { mkdirSync(env, { recursive: true }); } catch {}
    return env;
  }
  const own = join(ROOT_DIR, "panel");
  try {
    mkdirSync(own, { recursive: true });
    return own;
  } catch {}
  return "/usr/share/novnc";
}

/**
 * 取某账号的登录态文件路径。
 *
 * 不传 accountId 时走默认账号（storage/huaweicloud-auth.json），
 * 与改造前的行为完全一致；显式传入时才走 storage/accounts/<id>/。
 *
 * @param {string} [accountId]
 */
export function resolveAuthFile(accountId) {
  if (accountId) {
    const paths = authPathsFor(accountId);
    return existsSync(paths.authFile) ? paths.authFile : paths.authFile;
  }
  if (existsSync(AUTH_FILE)) return AUTH_FILE;
  if (existsSync(LEGACY_AUTH_FILE)) return LEGACY_AUTH_FILE;
  return AUTH_FILE;
}

export function hasSavedAuth(accountId) {
  return existsSync(resolveAuthFile(accountId));
}

export function loadSessionMeta(accountId) {
  const metaFile = accountId ? authPathsFor(accountId).sessionMetaFile : SESSION_META_FILE;
  if (!existsSync(metaFile)) return null;
  try {
    return JSON.parse(readFileSync(metaFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveSessionMeta(extra = {}, accountId) {
  const paths = accountId ? authPathsFor(accountId) : null;
  const metaFile = paths ? paths.sessionMetaFile : SESSION_META_FILE;
  mkdirSync(dirname(metaFile), { recursive: true });
  writeFileSync(
    metaFile,
    JSON.stringify(
      {
        saved_at: new Date().toISOString(),
        account: accountId ? resolveAccountId(accountId) : undefined,
        auth_file: paths ? paths.authFile : AUTH_FILE,
        grow_url: GROW_URL,
        ...extra,
      },
      null,
      2
    ),
    "utf8"
  );
  restrictStorageFilePermissions(metaFile);
}

/** 限制 storage 下敏感文件仅当前用户可读（Windows 上可能无效果） */
export function restrictStorageFilePermissions(filePath) {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    /* optional */
  }
}

/** @param {import('playwright').Page} page */
export async function isGrowLoggedIn(page) {
  const text = await page.innerText("body").catch(() => "");
  if (text.includes("登录/注册查看您的积分")) return false;
  if (text.includes("账号异常") || text.includes("已被限制使用")) return false;
  return text.includes("我的积分") || text.includes("积分明细");
}

/** @param {import('playwright').Page} page */
export async function openGrowAndCheckLogin(page) {
  await gotoWithRetry(page, GROW_URL);
  // 页面为 SPA，首次加载渲染积分模块可能需要数秒；轮询等待，最多约 36 秒
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(3000);
    if (await isGrowLoggedIn(page)) return true;
    if (i === 5) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    }
  }
  return false;
}

/**
 * 带重试的导航。
 *
 * 本机有一堆 tun 代理接口（mihomo），网络切换时 Chromium 会抛
 * ERR_NETWORK_CHANGED，把正在加载的页面直接打断——而这跟登录态无关，
 * 只是"这一下网断了一下"。2026-11-10 多次因此让整条 daily-run 在第一步就失败
 * （主号签到没做成、当天 0 分），所以这里统一重试。
 *
 * 只对网络类错误重试；页面真的 404/超时这类不重试，避免掩盖真实问题。
 */
export async function gotoWithRetry(page, url, { attempts = 4, timeout = 90000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      return true;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      const retryable = /ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_TIMED_OUT|ERR_ABORTED|ERR_INTERNET_DISCONNECTED|net::/i.test(msg);
      if (!retryable || i === attempts) break;
      await page.waitForTimeout(2000 * i);
    }
  }
  throw lastErr;
}

/** @param {import('playwright').Page} page */
export async function navigateToLogin(page) {
  const loginUrl =
    "https://auth.huaweicloud.com/authui/login?service=https%3A%2F%2Fdeveloper.huaweicloud.com%2Fgrow&locale=zh-cn";
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
  console.log("\n请在弹出的浏览器窗口中使用华为云 APP 扫码登录。");
  console.log("登录成功后会自动跳回成长中心并保存 Cookie。\n");
}

/** @param {import('playwright').Page} page */
export async function waitForLogin(page, timeoutMs = 60 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isGrowLoggedIn(page)) return true;
    if (page.url().includes("auth.huaweicloud.com")) {
      await page.waitForTimeout(2000);
      continue;
    }
    await page.goto(GROW_URL, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
  }
  return false;
}

/** @param {import('playwright').Page} page */
export async function getGrowPointsSnippet(page) {
  return page.evaluate(() => {
    const t = document.body.innerText;
    const m = t.match(/我的积分[\s\S]{0,40}/);
    return m ? m[0].replace(/\s+/g, " ").trim() : "";
  });
}

/**
 * 全局单点登录票据：华为云所有子站（BBS / 学堂 / devstation）都靠它换票。
 *
 * 踩过的坑：这组 cookie 曾因某次覆写从 storageState 里消失，
 * 于是「成长中心还能查积分、BBS 却一路 not login」，
 * 提交建议和论坛回答全部静默失败在登录页上。
 * 因此落盘时必须保证：新票据有就用新的，新票据没有就保留旧的，绝不丢。
 */
const SSO_TICKET_NAMES = new Set(["SSOTGC", "SSOJTC"]);

/**
 * 登录态文件写锁。
 *
 * 背景：登录守护与每日任务会同时跑，两边都持有同一个 storageState。
 * 若不串行，后写的会直接覆盖先写的，表现为「明明刚登录成功，任务那边却是掉线」。
 * 用 O_EXCL 建锁文件实现互斥，拿不到就等，超时则放弃加锁但继续写（不阻塞主流程）。
 *
 * 多账号：锁必须按目标文件派生。否则两个账号会争同一把锁——
 * 主号在写、新号就得等 30 秒，反之亦然，表现为「无缘无故变慢」。
 */
const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 60_000;

/** 锁文件路径派生：与要写的 auth 文件一一对应 */
function lockPathFor(filePath) {
  return `${filePath}.lock`;
}

async function acquireLock(filePath = AUTH_FILE) {
  const AUTH_LOCK = lockPathFor(filePath);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(AUTH_LOCK, "wx");
      closeSync(fd);
      return true;
    } catch {
      // 锁文件残留（持有者被 kill）：超过阈值视为陈旧锁，清掉重试
      try {
        if (Date.now() - statSync(AUTH_LOCK).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(AUTH_LOCK);
          continue;
        }
      } catch {
        /* 锁刚被释放 */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

function releaseLock(filePath = AUTH_FILE) {
  try {
    unlinkSync(lockPathFor(filePath));
  } catch {
    /* ignore */
  }
}

/**
 * 安全保存登录态：合并新旧 cookie，保证 SSO 全局票据不丢。
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} filePath
 */
export async function saveAuthState(context, filePath) {
  // 目录必须先于加锁创建：锁文件也放在同目录里，
  // 目录不存在时 openSync(lock, "wx") 永远失败，会白等满 LOCK_WAIT_MS。
  mkdirSync(dirname(filePath), { recursive: true });
  const locked = await acquireLock(filePath);
  if (!locked) {
    console.log("  [auth] 等待登录态写锁超时，仍继续保存（可能被并发覆盖）");
  }
  try {
    const fresh = await context.storageState({ path: undefined });

    // 多账号下登录态在 storage/accounts/<id>/ 子目录里，该目录按需创建。
    // 不建目录会直接 ENOENT：锁文件建不出来（白等 30s 后报「写锁超时」），
    // tmp 文件也写不下去，最终表现为「扫码已确认但登录态没保存、页面一直等」。
    mkdirSync(dirname(filePath), { recursive: true });

    let old = { cookies: [], origins: [] };
    if (existsSync(filePath)) {
      try {
        old = JSON.parse(readFileSync(filePath, "utf8"));
      } catch {
        /* 旧文件损坏就当没有 */
      }
    }

    const freshKeys = new Set(fresh.cookies.map((c) => `${c.domain}|${c.name}`));
    const carried = (old.cookies || []).filter(
      (c) => SSO_TICKET_NAMES.has(c.name) && !freshKeys.has(`${c.domain}|${c.name}`)
    );
    if (carried.length) {
      console.log(
        `  [auth] 保留 ${carried.length} 个本次未刷新的 SSO 票据：${carried.map((c) => c.name).join(", ")}`
      );
    }

    const merged = {
      cookies: [...fresh.cookies, ...carried],
      origins: fresh.origins?.length ? fresh.origins : old.origins || [],
    };

    // 原子写：先写临时文件再 rename，避免中途崩溃留下半截 JSON
    // （半截文件会被当成「登录态损坏」，进而误触发扫码）。
    const tmp = `${filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf8");
    renameSync(tmp, filePath);
    restrictStorageFilePermissions(filePath);
    // 保存成功即轮转一份快照，供掉线时回滚（见 rotateAuthSnapshot）。
    // 放在写主文件之后：主文件永远是权威，快照只是兜底。
    try {
      rotateAuthSnapshot(filePath, merged);
    } catch {
      /* 快照失败不影响主流程 */
    }
    return merged;
  } finally {
    if (locked) releaseLock(filePath);
  }
}

// ── 登录态快照轮转 ────────────────────────────────────────────────
//
// 为什么需要：华为云会话偶发被服务端回收，而掉线那一刻如果本地只剩
// 「刚被写坏/刚续期失败」的那一份，就只能等人扫码。
// 多留几份带时间戳的历史快照，掉线时可以逐个试回来。
//
// 注意边界：快照救得了「本地文件异常」，救不了「服务端把票据全作废」。
// 后者只能重新扫码，这一点在 recovery.log 里会写明原因，免得误判。

/** 每个账号保留的快照份数（含最新） */
export const AUTH_SNAPSHOT_KEEP = 5;

/** 快照目录：与主凭证同目录下的 auth-snapshots/ */
export function authSnapshotDir(filePath) {
  return `${dirname(filePath)}/auth-snapshots`;
}

/**
 * 把当前登录态写一份带时间戳的快照，并清理超出保留份数的旧快照。
 *
 * 文件名形如 20261019-143005-482.json（含毫秒，避免同一秒内两次保活撞名）。
 *
 * @param {string} filePath 主凭证路径
 * @param {object} state storageState 对象
 */
export function rotateAuthSnapshot(filePath, state) {
  const dir = authSnapshotDir(filePath);
  mkdirSync(dir, { recursive: true });

  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
  const target = `${dir}/${stamp}.json`;

  writeFileSync(target, JSON.stringify(state, null, 2), "utf8");
  chmodSync(target, 0o600);

  // 只留最近 AUTH_SNAPSHOT_KEEP 份
  const files = listAuthSnapshots(filePath);
  for (const f of files.slice(AUTH_SNAPSHOT_KEEP)) {
    try {
      unlinkSync(f.path);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 列出快照，按时间倒序（最新在前）。
 *
 * @param {string} filePath 主凭证路径
 * @returns {{path: string, mtime: number}[]}
 */
export function listAuthSnapshots(filePath) {
  const dir = authSnapshotDir(filePath);
  if (!existsSync(dir)) return [];
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((n) => {
      const full = `${dir}/${n}`;
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      return { path: full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 掉线时的回滚候选：把所有历史快照按新→旧返回。
 * 会排除与当前主文件完全相同的快照（试了也是白试）。
 *
 * @param {string} filePath 主凭证路径
 */
export function authRollbackCandidates(filePath) {
  let currentRaw = "";
  try {
    currentRaw = readFileSync(filePath, "utf8");
  } catch {
    /* 主文件不存在：所有快照都是候选 */
  }
  let current = null;
  try {
    current = JSON.parse(currentRaw);
  } catch {
    /* ignore */
  }
  return listAuthSnapshots(filePath).filter((s) => {
    if (!current) return true;
    try {
      const s2 = JSON.parse(readFileSync(s.path, "utf8"));
      // 内容一致就没必要回滚
      return JSON.stringify(s2) !== JSON.stringify(current);
    } catch {
      return false;
    }
  });
}

/**
 * 把某份快照恢复成主凭证。
 *
 * 先把当前主文件备份成 .before-rollback，再原子写入，出问题能退回去。
 *
 * @param {string} snapshotPath
 * @param {string} filePath
 */
export function restoreAuthSnapshot(snapshotPath, filePath) {
  const raw = readFileSync(snapshotPath, "utf8");
  JSON.parse(raw); // 校验是合法 JSON，坏文件直接抛错
  mkdirSync(dirname(filePath), { recursive: true });
  if (existsSync(filePath)) {
    try {
      writeFileSync(`${filePath}.before-rollback`, readFileSync(filePath), { mode: 0o600 });
    } catch {
      /* ignore */
    }
  }
  const tmp = `${filePath}.rollback.tmp`;
  writeFileSync(tmp, raw, "utf8");
  renameSync(tmp, filePath);
  restrictStorageFilePermissions(filePath);
}
