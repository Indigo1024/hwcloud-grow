#!/usr/bin/env node
/**
 * 扫码登录（风控兜底版）
 *
 * 场景：数据中心 IP + 自动化浏览器导致密码登录被华为云风控拦截（408「设备不安全」），
 * 但扫码登录接口不受影响。本脚本直接调用官方接口获取二维码并轮询状态：
 *   1. 打开登录页 → 调用 /authui/qrcode 拿 client_key + qrcode_content
 *   2. 渲染二维码到浏览器页面，同时写入 /usr/share/novnc/scan-qr.png（可通过 HTTP 查看）
 *   3. 轮询 /authui/qrcode/status；手机（华为云 APP）扫码并确认后跳转 redirect_url
 *   4. 保存登录态到 storage/huaweicloud-auth.json
 *
 * 二维码查看页: http://<你的主机>:6080/scan.html
 * 用法: node scripts/qr-login.mjs
 */
import { chromium } from "playwright";
import QRCode from "qrcode";
import { writeFileSync, chmodSync } from "node:fs";

import { ensureStorageDir, saveAuthState, resolveAuthFile,  dataDir } from "./auth-utils.mjs";
import { resolveAccountId, suffixFor } from "./accounts.mjs";

const SERVICE = "https://developer.huaweicloud.com/grow";
const LOGIN_URL = `https://auth.huaweicloud.com/authui/login?service=${encodeURIComponent(SERVICE)}&locale=zh-cn`;

// 多账号：二维码与状态文件按账号派生。主号沿用 scan-qr.png / scan-status.json
// （旧页面仍可用），新号为 scan-qr-acct2.png / scan-status-acct2.json。
const ACCOUNT_ID = resolveAccountId();
/** 该账号的登录态文件（勿用 auth-path 的 AUTH_FILE，那是默认账号的固定路径） */
const AUTH_FILE = resolveAuthFile(ACCOUNT_ID);
const QR_PNG_PATH = `${dataDir()}/${suffixFor(ACCOUNT_ID, "scan-qr", ".png")}`;
const QR_STATUS_PATH = `${dataDir()}/${suffixFor(ACCOUNT_ID, "scan-status", ".json")}`;
const POLL_INTERVAL_MS = 2000;
const POLL_ROUNDS = 150; // 每轮最长约 5 分钟
const MAX_QR_ROUNDS = 12; // 过期自动换新，最多 12 轮（约 1 小时）

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

function writeStatus(patch) {
  try {
    writeFileSync(QR_STATUS_PATH, JSON.stringify({ ...patch, at: Date.now() }));
  } catch {
    /* 状态文件仅用于展示，失败不影响登录 */
  }
}

async function fetchQr(page) {
  return page
    .evaluate(async () => {
      const r = await fetch("/authui/qrcode", { credentials: "include", cache: "no-store" });
      return r.json();
    })
    .catch((err) => {
      log("获取二维码失败：", err?.message || err);
      return null;
    });
}

async function pollStatus(page, clientKey) {
  return page
    .evaluate(
      async ({ clientKey, service }) => {
        const qs = new URLSearchParams({ client_key: clientKey, service });
        const r = await fetch("/authui/qrcode/status?" + qs.toString(), {
          credentials: "include",
          cache: "no-store",
        });
        return r.json();
      },
      { clientKey, service: SERVICE }
    )
    .catch(() => ({}));
}

async function showQr(page, dataUrl) {
  await page.evaluate((dataUrl) => {
    let ov = document.getElementById("__qr_overlay");
    if (!ov) {
      ov = document.createElement("div");
      ov.id = "__qr_overlay";
      ov.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:2147483647",
        "background:#fff",
        "display:flex",
        "flex-direction:column",
        "align-items:center",
        "justify-content:center",
        "font-family:sans-serif",
        "text-align:center",
      ].join(";");
      document.body.appendChild(ov);
    }
    ov.replaceChildren();
    const h = document.createElement("h2");
    h.textContent = "请用「华为云」APP 扫码登录";
    h.style.cssText = "margin:0 0 16px;color:#252b3a;font-weight:600";
    const img = document.createElement("img");
    img.src = dataUrl;
    img.style.cssText = "width:420px;height:420px;border:1px solid #eceff5;border-radius:10px";
    const tip = document.createElement("p");
    tip.textContent = "扫码后在手机上点击「确认登录」，本页会自动完成登录";
    tip.style.cssText = "color:#666;margin-top:14px;font-size:15px";
    ov.append(h, img, tip);
  }, dataUrl);
}

async function main() {
  ensureStorageDir();
  // 优先使用系统安装的真实 Chrome（指纹更接近普通用户，规避风控）；
  // 未安装时回退到 Playwright 自带 chromium。
  let browser;
  try {
    browser = await chromium.launch({ headless: false, channel: "chrome", args: ["--start-maximized"] });
    log("已使用系统 Google Chrome 启动");
  } catch {
    browser = await chromium.launch({ headless: false, args: ["--start-maximized"] });
    log("已使用 Playwright Chromium 启动");
  }
  const context = await browser.newContext({ viewport: null, locale: "zh-CN" });
  const page = await context.newPage();

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(3000);

  let done = false;
  for (let round = 1; round <= MAX_QR_ROUNDS && !done; round++) {
    const qr = await fetchQr(page);
    if (!qr?.client_key || !qr?.qrcode_content) {
      log("二维码接口返回异常，稍后重试…");
      await page.waitForTimeout(5000);
      continue;
    }

    log(`第 ${round} 轮二维码已生成`);
    log("二维码内容:", qr.qrcode_content);

    const png = await QRCode.toBuffer(qr.qrcode_content, { width: 512, margin: 1 });
    try {
      writeFileSync(QR_PNG_PATH, png);
    } catch (e) {
      log("写 PNG 失败(不影响扫码):", e.message);
    }
    writeStatus({ status: "waiting", round });
    await showQr(page, "data:image/png;base64," + png.toString("base64"));

    let scanned = false;
    for (let i = 0; i < POLL_ROUNDS && !done; i++) {
      await page.waitForTimeout(POLL_INTERVAL_MS);
      const st = await pollStatus(page, qr.client_key);

      if (st?.status === "authorized" && st.redirect_url) {
        writeStatus({ status: "confirmed" });
        log("手机已确认，正在完成登录跳转…");
        await page
          .goto(st.redirect_url, { waitUntil: "domcontentloaded", timeout: 90000 })
          .catch((e) => log("跳转异常：", e.message));
        await page.waitForTimeout(4000);
        await page.goto(SERVICE, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
        await page.waitForTimeout(4000);
        await saveAuthState(context, AUTH_FILE);
        try {
          chmodSync(AUTH_FILE, 0o600);
        } catch {}
        const body = await page.innerText("body").catch(() => "");
        const ok = body.includes("我的积分") || body.includes("积分明细");
        writeStatus({ status: "done", ok });
        log(`AUTH_SAVED 登录态已保存 ok=${ok} url=${page.url()}`);
        done = true;
        break;
      }

      if (st?.status === "expired") {
        writeStatus({ status: "expired" });
        log("二维码已过期，自动重新生成…");
        break;
      }
      if (st?.status === "authorizing") {
        if (!scanned) {
          scanned = true;
          writeStatus({ status: "scanned" });
          log("已扫描，等待手机点击「确认登录」…");
          await page
            .evaluate(() => {
              const p = document.querySelector("#__qr_overlay p");
              if (p) p.textContent = "已扫描，请在手机上点击「确认」";
            })
            .catch(() => {});
        }
      } else if (st?.error_code) {
        log("扫码接口返回错误：", JSON.stringify(st));
      } else if (i % 15 === 0) {
        log("等待扫码…（二维码过期会自动刷新）");
      }
    }
  }

  if (!done) log("QR_TIMEOUT 有效期内未完成扫码。窗口保持打开 60 分钟，可重新运行本脚本。");
  else log("登录成功。窗口保持打开 60 分钟，可随时查看。");
  await page.waitForTimeout(60 * 60 * 1000).catch(() => {});
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
