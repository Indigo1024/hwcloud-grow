#!/usr/bin/env node
/**
 * 本地生成技术文章正文（不依赖码道 TUI / 大模型）
 *
 * 为什么要有这个：
 *   原先发文走码道 TUI 让模型现写正文，一旦码道套餐流量耗尽，TUI 只会静默卡到
 *   超时，整个「每日发布文章 +60」直接失败。这里改成用本地模板按主题拼装正文，
 *   输出仍然是 600 字以上、带真实代码与步骤的 Markdown，不依赖任何外部模型。
 *
 * 用法：
 *   import { buildArticle } from "./article-content.mjs";
 *   const { title, body } = buildArticle(topic, { variant: 0 });
 *
 * variant 用来在同一主题下换一套素材（多账号同日各发一篇时避免内容完全一致）。
 */

/** 每个主题给一组「真实踩过的坑」素材，正文据此展开 */
const MATERIALS = {
  playwright: {
    keywords: ["Playwright", "浏览器自动化", "企业控制台"],
    pains: [
      ["登录态反复失效", "早期每次都用账号密码重新登录，撞上验证码就停摆。后来改成复用 storageState，登录成功一次后持久化 cookie 与 localStorage，后续任务直接加载。"],
      ["多账号互相覆盖", "两个账号共用一个 storageState 文件，后登录的覆盖前一个。按账号派生文件名（auth-{accountId}.json）后解决。"],
      ["等待策略写得死", "用固定 sleep 等待页面渲染，网络慢时仍会失败。改用 waitForSelector 与 waitForLoadState('networkidle') 组合，稳定性明显提升。"],
      ["并发抢同一个浏览器", "守护进程与手动测试同时启动浏览器，报 Target page, context or browser has been closed。方案是加文件锁，同一时刻只允许一个实例操作浏览器。"],
    ],
    code: `import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-features=NetworkServiceInProcess,NetworkChangeNotifier", "--disable-background-networking", "--disable-component-update", "--no-first-run"] });
const ctx = await browser.newContext({
  storageState: "auth.json",   // 登录一次，后续复用
  locale: "zh-CN",
});
const page = await ctx.newPage();
await page.goto("https://example.com/dashboard", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#data-table tbody tr");   // 等真实数据出现
const rows = await page.$$eval("#data-table tbody tr", (trs) =>
  trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())),
);
await browser.close();
console.log(rows);`,
  },

  tui: {
    keywords: ["TUI", "非交互环境", "自动化"],
    pains: [
      ["没有 tty 就静默空转", "TUI 程序在管道环境下不跑事件循环，进程活着但零输出，看起来像卡死。用 script -qfc 包一层伪终端后恢复正常。"],
      ["权限弹窗无人应答", "程序启动后弹出权限确认，非交互环境下会被自动拒绝。必须提前把权限配置写成 allow。"],
      ["输出带大量控制字符", "TUI 输出里全是 ANSI 转义序列，正则匹配前要先剥离，否则关键词永远匹配不上。"],
      ["超时判断难", "无法区分「正在思考」和「已经卡死」。解法是监听关键完成标记，加一个总超时兜底。"],
    ],
    code: `// 用伪终端包裹 TUI，否则多数 TUI 在管道下不会正常运行
script -qfc "my-tui --prompt '生成一段文本'" /dev/null

// Node 侧剥离 ANSI 后再做关键词匹配
const clean = (s) => s.replace(/\\x1b\\[[0-9;]*[A-Za-z]/g, "");
proc.stdout.on("data", (buf) => {
  const text = clean(buf.toString());
  if (/完成|成功|OK/.test(text)) resolve();
});`,
  },

  credential: {
    keywords: ["凭据隔离", "文件锁", "多账号"],
    pains: [
      ["凭据串号", "两个账号共用同一个环境变量文件，后加载的覆盖前面的，任务跑到一半发现分数记到了错误账号上。"],
      ["并发写坏文件", "两个进程同时写同一个 JSON，出现半截文件导致解析失败。改成写临时文件再 rename，保证原子性。"],
      ["锁文件残留", "进程被 kill 后锁文件没删，后续任务全部超时。加 pid 存活检查，失效锁自动清理。"],
      ["目录不存在导致静默失败", "写日志前没确认目录存在，写入报 ENOENT，但错误被吞掉，表现为「什么都没发生」。"],
    ],
    code: `import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// 原子写：先写临时文件再 rename，避免读到半截内容
export function writeJsonAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });   // 目录不存在会 ENOENT
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, file);
}`,
  },

  nodejs: {
    keywords: ["Node.js", "任务调度", "踩坑"],
    pains: [
      ["主流程结束进程不退", "异步任务跑完后仍有句柄未释放，进程挂着不退，长期占用资源。加显式 process.exit(0) 兜底。"],
      ["定时任务时区错乱", "服务器是 UTC，按本地时间写的 cron 实际差了 8 小时，任务在凌晨跑而不是早上。所有时间换算必须显式指定时区。"],
      ["错误被静默吞掉", "没有监听 unhandledRejection，失败的任务悄无声息。加上全局兜底日志后才看清问题。"],
      ["内存泄漏", "长时间运行累积闭包引用，内存持续上涨。定期重启进程是最简单的缓解手段。"],
    ],
    code: `// 时区必须显式处理：服务器常是 UTC
const beijing = () =>
  new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

// 进程兜底：任务做完主动退出，避免句柄泄漏挂住
process.on("unhandledRejection", (e) => {
  console.error("未捕获的 Promise 异常:", e);
});

async function main() {
  await runDailyTasks();
  process.exit(0);   // 关键：不让残留句柄拖住进程
}
main().catch((e) => { console.error(e); process.exit(1); });`,
  },

  ops: {
    keywords: ["自动化", "日常运营", "脚本"],
    pains: [
      ["一上来想全自动", "初期试图把整个流程一次做完，任何一个环节变动就全线崩溃。拆成小步骤、每步可单独重跑后，维护成本低得多。"],
      ["没有幂等设计", "脚本重跑会重复提交，产生重复内容。加「今日是否已完成」的前置检查后才敢放心重试。"],
      ["缺少观测手段", "出问题只能翻日志猜。补上耗时、退出码、关键中间结果的结构化输出后，定位速度快了一个量级。"],
      ["边界没想清楚", "哪些事该自动化、哪些必须人工确认，早期没划线，结果一个验证码就把整条链卡住。"],
    ],
    code: `// 幂等设计：先查今天是否已完成，避免重复提交
async function runOncePerDay() {
  const today = new Date().toISOString().slice(0, 10);
  const state = readJson("state.json") ?? {};
  if (state.lastRun === today && state.ok) {
    console.log("今日已完成，跳过");
    return;
  }
  const ok = await doTask();
  writeJsonAtomic("state.json", { lastRun: today, ok });
}`,
  },
};

/** 主题 → 素材键的映射（关键词命中即可） */
function pickMaterial(topic) {
  const t = String(topic || "");
  if (/playwright|浏览器|控制台/i.test(t)) return "playwright";
  if (/tui|交互环境|终端/i.test(t)) return "tui";
  if (/凭据|账号|锁|隔离/i.test(t)) return "credential";
  if (/node|调度|任务/i.test(t)) return "nodejs";
  return "ops";
}

/** 生成 Markdown 正文（600 字以上，含代码块与步骤） */
export function buildArticle(topic, opts = {}) {
  const m = MATERIALS[pickMaterial(topic)] || MATERIALS.ops;
  const title = String(topic || "自动化实践中的经验总结").trim();
  const variant = Number(opts.variant || 0) % 4;

  // 按 variant 轮转素材顺序，避免多账号同日内容完全一致
  const pains = m.pains.slice(variant).concat(m.pains.slice(0, variant));

  const lines = [];
  lines.push(`## 背景`);
  lines.push("");
  lines.push(
    `这段时间在做 ${m.keywords.join("、")} 相关的自动化，过程中踩了不少坑，` +
      `记录一下问题和最终的处理方式，希望对遇到同类场景的同学有帮助。`,
  );
  lines.push("");
  lines.push(`## 遇到的问题`);
  lines.push("");
  pains.forEach(([name, detail], i) => {
    lines.push(`### ${i + 1}. ${name}`);
    lines.push("");
    lines.push(detail);
    lines.push("");
  });
  lines.push(`## 关键代码`);
  lines.push("");
  lines.push("```javascript");
  lines.push(m.code);
  lines.push("```");
  lines.push("");
  lines.push(`## 落地步骤`);
  lines.push("");
  lines.push(`1. 先把最小可运行的流程跑通，只做一件事：能拿到结果就算成功。`);
  lines.push(`2. 加上失败重试与超时控制，避免单个环节异常导致整体卡死。`);
  lines.push(`3. 把关键中间结果落盘，出问题时能直接对照，不用靠猜。`);
  lines.push(`4. 最后再考虑并发与多账号，在此之前不要引入复杂度。`);
  lines.push("");
  lines.push(`## 小结`);
  lines.push("");
  lines.push(
    `自动化的价值不在于「一次写完就再也不管」，而在于把重复劳动压缩成可重复执行的步骤。` +
      `上面这些问题大多不是技术难点，而是没有提前想清楚边界：哪些环节必须人工介入、` +
      `失败了如何重试、怎么判断真的成功了。把这几件事想明白，脚本的稳定性会好很多。`,
  );
  lines.push("");

  return { title, body: lines.join("\n"), material: m };
}

/** 正文纯文本字数（用于校验是否够 600 字） */
export function countChars(markdown) {
  return String(markdown).replace(/\s/g, "").length;
}
