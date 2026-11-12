#!/usr/bin/env node
/**
 * 成长中心 API 客户端（接口级，不爬页面）
 *
 * 接口来源：成长中心前端 bundle（HDGrowthPortal）反混淆后确认，
 * 主机 devdata.huaweicloud.com，axios withCredentials=true（Cookie 会话鉴权），
 * 另需 csrf 请求头。
 *
 * csrf 取值说明（踩坑记录）：
 *   csrf 由页面 JS 自己持有，既不在 cookie 里（cookie 里的 csrf-eco 是另一个值，
 *   拿它去请求会得到 403 "CSRF unequal"），也不在 islogin / get-ainfo 的响应体里。
 *   唯一可靠办法是在页面加载后截获它真实发出的请求头 `csrf`（见 #csrfToken）。
 *   直接发请求不带该头会得到 403 "no request_csrf found"。
 *
 * 提供：
 *   - 任务定义（公开，无需登录）
 *   - 我的任务完成状态（需登录；is_finish 0=未完成 1=已完成）
 *   - 积分余额 / 积分明细（用于核实奖励是否真正到账）
 */
import { resolveAuthFile } from "./auth-utils.mjs";

const ORIGIN = "https://devdata.huaweicloud.com";

/**
 * 单次接口调用的整体上限。
 * 正常一次 1~3 秒；给到 30 秒是为了容忍偶发网络抖动，
 * 又不至于让整条 daily-run 被一步卡死（见 #fetch 的说明）。
 */
const REQUEST_TIMEOUT_MS = Number(process.env.HWCLOUD_API_TIMEOUT_MS) || 30_000;

const P = {
  missionDef: "/rest/developer/fwdo/rest/developer/servlet/hdcommunitysoservice/v1/growth/mission/query-mission-list-by-condition",
  missionMine: "/rest/developer/fwdu/rest/developer/user/hdcommunitysoservice/v1/growth/mission/query-mission-list-by-condition",
  bonusBeans: "/rest/developer/fwdu/rest/developer/user/hdcommunitysoservice/v1/growth/bonus-beans",
  bonusFlow: "/rest/developer/fwdu/rest/developer/user/hdcommunitysoservice/v1/growth/bonus-flow",
  sign: "/rest/developer/fwdu/rest/developer/user/hdcommunitysoservice/v1/growth/sign",
  signDef: "/rest/developer/fwdo/rest/developer/servlet/hdcommunitysoservice/v1/growth/sign",
  csrf: "/api/get-ainfo",
};

/** 上海时区的 YYYY/MM/DD（积分明细的时间口径） */
export function shanghaiDate(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d).replace(/-/g, "/");
}

/**
 * 把积分明细里的 time（UTC，形如「2026-11-09 19:28:33」）换算成上海日期
 * 「YYYY-MM-DD」。
 *
 * 为什么需要：接口返回的 time 是 **UTC**，而"今天"按上海时区算。
 * 直接 `f.time.startsWith(上海今天)` 会在上海时间 0:00~8:00 这段出错——
 * 那些记录在 UTC 里还是前一天，于是被算到昨天去。
 * 2026-11-10 实际踩到：主号凌晨 03:28（上海）签的到，接口给 UTC 19:28（前一天），
 * 面板整天显示「今日 +0」，看起来像任务压根没跑；DevSpace 也因此反复判定"未到账"、
 * 白白重试。多处以同一方式出错，故在此统一提供助手。
 *
 * @param {string} timeStr 接口返回的时间字符串
 * @returns {string} 上海日期 YYYY-MM-DD（无法解析时退化为原串前 10 位）
 */
export function utcToShanghaiDate(timeStr) {
  const s = String(timeStr || "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return s.slice(0, 10);
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(utc));
}

/** 这条明细是否属于「上海时间的今天」 */
export function isTodayShanghai(timeStr, todayDash = new Date()) {
  const want = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(todayDash);
  return utcToShanghaiDate(timeStr) === want;
}

export class GrowApi {
  /** @param {import('playwright').BrowserContext} context 已带登录 storageState 的上下文 */
  /**
   * @param {import('playwright').BrowserContext} context 已带登录 storageState 的上下文
   * @param {{page?: import('playwright').Page}} [opts] 可复用已打开的成长中心页面，
   *   省去重新加载（调用方负责不改动该页面）
   */
  constructor(context, { page = null } = {}) {
    this.ctx = context;
    this.csrf = null;
    this.page = page;
    this._ownsPage = !page;
  }

  /** 释放内部页面（不关闭传入的 context） */
  async close() {
    // 外部传入的页面不归本实例管理，不关闭
    if (this._ownsPage && this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => {});
    }
    this.page = null;
  }

  /**
   * 确保有一个停在 developer.huaweicloud.com 的页面。
   * 必须在页面里发 fetch：Playwright 的 ctx.request 不会把浏览器 cookie
   * 自动带到 devdata.huaweicloud.com（跨子域），会 403 not login；
   * 页面内 fetch + credentials:"include" 才带得上。
   */
  async #page() {
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = await this.ctx.newPage();
    // 带重试的导航：本机有多个 tun 代理接口，网络切换会让 Chromium 抛
    // ERR_NETWORK_CHANGED 直接打断导航。不重试的话整轮采集/任务就白跑
    // （2026-11-11 实测：采集脚本因此反复失败）。auth-utils 里已有同名助手，
    // 这里内联一份以免 grow-api 依赖 auth-utils 的加载顺序。
    let lastErr;
    for (let i = 1; i <= 4; i++) {
      try {
        await this.page.goto("https://developer.huaweicloud.com/grow", {
          waitUntil: "domcontentloaded",
          timeout: 90000,
        });
        break;
      } catch (e) {
        lastErr = e;
        const retryable = /ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_TIMED_OUT|ERR_ABORTED|ERR_INTERNET_DISCONNECTED|net::/i.test(String(e?.message || e));
        if (!retryable || i === 4) throw lastErr;
        await new Promise((r) => setTimeout(r, 2000 * i));
      }
    }
    // 等待 csrf-eco cookie 真正写入（服务端会在页面加载后轮换该 cookie）。
    // 死等固定毫秒数不够稳：网络慢时 cookie 还没到，请求会 403。
    await this.page
      .waitForFunction(() => /(?:^|; )csrf-eco=/.test(document.cookie), null, { timeout: 30_000 })
      .catch(() => {
        /* 超时则按原逻辑继续，由请求侧报错 */
      });
    await this.page.waitForTimeout(1000);
    return this.page;
  }

  /**
   * 获取页面真实使用的 csrf 值。
   *
   * 踩坑记录：csrf 不在任何 cookie 中，cookie 里的 csrf-eco 是另一个值
   * （拿它请求会 403 "CSRF unequal"）；也不在 islogin / get-ainfo 响应里。
   * 它由前端 JS 持有并逐次写入请求头，所以只能监听页面真实请求截获。
   * 做法：监听请求头 → 触发一次会带 csrf 的真实调用（积分余额）→ 从请求头取值。
   */
  async #csrfToken(page) {
    if (this.csrf) return this.csrf;
    let token = null;
    const onReq = (req) => {
      const t = req.headers()["csrf"];
      if (t && !token) token = t;
    };
    page.on("request", onReq);
    try {
      // 页面自身的轮询/埋点请求会持续带 csrf，但首个这类请求并不在页面加载完
      // 的瞬间发出：实测等待 20s 可截获 16 个带 csrf 的请求，而只等 3s 经常一个
      // 都抓不到——于是接口返回 403 `no request_csrf found`，被误判成「登录失效」
      // （实际 cookie 与登录态都在，BBS 接口同时是 200）。
      // 改为轮询等待，最多 25s，一旦截获立即返回，避免无谓等待。
      for (let i = 0; i < 25 && !token; i++) {
        await page.waitForTimeout(1000);
      }
      if (!token) {
        // 兜底：主动触发一次页面内请求，让页面上下文产生带 csrf 的后续请求
        await page
          .evaluate(
            (url) =>
              fetch(url, { credentials: "include", headers: { accept: "application/json" } }).catch(
                () => {},
              ),
            ORIGIN + P.bonusBeans,
          )
          .catch(() => {});
        for (let i = 0; i < 10 && !token; i++) {
          await page.waitForTimeout(1000);
        }
      }
    } finally {
      page.off("request", onReq);
    }
    if (!token) throw new Error("未截获到 csrf（页面未发出带 csrf 的请求）");
    this.csrf = token;
    return token;
  }

  /** 统一在页面上下文里请求，返回 {status, json, text} */
  async #fetch(method, path, body) {
    // 整体硬超时：csrf 获取 + 页面内 fetch 都可能挂住（页面不产生带 csrf 的
    // 请求时，上面那套轮询最多等 35s 仍拿不到；若此时 page.evaluate 也卡住，
    // 调用方会无限等）。2026-11-10 实际踩到：主号 daily-run 卡在
    // 「读取运行前积分与任务状态」整整 300s 被超时强杀，账号2 同一步却正常。
    // 这里兜一层，超时即返回失败，让上层走降级分支而不是卡死整条流程。
    return await this.#withTimeout(this.#fetchInner(method, path, body), REQUEST_TIMEOUT_MS);
  }

  async #withTimeout(promise, ms) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ ok: false, status: 0, json: null, text: `timeout after ${ms}ms` }), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #fetchInner(method, path, body) {
    const page = await this.#page();
    let csrf;
    try {
      csrf = await this.#csrfToken(page);
    } catch (e) {
      return { ok: false, status: 0, json: null, text: String(e) };
    }
    const res = await page.evaluate(
      async ({ url, method, body, csrf }) => {
        const headers = { accept: "application/json" };
        if (csrf) headers.csrf = csrf;
        if (body) headers["content-type"] = "application/json";
        try {
          const r = await fetch(url, {
            method,
            credentials: "include",
            headers,
            body: body ? JSON.stringify(body) : undefined,
          });
          return { status: r.status, text: await r.text() };
        } catch (e) {
          return { status: 0, text: String(e) };
        }
      },
      { url: ORIGIN + path, method, body, csrf },
    );
    let json = null;
    try {
      json = JSON.parse(res.text);
    } catch {
      /* 非 JSON，保留文本 */
    }
    // 登录态校验：掉线时服务端会把请求重定向到登录页，返回 **HTML** 而不是 JSON。
    // 不识别的话，调用方会把「拿不到数据」当成「今天没有入账」，
    // 于是面板显示今日 +0、任务全未完成，看着像「任务没跑」——
    // 2026-11-11 实际踩到，排查方向被带偏很久。
    // 这里明确标记，让上层能区分「未登录」与「真的没有」。
    if (!json && /<!doctype html|<html/i.test(res.text || "")) {
      return {
        ok: false,
        status: res.status,
        json: null,
        text: res.text,
        needLogin: true,
        error: "接口返回 HTML（登录态失效，被重定向到登录页）",
      };
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json, text: res.text };
  }

  async #post(path, body) {
    return this.#fetch("POST", path, body);
  }

  async #get(path) {
    return this.#fetch("GET", path);
  }

  /** 全部任务定义（公开接口，无需登录） */
  async missionDefs() {
    const r = await this.#post(P.missionDef, {
      page_no: 1,
      page_size: 100,
      category_key: "DAILY_MISSIONS",
    });
    if (!r.ok || !r.json) return null;
    return r.json?.data?.mission_list || r.json?.mission_list || r.json?.data || null;
  }

  /** 我的任务状态：返回 {missions:[{title, isFinish, bonus, period, type}]} */
  async myMissions() {
    const r = await this.#post(P.missionMine, {
      page_no: 1,
      page_size: 100,
      category_key: "DAILY_MISSIONS",
    });
    if (r.status === 403) return { error: "not-login" };
    if (!r.ok || !r.json) return { error: `HTTP ${r.status}` };
    // 实际响应结构：{ total, QueryMissionDtoList: [...] }
    const list =
      r.json?.QueryMissionDtoList ||
      r.json?.data?.mission_list ||
      r.json?.mission_list ||
      r.json?.data ||
      [];
    return {
      missions: list.map((m) => {
        const rule = Array.isArray(m.rule_list) ? m.rule_list[0] : null;
        return {
          id: m.id,
          title: m.title,
          type: m.type,
          url: m.url,
          isFinish: m.is_finish === 1,
          bonus: m.bonus ?? rule?.bonus ?? 0,
          period: rule
            ? `${rule.mission_cycle_type}×${rule.mission_cycle_num}`
            : "",
        };
      }),
    };
  }

  /** 积分余额 */
  async bonusBeans() {
    // 首次请求偶发 403（页面刚加载、csrf 尚未轮换完成），重试一次
    let r = await this.#get(P.bonusBeans);
    if (r.status === 403 || !r.json) {
      await new Promise((res) => setTimeout(res, 2500));
      r = await this.#get(P.bonusBeans);
    }
    if (r.status === 403) return null;
    if (!r.ok || !r.json) return null;
    const n =
      r.json?.data?.beans ??
      r.json?.beans ??
      r.json?.data?.bonus ??
      r.json?.bonus;
    return typeof n === "number" ? n : null;
  }

  /** 积分明细（最近若干条），规范化为 {time, points, source, balance, type} */
  async bonusFlow(pageSize = 20) {
    // 首次 POST 常因 csrf 未就绪返回 403，先用一次 GET 完成 csrf 轮换并重试。
    // 2026-11 实测：页面刚 domcontentloaded 时 js 还没发起任何业务请求，
    // csrf 截获不到，必须等多轮（每轮 2.5s），只重试 2 次会恒返回 null。
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await this.#post(P.bonusFlow, { page_no: 1, page_size: pageSize });
      if (r.ok && r.json) {
        const list =
          r.json?.BonusFlowList ||
          r.json?.data?.BonusFlowList ||
          r.json?.data?.bonus_flow_list ||
          [];
        return list.map((x) => ({
          time: x.commit_time || x.time || "",
          points: Number(x.beans ?? x.points ?? 0),
          source: x.detail || x.source || x.sourceName || "",
          balance: x.balance,
          type: x.type,
          flag: x.flag,
        }));
      }
      if (r.status !== 403 && r.json) return null;
      await this.bonusBeans().catch(() => {});
      await new Promise((res) => setTimeout(res, 2500));
    }
    return null;
  }
}

/**
 * 核实某个来源的积分「今天是否已发放」。
 * 用途：发布作品等场景，接口即使当日重复也返回成功，必须靠明细核实。
 *
 * 注意：积分明细的 time 是 **UTC**，比上海时间晚 8 小时。
 * 传 dateStr 时按它比对；不传则按"上海时间的今天"。
 * （早期版本直接拿 UTC 的 date 部分跟上海日期比，凌晨 0~8 点的记录会算错日。）
 */
export async function hasBonusToday(api, sourceKeyword, points, dateStr) {
  const flow = await api.bonusFlow(30);
  if (!flow) return null; // 查不到（未登录/接口异常），交由调用方决定
  const want = dateStr ? String(dateStr).replace(/\//g, "-") : null;
  return flow.some(
    (r) =>
      String(r.source || "").includes(sourceKeyword) &&
      Number(r.points) === Number(points) &&
      (want ? utcToShanghaiDate(r.time) === want : isTodayShanghai(r.time)),
  );
}

/**
 * 核实某个来源的积分「本月是否已发放」。
 *
 * 用途：成长中心有的任务是 MONTHLY×1（例如「在开发者作品展览馆中发布作品」+200，
 * 规则 mission_cycle_type=MONTHLY）。这类任务每天重复调用接口**都会返回成功**，
 * 但月度只计一次分；用 hasBonusToday 判断会误以为「今天没到账」而反复发布。
 *
 * @param {object} api GrowApi 实例
 * @param {string} sourceKeyword 积分来源关键字（子串匹配）
 * @param {number} points 分值
 * @param {string} [monthPrefix] 形如 2026-11；缺省取上海时区的当前月
 * @returns {Promise<boolean|null>} null = 查询失败
 */
export async function hasBonusThisMonth(api, sourceKeyword, points, monthPrefix) {
  // 一个月最多 31 条。这里取 50 而不用 100：实测 page_size 给到 100 时
  // 接口会返回异常，导致判断恒为「查询失败」。
  const flow = await api.bonusFlow(50);
  if (!flow) return null;
  const month = monthPrefix || shanghaiDate().replace(/\//g, "-").slice(0, 7);
  return flow.some(
    (r) =>
      String(r.source || "").includes(sourceKeyword) &&
      Number(r.points) === Number(points) &&
      String(r.time || "").startsWith(month),
  );
}

export { P as GROW_PATHS, ORIGIN as GROW_API_ORIGIN, resolveAuthFile };
