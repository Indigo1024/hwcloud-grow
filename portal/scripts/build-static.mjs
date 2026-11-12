import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const portalRoot = join(__dirname, "..");
const repoRoot = join(portalRoot, "..");
const catalog = JSON.parse(
  readFileSync(join(portalRoot, "src/data/tasks.json"), "utf8"),
);

const repo = catalog.meta.repo;
const basePath = (
  process.env.PORTAL_BASE_PATH ||
  catalog.meta.deploy?.base_path ||
  ""
).replace(/\/$/, "");
const publicOrigin = (
  process.env.PORTAL_PUBLIC_ORIGIN ||
  catalog.meta.deploy?.public_origin ||
  ""
).replace(/\/$/, "");

function portalPath(subpath) {
  const rel = subpath.startsWith("/") ? subpath : `/${subpath}`;
  return basePath ? `${basePath}${rel}` : rel;
}

function portalUrl(subpath) {
  const path = portalPath(subpath);
  return publicOrigin ? `${publicOrigin}${path}` : path;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const skillSrc = join(portalRoot, "src/skill/huaweicloud-grow/SKILL.md");
const skillMarkdown = readFileSync(skillSrc, "utf8");

const tasks = catalog.tasks
  .filter((t) => t.agent_eligible)
  .map((task) => ({
    task_id: task.task_id,
    title: task.title,
    description: task.description,
    points: task.points,
    recurrence: task.recurrence,
    risk_level: task.risk_level,
    auto_run: task.auto_run !== false,
    estimated_minutes: task.estimated_minutes,
    entry_url: task.entry_url,
    tags: task.tags,
  }));

const network = {
  ...catalog.agent_hints.network,
  read_skill_via: (catalog.agent_hints.network?.read_skill_via || "")
    .replaceAll("{repo_url}", repo.url)
    .replaceAll("{skill_raw_url}", repo.skill_raw_url),
};

function expandPrompt(tpl) {
  return (tpl || "")
    .replaceAll("{repo_url}", repo.url)
    .replaceAll("{skill_raw_url}", repo.skill_raw_url);
}

const defaultPrompt = expandPrompt(catalog.agent_hints.agent_prompt_template);
const gitCloneCmd = `git clone --depth 1 ${repo.url}`;

const manifest = {
  spec_version: catalog.meta.spec_version,
  generated_at: new Date().toISOString(),
  portal: {
    name: catalog.meta.portal_name,
    url: portalUrl("/"),
    official_grow_url: catalog.meta.official_grow_url,
    repo_url: repo.url,
    skill_path: repo.skill_path,
    manifest_path: repo.manifest_path,
  },
  tasks,
  agent_hints: {
    ...catalog.agent_hints,
    network,
    agent_prompt_template: defaultPrompt,
  },
};

const growAgents = {
  spec_version: "2.0.0",
  name: "Huawei Cloud Grow Agent Portal",
  name_zh: "华为云成长中心 Agent 任务门户",
  description: "Skill-driven auto executor for growth center tasks.",
  description_zh: "通过 huaweicloud-grow Skill + 本机执行器自动完成成长中心任务。",
  portal_url: portalUrl("/"),
  official_grow_url: catalog.meta.official_grow_url,
  repo: {
    url: repo.url,
    branch: repo.branch,
    skill_path: repo.skill_path,
    skill_raw_url: repo.skill_raw_url,
    manifest_path: repo.manifest_path,
    runner_path: repo.runner_path,
  },
  network,
  execution: {
    mode: "skill_executor",
    auto_run: true,
    do_not_use: ["Fetch", "WebFetch"],
    load_skill: [
      gitCloneCmd,
      `阅读 hwcloud-grow/${repo.skill_path}`,
    ],
    install_runner: {
      method: "git",
      repo_url: repo.url,
      branch: repo.branch,
      runner_path: repo.runner_path,
      commands: catalog.agent_hints.executor?.install,
    },
    quickstart: [
      `git clone --depth 1 ${repo.url}`,
      `cd hwcloud-grow/${repo.runner_path}`,
      "npm install && npx playwright install chromium",
      "npm run login  # headed browser, user scans QR if no cookie",
      "npm run agent  # auto-run all auto_run tasks (env auto-detected)",
      "npm run report  # Chinese summary per task_id",
    ],
    fetch_order: [repo.url, repo.skill_path, repo.manifest_path],
    executor: catalog.agent_hints.executor,
    default_prompt: defaultPrompt,
    note_zh:
      "Agent 无需访问门户网站。克隆 GitCode 仓库后阅读 skill/SKILL.md，在 runner/ 目录执行 npm run agent。",
  },
  manifest: {
    type: "json_file",
    path: repo.manifest_path,
    local_path: repo.manifest_path,
  },
  skills: [
    {
      name: "huaweicloud-grow",
      display_name_zh: "华为云成长中心自动做任务",
      recommended: true,
      url: repo.skill_raw_url,
      repo_path: repo.skill_path,
      content_md: skillMarkdown,
      install: {
        method: "git",
        repo_url: repo.url,
        clone: `git clone --depth 1 ${repo.url}`,
        pull: "cd hwcloud-grow && git pull --ff-only",
      },
      default_prompt: defaultPrompt,
    },
  ],
  updated_at: new Date().toISOString(),
};

function renderTaskRow(task) {
  const recurrenceLabel =
    task.recurrence === "daily"
      ? "每日"
      : task.recurrence === "weekly"
        ? "每周"
        : task.recurrence === "once"
          ? "一次性"
          : task.recurrence;
  const autoLabel =
    task.auto_run !== false
      ? '<span class="tag tag-auto">自动</span>'
      : '<span class="tag tag-manual">手动</span>';

  return `
    <tr>
      <td><code>${escapeHtml(task.task_id)}</code></td>
      <td><strong>${escapeHtml(task.title)}</strong><br><span class="muted">${escapeHtml(task.description)}</span></td>
      <td>+${task.points}</td>
      <td>${recurrenceLabel}</td>
      <td>${autoLabel}</td>
    </tr>`;
}

function generateIndexHtml() {
  const autoTasks = catalog.tasks.filter((t) => t.agent_eligible && t.auto_run !== false);
  const dailyAuto = autoTasks
    .filter((t) => t.recurrence === "daily")
    .reduce((s, t) => s + t.points, 0);
  const growUrl = catalog.meta.official_grow_url;

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="description" content="华为云开发者成长中心 Agent 自动任务 — 开放仓库 ${repo.url}" />
    <link rel="icon" href="https://www.huaweicloud.com/favicon.ico" />
    <title>成长中心 Agent 自动任务</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <div id="app">
      <div class="site-topbar">
        <span class="site-topbar-brand">华为云 · 开发者成长中心</span>
        <a href="${growUrl}" target="_blank" rel="noopener">官方成长中心</a>
      </div>

      <section class="guide-banner">
        <div class="guide-banner-inner">
          <h1>成长中心 · Agent 自动做任务</h1>
          <p class="subtitle">
            任意三方 Agent 加载 <code>huaweicloud-grow</code> Skill 即可自动做任务拿积分。具体步骤均在 Skill 内，Prompt 只需指向 Skill。
          </p>
          <div class="hero-cta">
            <button class="btn btn-hero" type="button" id="copy-agent-prompt">复制给 Agent 的 Prompt</button>
            <span class="hero-cta-hint">粘贴到华为云码道 / Claude Code / Cursor 等 Agent 即可开始</span>
          </div>
          <div class="stats-row">
            <div class="stat-chip"><span class="num">${autoTasks.length}</span><span class="label">自动任务</span></div>
            <div class="stat-chip"><span class="num">+${dailyAuto}</span><span class="label">每日自动积分</span></div>
          </div>
        </div>
      </section>

      <div class="content-wrap">
        <section class="panel skill-panel">
          <h2>huaweicloud-grow Skill</h2>
          <p class="muted">
            克隆、安装、登录、执行、汇报等<strong>全部步骤在 Skill 中</strong>。Agent 可不访问本网站，直接读仓库内
            <code>skill/SKILL.md</code> 或下方 raw 链接。
          </p>
          <div class="skill-links">
            <a class="btn btn-primary" href="${repo.url}" target="_blank" rel="noopener">打开 GitCode 仓库</a>
            <button class="btn btn-secondary" type="button" id="copy-clone-cmd">复制 git clone</button>
            <button class="btn btn-secondary" type="button" id="copy-agent-prompt-btn">复制 Prompt</button>
          </div>
          <p class="muted" style="margin-top:12px">复制给 Agent 的 Prompt（极简）：</p>
          <pre class="prompt-box" id="agent-prompt-preview">${escapeHtml(defaultPrompt)}</pre>
        </section>

        <section class="panel">
          <h2>自动执行任务（auto_run）</h2>
          <table class="task-table">
            <thead>
              <tr><th>task_id</th><th>任务</th><th>积分</th><th>周期</th><th>模式</th></tr>
            </thead>
            <tbody>${autoTasks.map(renderTaskRow).join("")}</tbody>
          </table>
        </section>
      </div>

      <footer class="site-footer">
        <p>官方成长中心：<a href="${growUrl}" target="_blank" rel="noopener">${growUrl}</a></p>
        <p>开放仓库：<a href="${repo.url}" target="_blank" rel="noopener">${repo.url}</a></p>
      </footer>
    </div>
    <div id="toast" role="status" aria-live="polite"></div>
    <script>
      const CLONE_CMD = ${JSON.stringify(gitCloneCmd)};
      const AGENT_PROMPT = ${JSON.stringify(defaultPrompt)};

      function toast(msg) {
        const el = document.getElementById("toast");
        el.textContent = msg;
        el.classList.add("show");
        setTimeout(() => el.classList.remove("show"), 2200);
      }

      async function copyText(text) {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          return;
        }
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }

      document.getElementById("copy-agent-prompt")?.addEventListener("click", async () => {
        try { await copyText(AGENT_PROMPT); toast("已复制 Agent Prompt"); }
        catch { toast("复制失败，请手动选中上方文本"); }
      });
      document.getElementById("copy-clone-cmd")?.addEventListener("click", async () => {
        try { await copyText(CLONE_CMD); toast("已复制 git clone 命令"); }
        catch { toast("复制失败"); }
      });
      document.getElementById("copy-agent-prompt-btn")?.addEventListener("click", async () => {
        try { await copyText(AGENT_PROMPT); toast("已复制 Agent Prompt"); }
        catch { toast("复制失败"); }
      });
    </script>
  </body>
</html>`;
}

// --- write repo-root artifacts (Agent primary source) ---
const repoWellKnown = join(repoRoot, ".well-known");
mkdirSync(repoWellKnown, { recursive: true });
writeFileSync(join(repoRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(join(repoWellKnown, "grow-agents.json"), JSON.stringify(growAgents, null, 2));
mkdirSync(join(repoRoot, "skill"), { recursive: true });
cpSync(skillSrc, join(repoRoot, "skill", "SKILL.md"));

// --- write portal/public for local dev reference ---
const publicDir = join(portalRoot, "public");
const publicWellKnown = join(publicDir, ".well-known");
mkdirSync(publicWellKnown, { recursive: true });
writeFileSync(join(publicDir, "manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(join(publicWellKnown, "grow-agents.json"), JSON.stringify(growAgents, null, 2));

// --- write static site to portal/dist (deploy target) ---
const distDir = join(portalRoot, "dist");
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true, force: true });
}
mkdirSync(distDir, { recursive: true });
writeFileSync(join(distDir, "index.html"), generateIndexHtml());
cpSync(join(portalRoot, "src/styles.css"), join(distDir, "styles.css"));

console.log("Generated:");
console.log(`  repo: manifest.json, .well-known/grow-agents.json, skill/SKILL.md`);
console.log(`  portal/dist: index.html, styles.css (static site only)`);
if (publicOrigin) {
  console.log(`Deploy site: ${portalUrl("/")}`);
}
console.log(`Agent repo: ${repo.url}`);
