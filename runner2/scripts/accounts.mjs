// accounts.mjs — 华为云账号注册表（新号独立部署版）
//
// 本目录（runner2）是**新号专属的独立部署**，与主号所在的 runner 部署（主号）
// 完全物理隔离：脚本、storage、日志、workspace、凭证全在自己这里，互不影响。
//
// 因此这里不再保留「多账号切换」能力——把账号写死为 acct2 反而更稳：
//   - 不依赖 HWCLOUD_ACCOUNT 环境变量，漏设也不会退回主号
//   - 不解析未知 id，没有「以为在跑 A 结果跑了 B」的空间
//   - 主号的 runner 与 acct2 的 runner2 各自演进，改一边不影响另一边
//
// 注：AK/SK 不写进本文件（会进 git），真实值放 ~/.codeartsdoer/.env.aksk-acct2。

import { homedir } from "node:os";
import { join } from "node:path";

/** 本部署固定服务的账号 id */
export const ACCOUNT_ID = "acct2";

/**
 * 账号配置。
 *
 * @typedef {object} Account
 * @property {string} id          短 slug，用于派生路径
 * @property {string} label       初始显示名；登录后会被真实昵称替换
 * @property {string} akEnv       AK 环境变量名
 * @property {string} skEnv       SK 环境变量名
 * @property {string} envFile     存放该账号 AK/SK 的 shell 文件
 * @property {string} gitcodeHome GitCode 凭证目录
 * @property {boolean} legacy     是否沿用旧的无后缀文件名
 */

/** @type {Account[]} */
export const ACCOUNTS = [
  {
    id: "acct2",
    label: "账号2",
    akEnv: "CODEARTS_CLI_AK_ACCT2",
    skEnv: "CODEARTS_CLI_SK_ACCT2",
    envFile: join(homedir(), ".codeartsdoer", ".env.aksk-acct2"),
    // GitCode login = gitcode_user_2
    gitcodeHome: join(homedir(), ".gitcode-acct2"),
    // 看板/扫码等公开文件名必须带 -acct2 后缀：/usr/share/novnc 是两个部署共用的，
    // 无后缀文件名（points-data.json、scan-qr.png）属于主号，新号写进去会覆盖主号看板。
    legacy: false,
  },
];

/** 默认账号 id（= 唯一账号） */
export const DEFAULT_ACCOUNT_ID = ACCOUNT_ID;

/** 全部账号 id */
export const ACCOUNT_IDS = ACCOUNTS.map((a) => a.id);

/**
 * 解析账号 id。
 * 本部署下恒返回 acct2；显式传入其它 id 会抛错，避免误用。
 *
 * @param {string|undefined|null} [id]
 * @returns {string}
 */
export function resolveAccountId(id) {
  const raw = id === undefined || id === null || id === "" ? ACCOUNT_ID : String(id).trim();
  if (!ACCOUNT_IDS.includes(raw)) {
    throw new Error(
      `本部署（runner2）只服务账号 "${ACCOUNT_ID}"，收到 "${raw}"。` +
        `若要操作主号，请使用主号所在的 runner 部署目录。`,
    );
  }
  return raw;
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
 * acct2 为 legacy=true，返回原名（`<base><ext>`），
 * 使看板与既有页面路径保持不变。
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
