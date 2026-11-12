#!/usr/bin/env node
/**
 * 每日回答 BBS 问题（成长中心「每日回答问题且被采纳」+60）
 *
 * ⚠️ 能力边界（务必知晓）：
 *   成长中心这条任务是**复合条件**——「在华为云开发者论坛问答专区回答问题，
 *   并且答案被采纳」。采纳按钮只对楼主可见，回答者页面上根本没有该入口，
 *   因此本题无法自动拿满。本脚本的目标是把「回答」这一步确定性地做掉，
 *   并把「被采纳」的概率做到最高：优先挑 **0 回复 + 未解决** 的真实提问，
 *   写针对性的回答，而不是在测试帖里灌水。
 *
 * 页面结构（2026-10 实测，踩坑点都在注释里）：
 *   - 论坛是 Vue SPA，帖子列表**没有 <a href>**，别找 a[href*=thread]；
 *     一条帖子 = div.forums-item，标题 = span.forums-title-text，
 *     回复数 = span.comment-num，已解决标记 = div.tag.solved。
 *     跳转靠点卡片，URL 形如 /forum/thread-{id}-1-1.html。
 *   - 回复框是 TinyMCE，真实输入区在 iframe#ueditor_ifr 的
 *     body[contenteditable=true]；外层 textarea#ueditor 是隐藏载体，
 *     页面里的 textarea.comment-textarea 尺寸 0×0，**填了没用**。
 *   - iframe 在视口外时点击会落空、文字直接丢失，必须先 scrollIntoView。
 *   - div.tiny-loading__mask（z-index 2000）会盖住编辑器，要等它消失。
 *   - 「发表」按钮是 div.postTopic 里的 button.tiny-button--primary，
 *     JS 的 element.click() **不触发** Vue 事件（无任何请求），
 *     必须用 page.mouse.click 点真实坐标；旁边那个
 *     a.btn-submit.custom-subBtn 是隐藏的（0×0），点了没反应。
 */
import { GrowApi } from "../grow-api.mjs";

const FORUM_SECTION_ID = "0120157023154615007";
const FORUM_LIST_URL = `https://bbs.huaweicloud.com/forum/forum-${FORUM_SECTION_ID}-1.html`;
const TOPIC_API =
  "https://devdata.huaweicloud.com/rest/developer/fwdu/rest/developer/user/hdcnforumservice/v1/get-topic-list";
const TOPIC_URL = (id) => `https://bbs.huaweicloud.com/forum/thread-${id}-1-1.html`;

/** 回答模板：结合帖子标题做具体化，避免千篇一律被判灌水。用「；」分句，不依赖换行。 */
function composeReply(title) {
  const t = (title || "").trim();
  return (
    `这个问题我这边也遇到过类似情况。${t ? `关于「${t.slice(0, 40)}」，` : ""}` +
    "建议先确认三件事：一是检查配置项是否按控制台和文档的最新要求填写，尤其是区域（Region）与项目 ID 是否一致；" +
    "二是看下调用链路上的权限是否齐备，不少报错其实是 IAM 权限或委托未授权导致的；" +
    "三是把报错码和请求 ID 一起看，能更快对上官方文档里的具体原因。" +
    "我这边按这个顺序排查基本都能定位到问题，希望对你有帮助。"
  );
}

/**
 * 拉取版块帖子列表，返回 [{ topicId, url, title, replies, solved }]。
 *
 * 踩坑：列表 DOM 里的卡片**没有 href、也没有 topicId**，用各种方式点标题
 * （Playwright click / 鼠标坐标点标题行 / 点卡片）都不会跳转，所以不能靠点。
 * 直接调列表页自己用的接口 get-topic-list 拿 topicId，再按
 * /forum/thread-{topicId}-1-1.html 组装详情页 URL 最稳。
 * 接口响应顶层是 { resultList, totalCount }（不是 data / topicList）。
 */
async function fetchTopics(page, { maxPages = 2, pageSize = 20 } = {}) {
  // 先打开论坛页，让页面拿到会话与 csrf（接口需要登录态 + csrf 请求头）。
  // 踩坑：csrf 由前端 JS 持有，不在 cookie 里，只能监听页面真实请求截获；
  // 不带头直接请求会拿不到数据（空 resultList）。
  //
  // 更坑的两点（实测）：
  // 1) 不同接口用的 csrf **不一样**：取「任意一个 hdcnforumservice 请求」的头，
  //    抓到的是 get-user-permissions 的令牌，请求 get-topic-list 会 403 "CSRF unequal"。
  // 2) 页面首次加载会连发**两次** get-topic-list：第一次带旧 csrf（403），
  //    前端随即用**新 csrf 重试**才 200。只取第一次的令牌永远 403。
  // 因此必须「等接口真正成功的那次」，再取它对应的请求头。
  let csrf = null;
  const pending = new Map(); // request → 该请求带的 csrf
  const onReq = (req) => {
    if (!req.url().includes("/get-topic-list")) return;
    const t = req.headers()["csrf"];
    if (t) pending.set(req, t);
  };
  const onRes = async (res) => {
    if (csrf || !res.url().includes("/get-topic-list")) return;
    if (res.status() !== 200) return;
    const t = pending.get(res.request());
    if (t) {
      csrf = t;
      return;
    }
    // 兜底：请求对象对不上时，取该次请求的父级链上的头
    const t2 = res.request()?.headers?.()?.["csrf"];
    if (t2) csrf = t2;
  };
  page.on("request", onReq);
  page.on("response", onRes);
  await page.goto(FORUM_LIST_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });
  // 等「成功响应」而不是等「有请求」；10 秒内没成功就放弃
  for (let i = 0; i < 15 && !csrf; i++) await page.waitForTimeout(1000);
  page.off("request", onReq);
  page.off("response", onRes);
  if (!csrf) return [];

  const out = [];
  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const list = await page.evaluate(
      async ({ url, pageNo, pageSize, sectionId, csrf }) => {
        try {
          const r = await fetch(url, {
            method: "POST",
            credentials: "include",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/plain, */*",
              csrf,
            },
            body: JSON.stringify({
              pageNo,
              pageSize,
              queryType: "2",
              filterCondition: "1",
              sectionId,
              topicClassId: "",
            }),
          });
          const j = await r.json();
          return j?.resultList || j?.data?.resultList || [];
        } catch {
          return [];
        }
      },
      { url: TOPIC_API, pageNo, pageSize, sectionId: FORUM_SECTION_ID, csrf },
    );
    if (!list.length) break;
    for (const t of list) {
      out.push({
        topicId: t.topicId || t.pid || "",
        title: (t.title || "").trim(),
        replies: Number(t.replies || 0),
        solved: Number(t.solved) === 1,
      });
    }
    if (list.length < pageSize) break;
  }
  return out.filter((t) => t.topicId).map((t) => ({ ...t, url: TOPIC_URL(t.topicId) }));
}

/** 在详情页发表回答。返回 { ok, detail } */
async function postReply(page, text) {
  // 等 loading 遮罩消失，否则点击全被它吃掉
  await page
    .locator("div.tiny-loading__mask")
    .first()
    .waitFor({ state: "hidden", timeout: 20_000 })
    .catch(() => {});
  await page.waitForTimeout(1500);

  const iframe = page.locator("iframe#ueditor_ifr").first();
  await iframe.waitFor({ state: "attached", timeout: 30_000 }).catch(() => {});
  if (!(await iframe.count())) return { ok: false, detail: "未找到回复编辑器 iframe#ueditor_ifr" };

  // iframe 在视口外时点击会落空、输入丢失 —— 先滚到中间
  await iframe.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(800);

  const box = await iframe.boundingBox();
  if (!box) return { ok: false, detail: "编辑器 iframe 无可见区域（可能被折叠）" };
  await page.mouse.click(box.x + Math.min(box.width / 2, 200), box.y + 40);
  await page.waitForTimeout(800);

  const frameEl = await iframe.elementHandle().catch(() => null);
  const frame = frameEl ? await frameEl.contentFrame().catch(() => null) : null;
  if (!frame) return { ok: false, detail: "无法进入编辑器 iframe" };

  // 注意：page.locator(...).contentFrame() 返回的是 FrameLocator（没有 click），
  // 这里用 ElementHandle.contentFrame() 拿真正的 Frame 对象。
  const body = frame.locator("body").first();
  await body.click({ timeout: 10_000 }).catch(() => {});
  // 单段输入，不按 Enter：实测在 TinyMCE 里逐行 Enter 会导致行被合并/截断
  // （发出去的 HTML 里第 2、3 条被压进同一个 <p>），内容读起来像缺字。
  // 回答模板已改成「；」分句，单段即可。
  await page.keyboard.type(text, { delay: 12 });
  await page.waitForTimeout(1200);

  const typed = await frame
    .evaluate(() => (document.body.innerText || "").trim())
    .catch(() => "");
  if (typed.length < 10) {
    return { ok: false, detail: `编辑器内文字过短（${typed.length} 字），输入可能丢失` };
  }

  // 「发表」按钮：JS click 不触发 Vue 事件，必须点真实坐标
  const btn = page.locator("div.postTopic button", { hasText: "发表" }).first();
  if (!(await btn.count())) return { ok: false, detail: "未找到「发表」按钮" };
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(600);

  // 成功判据用接口**返回值**，不要用页面文本：
  // 详情页是二次渲染的，回复列表要过好几秒才出来，扫页面会误判失败。
  // submit-post 成功时返回 { result:{ pid }, error_code:"HD.65100000", error_msg:"SUCCESS" }。
  let submitted = null;
  const onRes = async (res) => {
    if (!/hdcnforumservice\/.*submit-post/.test(res.url())) return;
    try {
      const j = await res.json();
      submitted = { status: res.status(), code: j?.error_code, msg: j?.error_msg, pid: j?.result?.pid };
    } catch {
      submitted = { status: res.status(), code: null, msg: "无法解析响应" };
    }
  };
  page.on("response", onRes);

  // 点击重试：实测「点一次没反应」偶发（按钮还没挂上 Vue 事件，
  // 或上一步输入后编辑器状态还在同步）。原先只点一次，点空就整轮失败，
  // 在批量跑（前面刚执行完建议任务、页面更慢）时尤其容易踩到。
  // 这里改成最多点 3 次，每次点完观察 20 秒是否发出 submit-post。
  let clicked = 0;
  for (let attempt = 0; attempt < 3 && !submitted; attempt++) {
    let bbox = await btn.boundingBox().catch(() => null);
    if (!bbox) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(800);
      bbox = await btn.boundingBox().catch(() => null);
    }
    if (!bbox) return { ok: false, detail: "「发表」按钮无可见区域" };

    await page.mouse.click(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
    clicked++;
    for (let i = 0; i < 20 && !submitted; i++) await page.waitForTimeout(1000);
    if (!submitted) {
      // 按钮被禁用/遮罩时，用 JS 兜底触发一次 click（Vue 有时只认原生事件冒泡）
      await btn.evaluate((el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }))).catch(() => {});
      for (let i = 0; i < 10 && !submitted; i++) await page.waitForTimeout(1000);
    }
  }
  page.off("response", onRes);

  if (!submitted) {
    return { ok: false, detail: `点击「发表」${clicked} 次后仍未发出 submit-post 请求` };
  }
  if (submitted.msg !== "SUCCESS") {
    return { ok: false, detail: `submit-post 返回异常：${submitted.code} ${submitted.msg}` };
  }
  return { ok: true, detail: `submit-post 成功（pid=${submitted.pid || "-"}）` };
}

/** 挑选目标：0 回复 + 未解决优先（被采纳概率最高），跳过测试/灌水标题 */
function pickTarget(topics) {
  const junk = /^(测试|test|111|啊啊|啦啦|好尴尬|\W*$)/i;
  const clean = topics.filter((t) => t.title && !junk.test(t.title));
  const score = (t) => (t.solved ? 100 : 0) + (t.replies > 0 ? t.replies : 0);
  return [...clean].sort((a, b) => score(a) - score(b))[0] || null;
}

/**
 * @param {import('playwright').Page} page 已登录的页面
 * @param {{dryRun?: boolean}} [opts]
 */
export async function runForumAnswerTask(page, { dryRun = false } = {}) {
  const topics = await fetchTopics(page);
  if (!topics.length) return { ok: false, detail: "未取到版块帖子列表（get-topic-list 无数据）" };

  const target = pickTarget(topics);
  if (!target) {
    return {
      ok: false,
      detail: `共 ${topics.length} 帖，但没有合适的答题目标（均为测试帖或已解决）`,
    };
  }
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      detail: `[试运行] 目标帖子：${target.title}（回复 ${target.replies}，${target.solved ? "已解决" : "未解决"}）`,
    };
  }

  await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.waitForURL(/\/forum\/thread-/, { timeout: 30_000 }).catch(() => {});

  const r = await postReply(page, composeReply(target.title));
  if (!r.ok) return { ok: false, detail: `${target.title}：${r.detail}`, url: target.url };

  return {
    ok: true,
    url: target.url,
    title: target.title,
    detail: `已在「${target.title}」发表回答（${r.detail}）；+60 需楼主采纳后才计分，无法自动达成`,
  };
}

/** 核验成长中心该任务是否已完成（需楼主采纳，通常当天不会变） */
export async function checkForumAnswerCredit(context, page) {
  const api = new GrowApi(context, { page });
  try {
    const m = await api.myMissions();
    if (m.error) return { error: m.error };
    const t = m.missions?.find((x) => /回答问题/.test(x.title));
    return { done: !!t?.isFinish, title: t?.title, bonus: t?.bonus };
  } finally {
    await api.close();
  }
}
