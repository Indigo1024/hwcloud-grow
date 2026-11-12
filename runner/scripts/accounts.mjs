// accounts.mjs — 华为云多账号注册表
//
// 背景：
//   原系统只有一套 storage/huaweicloud-auth.json，隐含「单账号」假设。
//   现在要跑两个华为云账号，各自独立登录态、独立 GitCode、独立任务。
//
// 设计：
//   - id 是短 slug，用于派生文件名与路径（auth 文件、锁、扫码图、看板数据…）
//   - label 只是初始占位显示名；登录后由华为云接口返回的真实昵称覆盖
//   - AK/SK 不写进本文件（本文件会进 git），只写环境变量名，
//     真实值放 /root/.codeartsdoer/.env.aksk-<id>（权限 600）
//   - 当前账号由 HWCLOUD_ACCOUNT 指定，未指定时默认 ACCOUNTS[0].id，
//     从而所有旧脚本不带参数时行为不变

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 账号列表。顺序即页面上的显示顺序，第一个是默认账号。
 *
 * @typedef {object} Account
 * @property {string} id          短 slug，用于派生路径（勿含特殊字符）
 * @property {string} label       初始显示名；登录后会被真实昵称替换
 * @property {string} akEnv       AK 环境变量名
 * @property {string} skEnv       SK 环境变量名
 * @property {string} envFile     存放该账号 AK/SK 的 shell 文件
 * @property {string} gitcodeHome GitCode 凭证目录
 * @property {boolean} legacy     是否沿用旧的无后缀文件名（兼容老页面）
 */

/** @type {Account[]} */
export const ACCOUNTS = [
  {
    id: "main",
    label: "主号",
    akEnv: "CODEARTS_CLI_AK",
    skEnv: "CODEARTS_CLI_SK",
    envFile: join(homedir(), ".codeartsdoer", ".env.aksk"),
    // GitCode login = gitcode_user_main
    gitcodeHome: join(homedir(), ".gitcode"),
    legacy: true,
  },
  {
    id: "acct2",
    label: "账号2",
    akEnv: "CODEARTS_CLI_AK_ACCT2",
    skEnv: "CODEARTS_CLI_SK_ACCT2",
    envFile: join(homedir(), ".codeartsdoer", ".env.aksk-acct2"),
    // GitCode login = gitcode_user_2
    gitcodeHome: join(homedir(), ".gitcode-acct2"),
    legacy: false,
  },
];

/** 默认账号 id */
export const DEFAULT_ACCOUNT_ID = ACCOUNTS[0].id;

/** 全部账号 id */
export const ACCOUNT_IDS = ACCOUNTS.map((a) => a.id);

/**
 * 解析账号 id。
 * 优先级：显式参数 > HWCLOUD_ACCOUNT 环境变量 > 默认账号。
 * 未知 id 直接抛错——静默回退到默认账号会让「以为在跑 A 结果跑了 B」难以察觉。
 *
 * @param {string|undefined|null} [id]
 * @returns {string}
 */
export function resolveAccountId(id) {
  const raw = id || process.env.HWCLOUD_ACCOUNT || DEFAULT_ACCOUNT_ID;
  const normalized = String(raw).trim();
  if (!ACCOUNT_IDS.includes(normalized)) {
    throw new Error(
      `未知账号 id: "${normalized}"，可选：${ACCOUNT_IDS.join(", ")}`,
    );
  }
  return normalized;
}

/**
 * 按 id 取账号配置。
 * @param {string|undefined|null} [id]
 * @returns {Account}
 */
export function getAccount(id) {
  const accountId = resolveAccountId(id);
  return ACCOUNTS.find((a) => a.id === accountId);
}

/**
 * 给文件名加账号后缀。
 * legacy 账号返回原名（兼容旧页面），其余返回 `<base>-<id><ext>`。
 *
 * @param {string} accountId
 * @param {string} baseName 不含扩展名的基名，如 "scan-status"
 * @param {string} ext      含点扩展名，如 ".json"
 */
export function suffixFor(accountId, baseName, ext) {
  const account = getAccount(accountId);
  return account.legacy ? `${baseName}${ext}` : `${baseName}-${account.id}${ext}`;
}

/**
 * 账号是否沿用旧的无后缀文件名。
 * @param {string|undefined|null} [id]
 */
export function isLegacyAccount(id) {
  return getAccount(id).legacy;
}
