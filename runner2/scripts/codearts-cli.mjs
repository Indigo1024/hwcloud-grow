import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, delimiter } from "node:path";

/**
 * 读取 JSON 文件，自动去除 UTF-8 BOM (U+FEFF)
 * 解决 Windows 环境下某些工具（如 PowerShell、记事本）写入的带 BOM 文件导致 JSON.parse 报错的问题
 * @param {string} path 文件路径
 * @returns {unknown} 解析后的 JSON 对象
 */
function readJsonSync(path) {
  let content = readFileSync(path, "utf8");
  // UTF-8 BOM: U+FEFF (字节序列 EF BB BF)
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }
  return JSON.parse(content);
}

export const CODEARTS_CLI_INSTALL_DOC =
  "https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0005.html";

export const CODEARTS_CLI_AUTH_DOC =
  "https://support.huaweicloud.com/usermanual-cli/codeartsagent_cli_0026.html";

const INSTALL_BASE =
  "https://cnnorth4-cloudide-marketplace.obs.cn-north-4.myhuaweicloud.com/codearts/cli_tui/install_script";

const AUTH_URL_RE =
  /https:\/\/codearts\.huaweicloud\.com\/portal\/authorize\?[^\s"'<>\]]+/i;

// 允许按账号切换配置根目录（CODEARTS_HOME 环境变量）。
// 背景：码道 CLI 的账号身份存在 cli-data/auth.json 里，两个账号共用同一份
// 配置时，新号发布永远带旧号身份（2026-10 实际踩过，作品全落到旧号）。
// runner2 通过 CODEARTS_HOME=~/.codeartsdoer-acct2 使用独立配置目录。
// CLI 本体（installers）仍共用，不额外占磁盘。
const CODEARTS_HOME = process.env.CODEARTS_HOME || join(homedir(), ".codeartsdoer");
const AUTH_JSON = join(CODEARTS_HOME, "cli-data", "auth.json");
const CLI_LOG_DIR = join(CODEARTS_HOME, "cli-data", "log");
const PERMISSION_GLOBAL = join(
  CODEARTS_HOME,
  "cli-data",
  "storage",
  "permission",
  "global.json",
);

/**
 * 码道 CLI 的作品工作目录（按账号）。
 *
 * 必须按账号取：acct2 的作品在 agent-workspace-acct2。
 * 写死主号的 agent-workspace 会让新号的发布落到主号仓库，
 * 也会让两个账号的问答 TUI 抢同一个目录。
 * 用函数而非模块常量——账号在运行时才由 HWCLOUD_ACCOUNT 决定。
 */
function agentWorkspaceFor(accountId = process.env.HWCLOUD_ACCOUNT) {
  // 不设 "main" 兜底：runner2 是新号的专属部署，漏设 HWCLOUD_ACCOUNT 时退回
  // 主号目录会让新号的发布落到主号仓库（2026-10 实际踩过）。宁可报错也不串号。
  //
  // 目录根用 CODEARTS_WORKSPACE_HOME：CODEARTS_HOME 已按账号切到独立配置目录，
  // 但作品目录是既有资产（带 git remote 与历史），不能跟着配置目录一起搬家。
  const id = accountId || "acct2";
  const base = process.env.CODEARTS_WORKSPACE_HOME || join(homedir(), ".codeartsdoer");
  return id === "main"
    ? join(base, "agent-workspace")
    : join(base, `agent-workspace-${id}`);
}

const AGENT_WORKSPACE = agentWorkspaceFor();

const AGENT_AUTO_ALLOW_PERMISSIONS = ["webfetch", "browser", "write", "edit"];

/** 码道 TUI 每日提问（纯代码生成，无需 webfetch 权限） */
export const CODEARTS_TUI_PROMPT =
  "请写一段python代码，把今天的日期转换为多种格式";

export function codeartsCliBinDir() {
  // CLI 本体始终共用主目录下的 installers：配置目录可按账号隔离，
  // 但几百 MB 的程序本体没必要复制多份（升级也只升一份）。
  // CODEARTS_CLI_INSTALL_HOME 供将来特殊场景覆盖。
  const installHome = process.env.CODEARTS_CLI_INSTALL_HOME || join(homedir(), ".codeartsdoer");
  return join(installHome, "installers");
}

export function codeartsExe() {
  return join(codeartsCliBinDir(), "bin", platform() === "win32" ? "codearts.exe" : "codearts");
}

export function augmentedPath() {
  const binDir = codeartsCliBinDir();
  const sep = platform() === "win32" ? ";" : ":";
  return `${binDir}${sep}${process.env.PATH || ""}`;
}

function codeartsKernelEnv(extra = {}) {
  return {
    ...process.env,
    PATH: augmentedPath(),
    package_tag: "undefined",
    CODEAGENT_USE_MESSAGE_FEEDBACK: "false",
    OMO_SEND_ANONYMOUS_TELEMETRY: "0",
    SCENARIO: "codeartsdoer",
    KERNEL_DATA_DIR: join(CODEARTS_HOME, "cli-data"),
    KERNEL_CONFIG_DIR: CODEARTS_HOME,
    OPENCODE_CHANNEL: "latest",
    OPENCODE_CONFIG: join(CODEARTS_HOME, "codearts_cli.json"),
    OPENCODE_CONFIG_FILE: "codearts_cli.json,codearts_cli.jsonc",
    OPENCODE_MODE: "tui",
    PLUGIN_ENV: "hc",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_ALWAYS_NOTIFY_UPDATE: "false",
    // 新版码道改用 CODEARTS_ 前缀；只设 OPENCODE_* 那组不生效，
    // 启动时会弹「是否立即升级? Yes/No」交互框，无人值守直接卡到超时。
    CODEARTS_DISABLE_AUTO_UPDATE: "true",
    ...extra,
  };
}

export function codeartsEnvNoBrowser() {
  return codeartsKernelEnv({
    // 阻止码道 CLI 拉起系统默认浏览器（OAuth 由 Playwright 处理）
    BROWSER: platform() === "win32" ? "cmd /c exit 0" : "/usr/bin/true",
    NO_BROWSER: "1",
  });
}

export function codeartsEnv() {
  return codeartsKernelEnv();
}

export function isCodeartsCliInstalled() {
  return existsSync(codeartsExe());
}

export function installCodeartsCli() {
  if (platform() === "win32") {
    execSync(`irm ${INSTALL_BASE}/install.ps1 | iex`, {
      shell: "powershell.exe",
      stdio: "inherit",
      timeout: 300000,
    });
  } else {
    execSync(`sh -c "$(curl -fsSL ${INSTALL_BASE}/install.sh)"`, {
      shell: "/bin/bash",
      stdio: "inherit",
      timeout: 300000,
    });
  }
}

export function getCodeartsVersion() {
  return execSync("codearts --version", {
    encoding: "utf8",
    env: codeartsEnv(),
    timeout: 30000,
    shell: platform() === "win32",
  }).trim();
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function getAuthExpires() {
  try {
    const data = readJsonSync(AUTH_JSON);
    return Number(data["inferhub-provider"]?.expires || 0);
  } catch {
    return 0;
  }
}

export function isCodeartsCliAuthenticated() {
  return getAuthExpires() > Date.now() + 60_000;
}

/** 与 CLI 子进程解绑，绝不 taskkill / Stop-Process（避免误杀码道 IDE） */
function detachProcess(proc, label = "codearts-cli") {
  if (!proc || proc.killed) return;
  try {
    proc.stdin?.end();
  } catch {
    /* ignore */
  }
  try {
    proc.unref();
  } catch {
    /* ignore */
  }
  console.log(`已与 ${label} 子进程解绑（pid=${proc.pid}），不终止任何进程`);
}

/** Win32 进程名与父 PID（PowerShell CIM，替代已弃用且常缺失的 wmic） */
function getWin32Process(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}') | Select-Object Name,ParentProcessId | ConvertTo-Json -Compress`;
    const out = execSync(`powershell -NoProfile -Command "${script}"`, {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const data = JSON.parse(out.trim());
    if (!data || typeof data !== "object") return null;
    return {
      name: data.Name || null,
      parentProcessId: Number(data.ParentProcessId) || 0,
    };
  } catch {
    return null;
  }
}

function isCodeArtsIdeProcessName(name) {
  if (!name) return false;
  if (/codeartsdoer|codearts\s*agent/i.test(name)) return false;
  return /CodeArts(?:\s*IDE)?\.exe$/i.test(name) || /DevStudio/i.test(name);
}

/** 单一路径段是否像码道 IDE 安装目录（排除 CLI / Doer / Agent） */
function isCodeArtsIdeInstallPath(segment) {
  if (!segment) return false;
  const s = segment.replace(/\\/g, "/");
  if (/codeartsdoer|codearts[\s._-]*agent|\.codearts-cli/i.test(s)) return false;
  return /\/CodeArts(?:\s+IDE)?(\/|$)/i.test(s) || /\/Huawei\/.*DevStudio/i.test(s);
}

function envSuggestsCodeArtsIde() {
  const segments = (process.env.PATH || "").split(delimiter);
  if (segments.some(isCodeArtsIdeInstallPath)) return true;
  const singles = [
    process.env.APPDATA,
    process.env.LOCALAPPDATA,
    process.execPath,
    process.env.VSCODE_CWD,
    process.env.TERM_PROGRAM,
  ].filter(Boolean);
  return singles.some(isCodeArtsIdeInstallPath);
}

/** 检查文件系统中是否存在码道 IDE 安装痕迹（不依赖进程链，最可靠） */
function detectCodeArtsIdeFiles() {
  const home = homedir();
  const candidates = [
    // IDE 数据目录
    join(home, ".codearts-ide"),
    join(home, "AppData", "Roaming", "CodeArts IDE"),
    join(home, "AppData", "Local", "CodeArts IDE"),
    join(home, ".codearts", "ide"),
    // IDE 可执行文件常见位置
    join(home, "AppData", "Local", "Programs", "CodeArts IDE", "CodeArts IDE.exe"),
    join(home, "AppData", "Local", "Programs", "@codearts-ide", "CodeArts IDE.exe"),
    // macOS
    join(home, "Applications", "CodeArts IDE.app"),
    join(home, "Library", "Application Support", "CodeArts IDE"),
    // Linux
    join(home, ".local", "share", "CodeArts IDE"),
  ];
  return candidates.some((p) => existsSync(p));
}

/**
 * 🔍 诊断模式：打印 IDE 检测的全部原始信息，用于在码道 IDE 中实测后分析
 * 设置 HWCLOUD_DIAGNOSE_IDE=1 即可启用
 */
export function dumpCodeArtsIdeDiagnostics() {
  if (process.env.HWCLOUD_DIAGNOSE_IDE !== "1") return;

  const lines = [];
  lines.push("========== 🔍 码道 IDE 检测诊断 ==========");

  // A. 全部环境变量（含 CodeArts / DevStudio / IDE / VSCODE 关键词的）
  lines.push("\n--- A. 环境变量 ---");
  for (const [k, v] of Object.entries(process.env).sort()) {
    if (/CODEARTS|DEVSTUDIO|VSCODE|IDE|WORKBENCH|CLOUDIDE|HUAWEI/i.test(k)) {
      const safe = v ? v.slice(0, 120) : "(empty)";
      lines.push(`  ${k}=${safe}`);
    }
  }
  if (process.env.HWCLOUD_ASSUME_CODEARTS_IDE) lines.push("  ⚡ HWCLOUD_ASSUME_CODEARTS_IDE=1 (手动覆盖)");
  if (process.env.HWCLOUD_FORCE_CODEARTS_QA) lines.push("  ⚡ HWCLOUD_FORCE_CODEARTS_QA=1 (强制 QA)");

  // B. PATH 中跟 IDE 相关的段
  lines.push("\n--- B. PATH 分析 ---");
  const sep = platform() === "win32" ? ";" : ":";
  const pathSegs = (process.env.PATH || "").split(sep);
  for (const s of pathSegs) {
    if (/CODEARTS|DEVSTUDIO/i.test(s)) lines.push(`  [IDE?] ${s}`);
  }
  lines.push(`  PATH 总段数: ${pathSegs.length}`);

  // C. 关键路径（APPDATA / HOME 下跟 IDE 相关的目录）
  lines.push("\n--- C. 文件系统扫描 ---");
  const home = homedir();
  const scanRoots = [
    join(home, ".codearts-ide"),
    join(home, ".codearts"),
    join(home, "AppData", "Roaming"),
    join(home, "AppData", "Local"),
    join(home, "AppData", "Local", "Programs"),
  ];
  for (const root of scanRoots) {
    if (!existsSync(root)) { lines.push(`  MISSING: ${root}`); continue; }
    try {
      const entries = readdirSync(root).filter(e => /CODEARTS|DEVSTUDIO/i.test(e));
      if (entries.length > 0) lines.push(`  ${root}/`);
      for (const e of entries) lines.push(`    ${e}`);
    } catch { lines.push(`  (no read): ${root}`); }
  }

  // D. 进程列表
  lines.push("\n--- D. 进程列表 ---");
  if (platform() === "win32") {
    try {
      const out = execSync(
        `powershell -NoProfile -Command "Get-Process -Name '*CodeArts*','*DevStudio*' -ErrorAction SilentlyContinue | Select-Object ProcessName,Id,ParentProcessId | ConvertTo-Json -Compress"`,
        { encoding: "utf8", timeout: 8000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      lines.push(`  CodeArts/DevStudio 进程: ${out.trim().slice(0, 1000)}`);
    } catch (e) {
      lines.push(`  (查询失败: ${e.message})`);
    }

    // D2. 当前进程父链
    lines.push("\n--- D2. 当前进程父链 (12层) ---");
    let pid = process.ppid;
    for (let depth = 0; depth < 12 && pid > 0; depth++) {
      const proc = getWin32Process(pid);
      if (proc) {
        const ideMark = isCodeArtsIdeProcessName(proc.name) ? " ← IDE!" : "";
        lines.push(`  [${depth}] pid=${pid} name=${proc.name} ppid=${proc.parentProcessId}${ideMark}`);
        pid = proc.parentProcessId;
      } else {
        lines.push(`  [${depth}] pid=${pid} (无法查询)`);
        break;
      }
      if (!Number.isFinite(pid)) break;
    }
  } else {
    try {
      const out = execSync("pgrep -fl 'CodeArts|DevStudio' 2>/dev/null || echo '(none)'", {
        encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
      });
      lines.push(`  CodeArts/DevStudio 进程: ${out.trim().slice(0, 500)}`);
    } catch { lines.push("  (pgrep 不可用)"); }
  }

  // E. CWD 和 execPath
  lines.push("\n--- E. 当前进程环境 ---");
  lines.push(`  cwd: ${process.cwd()}`);
  lines.push(`  execPath: ${process.execPath}`);
  lines.push(`  platform: ${platform()}`);
  lines.push(`  node: ${process.version}`);
  lines.push(`  ppid: ${process.ppid}`);
  lines.push(`  pid: ${process.pid}`);

  // F. 判定结果
  lines.push("\n--- F. 各层判定结果 ---");
  lines.push(`  env 匹配: ${(() => { for (const [k,v] of Object.entries(process.env)) { if (/CODEARTS.*(IDE|DEVSTUDIO|WORKBENCH)/i.test(k) && v) return true; } return false; })()}`);
  lines.push(`  PATH 匹配: ${envSuggestsCodeArtsIde()}`);
  lines.push(`  文件系统: ${detectCodeArtsIdeFiles()}`);
  lines.push(`  全局进程: ${detectCodeArtsIdeProcess()}`);
  if (platform() === "win32") {
    let found = false;
    let pid = process.ppid;
    for (let depth = 0; depth < 12 && pid > 0; depth++) {
      const proc = getWin32Process(pid);
      if (proc?.name && isCodeArtsIdeProcessName(proc.name)) { found = true; break; }
      pid = proc?.parentProcessId || 0;
    }
    lines.push(`  父链匹配: ${found}`);
  }
  lines.push(`\n  最终判定: detectCodeArtsIdeHost() = ${detectCodeArtsIdeHost()}`);

  lines.push("========== 🔍 诊断结束 ==========\n");
  console.log(lines.join("\n"));
}

/** 通过全局进程列表（不依赖父进程链）查找码道 IDE 进程 */
function detectCodeArtsIdeProcess() {
  try {
    if (platform() === "win32") {
      // 获取完整进程名列表，逐个用 isCodeArtsIdeProcessName 过滤（排除 CLI codearts.exe）
      const out = execSync(
        `powershell -NoProfile -Command "Get-Process -Name '*CodeArts*','*DevStudio*' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName"`,
        { encoding: "utf8", timeout: 8000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const names = out.split(/\r?\n/).map((n) => n.trim()).filter(Boolean);
      return names.some((n) => isCodeArtsIdeProcessName(n));
    } else {
      const out = execSync("pgrep -fl 'CodeArts IDE|DevStudio' 2>/dev/null || true", {
        encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
      });
      return out.trim().length > 0;
    }
  } catch {
    return false;
  }
}

export function detectCodeArtsIdeHost() {
  // 显式强制开关
  if (process.env.HWCLOUD_FORCE_CODEARTS_QA === "1") return false;

  // 第 1 层：环境变量（IDE 设置的特定变量）
  for (const [k, v] of Object.entries(process.env)) {
    if (/CODEARTS.*(IDE|DEVSTUDIO|WORKBENCH)/i.test(k) && v) return true;
  }

  // 第 2 层：PATH 嗅探（IDE 安装目录在 PATH 中）
  if (envSuggestsCodeArtsIde()) return true;

  // 第 3 层：文件系统（IDE 数据/安装目录存在，不依赖进程）——最可靠
  if (detectCodeArtsIdeFiles()) return true;

  // 第 4 层：全局进程列表（不依赖父进程链，避免 detached 导致断链）
  if (detectCodeArtsIdeProcess()) return true;

  // 第 5 层：进程父链回溯（原逻辑，保留作为兜底）
  if (platform() === "win32") {
    let pid = process.ppid;
    for (let depth = 0; depth < 12 && pid > 0; depth++) {
      const proc = getWin32Process(pid);
      if (proc?.name && isCodeArtsIdeProcessName(proc.name)) return true;
      pid = proc?.parentProcessId || 0;
      if (!Number.isFinite(pid)) break;
    }
  }

  return false;
}

export function isCodeArtsIdeHost() {
  if (process.env.HWCLOUD_ASSUME_CODEARTS_IDE === "1") return true;
  return detectCodeArtsIdeHost();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureAgentWorkspace() {
  if (!existsSync(AGENT_WORKSPACE)) {
    execSync(`mkdir "${AGENT_WORKSPACE}"`, { shell: true, stdio: "ignore" });
  }
  return AGENT_WORKSPACE;
}

const CODEARTS_SETTINGS_JSON = join(CODEARTS_HOME, "cli-data", "settings.json");

/**
 * 码道 CLI 启动时若工作目录不在 trustedFolders 会 fatal「文件夹未被信任」直接退出。
 * 启动前自动把工作目录写入信任列表（幂等；同时覆盖 KERNEL_DATA_DIR 的数据目录变体）。
 */
export function ensureCodeartsFolderTrusted() {
  const folders = [AGENT_WORKSPACE, CODEARTS_HOME];
  let settings = {};
  if (existsSync(CODEARTS_SETTINGS_JSON)) {
    try {
      settings = readJsonSync(CODEARTS_SETTINGS_JSON);
    } catch {
      settings = {};
    }
  }
  settings.security ||= {};
  settings.security.folderTrust ||= { enabled: true };
  settings.security.trustedFolders ||= [];

  const changed = [];
  for (const folder of folders) {
    if (!settings.security.trustedFolders.includes(folder)) {
      settings.security.trustedFolders.push(folder);
      changed.push(folder);
    }
  }

  if (changed.length) {
    const isWin = platform() === "win32";
    const tmp = isWin ? [CODEARTS_SETTINGS_JSON] : [CODEARTS_SETTINGS_JSON];
    // 直接覆写（cli-data 目录本就只有码道 CLI 使用）
    writeFileSync(tmp[0], `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }
  return { changed };
}

function listKernelLogs() {
  if (!existsSync(CLI_LOG_DIR)) return [];
  return readdirSync(CLI_LOG_DIR)
    .filter((f) => f.startsWith("kernel-codeartsdoer") && f.endsWith(".log"))
    .map((f) => {
      const p = join(CLI_LOG_DIR, f);
      return { path: p, mtime: statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function readLogTail(path, maxBytes = 500_000) {
  try {
    const buf = readFileSync(path);
    return buf.slice(Math.max(0, buf.length - maxBytes)).toString("utf8");
  } catch {
    return "";
  }
}

/**
 * 从 kernel 日志判断 TUI 是否完成对话（用户提问 + assistant 回复）
 * 只搜索本次提问之后的内容，避免匹配到历史会话的 finish:stop
 * @returns {{ ok: boolean, reply?: string, detail?: string }}
 */
export function analyzeTuiHiConversation(logContent, prompt = CODEARTS_TUI_PROMPT) {
  if (!logContent) return { ok: false };

  const promptKey = "python代码";

  // 1. 找到本次提问在日志中的位置
  const exactMatch = logContent.indexOf(`"text":"${prompt}"`);
  const fuzzyIdx = logContent.indexOf(promptKey);
  const promptIdx = exactMatch !== -1 ? exactMatch : fuzzyIdx;
  if (promptIdx === -1) return { ok: false };

  // 2. 只在此次提问之后的内容中搜索
  const afterPrompt = logContent.slice(promptIdx);

  // 3. 多完成标志检测（任一满足即可）
  const assistantFinished =
    /"role":"assistant"[\s\S]*?"finish":"stop"/.test(afterPrompt) ||
    /service=agent-finish-plugin/.test(afterPrompt) ||
    /"type":"result"[\s\S]*?"subtype":"success"/.test(afterPrompt);

  // 4. 检查是否有未处理的权限请求（在本次提问之后）
  const pendingPermission =
    /"type":"permission\.asked"/.test(afterPrompt) &&
    !/"permission\.(granted|denied)"/.test(afterPrompt);

  if (!assistantFinished || pendingPermission) {
    return { ok: false };
  }

  const replies = extractAssistantReplies(afterPrompt, prompt);
  const reply = replies.at(-1);

  if (reply) {
    return { ok: true, reply, detail: `码道 TUI 回复: ${reply.slice(0, 120)}` };
  }
  return { ok: true, detail: "码道 TUI 已收到提问并完成 assistant 回复" };
}

function extractAssistantReplies(logContent, prompt = CODEARTS_TUI_PROMPT) {
  return [...logContent.matchAll(/"type":"text","text":"((?:\\.|[^"\\])*)"/g)]
    .map((m) => m[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"))
    .filter(
      (t) =>
        t &&
        t !== prompt &&
        !t.includes("system-reminder") &&
        !t.includes("重要提示"),
    );
}

/** 自动化运行前放开 webfetch/browser，避免 TUI 卡在 permission.asked */
export function ensureCodeartsPermissionsForAgent() {
  if (!existsSync(PERMISSION_GLOBAL)) return { changed: [] };

  const rules = readJsonSync(PERMISSION_GLOBAL);
  const changed = [];

  for (const rule of rules) {
    if (
      AGENT_AUTO_ALLOW_PERMISSIONS.includes(rule.permission) &&
      rule.action === "ask"
    ) {
      rule.action = "allow";
      changed.push(rule.permission);
    }
  }

  if (changed.length) {
    writeFileSync(PERMISSION_GLOBAL, `${JSON.stringify(rules, null, 2)}\n`, "utf8");
  }

  return { changed };
}

const TUI_BOOT_TIMEOUT_MS = 30_000;

function quoteWinArg(text) {
  return `"${String(text).replace(/"/g, '\\"')}"`;
}

function resolveCodeartsLauncher(promptArgs) {
  const binDir = codeartsCliBinDir();
  // 优先用 .exe 直接路径（shell:false），避免 cmd.exe /c 导致 Bun CLI 卡在 TUI 启动画面
  const exe = codeartsExe();
  if (existsSync(exe)) {
    return { useShell: false, command: exe, args: promptArgs };
  }
  if (platform() === "win32") {
    const cmd = join(binDir, "codearts.cmd");
    if (existsSync(cmd)) {
      return {
        useShell: true,
        command: `${quoteWinArg(cmd)} ${promptArgs.map(quoteWinArg).join(" ")}`,
        args: [],
      };
    }
  }
  const sh = join(binDir, "codearts");
  if (existsSync(sh)) return { useShell: false, command: sh, args: promptArgs };
  return {
    useShell: false,
    command: existsSync(codeartsExe()) ? codeartsExe() : "codearts",
    args: promptArgs,
  };
}

function isTuiPromptSent(logContent, prompt = CODEARTS_TUI_PROMPT) {
  if (!logContent) return false;
  const promptKey = "python代码";
  return (
    logContent.includes(`"text":"${prompt}"`) ||
    (logContent.includes(promptKey) &&
      (/"role":"user"/.test(logContent) || /\[chat\.message\]/.test(logContent)))
  );
}

async function waitForTuiHiReply({ logsBefore, spawnTime }, timeoutMs = 90_000) {
  const bootStart = Date.now();
  let promptSentAt = null;
  let lastHeartbeat = bootStart;
  let emittedReplies = 0;
  let sawAnyOutput = false;

  // 用文件位置追踪代替 mtime，精确检测增量内容（mtime 可能有 FS 缓存延迟）
  /** @type {Map<string, number>} */
  const filePositions = new Map();

  while (true) {
    const now = Date.now();

    // 动态扩展超时：如果检测到 assistant 在生成内容但还没 finish，延长等待
    const effectiveTimeout = sawAnyOutput && !promptSentAt
      ? Math.max(timeoutMs, 180_000)
      : timeoutMs;

    if (!promptSentAt && now - bootStart > TUI_BOOT_TIMEOUT_MS) {
      return {
        ok: false,
        detail: `超时：码道 TUI 在 ${TUI_BOOT_TIMEOUT_MS / 1000}s 内未发出提问`,
      };
    }
    if (promptSentAt && now - promptSentAt > effectiveTimeout) {
      return {
        ok: false,
        detail: `超时：提问后 ${effectiveTimeout / 1000}s 内未检测到 assistant 回复（finish:stop）`,
      };
    }

    for (const { path, mtime } of listKernelLogs()) {
      const prevPos = filePositions.get(path) || 0;
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue;
      }
      if (stat.size <= prevPos) continue; // 没有新内容

      // 读取增量内容
      const fd = openSync(path, "r");
      const buf = Buffer.alloc(stat.size - prevPos);
      readSync(fd, buf, 0, buf.length, prevPos);
      closeSync(fd);
      const newContent = buf.toString("utf8");

      filePositions.set(path, stat.size);

      if (!promptSentAt && isTuiPromptSent(newContent)) {
        promptSentAt = Date.now();
        console.log(`码道已发出提问，等待回复（${effectiveTimeout / 1000}s）…`);
      }

      const replies = extractAssistantReplies(newContent);
      while (emittedReplies < replies.length) {
        sawAnyOutput = true;
        const reply = replies[emittedReplies];
        console.log(`[码道回复] ${reply}`);
        emittedReplies++;
      }

      // 用累积的全部内容（从 cli 启动开始到现在）做完成检测，但只搜索本次提问之后的部分
      const fullContent = readLogTail(path);
      const result = analyzeTuiHiConversation(fullContent);
      if (result.ok) {
        if (result.reply && emittedReplies === 0) {
          console.log(`[码道回复] ${result.reply}`);
        }
        return result;
      }
    }

    if (now - lastHeartbeat >= 10_000) {
      if (!promptSentAt) {
        const bootSec = Math.floor((now - bootStart) / 1000);
        console.log(`码道 TUI 启动中… ${bootSec}s（等待发出提问，通常 <10s）`);
      } else {
        const replySec = Math.floor((now - promptSentAt) / 1000);
        const hint = sawAnyOutput ? "已有部分回复" : "尚无回复（可能在排队）";
        console.log(
          `码道 TUI 等待回复… ${replySec}s / ${effectiveTimeout / 1000}s（${hint}，超时将跳过）`,
        );
      }
      lastHeartbeat = now;
    }
    await sleep(1000);
  }
}

function parseAuthUrl(text) {
  return stripAnsi(text).match(AUTH_URL_RE)?.[0] ?? null;
}

function readAuthUrlFromLatestLog(sinceMs = 0) {
  // 只读取本次运行之后创建/更新的日志，避免拿到上一次运行的过期链接
  const logs = listKernelLogs().filter((l) => !sinceMs || l.mtime >= sinceMs - 3000);
  if (!logs.length) return null;
  const content = readFileSync(logs[0].path, "utf8");
  // 优先取最后一条「opening browser」记录中的完整 URL（保证 port 与 ticket 来自同一次尝试）
  const urls = [
    ...content.matchAll(/url=(https:\/\/codearts\.huaweicloud\.com\/portal\/authorize\?[^\s"'\\]+)/g),
  ];
  if (urls.length) return urls.at(-1)[1];
  // 兜底：手工拼接（同样取最后一条记录）
  const ticket = [...content.matchAll(/ticketId=([a-f0-9]+)/gi)].at(-1)?.[1];
  const port = [...content.matchAll(/oauth callback server started" port=(\d+)/g)].at(-1)?.[1];
  if (!ticket || !port) return null;
  const q = new URLSearchParams({
    client_id: "CodeArts_Tui",
    port,
    code_challenge_method: "SHA-256",
    ticket_id: ticket,
  });
  return `https://codearts.huaweicloud.com/portal/authorize?${q.toString()}`;
}

/** 清理残留的旧 CLI 进程（独立 Agent 环境安全，不涉及码道 IDE） */
function killStaleCodeartsProcesses() {
  if (platform() !== "win32") return;
  try {
    const myPid = process.pid;
    execSync(`taskkill /f /im codearts.exe /fi "PID ne ${myPid}"`, {
      timeout: 5000,
      windowsHide: true,
      stdio: "ignore",
    });
    console.log("已清理残留的码道 CLI 进程");
  } catch {
    /* 可能没有残留进程，忽略 */
  }
}

function spawnCodeartsAuthTrigger() {
  const output = { text: "" };

  // 清理旧 CLI 进程，避免端口/状态冲突
  killStaleCodeartsProcesses();

  // 文件夹信任（不修复会 fatal 退出）
  ensureCodeartsFolderTrusted();

  // 直接用 .exe 路径 + shell:false，避免 cmd.exe /c 导致 Bun CLI 卡在 TUI 启动画面（实测 shell:true 会卡住）
  const exe = codeartsExe();
  const proc = spawn(exe, [], {
    env: codeartsEnvNoBrowser(),
    cwd: ensureAgentWorkspace(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const onData = (chunk) => {
    output.text += chunk.toString();
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
  setTimeout(() => {
    try {
      proc.stdin?.write("n\r\n");
    } catch {
      /* ignore */
    }
  }, 2500);
  return { proc, output };
}

async function waitForAuthUrl(output, timeoutMs = 45000, sinceMs = 0) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const fromOutput = parseAuthUrl(output.text);
    if (fromOutput) return fromOutput;
    if (Date.now() - start > 5000) {
      const fromLog = readAuthUrlFromLatestLog(sinceMs || start);
      if (fromLog) return fromLog;
    }
    if (/OAuth callback timeout|Login exception/i.test(stripAnsi(output.text))) return null;
    await sleep(500);
  }
  return parseAuthUrl(output.text) || readAuthUrlFromLatestLog(sinceMs || start);
}

async function waitForOAuthComplete(output, expiresBefore, timeoutMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (/OAuth callback timeout|Login exception/i.test(stripAnsi(output.text))) return false;
    if (getAuthExpires() > expiresBefore + 500) return true;
    await sleep(1000);
  }
  return getAuthExpires() > expiresBefore;
}

async function clickConfirmAuthButton(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  await sleep(2000);

  const selectors = [
    () => page.getByRole("button", { name: "确认授权" }),
    () => page.getByRole("button", { name: /确认授权|同意授权|授权登录|Authorize/i }),
    () => page.locator('button:has-text("确认授权")'),
    () => page.locator('button:has-text("授权")'),
    () => page.locator('[class*="confirm"], [class*="authorize"]').filter({ hasText: /授权/ }),
    () => page.locator('input[type="submit"][value*="授权"]'),
    () => page.locator('a:has-text("确认授权")'),
    () => page.locator('[class*="btn-primary"]:has-text("授权"), [class*="primary"]:has-text("授权")'),
  ];

  for (const pick of selectors) {
    try {
      const btn = pick();
      const count = await btn.count();
      if (count === 0) continue;
      await btn.first().waitFor({ state: "visible", timeout: 30000 });
      await btn.first().click({ timeout: 15000 });
      return "确认授权";
    } catch {
      /* try next selector */
    }
  }

  // 未找到按钮：页面可能已免点击自动完成授权并跳转（如「登录成功 / 请返回客户端」页）
  const bodyText = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ");
  if (/login_succeed=true|登录成功|请返回客户端/.test(`${page.url()} ${bodyText}`)) {
    console.log("授权页已自动完成跳转（无需点击按钮）");
    return "已自动授权";
  }

  // 全部选择器失败 → 截图保存便于调试
  try {
    const { mkdirSync } = await import("node:fs");
    const probeDir = join(CODEARTS_HOME, "probe-oauth");
    mkdirSync(probeDir, { recursive: true });
    const screenshotPath = join(probeDir, `oauth-fail-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`OAuth 授权页截图已保存: ${screenshotPath}`);
  } catch {
    /* screenshot optional */
  }

  const snippet = (await page.innerText("body").catch(() => "")).replace(/\s+/g, " ").slice(0, 240);
  throw new Error(`未找到「确认授权」按钮；当前 URL=${page.url()}；页面片段=${snippet}`);
}

/** @param {import('playwright').BrowserContext} context */
export async function confirmCodeartsBrowserAuth(context, authUrl, { headed = false } = {}) {
  console.log(
    headed
      ? "弹出有界面浏览器完成码道「确认授权」（headless 模式下 OAuth 必须可见）…"
      : "Playwright 打开授权页并点击「确认授权」…",
  );

  let authPage;
  let headedBrowser;

  try {
    if (headed) {
      const { chromium } = await import("playwright");
      // 优先使用系统安装的 Google Chrome（无则回退 Playwright 自带 chromium）
      headedBrowser = await chromium.launch({
        headless: false,
        args: ["--start-maximized"],
        channel: "chrome",
      }).catch(() => chromium.launch({ headless: false, args: ["--start-maximized"] }));
      const headedContext = await headedBrowser.newContext({
        storageState: await context.storageState(),
        locale: "zh-CN",
        viewport: null,
      });
      authPage = await headedContext.newPage();
    } else {
      authPage = await context.newPage();
      await authPage.bringToFront();
    }

    await authPage.goto(authUrl, { timeout: 90000, waitUntil: "domcontentloaded" });
    const clicked = await clickConfirmAuthButton(authPage);
    await sleep(2000);
    return clicked;
  } finally {
    if (headedBrowser) {
      await headedBrowser.close().catch(() => {});
    } else {
      await authPage?.close().catch(() => {});
    }
  }
}

/** @param {import('playwright').BrowserContext} context */
export async function ensureCodeartsBrowserAuth(context, { headedAuth = false } = {}) {
  if (isCodeartsCliAuthenticated()) {
    return { ok: true, detail: "码道 CLI OAuth 有效" };
  }

  const expiresBefore = getAuthExpires();
  const authTriggerStartedAt = Date.now();
  const { proc, output } = spawnCodeartsAuthTrigger();
  try {
    const authUrl = await waitForAuthUrl(output, 45000, authTriggerStartedAt);
    if (!authUrl) {
      // CLI 可能已通过 refresh token 静默刷新认证，二次检查
      if (isCodeartsCliAuthenticated()) {
        return { ok: true, detail: "码道 CLI 已通过刷新令牌自动登录" };
      }
      return {
        ok: false,
        detail:
          "未能获取码道 CLI 授权链接；若系统浏览器已打开授权页，请手动点击「确认授权」后重试",
      };
    }
    console.log(`授权链接: ${authUrl}`);
    console.log(
      "⚠️ 系统浏览器可能会弹出授权页——请不要手动操作，Playwright 正在自动完成授权（OAuth 回调走 localhost，无论哪个浏览器完成均可）",
    );
    await confirmCodeartsBrowserAuth(context, authUrl, { headed: headedAuth });
    const ok = await waitForOAuthComplete(output, expiresBefore);
    if (!ok) {
      return {
        ok: false,
        detail:
          "CLI 未收到 OAuth 回调；请在授权页点击「确认授权」，或运行 npm run agent（有界面）重试",
      };
    }
    return { ok: true, detail: "CLI 浏览器授权成功" };
  } finally {
    detachProcess(proc, "codearts-auth-trigger");
  }
}

/** 码道 TUI 默认模型：GLM-5.2 实测不排队（openpangu-2.0-pro 常排 8~9 位，flash 排 4 位） */
const DEFAULT_CODEARTS_MODEL = "huaweicloud-maas/GLM-5.2";

export function codeartsTuiModel() {
  return process.env.HWCLOUD_CODEARTS_MODEL || DEFAULT_CODEARTS_MODEL;
}

/** 在码道 TUI 中发送每日提问（--prompt），通过 kernel 日志检测 assistant 回复 */
export function spawnCodeartsTuiHi() {
  const workspace = ensureAgentWorkspace();
  ensureCodeartsFolderTrusted();
  const logsBefore = new Set(listKernelLogs().map((l) => l.path));
  const spawnTime = Date.now();
  const model = codeartsTuiModel();
  console.log(`码道 TUI 模型: ${model}`);
  const launcher = resolveCodeartsLauncher([
    "-m",
    model,
    "--prompt",
    CODEARTS_TUI_PROMPT,
  ]);

  const spawnOpts = {
    env: codeartsEnvNoBrowser(),
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: false,
  };

  const proc = launcher.useShell
    ? spawn(launcher.command, [], { ...spawnOpts, shell: true })
    : spawn(launcher.command, launcher.args, { ...spawnOpts, shell: false });

  const flushStream = (chunk) => {
    const text = stripAnsi(chunk.toString());
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t) console.log(`[码道] ${t}`);
    }
  };
  proc.stdout?.on("data", flushStream);
  proc.stderr?.on("data", flushStream);

  return { proc, logsBefore, spawnTime };
}

/** @param {import('playwright').BrowserContext} context */
export async function sendHiViaCodeartsTui(context, { headedAuth = false, tuiTimeoutMs = 90_000 } = {}) {
  const auth = await ensureCodeartsBrowserAuth(context, { headedAuth });
  if (!auth.ok) return auth;
  if (auth.detail !== "码道 CLI OAuth 有效") {
    console.log(auth.detail);
  }

  const perm = ensureCodeartsPermissionsForAgent();
  if (perm.changed.length) {
    console.log(`已自动放开码道权限: ${perm.changed.join(", ")}`);
  }

  console.log(`启动码道 TUI 并提问: ${CODEARTS_TUI_PROMPT}`);
  const { proc, logsBefore, spawnTime } = spawnCodeartsTuiHi();

  // 监听进程异常退出（Bun segfault 等），用于区分"成功但崩溃"和"崩溃未完成"
  let procExited = false;
  let procExitCode = null;
  proc.on("exit", (code) => {
    procExited = true;
    procExitCode = code;
  });

  let result;
  try {
    result = await waitForTuiHiReply({ logsBefore, spawnTime }, tuiTimeoutMs);
  } finally {
    // 先评估结果再 detach
    if (procExited && procExitCode !== 0 && !result?.ok) {
      console.log(`码道 CLI 异常退出(code=${procExitCode})，可能是 Bun 崩溃`);
      result = { ok: false, detail: `码道 CLI 异常退出(code=${procExitCode})，Bun 可能已崩溃` };
    } else if (procExited && procExitCode !== 0 && result?.ok) {
      console.log("码道 CLI 退出时崩溃(Bun segfault)，但回复已成功获取——不影响本次任务");
    }
    detachProcess(proc, "codearts-tui");
  }

  if (result.ok) {
    return { ok: true, detail: result.detail };
  }
  return {
    ok: false,
    detail: result.detail || `TUI 未完成对话（等待 ${tuiTimeoutMs / 1000}s）`,
  };
}

/** @param {import('playwright').BrowserContext} context */
export async function sendHiViaCodeartsCli(context, options = {}) {
  return sendHiViaCodeartsTui(context, options);
}

/** @returns {{ installed: boolean, version?: string, detail: string }} */
export function ensureCodeartsCli() {
  if (isCodeartsCliInstalled()) {
    try {
      const version = getCodeartsVersion();
      return { installed: true, version, detail: `已安装 ${version}` };
    } catch {
      return { installed: true, detail: "已检测到 codearts 命令" };
    }
  }

  try {
    console.log("正在安装码道 CLI…");
    installCodeartsCli();
    return { installed: true, version: getCodeartsVersion(), detail: `新安装 ${getCodeartsVersion()}` };
  } catch (e) {
    return { installed: false, detail: `安装失败: ${e.message}` };
  }
}
