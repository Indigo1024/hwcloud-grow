import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ACCOUNTS, DEFAULT_ACCOUNT_ID, resolveAccountId } from "./accounts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const STORAGE_DIR = join(__dirname, "..", "storage");

/**
 * 按账号派生凭据路径。
 *
 * 布局：
 *   main   → storage/huaweicloud-auth.json          （沿用旧路径，兼容历史脚本与备份）
 *   acct2  → storage/accounts/acct2/huaweicloud-auth.json
 *
 * main 保持旧路径是刻意的：已经部署的脚本、备份内容、外部引用都不必改动。
 *
 * @param {string} [accountId]
 */
export function authPathsFor(accountId) {
  const id = resolveAccountId(accountId);
  // 注意：runner2 只有一套 storage，不再按账号分子目录——
  // 本部署自己就是 acct2 的专属目录，再套一层只是徒增路径深度。
  const dir = STORAGE_DIR;
  return {
    accountId: id,
    storageDir: dir,
    authFile: join(dir, "huaweicloud-auth.json"),
    sessionMetaFile: join(dir, "session-meta.json"),
    lockFile: join(dir, "huaweicloud-auth.json.lock"),
  };
}

/**
 * 账号专属的运行时目录（报告、日志、PID）。
 *
 * 两个账号并行跑任务时，若共用 storage/last-run-report.json 会互相覆盖，
 * 表现为「报告里出现另一个账号的数据」。所以 main 之外的账号走独立子目录。
 *
 * @param {string} [accountId]
 */
export function runtimeDirFor(accountId) {
  resolveAccountId(accountId);
  return STORAGE_DIR;
}

// ── 向后兼容常量 ────────────────────────────────────────────────────
// 这些常量等于「默认账号」的值。保留它们是为了让已有的 import 点零改动：
// 未设置 HWCLOUD_ACCOUNT 时，行为与改造前完全一致。

const DEFAULT_PATHS = authPathsFor(DEFAULT_ACCOUNT_ID);

export const AUTH_FILE = DEFAULT_PATHS.authFile;
export const SESSION_META_FILE = DEFAULT_PATHS.sessionMetaFile;
export const GROW_URL = "https://developer.huaweicloud.com/grow";

export const PORTAL_ORIGIN = (
  // 新号独立部署用 8090，避免与主号的 8080 门户互相抢占
  process.env.GROW_PORTAL_ORIGIN || "http://127.0.0.1:8090"
).replace(/\/$/, "");

export const MANIFEST_URL =
  process.env.GROW_MANIFEST_URL || `${PORTAL_ORIGIN}/grow-portal/manifest.json`;

export const DEFAULT_MANIFEST_FILE = join(__dirname, "..", "manifest.cache.json");

export const REPO_MANIFEST = join(__dirname, "..", "..", "manifest.json");

/** 开发者在 monorepo 内联调时，可回退到 portal/public/manifest.json */
export const PORTAL_DEV_MANIFEST = join(
  __dirname,
  "..",
  "..",
  "portal",
  "public",
  "manifest.json",
);

/** monorepo 开发时复用 portal/storage 里已有的 Cookie */
export const LEGACY_AUTH_FILE = join(
  __dirname,
  "..",
  "..",
  "portal",
  "storage",
  "huaweicloud-auth.json",
);

export { ACCOUNTS };
