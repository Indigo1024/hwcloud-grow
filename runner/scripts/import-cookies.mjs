#!/usr/bin/env node
/**
 * 方案B（兜底）：把从浏览器导出的 Cookie JSON 转换为 Playwright storageState，
 * 写入当前账号的登录态文件（main → storage/huaweicloud-auth.json，
 * acct2 → storage/accounts/acct2/huaweicloud-auth.json），供 npm run agent 复用。
 *
 * 支持两种输入：
 *  1) Cookie-Editor 扩展「Export as JSON」导出的数组（元素含 domain/name/value 等）
 *  2) 已包装的 { "cookies": [...] } 对象
 *
 * 用法: node scripts/import-cookies.mjs <cookies.json>
 */
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { authPathsFor } from "./auth-path.mjs";
import { resolveAccountId } from "./accounts.mjs";

// 按账号写登录态：AUTH_FILE 恒为主号文件，给 acct2 导 Cookie 会覆盖主号，
// 主号当场掉线且无任何提示。
const ACCOUNT_ID = resolveAccountId(process.env.HWCLOUD_ACCOUNT);
const AUTH_FILE = authPathsFor(ACCOUNT_ID).authFile;

const file = process.argv[2];
if (!file) {
  console.error("用法: node scripts/import-cookies.mjs <cookies.json>");
  process.exit(1);
}

const raw = JSON.parse(readFileSync(file, "utf8"));
const list = Array.isArray(raw) ? raw : raw.cookies || [];

const SAME_SITE = { no_restriction: "None", unspecified: "Lax", lax: "Lax", strict: "Strict", none: "None" };
const cookies = list
  .filter((c) => c && c.name && c.domain)
  .map((c) => ({
    name: c.name,
    value: c.value ?? "",
    domain: c.domain,
    path: c.path || "/",
    expires:
      typeof c.expirationDate === "number"
        ? Math.floor(c.expirationDate)
        : typeof c.expires === "number"
          ? Math.floor(c.expires)
          : -1,
    httpOnly: !!c.httpOnly,
    secure: !!c.secure,
    sameSite: SAME_SITE[String(c.sameSite || "").toLowerCase()] || "Lax",
  }));

if (!cookies.length) {
  console.error("未解析到有效 Cookie");
  process.exit(1);
}

writeFileSync(AUTH_FILE, JSON.stringify({ cookies, origins: [] }, null, 2), "utf8");
chmodSync(AUTH_FILE, 0o600);
console.log(`✓ 已导入 ${cookies.length} 条 Cookie 到 ${AUTH_FILE}`);
