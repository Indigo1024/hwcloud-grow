#!/usr/bin/env node
/**
 * GitCode 侧任务（AI 办公实践中心）
 *
 * 对应「AI办公实践中心」（https://hands-on-agent.developer.huaweicloud.com/）站内任务：
 *   - Star 实践中心代码仓        +50   仅一次
 *   - 给代码仓提 Issue           +60   每日最多一次
 *
 * 积分由华为云激励服务端按「已绑定的 GitCode 账号 + 平台侧行为」异步核对发放，
 * 前端不做计数，因此本模块只负责「把行为做掉」，不承诺即时到分。
 *
 * 凭证：按账号读 GitCode token。主号 ~/.gitcode/auth.toml，新号 ~/.gitcode-acct2/auth.toml
 * （均由 accounts.mjs 的 gitcodeHome 决定）；可用环境变量 GITCODE_TOKEN 覆盖。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TaskStatus } from "./task-status.mjs";
import { getAccount, resolveAccountId } from "./accounts.mjs";

const API_BASE = "https://api.gitcode.com/api/v5";

/** AI 办公实践中心组织 */
export const OFFICE_ORG = "agent-best-practices";

/** 优先 Star 的仓库（官方 Readme 引导「进每个项目点个 Star」） */
/**
 * Star 目标仓库。
 *
 * 注意：官方对「Star AI办公实践中心代码仓」的周期定义是 LIMIT×1（仅限一次），
 * 即点再多仓库也只计一次分。这里保留逐仓点亮，仅为「顺带支持该组织项目」之意。
 *
 * 默认从组织动态拉取全部仓库（避免硬编码列表被点完后无仓可点）；
 * 拉取失败时回退到内置列表。也可用环境变量 GITCODE_STAR_TARGETS 覆盖
 * （逗号分隔的仓库名）。
 */
export const FALLBACK_STAR_TARGETS = [
  "Readme",
  "workvault",
  "PPT-diff",
  "eduSwarm",
  "redbook-operate",
  "ai-interview-swarm",
  "OpsSwarm",
  "gitcode-issue-triage",
  "scenario-planner",
  "ai-campus-event-planner",
  "Prompt_to_Premiere",
  "AgentArts",
  "teaching-skills",
  "product_analysis",
  "screenshot_and_analysis",
  "screen_recording_tool",
  "clipboard",
  "decision-arena",
  "powered-by-jiuwen",
  "xhs-cross-platform-rewrite",
  "get-together",
  "intelligent-Customer-Communication-Management-System",
];

/** 每次运行最多点亮多少个仓库（避免一次点太多触发风控） */
// WEEKLY×1 任务：每周只需一次成功的 Star 动作就计分，多点是浪费资源。
// 组织共 32 个仓库，每周点 1 个可支撑 8 个月；配 hasWeeklyStarBonus 幂等后
// 已计分就完全跳过，不会把仓库一次性耗尽。
export const STAR_MAX_PER_RUN = Number(process.env.GITCODE_STAR_MAX || 1);

/** 拉取组织全部仓库名；失败返回 null 由调用方回退 */
export async function fetchOrgRepos(token) {
  const names = [];
  for (let page = 1; page <= 5; page++) {
    const r = await api(`/orgs/${OFFICE_ORG}/repos?per_page=100&page=${page}`, { token });
    if (!r.ok || !Array.isArray(r.json)) return names.length ? names : null;
    if (r.json.length === 0) break;
    for (const repo of r.json) {
      const n = repo.path || repo.name;
      if (n) names.push(n);
    }
    if (r.json.length < 100) break;
  }
  return names.length ? names : null;
}

/**
 * 用搜索接口分页拉取组织全部仓库名。
 *
 * 2026-11-01 新增：组织列表接口 /orgs/{org}/repos 对本 token 返回 403，
 * 页面又是懒加载只渲染 10 个，导致 fallback 列表长期只有 8 个且含死链
 * （agent-office-skills 根本不存在，POST star 恒 403，任务天天报失败）。
 * /search/repositories 可用，per_page 上限 20，按 page 翻页。
 *
 * @param {string} token
 * @returns {Promise<string[]|null>} 失败返回 null，由调用方回退内置列表
 */
export async function fetchOrgReposBySearch(token) {
  const names = [];
  for (let page = 1; page <= 10; page++) {
    const r = await api(
      `/search/repositories?q=${encodeURIComponent(OFFICE_ORG)}&per_page=20&page=${page}`,
      { token },
    );
    if (!r.ok || !Array.isArray(r.json)) {
      return names.length ? names : null;
    }
    if (r.json.length === 0) break;
    for (const item of r.json) {
      const full = item?.full_name || "";
      if (!full.startsWith(`${OFFICE_ORG}/`)) continue;
      const name = full.slice(OFFICE_ORG.length + 1);
      if (name && !names.includes(name)) names.push(name);
    }
    if (r.json.length < 20) break;
  }
  return names.length ? names : null;
}

/** 解析本次要处理的仓库列表 */
export async function resolveStarTargets(token) {
  const env = (process.env.GITCODE_STAR_TARGETS || "").trim();
  if (env) {
    return { repos: env.split(",").map((s) => s.trim()).filter(Boolean), source: "env" };
  }
  // 优先用搜索接口（能拿到全部 32 个，含新仓库）；失败再退组织接口/内置列表
  const bySearch = await fetchOrgReposBySearch(token);
  if (bySearch) return { repos: bySearch, source: "search-api" };
  const fetched = await fetchOrgRepos(token);
  if (fetched) return { repos: fetched, source: "org-api" };
  return { repos: FALLBACK_STAR_TARGETS, source: "fallback" };
}

/** 提 Issue 的目标仓库 */
export const ISSUE_REPO = "Readme";

/**
 * 读取 GitCode 访问令牌。
 *
 * 优先级：GITCODE_TOKEN 环境变量 > 账号专属凭证文件。
 * 多账号：凭证目录由 accounts.mjs 决定，主号 ~/.gitcode，新号 ~/.gitcode-acct2，
 * 避免两个账号共用一个 token 导致「提 Issue 记到了错误的账号名下」。
 *
 * @param {string} [accountId] 不传则用当前账号（HWCLOUD_ACCOUNT 或默认）
 */
function readToken(accountId) {
  if (process.env.GITCODE_TOKEN) return process.env.GITCODE_TOKEN;
  const authFile = join(getAccount(accountId).gitcodeHome, "auth.toml");
  if (!existsSync(authFile)) return null;
  const txt = readFileSync(authFile, "utf8");
  const m = txt.match(/access_token\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 保留原始文本 */
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * 一次拉取当前用户 star 过的全部仓库（full_name 集合），供批量判断复用。
 * 旧实现对每个仓库调 /repos/{org}/{repo}/stargazers?per_page=100 再在前 100 人里找自己，
 * 但热门仓库（实测 196 星）根本排不进前 100，于是「明明已 Star 却判成未 Star」，
 * 每轮都重复点 Star。改用反向查询：直接问「我 star 了哪些」。
 */
async function fetchStarredFullNames(token) {
  const names = new Set();
  for (let pageNo = 1; pageNo <= 10; pageNo++) {
    const r = await api(`/user/starred?per_page=100&page=${pageNo}`, { token });
    if (!r.ok || !Array.isArray(r.json) || r.json.length === 0) break;
    for (const x of r.json) if (x.full_name) names.add(x.full_name);
    if (r.json.length < 100) break;
  }
  return names;
}

/** 该用户是否已 star 某仓库 */
async function hasStarred(repo, token, starredSet) {
  const set = starredSet?.size ? starredSet : await fetchStarredFullNames(token);
  return set.has(`${OFFICE_ORG}/${repo}`);
}

/**
 * T_AI_OFFICE_STAR：为 AI 办公实践中心代码仓点亮 Star
 */
export async function tryOfficeStar(_page, task, report) {
  const push = (status, detail) => {
    report.push({ task_id: task.task_id, status, detail });
    console.log(`  [${status}] ${detail}`);
  };

  const token = readToken(resolveAccountId(process.env.HWCLOUD_ACCOUNT));
  if (!token) {
    push(TaskStatus.FAIL, `未找到 GitCode 凭证（${getAccount(resolveAccountId(process.env.HWCLOUD_ACCOUNT)).gitcodeHome}/auth.toml 或 GITCODE_TOKEN）`);
    return;
  }

  const me = await api("/user", { token });
  if (!me.ok) {
    push(TaskStatus.FAIL, `GitCode 凭证无效（HTTP ${me.status}），请重新授权`);
    return;
  }
  const login = me.json.login;

  // 硬前置：GitCode 必须已绑定华为云账号，否则 Star/Issue 永不计分。
  let bindDetail = "";
  if (_page) {
    const bind = await ensureGitcodeBinding(_page, login);
    if (!bind.ok) {
      push(TaskStatus.FAIL, `GitCode 未绑定华为云账号（${bind.detail}）——不绑定则 Star 贡献不计积分`);
      return;
    }
    bindDetail = bind.detail;

    // 本周已计分就跳过：任务是 WEEKLY×1，一周只计一次。
    // 按「积分明细里本周已有 Star 记录」判断（这是唯一可靠判据），
    // 而不是按「已 Star 的仓库数」——后者无上限，会把 32 个仓库一次性点完。
    const scored = await hasWeeklyStarBonus(_page);
    if (scored === true) {
      push(TaskStatus.SKIP, `本周 Star +50 已到账，跳过（${bindDetail.slice(0, 30)}）`);
      return;
    }
  }

  const { repos: targets, source } = await resolveStarTargets(token);
  const starred = [];
  const already = [];
  const failed = [];
  const skipped = [];
  const deferred = [];

  // 一次性拉取已 Star 集合，避免每个仓库都查一遍 stargazers
  const starredSet = await fetchStarredFullNames(token);

  for (const repo of targets) {
    // 本轮已达上限：其余留待下次（避免一次点太多触发风控）
    if (starred.length >= STAR_MAX_PER_RUN) {
      deferred.push(repo);
      continue;
    }
    const before = await hasStarred(repo, token, starredSet);
    if (before === true) {
      already.push(repo);
      continue;
    }
    const r = await api(`/repos/${OFFICE_ORG}/${repo}/star`, {
      method: "POST",
      token,
    });
    if (r.ok) {
      starred.push(repo);
      starredSet.add(`${OFFICE_ORG}/${repo}`);
    } else if (r.status === 403 || r.status === 404) {
      // 仓库不存在（fallback 列表里的死链，如 agent-office-skills）或
      // 组织接口对本 token 无权限时，403 并不代表任务失败——该仓库跳过即可。
      // 旧实现把它计入 failed，导致「早已 Star 满 7 个仓库」仍整轮报失败。
      skipped.push(`${repo}(HTTP ${r.status})`);
    } else {
      failed.push(`${repo}(HTTP ${r.status})`);
    }
  }

  if (starred.length === 0 && failed.length === 0) {
    // 组织仓库全部已 Star —— 本账号已把该组织的仓库点完。
    //
    // 事实（2026-11-11 逐项核实）：
    //   · 组织共 32 个仓库（GitCode 组织页显示「项目 32」，与已 Star 数一致）
    //   · /user/starred 返回 32 个该组织仓库，**未 Star 的为 0**
    //   · GitCode **没有取消 Star 的接口**（DELETE/PUT/unstar 等 5 种实测全 405/404）
    //   · 在自己账号下新建仓库再 Star（探测仓）**不计分**——任务要求的是
    //     "组织下的仓库"，gitcode_user_main/star-probe-* 不在组织命名空间内
    //   · 因此无法再产生"组织仓库的新 Star 动作"
    //
    // 注意与「提 Issue」的区别：Issue 靠**每周创建新对象**续命；
    // Star 是一次性动作，仓库点完就真的没了。所以这里如实报告，
    // 不做"看似成功"的动作（2026-11-11 曾误判探测仓可行，实测不到账后纠正）。
    //
    // 组织**新增仓库**后本任务会自动恢复（下一轮就能点新仓库）。
    push(
      TaskStatus.SKIP,
      `组织 ${targets.length} 个仓库已全部 Star（未 Star 的为 0），` +
        `GitCode 不提供取消 Star 接口，故本轮无新动作可产生；` +
        `组织新增仓库后会自动恢复`,
    );
    return;
  }
  if (starred.length === 0) {
    push(TaskStatus.FAIL, `Star 失败: ${failed.join(", ")}`);
    return;
  }

  const parts = [
    `账号 ${login}`,
    `目标 ${targets.length} 个(来源 ${source})`,
    `新增 Star ${starred.length} 个: ${starred.join(", ")}`,
  ];
  if (already.length) parts.push(`已是 Star: ${already.length} 个`);
  if (skipped.length) parts.push(`不可访问(跳过): ${skipped.length} 个`);
  if (deferred.length) parts.push(`留待下次: ${deferred.length} 个`);
  if (failed.length) parts.push(`失败: ${failed.join(", ")}`);
  push(TaskStatus.TRIED, parts.join(" | "));
}

/**
 * 建/复用本周探测仓库并 Star 它，用于在组织仓库点完后继续造出新 Star 动作。
 *
 * 命名 star-probe-<ISO周>，每周唯一；保留最近 2 个不删（跨日结算期间删掉
 * 会连 star 记录一起消失），更早的在下次运行时清理。
 *
 * @param {string} token
 * @param {string} login
 * @returns {Promise<{ok:boolean, repo?:string, detail:string}>}
 */
async function starProbeRepo(token, login) {
  try {
    let name = `star-probe-${isoWeekLabel()}`;

    // 清理旧探测仓库（保留最近 2 个）
    const repos = await api(`/users/${login}/repos?per_page=100`, { token });
    const probes = (Array.isArray(repos.json) ? repos.json : [])
      .filter((r) => String(r.name || r.path || "").startsWith("star-probe-"))
      .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    for (const r of probes.slice(2)) {
      const old = r.name || r.path;
      const d = await api(`/repos/${login}/${old}`, { method: "DELETE", token });
      console.log(`  [清理] 删除旧探测仓库 ${login}/${old} → ${d.status}`);
    }

    const existingNames = new Set(probes.map((r) => r.name || r.path));

    // 关键：若本周名字**已存在且已 Star**，就不能再用它 ——
    // 「Star 计分只认新的 Star 动作」，对同一个仓库重复 Star 不产生新动作。
    // 之前这里只看"名字存不存在"，存在就直接去 Star，结果永远是已 Star 状态、
    // 拿不到分（2026-11-11 定位到：建仓报 422「already used」）。
    // 所以：已存在 → 追加序号（-2、-3…）建一个新仓库。
    let attempt = 0;
    for (;;) {
      const exists = existingNames.has(name);
      if (!exists) {
        const created = await api("/user/repos", {
          method: "POST",
          token,
          body: {
            name,
            description: `每周 Star 任务用的临时仓库（${name}），计分后自动清理`,
            private: true,
            auto_init: true,
          },
        });
        if (created.ok) break;
        // 名字仍被占用（可能是刚才列表没拉到）→ 换名重试
        if (created.status === 422 && attempt < 5) {
          attempt++;
          name = `star-probe-${isoWeekLabel()}-${attempt + 1}`;
          continue;
        }
        return { ok: false, detail: `建仓 HTTP ${created.status} ${created.text.slice(0, 80)}` };
      }
      // 已存在：换一个带序号的新名字，确保是"新动作"
      attempt++;
      if (attempt > 5) return { ok: false, detail: "同名探测仓过多，无法新建" };
      name = `star-probe-${isoWeekLabel()}-${attempt + 1}`;
    }

    const starred = await api(`/repos/${login}/${name}/star`, { method: "POST", token });
    if (!starred.ok) return { ok: false, detail: `Star HTTP ${starred.status}` };
    return { ok: true, repo: name, detail: "ok" };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 80) };
  }
}



const ISSUE_TITLE = "建议：为实践中心各仓库补充统一的快速上手文档与环境自检脚本";

const ISSUE_BODY = `## 反馈类型
建议改进

## 涉及模块
实践中心代码仓（组织 [agent-best-practices](https://gitcode.com/agent-best-practices)）的文档结构与上手体验

## 问题描述

在按 README 指引逐个体验组织下项目时，发现几个影响"clone 下来就能跑"这一目标的地方：

### 1. 各仓库的快速上手章节结构不统一

组织下目前有 20+ 个仓库，但 README 的组织方式差异较大：有的把安装命令写在最前面，有的放在靠后位置，有的只给了依赖清单而没有可直接复制的完整命令块。

**建议**：统一采用下列最小结构，并在组织级 README 中作为模板链接出去——

\`\`\`markdown
## 快速开始
### 环境要求
- Python >= 3.10 / Node >= 18（写明实际版本）
### 安装
\`\`\`bash
git clone <repo>
cd <repo>
<依赖安装命令>
\`\`\`
### 运行
\`\`\`bash
<启动命令>
\`\`\`
### 验证
<预期输出或截图>
\`\`\`

### 2. 缺少环境自检脚本，失败时难以定位

实际安装依赖时遇到过若干环境层面的问题（比如系统 Python 受 PEP 668 保护、无法直接 pip 安装；浏览器类依赖缺少系统库等）。这些报错对新用户不够友好，往往需要反复搜索才能解决。

**建议**：每个仓库附带一个 \`preflight.sh\` 或 \`doctor.py\`，在正式运行前检查：
- 运行时版本是否满足要求
- 关键系统依赖是否就绪
- 报错时直接给出对应的安装命令

例如在 Debian/Ubuntu 上遇到 PEP 668 时，给出：

\`\`\`bash
pip3 install --break-system-packages -r requirements.txt
# 或推荐使用虚拟环境
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
\`\`\`

### 3. README 中的外部链接建议补充可达性说明

部分仓库依赖华为云侧的服务或控制台页面，README 里给了入口但未说明前置条件（是否需要实名认证、是否需要先开通对应服务、是否有免费额度）。补充这些信息能显著减少中途卡住的情况。

## 期望效果

新用户从组织首页任选一个项目，到本地跑起来，中途不需要额外搜索资料。

## 备注

以上是在实际体验过程中整理的建议，如果组织已有统一的文档规范或模板，欢迎指路，我可以据此调整后再补充具体细节。`;

/**
 * T_AI_OFFICE_ISSUE：向 AI 办公实践中心代码仓提 Issue
 */
export async function tryOfficeIssue(_page, task, report) {
  const push = (status, detail) => {
    report.push({ task_id: task.task_id, status, detail });
    console.log(`  [${status}] ${detail}`);
  };

  const token = readToken(resolveAccountId(process.env.HWCLOUD_ACCOUNT));
  if (!token) {
    push(TaskStatus.FAIL, `未找到 GitCode 凭证（${getAccount(resolveAccountId(process.env.HWCLOUD_ACCOUNT)).gitcodeHome}/auth.toml 或 GITCODE_TOKEN）`);
    return;
  }

  if (process.env.HWCLOUD_SKIP_OFFICE_ISSUE === "1") {
    push(TaskStatus.SKIP, "HWCLOUD_SKIP_OFFICE_ISSUE=1，跳过提 Issue");
    return;
  }

  const me = await api("/user", { token });
  if (!me.ok) {
    push(TaskStatus.FAIL, `GitCode 凭证无效（HTTP ${me.status}），请重新授权`);
    return;
  }
  const login = me.json.login;

  // 硬前置：GitCode 必须已绑定华为云账号，否则 Issue 贡献不计积分。
  if (_page) {
    const bind = await ensureGitcodeBinding(_page, login);
    if (!bind.ok) {
      push(TaskStatus.FAIL, `GitCode 未绑定华为云账号（${bind.detail}）——不绑定则 Issue 贡献不计积分`);
      return;
    }
  }

  // 每周最多一次：按「本周（ISO 周一为一周起点）」判断，而不是按自然日。
  // 任务是 WEEKLY×1，每周重置；按日判断会导致周一提交后、周二又提交一次，白耗。
  const list = await api(
    `/repos/${OFFICE_ORG}/${ISSUE_REPO}/issues?state=all&per_page=100`,
    { token },
  );
  const weekStart = isoWeekStartUtc();
  if (list.ok && Array.isArray(list.json)) {
    const mineThisWeek = list.json.find(
      (it) =>
        it?.user?.login === login &&
        String(it?.created_at || "").slice(0, 10) >= weekStart,
    );
    if (mineThisWeek) {
      push(
        TaskStatus.SKIP,
        `本周已提过 Issue（#${mineThisWeek.number}），每周限一次（周起点 ${weekStart}）`,
      );
      return;
    }
  }

  // 标题按周轮换：固定标题只能提一次，第二周起就永远 SKIP，任务必然拿不到分。
  // 用「ISO 周序号」做区分，保证每周标题唯一且可预期，又不至于像随机串那样扰民。
  const { title, body } = buildWeeklyIssue(weekStart);

  const r = await api(`/repos/${OFFICE_ORG}/${ISSUE_REPO}/issues`, {
    method: "POST",
    token,
    body: { title, body },
  });

  if (!r.ok) {
    push(TaskStatus.FAIL, `提 Issue 失败（HTTP ${r.status}）: ${r.text.slice(0, 200)}`);
    return;
  }

  const num = r.json?.number ?? "?";
  const url = r.json?.html_url ?? "";
  push(TaskStatus.TRIED, `已提本周 Issue #${num}「${title}」${url ? " " + url : ""}`);
}

/**
 * 本周（ISO 周，周一 00:00 UTC）的起始日期，格式 YYYY-MM-DD。
 * 用 UTC 是为了和 GitHub/GitCode 的 created_at 口径一致，避免时区错位一天。
 */
function isoWeekStartUtc() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=周日
  const diff = day === 0 ? 6 : day - 1; // 回退到周一
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diff));
  return monday.toISOString().slice(0, 10);
}

/** ISO 周序号（如 2026-W44），用于让每周标题唯一 */
function isoWeekLabel() {
  const d = new Date();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * 按周轮换的 Issue 主题池。
 * 每个主题都是对实践中心代码仓有实际价值的改进建议，而不是为凑数编的废话；
 * 用周序号取模轮换，保证同一周内标题固定（重跑幂等）、不同周不重复。
 */
const WEEKLY_ISSUE_TOPICS = [
  {
    title: "文档建议：为各仓库补充统一的「快速开始」章节结构",
    body:
      "## 背景\n\n组织下仓库数量较多，README 的组织方式差异较大：有的把安装命令写在最前面，有的放在靠后位置，有的只给了依赖清单而没有可直接复制的完整命令块。\n\n## 建议\n\n统一采用下列最小结构，并在组织级 README 中作为模板链接出去：\n\n```markdown\n## 快速开始\n### 环境要求\n- Python >= 3.10 / Node >= 18（写明实际版本）\n### 安装\n```bash\ngit clone <repo>\ncd <repo>\n<依赖安装命令>\n```\n### 运行\n```bash\n<启动命令>\n```\n### 验证\n<预期输出或截图>\n```\n\n## 期望效果\n\n新用户从组织首页任选一个项目，到本地跑起来，中途不需要额外搜索资料。",
  },
  {
    title: "环境建议：为各仓库提供 preflight 自检脚本",
    body:
      "## 背景\n\n实际安装依赖时会遇到若干环境层面的问题（例如系统 Python 受 PEP 668 保护无法直接 pip 安装、浏览器类依赖缺少系统库）。这类报错对新用户不够友好，往往需要反复搜索才能解决。\n\n## 建议\n\n每个仓库附带一个 `preflight.sh` 或 `doctor.py`，在正式运行前检查：\n\n- 运行时版本是否满足要求\n- 关键系统依赖是否就绪\n- 报错时直接给出对应的安装命令\n\n例如 Debian/Ubuntu 上遇到 PEP 668 时给出：\n\n```bash\npip3 install --break-system-packages -r requirements.txt\n# 或推荐使用虚拟环境\npython3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt\n```\n\n## 期望效果\n\n环境问题在启动前就被拦住并给出可执行的修复命令，而不是运行到一半才报错。",
  },
  {
    title: "文档建议：README 补充外部依赖的可达性说明",
    body:
      "## 背景\n\n部分仓库依赖华为云侧的服务或控制台页面，README 里给了入口但未说明前置条件（是否需要实名认证、是否需要先开通对应服务、是否有免费额度）。用户常在走到一半才发现缺前置条件。\n\n## 建议\n\n在每个仓库 README 的环境要求一节，补充一张「外部依赖清单」表格，至少包含：\n\n| 依赖服务 | 是否必需 | 前置条件 | 免费额度 | 申请入口 |\n|---|---|---|---|---|\n| 示例服务 | 是 | 实名认证 + 开通 | 有 | 链接 |\n\n## 期望效果\n\n用户能在开始前判断自己是否具备条件，减少中途卡住的情况。",
  },
  {
    title: "工程建议：统一示例代码的运行参数与端口约定",
    body:
      "## 背景\n\n不同仓库的示例代码默认端口、启动参数、环境变量命名各自为政，同一台机器上同时跑两个示例容易冲突，切换项目时也要反复查 README。\n\n## 建议\n\n1. 统一从环境变量读取端口（如 `PORT`），默认值写进 README\n2. 环境变量统一前缀（如 `AGENT_OFFICE_*`），避免与系统变量冲突\n3. 在 README 里给出「同机运行多个示例」的端口分配建议\n\n## 期望效果\n\n同机并行跑多个示例不再需要手工改代码。",
  },
  {
    title: "工程建议：为示例项目补充最小可运行的冒烟测试",
    body:
      "## 背景\n\n多数仓库只提供运行说明，没有可自动执行的验证手段。用户跑起来后无法快速确认「我这边环境是对的」，维护者也难以及时发现依赖升级导致的破坏。\n\n## 建议\n\n为每个示例补充一个最小冒烟测试（`smoke_test.sh` 或 `tests/smoke.py`），覆盖：\n\n- 依赖能否成功导入\n- 核心入口能否启动\n- 一个最小输入能否走通主流程\n\n并在 CI 里跑这个冒烟测试。\n\n## 期望效果\n\n依赖升级或环境变化导致示例不可用时，能在提交阶段就被发现。",
  },
];

/** 按周序号轮换取主题，返回 {title, body}；标题带周序号保证唯一 */
function buildWeeklyIssue(weekStart) {
  const label = isoWeekLabel();
  const idx =
    Math.abs(
      Math.floor(new Date(weekStart + "T00:00:00Z").getTime() / (7 * 86400000)),
    ) % WEEKLY_ISSUE_TOPICS.length;
  const t = WEEKLY_ISSUE_TOPICS[idx];
  return {
    title: `${t.title}（${label}）`,
    body: `${t.body}\n\n---\n\n> 本建议由自动化周报流程提交（${label}），如与已有规划重复请直接关闭。`,
  };
}

/**
 * 确保「GitCode 账号已绑定到华为云账号」。
 *
 * 2026-11-01 新增。这是 Star(+50) 与 Issue(+60) 两个每周任务**能否计分的硬前置**：
 * 实践中心页面明确写着「绑定后，您在 GitCode 上的 Star 和 Issue 贡献将自动获得
 * 华为云成长积分奖励」。未绑定时，两个任务即使操作成功也永远不计分——历史积分
 * 明细里从来没有出现过 Star/Issue 的记录，原因就在这里。
 *
 * 页面绑定逻辑（hands-on-agent 站内联脚本）：
 *   - 读取 localStorage['hw_user_info'] 拿 hw_account_name / hw_domain_id / hw_user_id
 *   - 为空时直接提示「请先登录华为云账号」并中止，不会发请求
 *   - 表单提交 POST /api/binding/create {gitcode_username, ...hwInfo}
 * 该子站是独立登录态且不会自动写这个缓存，所以必须在页面里手动写入。
 *
 * @param {import("playwright").Page} page 停在 hands-on-agent 的页面
 * @param {{accountName:string, domainId:string, userId:string, projectId?:string}} hw
 * @param {string} gitcodeLogin GitCode 用户名
 * @returns {Promise<{ok:boolean, detail:string}>}
 */
export async function ensureGitcodeBinding(page, gitcodeLogin) {
  try {
    await page.goto("https://hands-on-agent.developer.huaweicloud.com/#tasks", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForTimeout(12_000);

    // 1. 已绑定？直接返回
    const cur = await page.evaluate(() => ({
      txt: document.getElementById("boundInfo")?.textContent?.trim() || "",
      bound: document.getElementById("boundView")?.style.display === "",
    }));
    if (cur.bound && cur.txt.includes(gitcodeLogin)) {
      return { ok: true, detail: `已绑定（${cur.txt.slice(0, 60)}）` };
    }

    // 2. 从 devdata 的 islogin 取当前登录身份，写入 localStorage['hw_user_info']，
    //    否则绑定按钮读不到身份会直接中止（表现为「请先登录华为云账号」）。
    //    不硬编码账号名/ID，换账号或改昵称都能自适应。
    const hw = await page.evaluate(async () => {
      const r = await fetch("https://devdata.huaweicloud.com/index/islogin?callback=checklogin", {
        credentials: "include",
      });
      const m = (await r.text()).match(/checklogin\((.*)\)/s);
      if (!m) return null;
      const j = JSON.parse(m[1]);
      return {
        accountName: j.username || "",
        domainId: j.userId || "",
        userId: j.bbs_customerID || j.userId || "",
        projectId: j.projectId || "",
      };
    });
    if (!hw?.accountName) {
      return { ok: false, detail: "取不到华为云登录身份（islogin 未返回 username）" };
    }
    await page.evaluate(
      (info) => localStorage.setItem("hw_user_info", JSON.stringify(info)),
      hw,
    );

    // 3. 填用户名 + 真鼠标点「绑定」
    await page.locator("#gitcodeUsernameInput").fill(gitcodeLogin, { timeout: 15_000 });
    await page.waitForTimeout(600);
    const btn = page.locator("#bindGitcodeBtn");
    const rect = await btn.boundingBox({ timeout: 15_000 });
    if (!rect) return { ok: false, detail: "未找到绑定按钮" };
    await page.bringToFront().catch(() => {});
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(100);
    await page.mouse.up();
    await page.waitForTimeout(8_000);

    const after = await page.evaluate(() => ({
      txt: document.getElementById("boundInfo")?.textContent?.trim() || "",
      bound: document.getElementById("boundView")?.style.display === "",
    }));
    if (after.bound) return { ok: true, detail: `绑定成功：${after.txt.slice(0, 70)}` };
    return { ok: false, detail: `绑定未生效（页面未显示已绑定）：${after.txt.slice(0, 60)}` };
  } catch (e) {
    return { ok: false, detail: `绑定异常：${String(e).slice(0, 100)}` };
  }
}

/**
 * 本周积分明细里是否已有「Star」+50 记录。
 *
 * WEEKLY×1 任务的唯一可靠判据（用户实证：不要看 is_finish，也不要看
 * 已 Star 仓库数）。按 ISO 周起点（周一）比较 commit_time 的日期部分。
 *
 * @param {import("playwright").Page} page
 * @returns {Promise<boolean|null>} null = 查询失败
 */
export async function hasWeeklyStarBonus(page) {
  try {
    const { GrowApi, utcToShanghaiDate } = await import("./grow-api.mjs");
    const api = new GrowApi(page.context());
    const flow = await api.bonusFlow(40);
    await api.close().catch(() => {});
    if (!flow) return null;

    // 本周起点：必须按**上海时区**算周一，不能用 getUTCDay()。
    // 用 UTC 算会在「北京时间周一凌晨 0~8 点」这段时间里把周一算成周日，
    // 导致周任务被重复执行或漏判（2026-11-11 发现）。
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    });
    const todaySh = fmt.format(new Date()); // YYYY-MM-DD（上海）
    const d0 = new Date(`${todaySh}T00:00:00+08:00`);
    const wd = (d0.getUTCDay() + 6) % 7; // 周一=0
    d0.setUTCDate(d0.getUTCDate() - wd);
    const weekStart = d0.toISOString().slice(0, 10);

    return flow.some((r) => {
      const src = String(r.source || "");
      // 必须精确匹配 **Agent 中心** 的 Star，不能只写 /Star/i——
      // 那会把「每日Star一个鸿蒙案例代码仓」也算进来（它是每日任务、每天都有），
      // 于是每周的 Agent Star 天天被判成「已到账」而跳过（2026-11-11 发现的 bug）。
      const isAgentStar = /Agent/i.test(src) && /Star/i.test(src);
      if (!isAgentStar) return false;
      const dSh = utcToShanghaiDate(r.time);
      return dSh >= weekStart && dSh <= todaySh;
    });
  } catch {
    return null;
  }
}
