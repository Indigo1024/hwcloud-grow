#!/usr/bin/env node
/**
 * 每日提交建议（成长中心「提交建议」+30）
 *
 * 入口：https://bbs.huaweicloud.com/suggestion/new
 * 表单结构（2026-10 实测）：
 *   - 标题：input.input-title，placeholder「请一句话描述您的建议」
 *   - 正文：TinyMCE，真实输入区在 iframe#editor_ifr 的 body（contenteditable=true），
 *     字数要求 10~2000（右下角字数器显示 10/2000）
 *   - 标签：input.tagator_input，最多 5 个，回车加入
 *   - 提交：div.submit-block.btn-block（文案「提交建议」）
 *
 * 判定：成长中心任务「提交建议」is_finish 由服务端评估（2 个工作日内），
 * 因此本脚本只负责「成功提交」，到账由 GrowApi.myMissions 事后核验。
 */
import { GrowApi } from "../../scripts/grow-api.mjs";

const SUGGEST_URL = "https://bbs.huaweicloud.com/suggestion/new";

/** 建议内容池：技术向、具体可执行，避免像模板灌水被判定无效 */
const POOL = [
  {
    title: "建议成长中心的任务状态支持实时刷新",
    body:
      "场景描述：完成每日任务后，成长中心的任务卡片往往需要手动刷新页面才会更新为「已完成」，有时要等几分钟。\n\n" +
      "建议方案：在任务列表接口返回后增加轮询刷新（例如每 30 秒一次），或在页面重新获得焦点时自动拉取最新状态；" +
      "同时在任务卡片上显示「最近更新时间」，让用户能判断当前状态是否为最新。这样能减少用户反复刷新页面确认进度的情况。",
    tags: ["函数工作流 FunctionGraph", "对象存储服务 OBS"],
  },
  {
    title: "建议积分明细增加按任务类型筛选",
    body:
      "场景描述：积分明细目前是一整条时间流水，任务多的时候很难快速确认某个具体任务（例如每日发布文章）是否已经计分。\n\n" +
      "建议方案：在积分明细弹窗中增加按来源筛选的下拉框，支持按「签到 / 每日任务 / 每周任务 / 活动」分类查看；" +
      "并支持按时间区间过滤，方便用户核对某一周或某一天的积分入账情况。",
    tags: ["云数据库 RDS for MariaDB", "弹性云服务器 ECS"],
  },
  {
    title: "建议未完成的任务提供一键跳转入口",
    body:
      "场景描述：成长中心里部分任务（例如实践实验、微认证、体验开发者空间）需要跳到其他站点完成，" +
      "但任务卡片上没有明确入口，用户需要自己搜索，路径较长容易放弃。\n\n" +
      "建议方案：在每个任务卡片的操作按钮中直接给出目标页面链接，并在跳转时携带来源标识，" +
      "便于完成后自动关联任务状态；对于需要多次访问的任务，可增加进度提示（例如已完成 1/2 步）。",
    tags: ["云容器引擎 CCE", "云备份 CBR"],
  },
];

/** 按日期取一条，保证同一天重复跑用同一条（避免一天刷多条） */
function pickToday() {
  const day = Math.floor(Date.now() / 86_400_000);
  return POOL[day % POOL.length];
}

/**
 * @param {import('playwright').Page} page 已登录的页面
 * @param {{dryRun?: boolean}} [opts]
 */
export async function runSuggestionTask(page, { dryRun = false } = {}) {
  const item = pickToday();

  await page.goto(SUGGEST_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.locator("input.input-title").first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(2500);

  if (dryRun) {
    return { ok: true, dryRun: true, detail: `[试运行] 将提交：${item.title}` };
  }

  // 标题
  const titleEl = page.locator("input.input-title").first();
  await titleEl.click({ timeout: 10_000 });
  await titleEl.fill(item.title.slice(0, 60));

  // 正文：TinyMCE 的真实输入区在 iframe#editor_ifr 的 body
  const frame = await waitEditorFrame(page);
  if (!frame) {
    return { ok: false, detail: "未找到编辑器 iframe#editor_ifr" };
  }
  await frame.click("body");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await frame.type("body", item.body, { delay: 8 });
  await page.waitForTimeout(800);

  const bodyLen = await frame.evaluate(() => (document.body.innerText || "").trim().length);
  if (bodyLen < 10) {
    return { ok: false, detail: `正文过短（${bodyLen} 字），需 ≥10 字` };
  }

  // 标签（关联产品/功能，页面标为必填 *）：
  // 点输入框会展开 .tagator_options 面板，候选项是 li.tagator_option，
  // 直接点候选项即可选中（注意：直接敲字后回车只会让 tagator_options 收起，
  // 并不产生标签，所以必须以「点候选项」为准）。
  const tagInput = page.locator("input.tagator_input").first();
  await tagInput.click({ timeout: 10_000 });
  await page.waitForTimeout(2500);

  const picked = [];
  for (const tag of item.tags.slice(0, 5)) {
    // 真实可点的产品项是 li.product-item（在 .more-block-cover.show-more-block 浮层里）；
    // .tagator_options li.tagator_option 那一组是 display:none 的隐藏备份，点它无效。
    const idx = await page.evaluate((kw) => {
      const items = [...document.querySelectorAll("li.product-item")];
      const norm = (s) => (s || "").replace(/\s+/g, "").toLowerCase();
      const k = norm(kw);
      return items.findIndex((e) => norm(e.textContent).includes(k));
    }, tag);

    if (idx < 0) continue;
    const option = page.locator("li.product-item").nth(idx);
    await option.scrollIntoViewIfNeeded().catch(() => {});
    await option.click({ timeout: 8000 }).catch(() => {});
    picked.push(tag);
    await page.waitForTimeout(1200);
    // 选完面板会收起，重新点开继续选下一个
    if (await page.locator("input.tagator_input").first().isVisible().catch(() => false)) {
      await page.locator("input.tagator_input").first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(1200);
    }
  }
  // 收起面板：选完产品后浮层不会自动关闭，会一直遮住提交按钮。
  // 点浮层右上角的 X（或按 Esc）收起。
  const cover = page.locator(".more-block-cover.show-more-block").first();
  if ((await cover.count().catch(() => 0)) > 0) {
    const closeBtn = cover.locator("[class*=close], i, span").filter({ hasText: /^$/ }).first();
    // 优先点明确的关闭图标
    const x = page
      .locator(".more-block-cover [class*=close], .more-block-cover .icon-close, .more-block-cover i")
      .first();
    if ((await x.count().catch(() => 0)) > 0) {
      await x.click({ timeout: 5000 }).catch(() => {});
    } else {
      await closeBtn.click({ timeout: 3000 }).catch(() => {});
    }
    await page.waitForTimeout(800);
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(800);
  // 兜底：点空白处让浮层失焦收起
  if ((await cover.count().catch(() => 0)) > 0) {
    const vis = await cover.isVisible().catch(() => false);
    if (vis) {
      await page.mouse.click(20, 400).catch(() => {});
      await page.waitForTimeout(800);
    }
  }

  if (picked.length === 0) {
    return { ok: false, detail: "未能选中「关联产品/功能」（必填项），请检查候选文本" };
  }

  // 勾选「已知晓建议内容将会被公开，且未提交敏感信息」。
  // 真实结构：<div class="agreement-block"><span id="agreementBox"></span><p>文案</p></div>
  // span#agreementBox 是自定义复选框外壳，内部没有真实 input；
  // 不点它，「提交建议」按钮一直保持灰色禁用态（与发文章页的免责声明同一套组件）。
  const beforeCls = await page
    .locator("#agreementBox")
    .first()
    .getAttribute("class")
    .catch(() => "");
  await page.locator("#agreementBox").first().click({ timeout: 8000 }).catch(async () => {
    // 不可点击时直接用 JS 触发
    await page.evaluate(() => document.querySelector("#agreementBox")?.click());
  });
  await page.waitForTimeout(1200);
  const afterCls = await page
    .locator("#agreementBox")
    .first()
    .getAttribute("class")
    .catch(() => "");
  if (beforeCls === afterCls) {
    // 二次确认：文案行也点一下
    await page.evaluate(() => {
      document.querySelector(".agreement-block p")?.click();
      document.querySelector("#agreementBox")?.click();
    });
    await page.waitForTimeout(1000);
  }
  // 提交：真实按钮是 span#submit-btn（外层 div.submit-block 只是容器，
  // 点容器没有任何反应）。禁用态时 span 上是 btn-no 之类的类。
  const submit = page.locator("#submit-btn").first();
  await submit.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(800);
  await submit.waitFor({ state: "visible", timeout: 10_000 });
  await submit.click({ timeout: 15_000 });

  // 等待跳转或成功提示
  await page.waitForTimeout(6000);
  for (const re of [/^(确定|确认|提交|继续提交)$/]) {
    const btn = page.getByRole("button", { name: re }).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(4000);
    }
  }

  const url = page.url();
  const text = await page.innerText("body").catch(() => "");
  const submitted = /suggestion\/\d+|感谢|提交成功|已提交/.test(url + text);
  if (!submitted) {
    return { ok: false, detail: `点击提交后未见成功标志（url=${url.slice(0, 80)}）` };
  }
  return { ok: true, detail: `已提交建议：${item.title}` };
}

/** 轮询等待 TinyMCE 的编辑 iframe（加载有延迟） */
async function waitEditorFrame(page, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const id = f.name() || "";
      if (id === "editor_ifr" || /editor_ifr/.test(f.url())) {
        return f;
      }
    }
    // frame name 可能为空，退回按元素句柄取
    const el = await page.$("iframe#editor_ifr");
    if (el) {
      const f = await el.contentFrame();
      if (f) return f;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

/** 核验成长中心「提交建议」任务是否已被标记完成 */
export async function checkSuggestionCredit(context, page) {
  const api = new GrowApi(context, { page });
  const m = await api.myMissions();
  if (m.error) return { error: m.error };
  const t = m.missions?.find((x) => /提交建议/.test(x.title));
  return { done: !!t?.isFinish, title: t?.title, bonus: t?.bonus };
}
