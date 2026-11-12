import taskCatalog from "./data/tasks.json";
import "./styles.css";

const GROW_URL = taskCatalog.meta.official_grow_url;
const SKILL_PATH =
  taskCatalog.agent_hints.skill_url_path || "/skill/huaweicloud-grow/SKILL.md";

function buildManifest() {
  const tasks = taskCatalog.tasks
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

  return {
    spec_version: taskCatalog.meta.spec_version,
    generated_at: new Date().toISOString(),
    portal: {
      name: taskCatalog.meta.portal_name,
      url: window.location.href.split("?")[0],
      official_grow_url: GROW_URL,
      skill_url: new URL(SKILL_PATH.replace(/^\//, ""), window.location.href).href,
      manifest_json: new URL("manifest.json", window.location.href).href,
    },
    tasks,
    agent_hints: taskCatalog.agent_hints,
  };
}

function publishManifest(manifest) {
  const skillUrl = new URL(SKILL_PATH.replace(/^\//, ""), window.location.href).href;
  window.__GROW_AGENT_MANIFEST__ = manifest;
  window.__GROW_AGENT_SKILL_URL__ = skillUrl;
  window.__GROW_AGENT_EXECUTION__ = { mode: "skill_executor", auto_run: true };
  window.dispatchEvent(
    new CustomEvent("grow:manifest-ready", {
      detail: { manifest, skill_url: skillUrl },
    }),
  );
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fallback */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(ta);
  if (!ok) throw new Error("copy failed");
}

function buildAgentPrompt(skillUrl) {
  const tpl =
    taskCatalog.agent_hints.agent_prompt_template ||
    "加载 {skill_url} 并按 Skill 自动执行成长中心任务。";
  return tpl.replaceAll("{skill_url}", skillUrl);
}

function tag(text, kind) {
  return `<span class="tag tag-${kind}">${text}</span>`;
}

function renderTaskRow(task) {
  const recurrenceLabel =
    task.recurrence === "daily"
      ? "每日"
      : task.recurrence === "weekly"
        ? "每周"
        : task.recurrence === "once"
          ? "一次性"
          : task.recurrence;
  const autoLabel = task.auto_run !== false ? tag("自动", "auto") : tag("手动", "manual");

  return `
    <tr data-task-id="${task.task_id}">
      <td><code>${task.task_id}</code></td>
      <td><strong>${task.title}</strong><br><span class="muted">${task.description}</span></td>
      <td>+${task.points}</td>
      <td>${recurrenceLabel}</td>
      <td>${autoLabel}</td>
    </tr>`;
}

function renderApp(manifest) {
  const skillUrl = new URL(SKILL_PATH.replace(/^\//, ""), window.location.href).href;
  const agentPrompt = buildAgentPrompt(skillUrl);
  const autoTasks = taskCatalog.tasks.filter((t) => t.agent_eligible && t.auto_run !== false);
  const manualTasks = taskCatalog.tasks.filter((t) => t.agent_eligible && t.auto_run === false);
  const dailyAuto = autoTasks.filter((t) => t.recurrence === "daily").reduce((s, t) => s + t.points, 0);

  document.getElementById("app").innerHTML = `
    <div class="site-topbar">
      <span class="site-topbar-brand">华为云 · 开发者成长中心</span>
      <a href="${GROW_URL}" target="_blank" rel="noopener">官方成长中心</a>
    </div>

    <section class="guide-banner">
      <div class="guide-banner-inner">
        <h1>成长中心 · Agent 自动做任务</h1>
        <p class="subtitle">
          任意三方 Agent 加载 <code>huaweicloud-grow</code> Skill，下载 zip 执行器后运行
          <code>npm run agent</code> 即可自动做任务拿积分。
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
          Agent 的唯一执行契约。内含登录扫码、浏览器自动化、码道 CLI 等完整步骤。
          <strong>不要用 Fetch 读门户 URL</strong>（会触发自签 HTTPS 错误）——用下方 curl 或读本机 <code>skill/SKILL.md</code>。
        </p>
        <div class="skill-links">
          <a class="btn btn-primary" href="${SKILL_PATH.replace(/^\//, "")}" target="_blank" rel="noopener">打开 SKILL.md</a>
          <button class="btn btn-secondary" type="button" id="copy-skill-url">复制 Skill URL</button>
          <button class="btn btn-secondary" type="button" id="copy-curl-cmd">复制 curl 命令</button>
        </div>
        <pre class="prompt-box" id="agent-prompt-preview">${agentPrompt}</pre>
        <details class="json-preview">
          <summary>执行器安装</summary>
          <pre><code>rm -rf hwcloud-grow-runner hwcloud-grow-runner.zip
curl -sLO <你的门户主机>/grow-portal/hwcloud-grow-runner.zip
unzip -o hwcloud-grow-runner.zip && cd hwcloud-grow-runner
grep T_DEVSPACE_CREATE_ENV scripts/agent-run.mjs
# Windows: Remove-Item -Recurse -Force hwcloud-grow-runner, hwcloud-grow-runner.zip -EA SilentlyContinue; …

npm install && npx playwright install chromium
npm run login
npm run agent
npm run report</code></pre>
        </details>
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

      ${
        manualTasks.length
          ? `
      <section class="panel">
        <h2>不自动执行</h2>
        <table class="task-table">
          <thead>
            <tr><th>task_id</th><th>任务</th><th>积分</th><th>周期</th><th>模式</th></tr>
          </thead>
          <tbody>${manualTasks.map(renderTaskRow).join("")}</tbody>
        </table>
        <p class="muted">可用 <code>npm run agent -- --task=T_CODEARTS_SUBSCRIBE</code> 单独执行。</p>
      </section>`
          : ""
      }
    </div>

    <footer class="site-footer">
      <p>官方成长中心：<a href="${GROW_URL}" target="_blank" rel="noopener">${GROW_URL}</a></p>
    </footer>
  `;

  document.getElementById("copy-agent-prompt")?.addEventListener("click", async () => {
    try {
      await copyText(agentPrompt);
      toast("已复制 Agent Prompt");
    } catch {
      toast("复制失败，请手动选中上方文本");
    }
  });

  document.getElementById("copy-skill-url")?.addEventListener("click", async () => {
    try {
      await copyText(skillUrl);
      toast("已复制 Skill URL");
    } catch {
      toast("复制失败");
    }
  });

  document.getElementById("copy-curl-cmd")?.addEventListener("click", async () => {
    try {
      await copyText(`curl -s --http1.1 ${skillUrl}`);
      toast("已复制 curl 命令");
    } catch {
      toast("复制失败");
    }
  });
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

const manifest = buildManifest();
publishManifest(manifest);
renderApp(manifest);
