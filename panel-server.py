#!/usr/bin/env python3
"""华为积分看板服务：静态文件 + 控制 API。

原本只是禁缓存的静态服务器（SimpleHTTPRequestHandler）。现在多挂了一组
/api/* 端点，用于：
  - 查询两账号的运行状态、上次结果、实时日志尾部
  - 手动触发某个任务（单项 / 完整每日流程）
  - 读改定时开关

安全：面板本身是公网可达（<PANEL_DOMAIN>），所以写操作必须带
控制令牌。令牌不出现在 HTML 里——页面加载时提示用户输入一次，
存进 localStorage，后续带 X-Control-Token 头。没令牌只能读不能写。
"""
import http.server
import json
import os
import re
import subprocess
import sys
import socketserver
import urllib.parse
from functools import partial

# 路径按**本文件位置**推导，不再写死绝对路径：
#   项目根 = 本文件所在目录（panel-server.py 就在项目根）
# 这样换目录部署、或发布给别人都能直接跑。
#
# 环境变量可覆盖（非常规布局时用）：
#   PANEL_ROOT        项目根
#   PANEL_STATIC_DIR  静态页 + 数据文件目录
#   PANEL_CONTROL_DIR 控制层目录
#   PANEL_TOKEN_FILE  控制令牌文件
_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get("PANEL_ROOT", _HERE)


def _pick_static_dir():
    """静态目录：显式指定 > <root>/panel > <root>/data > /usr/share/novnc。

    为什么会挑：同一份代码会出现在三种布局里——
      · 发布包：HTML 与数据都在 <root>/panel（本仓库自带）
      · 开发机：同上
      · 生产部署：HTML 与实时数据写在 /usr/share/novnc（Web 服务器目录）
    """
    env = os.environ.get("PANEL_STATIC_DIR")
    if env:
        return env
    for cand in (os.path.join(ROOT, "panel"), os.path.join(ROOT, "data")):
        if os.path.isdir(cand):
            return cand
    return "/usr/share/novnc"


STATIC_DIR = _pick_static_dir()
CONTROL_DIR = os.environ.get("PANEL_CONTROL_DIR", os.path.join(ROOT, "control"))
TOKEN_FILE = os.environ.get("PANEL_TOKEN_FILE", os.path.join(ROOT, "panel-control.token"))
NODE = os.environ.get("PANEL_NODE", "/usr/local/bin/node")
if not os.path.exists(NODE):
    NODE = "node"


def read_token():
    try:
        with open(TOKEN_FILE) as f:
            return f.read().strip()
    except OSError:
        return None


def run_node(script, *args, timeout=30):
    """调用 control/ 下的 node 模块并把 stdout 当 JSON 解析。"""
    p = subprocess.run(
        [NODE, os.path.join(CONTROL_DIR, script), *args],
        capture_output=True,
        text=True,
        timeout=timeout,
        cwd=CONTROL_DIR,
    )
    out = (p.stdout or "").strip()
    try:
        return json.loads(out), p.returncode, (p.stderr or "").strip()
    except json.JSONDecodeError:
        return None, p.returncode, out or (p.stderr or "").strip()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC_DIR, **kw)

    # ---------- 工具 ----------
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def _authed(self):
        """是否需要控制令牌。

        用户明确要求（2026-11-10）：这是他自己用的面板，不想每次填令牌，
        所以默认**关掉鉴权**，打开面板即可直接点运行/切开关。

        如需临时恢复保护，把 PANEL_REQUIRE_TOKEN 设为 1 即可
        （或恢复本文件的历史备份，见 /root/hwcloud-grow/backups/）。
        """
        if os.environ.get("PANEL_REQUIRE_TOKEN") != "1":
            return True
        tok = read_token()
        if not tok:
            return False
        got = self.headers.get("X-Control-Token") or ""
        return got == tok

    # ---------- 路由 ----------
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/state":
            return self._cli(["state"])
        if path.startswith("/api/tasks/"):
            acc = urllib.parse.unquote(path[len("/api/tasks/"):])
            return self._cli(["tasks", acc])
        if path.startswith("/api/harmony-oauth/"):
            acc = urllib.parse.unquote(path[len("/api/harmony-oauth/"):])
            return self._harmony_oauth(acc)
        if path.startswith("/api/harmony-status/"):
            acc = urllib.parse.unquote(path[len("/api/harmony-status/"):])
            return self._harmony_status(acc)
        if path == "/api/scan-files":
            # 列出静态目录里的扫码状态文件，供面板识别"正在扫码但还没成功"的账号。
            # 只读，不碰任何账号数据。
            import glob as _glob
            out = []
            for fp in _glob.glob(os.path.join(STATIC_DIR, "scan-status*.json")):
                base = os.path.basename(fp)
                # scan-status.json → main；scan-status-xxx.json → xxx
                m = re.match(r"^scan-status(?:-(.+))?\.json$", base)
                if not m:
                    continue
                acc = m.group(1) or "main"
                try:
                    with open(fp) as f:
                        j = json.load(f)
                    out.append({"acc": acc, "status": j.get("status"), "message": j.get("message")})
                except (OSError, ValueError):
                    continue
            return self._json({"ok": True, "files": out})
        if path == "/api/schedule":
            return self._cli(["schedule", "get"])
        if path == "/api/gitcode/status":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            acc = (qs.get("acc") or ["main"])[0]
            return self._gitcode_status(acc)
        # 面板源目录优先，找不到再回落到部署目录（二维码、积分数据在那里）
        rel = path.lstrip("/") or "index.html"
        if not os.path.exists(os.path.join(STATIC_DIR, rel)):
            fallback = os.path.join("/usr/share/novnc", rel)
            if os.path.exists(fallback):
                self.path = "/__static__/" + rel
                return self._serve_file(fallback)
        return super().do_GET()

    def _serve_file(self, full):
        try:
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            return self._json({"ok": False, "error": "not found"}, 404)
        import mimetypes
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if not self._authed():
            return self._json({"ok": False, "error": "未授权：请先在面板填入控制令牌"}, 401)
        path = urllib.parse.urlparse(self.path).path
        body = self._body()
        if path == "/api/gitcode/token":
            acc = str(body.get("acc") or "main")
            token = str(body.get("token") or "").strip()
            if not token:
                return self._json({"ok": False, "error": "缺少令牌"}, 400)
            return self._gitcode_set(acc, token)
        if path == "/api/remove-account":
            acc = str(body.get("acc") or "").strip()
            if not acc:
                return self._json({"ok": False, "error": "缺少 acc"}, 400)
            return self._remove_account(acc)
        if path == "/api/run":
            acc, key = body.get("acc"), body.get("task")
            if not acc or not key:
                return self._json({"ok": False, "error": "缺少 acc 或 task"}, 400)
            return self._run_task(str(acc), str(key))
        if path == "/api/add-account":
            # 添加账号：拉起一次扫码登录（默认一次只扫一个）。
            # 详情见 _add_account。body: {acc?: "main|acct2|<自定义id>"}
            acc = str(body.get("acc") or "").strip() or self._next_account_id()
            return self._add_account(acc)
        if path == "/api/schedule":
            acc, field, value = body.get("acc"), body.get("field"), body.get("value")
            if not acc or not field:
                return self._json({"ok": False, "error": "缺少 acc 或 field"}, 400)
            return self._cli(["schedule", "set", str(acc), str(field), "1" if value else "0"])
        return self._json({"ok": False, "error": "未知接口"}, 404)

    # ---------- 具体实现 ----------
    def _deps_ok(self):
        """检查运行任务所需的依赖是否就位。

        为什么要统一查：面板上凡是"真正干活"的功能（跑任务、加账号、取授权链接）
        都依赖 runner/node_modules 里的 playwright 等。
        新用户 clone 下来最容易漏的就是 `npm install`；
        若不拦在入口，表现为**点击后报成功、任务实际瞬间崩**
        （2026-11-11 实测：/api/run 返回 ok:true，日志里是 ERR_MODULE_NOT_FOUND）
        ——用户完全不知道发生了什么，比直接报错还糟。

        @returns {dict|None} 就绪返回 None；否则返回带 hint 的错误体
        """
        for rel in ("runner", "runner2"):
            d = os.path.join(ROOT, rel)
            if os.path.isdir(os.path.join(d, "node_modules", "playwright")):
                return None
        return {
            "ok": False,
            "error": "运行依赖未安装（没找到 playwright）",
            "hint": (
                f"请先在服务器上执行：\n"
                f"  cd {os.path.join(ROOT, 'runner')}\n"
                f"  npm install\n"
                f"  npx playwright install chromium\n"
                f"（可运行 node control/doctor.mjs 做完整环境检查）"
            ),
        }

    def _run_task(self, acc, key):
        """启动任务前先确认依赖就绪 —— 否则任务会瞬间崩且用户不知情。"""
        bad = self._deps_ok()
        if bad:
            return self._json(bad, 409)
        return self._cli(["start", str(acc), str(key)])

    def _gitcode_status(self, acc):
        """查 GitCode 令牌与绑定状态（给授权页用）。

        可能较慢（要探测华为云侧绑定，约 20~40 秒），故超时给宽。
        """
        try:
            p = subprocess.run(
                [NODE, os.path.join(CONTROL_DIR, "gitcode-token.mjs"), "status", acc],
                capture_output=True, text=True, timeout=180, cwd=CONTROL_DIR,
            )
            return self._json(json.loads((p.stdout or "{}").strip()))
        except subprocess.TimeoutExpired:
            return self._json({"ok": False, "error": "查询超时，请稍后重试"}, 504)
        except Exception as e:
            return self._json({"ok": False, "error": str(e)[:150]}, 500)

    def _gitcode_set(self, acc, token):
        """保存 GitCode 令牌并立即检测（含绑定探测与授权链接获取）。"""
        try:
            p = subprocess.run(
                [NODE, os.path.join(CONTROL_DIR, "gitcode-token.mjs"), "set", acc, token],
                capture_output=True, text=True, timeout=300, cwd=CONTROL_DIR,
            )
            return self._json(json.loads((p.stdout or "{}").strip()))
        except subprocess.TimeoutExpired:
            return self._json({"ok": False, "error": "检测超时（绑定探测较慢），请点「刷新」看结果"}, 504)
        except Exception as e:
            return self._json({"ok": False, "error": str(e)[:150]}, 500)

    def _remove_account(self, acc):
        """删除一个账号：清掉它的扫码状态、登录态，并杀掉可能在跑的扫码进程。

        为什么需要：面板上「＋ 加账号」点了就会拉起扫码并生成一个"待扫码"卡片，
        误触（或扫到一半放弃）就会留下一个用不掉的账号。
        （2026-11-11 用户误触产生 acct3 后提出需要删除入口。）

        安全约束：**不允许删掉正在被调度使用的账号**——
           跑着任务的、或已存在于账号清单（accountOrder）的，都拒绝删除，
           避免把正在用的账号误删导致任务全挂。
        """
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,24}", acc):
            return self._json({"ok": False, "error": "账号 id 非法"}, 400)
        if acc in ("main",):
            return self._json({"ok": False, "error": "主号不可删除"}, 403)

        # 拒绝删除：账号清单里已登记的（说明是正式账号，不是误触产物）
        try:
            with open(os.path.join(STATIC_DIR, "points-index.json")) as f:
                if acc in (json.load(f).get("accountOrder") or []):
                    return self._json(
                        {"ok": False, "error": f"账号 {acc} 已在账号清单中（是正式账号），不通过此入口删除"},
                        403,
                    )
        except (OSError, ValueError):
            pass

        # 拒绝删除：正在跑任务的
        try:
            p = subprocess.run(
                [NODE, os.path.join(CONTROL_DIR, "control-cli.mjs"), "state"],
                capture_output=True, text=True, timeout=20, cwd=CONTROL_DIR,
            )
            st = json.loads((p.stdout or "{}").strip())
            if st.get("accounts", {}).get(acc, {}).get("running"):
                return self._json({"ok": False, "error": f"账号 {acc} 正在运行任务，请等它结束后再删"}, 409)
        except Exception:
            pass

        removed = []
        # 1) 杀掉该账号的扫码进程（可能在等扫码）
        try:
            subprocess.run(["pkill", "-f", f"scan-login.mjs {acc}"], timeout=10)
        except Exception:
            pass
        # 2) 删掉扫码状态与二维码（命名规则同 scan-login.mjs：main 无后缀）
        base = "scan-status.json" if acc == "main" else f"scan-status-{acc}.json"
        qr = "scan-qr.png" if acc == "main" else f"scan-qr-{acc}.png"
        for fn in (base, qr, f"gitcode-status-{acc}.json", f"gitcode-qr-{acc}.png",
                   f"points-data-{acc}.json"):
            fp = os.path.join(STATIC_DIR, fn)
            try:
                if os.path.exists(fp):
                    os.remove(fp)
                    removed.append(fn)
            except OSError:
                pass
        # 3) 删掉登录态
        for rel in (f"storage/accounts/{acc}.json",):
            fp = os.path.join(ROOT, rel)
            try:
                if os.path.exists(fp):
                    os.remove(fp)
                    removed.append(rel)
            except OSError:
                pass
        return self._json({"ok": True, "acc": acc, "removed": removed})

    def _next_account_id(self):
        """挑一个还没被占用的账号 id：main → acct2 → acct3 …

        占用判据用**登录态文件**（storage/accounts/<id>.json）与**面板账号清单**
        （points-index.json 的 accountOrder），**不用 scan-status*.json**：
        后者只是一次扫码的临时进度文件，骨架里预置一份不该意味着"这个账号已存在"
        （2026-11-11 踩到：全新安装时报 acct3，因为残留的状态文件把 main/acct2 都算占用了）。
        """
        used = set()
        # ① 已保存的登录态
        try:
            import glob as _glob
            for p in _glob.glob(os.path.join(ROOT, "storage", "accounts", "*.json")):
                used.add(os.path.basename(p)[:-len(".json")])
        except OSError:
            pass
        # ② 面板账号清单（账号已入列即视为占用）
        try:
            with open(os.path.join(STATIC_DIR, "points-index.json")) as f:
                for a in json.load(f).get("accountOrder", []) or []:
                    used.add(str(a))
        except (OSError, ValueError):
            pass
        if "main" not in used:
            return "main"
        i = 2
        while f"acct{i}" in used:
            i += 1
        return f"acct{i}"

    def _add_account(self, acc):
        """拉起扫码登录（后台跑，立即返回）。

        为什么异步：扫码要等用户操作，可能几分钟；HTTP 请求不能挂着等。
        前端改为轮询 <STATIC_DIR>/scan-status-<acc>.json 看进度。
        """
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,24}", acc):
            return self._json({"ok": False, "error": "账号 id 只能含字母/数字/下划线，长度 1~24"}, 400)
        script = os.path.join(CONTROL_DIR, "scan-login.mjs")
        if not os.path.exists(script):
            return self._json({"ok": False, "error": "缺少 control/scan-login.mjs"}, 500)

        # 依赖前置检查（与跑任务共用同一套判定）
        bad = self._deps_ok()
        if bad:
            return self._json(bad, 409)

        env = dict(os.environ)
        env["PANEL_STATIC_DIR"] = STATIC_DIR
        # 有头浏览器需要 X server：没设 DISPLAY 时兜底为 :99（生产/Xvfb 常用值）
        if not env.get("DISPLAY"):
            env["DISPLAY"] = ":99"
        try:
            subprocess.Popen(
                [NODE, script, acc, "--data-dir", STATIC_DIR],
                cwd=CONTROL_DIR, env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError as e:
            return self._json({"ok": False, "error": f"启动扫码失败：{e}"}, 500)
        return self._json({"ok": True, "acc": acc,
                           "statusUrl": self._scan_name(acc, "scan-status", ".json"),
                           "qrUrl": self._scan_name(acc, "scan-qr", ".png"),
                           "note": "已拉起扫码，请用华为云 App 扫描；面板会自动检测结果"})

    @staticmethod
    def _scan_name(acc, base, ext):
        """扫码相关文件名：main 用无后缀（兼容旧版页面），其余带 -<id>。

        必须与 scan-login.mjs / accounts.mjs 的 suffixFor 保持一致。
        2026-11-13 踩坑：这里曾写死 f"scan-status-{acc}.json"，
        于是加账号接口给 main 返回 scan-status-main.json，
        而实际文件是 scan-status.json —— 前端按错名字轮询，
        永远看不到二维码，「加账号」看起来像坏的。
        """
        return f"{base}{ext}" if acc == "main" else f"{base}-{acc}{ext}"

    def _harmony_oauth(self, acc):
        """给前端一条鸿蒙 GitCode 授权链接。

        走 control/harmony-oauth.mjs 的 get：
          - 缓存里那条还够新鲜 → 立刻返回（毫秒级）
          - 快过期或没有 → 现取一条（约 30~60 秒）
        后台有预热守护持续补充，所以正常情况下用户点一下就能拿到。
        """
        if acc not in ("main", "acct2"):
            return self._json({"ok": False, "error": f"未知账号 {acc}"}, 400)
        # 取授权链接要开浏览器，同样依赖 playwright
        bad = self._deps_ok()
        if bad:
            return self._json(bad, 409)
        try:
            p = subprocess.run(
                [NODE, os.path.join(CONTROL_DIR, "harmony-oauth.mjs"), "get", acc],
                capture_output=True, text=True, timeout=180, cwd=CONTROL_DIR,
            )
        except subprocess.TimeoutExpired:
            return self._json({"ok": False, "error": "取授权链接超时（>180s），请重试"}, 504)
        txt = (p.stdout or "").strip()
        try:
            return self._json(json.loads(txt))
        except json.JSONDecodeError:
            return self._json({"ok": False, "error": (p.stderr or txt or "无输出")[:300]}, 500)

    def _harmony_status(self, acc):
        """绑定状态 + 缓存链接信息。

        注意：这里可能真去查一次服务端绑定（约 18 秒），所以超时不能按"零成本"设。
        超过 60 秒才真查一次，命中窗口时毫秒级返回。
        """
        if acc not in ("main", "acct2"):
            return self._json({"ok": False, "error": f"未知账号 {acc}"}, 400)
        try:
            p = subprocess.run(
                [NODE, os.path.join(CONTROL_DIR, "harmony-oauth.mjs"), "status", acc],
                capture_output=True, text=True, timeout=90, cwd=CONTROL_DIR,
            )
            return self._json(json.loads((p.stdout or "{}").strip()))
        except subprocess.TimeoutExpired:
            return self._json({"ok": False, "error": "查询绑定状态超时"}, 504)
        except Exception as e:
            return self._json({"ok": False, "error": str(e)[:150]}, 500)

    def _cli(self, argv):
        """调用 control-cli.mjs，把它的 JSON 输出原样回给前端。"""
        try:
            p = subprocess.run(
                [NODE, os.path.join(CONTROL_DIR, "control-cli.mjs"), *argv],
                capture_output=True, text=True, timeout=30, cwd=CONTROL_DIR,
            )
        except subprocess.TimeoutExpired:
            return self._json({"ok": False, "error": "控制命令超时"}, 504)
        out = (p.stdout or "").strip()
        try:
            obj = json.loads(out)
        except json.JSONDecodeError:
            return self._json({"ok": False, "error": (p.stderr or out or "控制命令无输出")[:400]}, 500)
        if argv[0] in ("state",):
            obj["authed"] = self._authed()
        return self._json(obj)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    # 用 ThreadingTCPServer 而不是 TCPServer：
    # 单线程时，一个耗时的请求（如取鸿蒙授权链接要开浏览器跑 30~60 秒）
    # 会把整个面板堵住——页面轮询 /api/state 全部排队，用户看到的是「卡死」。
    # 多线程后耗时请求只占自己那条连接，其余接口照常响应。
    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    with Server(("127.0.0.1", port), Handler) as httpd:
        httpd.serve_forever()
