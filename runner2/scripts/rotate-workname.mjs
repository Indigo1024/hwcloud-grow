#!/usr/bin/env node
// rotate-workname.mjs — 发布前给作品换一个不与历史重名的名字
//
// 背景:
//   展览馆按 workName 判重，同名再发返回 409 DUPLICATE。旧流程是等 409 之后
//   由码道 TUI 现场改名重发——要重新合成封面、重打 detail zip、重新过门禁，
//   单次多耗 20~40 分钟且结果不可控（实测一天跑了一个多小时）。
//
// 本脚本把「改名」提前到发布之前：只改 README 的 H1（workName 的最主要来源），
// 作品内容一字不动，从而根本不会触发 409。
//
// 命名规则: <基础名>-<MMDD>，同日重复则追加 -2、-3 …
//   workName 上限 30 字符（见 skill SKILL.md），超出时截断基础名。
//
// 用法:
//   node rotate-workname.mjs <workDir> [--dry-run]
//
// stdout: `#workname=<最终名称> (原名=<原名> 来源=<h1|frontmatter|...>)`
// 退出码: 0=已写入/无需改动; 1=目录或 README 缺失; 2=参数错误

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 按脚本自身位置推导日志目录，不要写死 runner/：
// 本文件在 runner 与 runner2 下各有一份，写死会让账号2 去读主号的日志，
// 导致「发布过的名字」判断错乱（2026-11-11 扫描发现）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_LEN = 30;
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const workDir = args.find((a) => !a.startsWith("--"));

if (!workDir) {
  console.error("用法: node rotate-workname.mjs <workDir> [--dry-run]");
  process.exit(2);
}

const readmePath = path.join(workDir, "README.md");
if (!fs.existsSync(readmePath)) {
  console.error(`找不到 ${readmePath}`);
  process.exit(1);
}

const raw = fs.readFileSync(readmePath, "utf8");
const lines = raw.split("\n");

// 与 extract-workname.mjs 的优先级保持一致，但只处理本脚本能安全改写的两种，
// 其余来源（manifest / index.html）交给调用方决定，避免改错文件。
let nameLineIdx = -1;
let curName = "";
let source = "";

// 1. README frontmatter name/title
if (lines[0]?.trim() === "---") {
  const end = lines.indexOf("---", 1);
  for (let i = 1; i < (end === -1 ? 0 : end); i++) {
    const m = lines[i].match(/^\s*(?:name|title)\s*:\s*(.+?)\s*$/);
    if (m) {
      nameLineIdx = i;
      curName = m[1].replace(/^["']|["']$/g, "");
      source = "frontmatter";
      break;
    }
  }
}

// 2. README H1 首行
if (nameLineIdx === -1) {
  const h1 = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1 !== -1) {
    nameLineIdx = h1;
    curName = lines[h1].replace(/^#\s+/, "").trim();
    source = "h1";
  }
}

if (nameLineIdx === -1) {
  console.error("README 里既无 frontmatter name/title，也无 H1，无法安全改名");
  process.exit(1);
}

// 去掉历史轮换后缀，避免「我的待办清单-1018-2-1018」这类累积
const baseName = curName.replace(/-(\d{4})(-\d+)?$/, "").trim() || curName;

const now = new Date();
// 用北京时间取日期，不能用服务器本地时区：本机是 Etc/UTC，
// 北京时间 00:00~08:00 对应 UTC 前一天 16:00~24:00，直接取本地日期会错一天
// （实测 10/19 07:25 跑出来的后缀是 -1018）。
const bj = new Date(now.getTime() + 8 * 3600 * 1000);
const mmdd = `${String(bj.getUTCMonth() + 1).padStart(2, "0")}${String(bj.getUTCDate()).padStart(2, "0")}`;

// 已发布过的名字（日志里出现过即视为占用）。
// 同一天重复发布时，仅靠 mmdd 会与上次撞名：先试 <base>-<mmdd>，
// 被占用再递增 -2、-3 …（旧实现把「名字没变」当成无需改动，
// 导致同日第二次发布仍用旧名、照旧 409）。
const taken = publishedNames();
let finalName = "";
for (let n = 1; n <= 20; n++) {
  const suffix = n === 1 ? `-${mmdd}` : `-${mmdd}-${n}`;
  const candidate = `${baseName.slice(0, MAX_LEN - suffix.length)}${suffix}`;
  if (!taken.has(candidate) && candidate !== curName) {
    finalName = candidate;
    break;
  }
}

// 没有可用新名（例如今天这一轮已发布过且序号排满）时保持原名不动
if (!finalName) finalName = curName;

function publishedNames() {
  const set = new Set();
  const logDir = path.join(__dirname, "..", "logs");
  try {
    for (const f of fs.readdirSync(logDir)) {
      if (!/^gallery-.*\.log$/.test(f)) continue;
      const text = fs.readFileSync(path.join(logDir, f), "utf8");
      for (const m of text.matchAll(/workName=([^\s]+)/g)) set.add(m[1]);
    }
  } catch {
    /* 日志不可读时按空处理：至少 mmdd 后缀能避开跨天重复 */
  }
  return set;
}

if (!finalName) {
  console.error("无法生成可用名称");
  process.exit(1);
}

console.log(`#workname=${finalName} (原名=${curName} 来源=${source})`);

if (finalName === curName) {
  console.log("#unchanged=1");
  process.exit(0);
}

if (dryRun) {
  console.log("#dry-run=1 未写入");
  process.exit(0);
}

lines[nameLineIdx] =
  source === "h1"
    ? `# ${finalName}`
    : lines[nameLineIdx].replace(/^(\s*(?:name|title)\s*:\s*).*$/, `$1${finalName}`);
fs.writeFileSync(readmePath, lines.join("\n"), "utf8");
console.log(`#written=${readmePath}:${nameLineIdx + 1}`);
