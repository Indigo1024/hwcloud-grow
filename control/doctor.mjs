#!/usr/bin/env node
/**
 * 环境自检（衔接装置）—— 跑任务前先确认"能不能跑"。
 *
 * 为什么需要：
 *   本项目依赖浏览器做自动化。新用户 clone 下来常见的三个坑：
 *     ① 没装 playwright 的浏览器（`npm i` 不会自动下载浏览器二进制）
 *     ② 无头环境没有 X server，有头模式（扫码登录）直接崩
 *     ③ Node 版本过低（用到全局 fetch，需 ≥18）
 *   这三点若不提前查，用户会在跑任务时才看到莫名其妙的报错
 *   （"Target page, context or browser has been closed"、"ERR_MODULE_NOT_FOUND"）。
 *
 * 用法:
 *   node control/doctor.mjs            # 人读的检查报告
 *   node control/doctor.mjs --json     # 机器可读（供面板/启动脚本判断）
 *   node control/doctor.mjs --quiet    # 仅在失败时输出
 *
 * 退出码: 0=全部就绪  1=有阻塞项  2=有警告但可运行
 */
import { existsSync, readdirSync, mkdirSync, accessSync, constants } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const argv = process.argv.slice(2);
const AS_JSON = argv.includes("--json");
const QUIET = argv.includes("--quiet");

const checks = [];
const add = (name, status, detail, hint) =>
  checks.push({ name, status, detail, hint: hint || null });

// ── 1. Node 版本 ─────────────────────────────────────────────
{
  const v = process.versions.node;
  const major = Number(v.split(".")[0]);
  if (major >= 18) add("Node.js", "ok", `v${v}`);
  else add("Node.js", "fail", `v${v}（需要 ≥18）`, "升级 Node：https://nodejs.org/");
}

// ── 2. playwright 依赖 ───────────────────────────────────────
function inRunners(rel) {
  for (const r of ["runner", "runner2"]) {
    const p = join(ROOT, r, rel);
    if (existsSync(p)) return p;
  }
  return null;
}
{
  const pw = inRunners(join("node_modules", "playwright", "index.mjs"));
  if (pw) add("playwright 依赖", "ok", "已安装");
  else add("playwright 依赖", "fail", "未安装（runner/ 下没有 node_modules）",
           "在 runner/ 目录执行：npm install");
}

// ── 3. 浏览器二进制 ──────────────────────────────────────────
{
  const home = process.env.HOME || "/root";
  const cacheDir =
    process.env.PLAYWRIGHT_BROWSERS_PATH || join(home, ".cache", "ms-playwright");
  let found = [];
  try {
    found = readdirSync(cacheDir).filter((d) => /^chromium/.test(d));
  } catch {}
  if (found.length) {
    add("浏览器二进制", "ok", `已下载：${found.join(", ")}`);
  } else {
    add(
      "浏览器二进制",
      "fail",
      `未找到（${cacheDir} 为空或不存在）`,
      "执行：cd runner && npx playwright install chromium\n" +
        "  （注意：npm install 不会自动下载浏览器，必须单独跑这一步）",
    );
  }
}

// ── 3b. 浏览器能否真正启动（实测，不只是看文件在不在）────────
// 「文件在」不等于「能跑」：缺系统库（如 libnss3）、沙箱受限等都会启动失败，
// 而这只有真启动一次才知道。生产上遇到过"装是装了、跑就是起不来"的情况。
if (checks.every((c) => c.status !== "fail")) {
  const probe = spawnSync(
    "node",
    [
      "-e",
      `(async () => {
         try {
           const { chromium } = await import('playwright');
           const b = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
           await b.close();
           console.log('OK');
         } catch (e) { console.log('ERR:' + String(e).slice(0, 200)); }
       })()`,
    ],
    {
      cwd: join(ROOT, "runner"),
      encoding: "utf8",
      timeout: 60000,
      env: { ...process.env, PATH: process.env.PATH },
    },
  );
  const out = (probe.stdout || "").trim();
  if (out.includes("OK")) {
    add("浏览器可启动（实测）", "ok", "headless 启动成功");
  } else if (out.startsWith("ERR:")) {
    const msg = out.slice(4);
    const isLib = /libnss|libatk|libx11|Shared library|error while loading/i.test(msg);
    add("浏览器可启动（实测）", "fail", msg.slice(0, 90),
        isLib
          ? "缺少系统库。Debian/Ubuntu 上执行：\n" +
            "      npx playwright install-deps chromium\n" +
            "  （或 apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2）"
          : "请在 runner/ 下重试：npx playwright install chromium");
  } else {
    add("浏览器可启动（实测）", "warn",
        "探测未返回结果（可能超时）—— 可手动在 runner/ 下跑一次任务确认");
  }
}

// ── 4. 显示环境（有头模式 / 扫码登录需要） ────────────────────
{
  const disp = process.env.DISPLAY;
  if (!disp) {
    add(
      "显示环境 (DISPLAY)",
      "warn",
      "未设置",
      "扫码登录需要 X server。二选一：\n" +
        "  · 有桌面环境：export DISPLAY=:0\n" +
        "  · 服务器（无桌面）：\n" +
        "      apt install -y xvfb\n" +
        "      Xvfb :99 -screen 0 1280x900x24 -ac +extension GLX +render -noreset &\n" +
        "      export DISPLAY=:99",
    );
  } else {
    const r = spawnSync("xdpyinfo", ["-display", disp], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0) {
      add("显示环境 (DISPLAY)", "ok", `${disp} 可用`);
    } else if (r.error && r.error.code === "ENOENT") {
      add("显示环境 (DISPLAY)", "warn", `${disp}（xdpyinfo 未安装，无法验证）`,
          "建议装 x11-utils 以便自检：apt install -y x11-utils");
    } else {
      add("显示环境 (DISPLAY)", "fail", `${disp} 连不上 X server`,
          `启动虚拟显示：Xvfb ${disp} -screen 0 1280x900x24 -ac &\n  或检查 DISPLAY 是否写对`);
    }
  }
}

// ── 5. 数据目录可写 ──────────────────────────────────────────
{
  const d = process.env.HWCLOUD_DATA_DIR || process.env.PANEL_STATIC_DIR || join(ROOT, "panel");
  try {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    accessSync(d, constants.W_OK);
    add("数据目录", "ok", d);
  } catch (e) {
    add("数据目录", "fail", `${d} 不可写：${String(e?.code || e).slice(0, 40)}`,
        "检查权限，或设 HWCLOUD_DATA_DIR 指向可写目录");
  }
}

// ── 6. Xvfb 是否已装（无头服务器常用） ───────────────────────
{
  const r = spawnSync("which", ["Xvfb"], { encoding: "utf8", timeout: 5000 });
  const has = r.status === 0 && (r.stdout || "").trim();
  add("Xvfb（可选的虚拟显示）", has ? "ok" : "warn",
      has ? (r.stdout || "").trim() : "未安装（有桌面环境时不需要）",
      has ? null : "服务器环境建议：apt install -y xvfb");
}

// ── 输出 ─────────────────────────────────────────────────────
const fails = checks.filter((c) => c.status === "fail");
const warns = checks.filter((c) => c.status === "warn");
const code = fails.length ? 1 : warns.length ? 2 : 0;

if (AS_JSON) {
  process.stdout.write(JSON.stringify({ ok: fails.length === 0, code, checks }, null, 2));
  process.exit(code);
}

const ICON = { ok: "✅", warn: "⚠️ ", fail: "❌" };
if (!QUIET || fails.length) {
  console.log("\n===== 运行环境自检 =====\n");
  for (const c of checks) {
    console.log(`${ICON[c.status]} ${c.name}: ${c.detail}`);
    if (c.hint && c.status !== "ok") {
      for (const line of c.hint.split("\n")) console.log(`     ${line}`);
    }
  }
  console.log();
  if (fails.length) console.log(`❌ 有 ${fails.length} 项阻塞，请按提示处理后再运行。`);
  else if (warns.length) console.log(`⚠️  有 ${warns.length} 项警告 —— 多数任务可运行，有头操作（扫码）可能受影响。`);
  else console.log("✅ 环境就绪，可以开始运行任务。");
  console.log();
}
process.exit(code);
