#!/usr/bin/env node
/**
 * 用 Playwright 直接操作华为云社区发文页发布文章（不依赖码道 TUI）
 *
 * 为什么不用 TUI：
 *   码道套餐流量耗尽时，TUI 的 --prompt 不会报错，只会静默卡到超时，
 *   「每日发布文章 +60」直接失败。这个脚本用本地模板生成正文，再用浏览器
 *   按页面真实交互填标题、正文、勾免责声明、点发表，全程不依赖外部模型。
 *
 * 页面实测结构（2026-10，http://bbs.huaweicloud.com/blogs/article）：
 *   标题   input#blogTitle（placeholder「请输入标题」）
 *   正文   TinyMCE，内容在 iframe.tox-edit-area__iframe 的 body 里
 *   评论   label#commentLablel（toggle，内含隐藏 input#commentType）
 *   声明   span#agreementBox（点击后加 class=checked，不勾则发表按钮禁用）
 *   产品   li.product-item（选完要收起浮层，否则挡住按钮）
 *   发表   a#submit-btn（带 -no 类时表示禁用）
 *
 * 用法：
 *   node scripts/article-publish.mjs                 # 生成并发布今天主题的文章
 *   node scripts/article-publish.mjs --dry-run       # 只生成正文，不打开浏览器
 *   ARTICLE_TOPIC=xxx node scripts/article-publish.mjs
 *
 * 环境变量：
 *   ARTICLE_TOPIC   指定标题
 *   ARTICLE_VARIANT 素材偏移（多账号同日发，换一套素材避免雷同）
 *   ARTICLE_HEADLESS=0 显示浏览器（调试用）
 */
import { resolveAccountId } from "./accounts.mjs";
import { authPathsFor } from "./auth-path.mjs";
import { buildArticle, countChars } from "./article-content.mjs";

const ACCOUNT_ID = resolveAccountId(process.env.HWCLOUD_ACCOUNT);
const DRY_RUN = process.argv.includes("--dry-run");
const HEADLESS = process.env.ARTICLE_HEADLESS !== "0";

const PAGE_URL = "https://bbs.huaweicloud.com/blogs/article";

const TOPICS = [
  "如何用 Playwright 稳定地做企业控制台自动化",
  "TUI 应用在非交互环境下的自动化实践",
  "多账号系统的凭据隔离与文件锁设计",
  "用 Node.js 做浏览器自动化任务调度时的踩坑记录",
  "把重复的日常运营任务交给脚本：我的经验",
  "前端状态持久化的几种方案对比",
  "如何给自动化脚本加可靠的失败重试与断点续跑",
  "云服务积分任务的自动化边界在哪里",
  "systemd 托管 Node 脚本的实践要点",
  "从零搭一个轻量看板：数据采集与展示",
];

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

/** 按今年第几天取主题，同一天多次调用得到同一主题 */
function pickTopic() {
  if (process.env.ARTICLE_TOPIC) return process.env.ARTICLE_TOPIC;
  const now = new Date();
  const dayOfYear = Math.floor(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
      Date.UTC(now.getFullYear(), 0, 0)) /
      86400000,
  );
  return TOPICS[dayOfYear % TOPICS.length];
}

/** 把 Markdown 转成简单 HTML（TinyMCE 接受设置 innerHTML） */
function markdownToHtml(md) {
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const out = [];
  const lines = String(md).split("\n");
  let inCode = false;
  let codeBuf = [];

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^```/.test(line)) {
      if (inCode) {
        out.push(
          `<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`,
        );
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }
    if (!line.trim()) continue;

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lv = Math.min(h[1].length + 1, 6);
      out.push(`<h${lv}>${esc(h[2])}</h${lv}>`);
      continue;
    }
    const ol = line.match(/^(\d+)\.\s+(.*)$/);
    if (ol) {
      out.push(`<p>${ol[1]}. ${esc(ol[2])}</p>`);
      continue;
    }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) {
      out.push(`<p>· ${esc(ul[1])}</p>`);
      continue;
    }
    out.push(`<p>${esc(line)}</p>`);
  }
  if (inCode && codeBuf.length) {
    out.push(`<pre><code>${esc(codeBuf.join("\n"))}</code></pre>`);
  }
  return out.join("\n");
}

/** 发布主流程 */
async function publish(browser, ctx, article) {
  const page = await ctx.newPage();
  log(`打开发文页 ${PAGE_URL}`);
  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector("#blogTitle", { timeout: 60000 });
  await page.waitForTimeout(3000);

  // ---- 1. 标题 ----
  await page.fill("#blogTitle", article.title);
  log(`标题已填: ${article.title}`);

  // ---- 2. 正文（TinyMCE iframe）----
  const html = markdownToHtml(article.body);
  const editor = page.frameLocator("iframe.tox-edit-area__iframe").locator("body");
  await editor.waitFor({ timeout: 30000 });
  await editor.evaluate((body, h) => {
    body.innerHTML = h;
    // 触发 input 让编辑器同步内容
    body.dispatchEvent(new Event("input", { bubbles: true }));
  }, html);
  await page.waitForTimeout(1500);
  log(`正文已填（${countChars(article.body)} 字）`);

  // ---- 3. 「文章不需要评论」toggle：先读状态，不勾就点 ----
  const commentToggled = await page.evaluate(() => {
    const el = document.querySelector("#commentLablel");
    if (!el) return null;
    return el.classList.contains("checked");
  });
  if (commentToggled === false) {
    await page.click("#commentLablel");
    await page.waitForTimeout(300);
    log("已勾选「文章不需要评论」");
  } else if (commentToggled === true) {
    log("「文章不需要评论」已是勾选状态");
  } else {
    log("未找到评论 toggle，跳过");
  }

  // ---- 4. 产品标签 ----
  try {
    const tagOpened = await page.evaluate(() => {
      const btn = document.querySelector(".tagator, .add-tag, .product-tag-add");
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (tagOpened) {
      await page.waitForTimeout(800);
    }
    const clicked = await page.evaluate(() => {
      const items = [...document.querySelectorAll("li.product-item")];
      // 优先选跟正文主题相关的标签
      const prefer = ["Playwright", "Node.js", "JavaScript", "自动化", "云原生"];
      for (const p of prefer) {
        const hit = items.find(
          (li) => li.textContent && li.textContent.includes(p),
        );
        if (hit) {
          hit.click();
          return p;
        }
      }
      if (items[0]) {
        items[0].click();
        return items[0].textContent.trim().slice(0, 20);
      }
      return null;
    });
    log(`产品标签: ${clicked || "未选中"}`);
    await page.waitForTimeout(500);
    // 选完收起浮层，否则会挡住发表按钮
    await page.keyboard.press("Escape").catch(() => {});
    await page.mouse.click(20, 20).catch(() => {});
    await page.waitForTimeout(500);
  } catch (e) {
    log(`产品标签处理失败（不阻塞）: ${e.message}`);
  }

  // ---- 5. 免责声明（不勾则发表按钮禁用）----
  const agreed0 = await page.evaluate(() => {
    const el = document.querySelector("#agreementBox");
    return el ? el.classList.contains("checked") : null;
  });
  if (agreed0 === false) {
    await page.click("#agreementBox");
    await page.waitForTimeout(600);
  }
  const agreed1 = await page.evaluate(() => {
    const el = document.querySelector("#agreementBox");
    return el ? el.classList.contains("checked") : null;
  });
  log(`免责声明状态: ${agreed0} -> ${agreed1}`);
  if (agreed1 !== true) {
    throw new Error("免责声明未能勾选，发表按钮会保持禁用");
  }

  // ---- 6. 发表 ----
  await page.waitForTimeout(1000);
  const disabled = await page.evaluate(() => {
    const btn = document.querySelector("a#submit-btn");
    if (!btn) return "missing";
    return btn.classList.contains("write-blog-publish-btn-no") ||
      btn.classList.contains("-no")
      ? "disabled"
      : "enabled";
  });
  log(`发表按钮状态: ${disabled}`);
  if (disabled === "disabled") {
    throw new Error("发表按钮仍为禁用状态");
  }

  await page.click("a#submit-btn");
  log("已点击发表，等待跳转…");

  // 发表成功会跳到文章详情页 /blogs/<id>，或跳到发布完成页 processcomplete?type=blog
  const DONE_URL = /bbs\.huaweicloud\.com\/blogs\/\d+|processcomplete\?type=blog/;
  try {
    await page.waitForURL(DONE_URL, { timeout: 60000 });
  } catch {
    await page.waitForTimeout(8000);
  }
  const finalUrl = page.url();
  const m = finalUrl.match(/\/blogs\/(\d+)/);
  if (m) {
    log(`✅ 发表成功: ${finalUrl}`);
    return { ok: true, url: finalUrl, blogId: m[1], title: article.title };
  }
  if (/processcomplete\?type=blog/.test(finalUrl)) {
    log(`✅ 已提交（跳转发布完成页）: ${finalUrl}`);
    return { ok: true, url: finalUrl, blogId: null, title: article.title };
  }
  // 没跳转也不一定失败，截图留证
  await page.screenshot({ path: `/tmp/article-fail-${ACCOUNT_ID}.png` }).catch(() => {});
  return { ok: false, url: finalUrl, title: article.title };
}

async function main() {
  log(`===== 直接发布文章（账号 ${ACCOUNT_ID}）=====`);
  const topic = pickTopic();
  const variant = Number(process.env.ARTICLE_VARIANT || 0);
  const article = buildArticle(topic, { variant });
  log(`标题: ${article.title}`);
  log(`正文字数: ${countChars(article.body)}`);

  if (DRY_RUN) {
    log("【dry-run】不打开浏览器。正文预览：");
    console.log("\n" + article.body.slice(0, 600) + "\n…");
    return;
  }

  const { chromium } = await import("playwright");
  const paths = authPathsFor(ACCOUNT_ID);
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-features=NetworkServiceInProcess,NetworkChangeNotifier", "--disable-background-networking", "--disable-component-update", "--no-first-run"],
  });
  try {
    const ctx = await browser.newContext({
      storageState: paths.authFile,
      locale: "zh-CN",
      viewport: { width: 1440, height: 1000 },
    });
    const r = await publish(browser, ctx, article);
    if (!r.ok) {
      log(`❌ 未能确认发表成功，当前 URL: ${r.url}`);
      process.exit(1);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("发布失败:", e.message);
  process.exit(1);
});
