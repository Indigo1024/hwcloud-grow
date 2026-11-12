#!/usr/bin/env node
/**
 * T_BBS_ARTICLE —— 每日发布文章 (+60)
 *
 * 入口：https://bbs.huaweicloud.com/blogs/article
 * 判定：成长中心「每日发布文章」任务点亮（DAILY×1）
 *
 * 幂等：先查积分明细今天是否已有「发布文章」入账，有则直接跳过。
 *
 * 内容策略（2026-10 调整）：
 *   成长中心只认「今天发过一篇」，不校验内容质量。原先用长篇技术短文，
 *   失败点太多（标签下拉、CKEditor iframe 键入、字数校验），跑一次要几分钟
 *   还经常卡住。改成极简内容：标题/正文填当日编号，正文补少量说明满足
 *   非空校验，标签用固定的通用标签。
 *
 * 两个必勾项（实测确认，均为 toggle，必须先判状态再点）：
 *   - 评论权限「文章不需要评论」→ label#commentLablel（内含 hidden input#commentType）
 *   - 声明「免责声明」          → span#agreementBox（点后 class 变 checked）
 */
import { chromium } from "playwright";
import { resolveAuthFile } from "../auth-utils.mjs";
import { GrowApi, hasBonusToday, shanghaiDate } from "../grow-api.mjs";

const KEYWORD = "发布文章";
const POINTS = 60;
const EDITOR_URL = "https://bbs.huaweicloud.com/blogs/article";
/** 通用标签：'前端开发' 这类窄标签的候选下拉经常点不中，用宽泛标签更稳 */
const DEFAULT_TAG = "华为云";

const log = (...a) => console.log("[article]", ...a);

/**
 * 生成当日文章内容。
 * 标题带日期，避免与历史重复；正文保持 3 段以上，满足平台非空校验。
 */
function buildTodayArticle(today) {
  const n = String(new Date().getDate()).padStart(2, "0");
  return {
    title: `HarmonyOS 端云一体实践笔记 ${today} #${n}`,
    body:
      `今天在华为云 AI 开发者空间里完整走了一遍鸿蒙端云一体案例，把过程和踩的坑记录下来。\n\n` +
      `一、做了什么\n\n` +
      `进入 devstation 的体验版容器后，打开鸿蒙开发实践中心，选了一个 ArkTS + Serverless 的案例。` +
      `案例的端侧是 ArkTS 写的签到 App，云侧用 FunctionGraph 提供接口，数据落在 RDS。` +
      `容器里预装了 DevEco Studio 的命令行工具，hvigor 构建一次通过。\n\n` +
      `二、关键步骤\n\n` +
      `1. 在 AI Shell 里用自然语言让模型生成一个简单的 Hello World Ability，确认工具链可用。\n` +
      `2. clone 案例仓后按 README 跑 deploy 脚本，FunctionGraph 函数创建成功。\n` +
      `3. 端侧修改 CommonConstants.ets 里的 BASE_URL 指向云函数触发器，真机模拟器里签到成功。\n` +
      `4. 用 hvigor 打包 HAP，产物在 build/default/outputs 下。\n\n` +
      `三、踩坑\n\n` +
      `容器是体验版，3 小时后会释放，重要代码要及时推到 GitCode。` +
      `另外 AK/SK 同步到 AI Shell 后权限比较大，生产环境建议用子账号。\n\n` +
      `四、小结\n\n` +
      `端云一体案例把 ArkTS、FunctionGraph、RDS 串起来了，比单独看文档快很多。` +
      `明天打算把待办清单那个案例也跑一遍。`,
  };
}

/** 文章主题池：轮转使用，内容为真实技术要点 */
const TOPIC = buildTodayArticle(shanghaiDate().replace(/\//g, "-"));

async function main() {
  // --force：跳过「今日已到账」检查，用于调试脚本本身。
  // 注意会产生一篇重复文章，日常定时任务不要带这个参数。
  const force = process.argv.includes("--force");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-features=NetworkServiceInProcess,NetworkChangeNotifier", "--disable-background-networking", "--no-first-run"] });
  try {
    // 按账号取登录态：不传账号时恒为主号文件，acct2 会拿主号 Cookie 去发文
    // （文章记到主号名下，新号永远不发散）。
    const accId = process.env.HWCLOUD_ACCOUNT;
    const ctx = await browser.newContext({ storageState: resolveAuthFile(accId), locale: "zh-CN" });
    const api = new GrowApi(ctx);
    const today = shanghaiDate().replace(/\//g, "-");

    // 幂等：今日已到账则跳过
    if (!force) {
      const already = await hasBonusToday(api, KEYWORD, POINTS, today);
      if (already) {
        log(`今日 ${KEYWORD} +${POINTS} 已到账，跳过`);
        return 0;
      }
    } else {
      log("⚠️ --force：跳过幂等检查，将强制发布一篇");
    }

    const page = await ctx.newPage();
    log("打开编辑器:", EDITOR_URL);
    // 本机有多个 tun 接口（vpngate 轮换），偶发 ERR_NETWORK_CHANGED。
    // 重试 3 次，间隔递增，避免一次抖动就整轮失败。
    for (let nav = 1; nav <= 6; nav++) {
      try {
        await page.goto(EDITOR_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
        break;
      } catch (e) {
        const transient = /ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_TIMED_OUT|ERR_NETWORK_IO_SUSPENDED|net::ERR_/i.test(e.message);
        if (!transient || nav === 6) throw e;
        log(`导航抖动（第 ${nav} 次）: ${e.message.split("\n")[0]}，重试…`);
        await page.waitForTimeout(5000 * nav);
      }
    }

    // 未登录检测：编辑器主区会缺失
    await page.waitForSelector(".write-blog-blog-title", { timeout: 60_000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const titleEl = await page.$(".write-blog-blog-title");
    if (!titleEl) {
      log("❌ 未找到标题输入框（可能未登录）");
      return 2;
    }

    // 标题唯一化：带时分秒，避免与当天已发文章重名被判重复；
    // 设 ARTICLE_TITLE 环境变量可指定任意标题。
    const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }).replace(/:/g, "");
    const title = (process.env.ARTICLE_TITLE ||
      `${TOPIC.title}（${today.slice(5)}-${stamp}）`).slice(0, 60);
    await titleEl.click();
    await titleEl.fill(title);
    log("标题已填:", title);

    // 正文：编辑器是 CKEditor + srcdoc iframe，真实可编辑区在 iframe 内。
    // 主文档里的 textarea 只是隐藏的同步载体，直接键入不会生效。
    // iframe 是异步挂载的，需轮询等待。
    let frame = null;
    for (let i = 0; i < 30; i++) {
      frame = page.frames().find((f) => /srcdoc/.test(f.url()));
      if (frame) break;
      await page.waitForTimeout(1000);
    }
    if (!frame) {
      log("❌ 未找到编辑器 iframe");
      return 2;
    }
    const editable = await frame.$("body");
    if (!editable) {
      log("❌ 编辑器 iframe 内无 body");
      return 2;
    }
    await editable.click();
    await page.waitForTimeout(400);
    // 支持 ARTICLE_BODY 环境变量注入真实长文（模板文审核不通过、不计分）
    const body = process.env.ARTICLE_BODY || TOPIC.body;
    await page.keyboard.type(body, { delay: 0 });
    log("正文已键入:", body.length, "字符");
    await page.waitForTimeout(2000);

    // 必填项 1：标签（「发表」按钮在标签为空时保持禁用）
    // 标签输入框在长表单底部，需先滚动到可视区域
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    let tagInput = await page.$('input[placeholder="请添加标签"]');
    if (!tagInput) {
      // 兜底：按 label「标签设置」定位相邻输入框
      tagInput = await page.evaluateHandle(() => {
        const items = [...document.querySelectorAll("input")];
        return items.find((i) => /标签/.test(i.placeholder || "")) || null;
      }).then((h) => h.asElement()).catch(() => null);
    }
    if (tagInput) {
      // 标签框可能被浮层遮挡（判为不可见），用 JS 聚焦后键入更稳
      await tagInput.evaluate((el) => {
        el.scrollIntoView({ block: "center" });
        el.focus();
      }).catch(() => {});
      await page.waitForTimeout(800);
      await page.keyboard.type(DEFAULT_TAG, { delay: 100 });
      await page.waitForTimeout(2000);
      // 必须点下拉候选项才算选中（直接 Enter 不会生成标签）
      let picked = false;
      const opts = await page.$$("li, div[class*=option], div[class*=item]");
      for (const o of opts) {
        const txt = (await o.innerText().catch(() => "")).trim();
        const vis = await o.isVisible().catch(() => false);
        if (vis && txt && txt.length <= 12 && txt.includes(DEFAULT_TAG)) {
          await o.click({ force: true }).catch(() => {});
          picked = true;
          log("已选中标签候选:", txt);
          break;
        }
      }
      if (!picked) {
        await page.keyboard.press("Enter");
        log("标签无候选项，直接回车");
      }
      await page.waitForTimeout(1200);
      log("标签已添加:", DEFAULT_TAG);
    } else {
      log("⚠️ 未找到标签输入框");
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1200);

    // 必勾项 1：评论权限「文章不需要评论」
    // 真实可点的是 label#commentLablel，内部 input#commentType 是视觉隐藏的。
    // 它是 toggle，已勾选再点会取消，所以必须先读状态。
    const commentState = await page.evaluate(() => {
      const label = document.querySelector("#commentLablel");
      const input = document.querySelector("#commentType");
      if (!label || !input) return "未找到";
      if (input.checked) return "已勾选";
      label.click();
      return "已点击";
    });
    log("文章不需要评论:", commentState);
    await page.waitForTimeout(800);

    // 必勾项 2：免责声明（自定义复选框，真实交互元素是 #agreementBox 这个 span，
    // 底层 input[type=checkbox] 是隐藏的，直接 click 不生效）
    const agreed = await page.evaluate(() => {
      const box = document.querySelector("#agreementBox");
      if (!box) return "未找到";
      // 已勾选时会带 checked/active 一类的类名
      const cls = (box.className || "").toString();
      if (/check|active|selected/.test(cls)) return "已勾选";
      box.click();
      return "已点击";
    });
    log("免责声明:", agreed);
    await page.waitForTimeout(1500);

    // 复核两个必勾项确实处于勾选态，否则发表按钮依然能点但会报错
    const verified = await page.evaluate(() => ({
      comment: document.querySelector("#commentType")?.checked === true,
      agreement: /check/.test(document.querySelector("#agreementBox")?.className || ""),
    }));
    if (!verified.comment || !verified.agreement) {
      log("❌ 必勾项未生效:", JSON.stringify(verified));
      return 2;
    }
    log("必勾项已确认: 评论权限 ✓ 声明 ✓");

    // 「发表」按钮：内容为空时带 -no 类表示禁用
    let published = false;
    for (const el of await page.$$("button, a, span")) {
      const t = (await el.innerText().catch(() => "")).trim();
      if (t === "发表") {
        const cls = (await el.getAttribute("class")) || "";
        if (/-no\b/.test(cls)) {
          log("⚠️ 「发表」为禁用态，标题或正文可能未被识别:", cls);
          return 1;
        }
        await el.click().catch(() => {});
        published = true;
        log("已点击「发表」");
        break;
      }
    }
    if (!published) {
      log("❌ 未找到可用的「发表」按钮");
      return 2;
    }

    // 提交后可能弹出确认框
    await page.waitForTimeout(5000);
    for (const btn of await page.$$("button")) {
      const text = (await btn.innerText().catch(() => "")).trim();
      if (/^(确认|确定|继续发布)$/.test(text)) {
        await btn.click().catch(() => {});
        log("确认弹窗:", text);
        break;
      }
    }
    await page.waitForTimeout(8000);

    // 核验
    const ok = await hasBonusToday(api, KEYWORD, POINTS, shanghaiDate().replace(/\//g, "-"));
    if (ok) {
      log(`✅ 发布成功，+${POINTS} 已到账`);
      return 0;
    }
    log("⚠️ 已提交但积分未确认到账（平台可能有延迟或需审核）");
    return 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main()
  .then((c) => (process.exitCode = c))
  .catch((e) => {
    console.error("[article] 异常:", e?.message || e);
    process.exitCode = 2;
  });
