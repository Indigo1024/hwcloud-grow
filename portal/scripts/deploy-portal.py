#!/usr/bin/env python3
"""Deploy hwcloud-grow portal dist/ to Huawei Cloud ECS via SSH + Nginx."""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"
REMOTE_DIR = "/var/www/html/grow-portal"
NGINX_SITE = "/etc/nginx/sites-enabled/openclaw"
URL_PATH = "/grow-portal/"

NGINX_BLOCK = """
    # hwcloud-grow Agent task portal
    location = /grow-portal {
        return 301 http://$host/grow-portal/;
    }

    location /grow-portal/ {
        alias /var/www/html/grow-portal/;
        index index.html;
        try_files $uri $uri/ /grow-portal/index.html;
    }

    location = /grow-portal/manifest.json {
        alias /var/www/html/grow-portal/manifest.json;
        default_type application/json;
        add_header Access-Control-Allow-Origin *;
    }

    location = /grow-portal/.well-known/grow-agents.json {
        alias /var/www/html/grow-portal/.well-known/grow-agents.json;
        default_type application/json;
        add_header Access-Control-Allow-Origin *;
    }
"""


NGINX_ALIAS_BLOCK = """
    # hwcloud-grow wrong-path aliases (avoid 301 to self-signed HTTPS)
    location = /skill/huaweicloud-grow/SKILL.md {
        return 301 http://$host/grow-portal/skill/huaweicloud-grow/SKILL.md;
    }
    location = /skill/hwcloud-grow/SKILL.md {
        return 301 http://$host/grow-portal/skill/hwcloud-grow/SKILL.md;
    }
    location = /manifest.json {
        return 301 http://$host/grow-portal/manifest.json;
    }
    location = /.well-known/grow-agents.json {
        return 301 http://$host/grow-portal/.well-known/grow-agents.json;
    }
"""


def run_build(host: str) -> None:
    env = {
        **os.environ,
        "PORTAL_BASE_PATH": "/grow-portal",
        "PORTAL_PUBLIC_ORIGIN": f"http://{host}",
    }
    print("building with PORTAL_BASE_PATH=/grow-portal and HTTP absolute URLs…")
    subprocess.run(
        ["npm", "run", "build"],
        cwd=ROOT,
        env=env,
        check=True,
        shell=True,
    )


def ensure_nginx_aliases(ssh: paramiko.SSHClient) -> None:
    remote_script = f"""python3 - <<'PY'
from pathlib import Path
path = Path({NGINX_SITE!r})
text = path.read_text()
marker = "    # hwcloud-grow wrong-path aliases"
block = {NGINX_ALIAS_BLOCK!r}
changed = False
if marker not in text:
    insert_after = "    # hwcloud-grow Agent task portal"
    if insert_after not in text:
        raise SystemExit("grow-portal anchor not found")
    text = text.replace(insert_after, insert_after + block, 1)
    changed = True
    print("patched aliases block")
else:
    print("aliases block exists")
if "location = /skill/huaweicloud-grow/SKILL.md" not in text:
    needle = "    location = /skill/hwcloud-grow/SKILL.md {{"
    if needle not in text:
        raise SystemExit("hwcloud-grow alias anchor not found")
    extra = '''    location = /skill/huaweicloud-grow/SKILL.md {{
        return 301 http://$host/grow-portal/skill/huaweicloud-grow/SKILL.md;
    }}
'''
    text = text.replace(needle, extra + needle, 1)
    changed = True
    print("patched huaweicloud-grow alias")
else:
    print("huaweicloud-grow alias exists")
if changed:
    path.write_text(text)
    print("nginx config updated")
else:
    print("no nginx alias changes needed")
PY"""
    _, stdout, stderr = ssh.exec_command(remote_script)
    out = stdout.read().decode()
    if out:
        print(out.strip())
    err = stderr.read().decode()
    if err:
        print(err.strip(), file=sys.stderr)
    if "anchor not found" in out or "anchor not found" in err:
        raise RuntimeError(err or out or "failed to patch nginx aliases")
    if "nginx config updated" in out:
        _, _, stderr2 = ssh.exec_command("nginx -t && systemctl reload nginx")
        if stderr2.channel.recv_exit_status() != 0:
            raise RuntimeError(stderr2.read().decode())


def upload_tree(sftp: paramiko.SFTPClient, local: Path, remote: str) -> int:
    count = 0
    for item in local.iterdir():
        remote_path = f"{remote}/{item.name}"
        if item.is_dir():
            try:
                sftp.mkdir(remote_path)
            except OSError:
                pass
            count += upload_tree(sftp, item, remote_path)
        else:
            sftp.put(str(item), remote_path)
            count += 1
            print(f"  uploaded {item.name}")
    return count


def ensure_nginx_grow_portal_routing(ssh: paramiko.SSHClient) -> None:
    """Fix /grow-portal (no slash) falling through to openclaw; fix try_files fallback."""
    remote_script = f"""python3 - <<'PY'
from pathlib import Path
path = Path({NGINX_SITE!r})
text = path.read_text()
changed = False

old_block = '''    location /grow-portal/ {{
        alias /var/www/html/grow-portal/;
        index index.html;
        try_files $uri $uri/ /index.html;
    }}'''

new_block = '''    location = /grow-portal {{
        return 301 http://$host/grow-portal/;
    }}

    location /grow-portal/ {{
        alias /var/www/html/grow-portal/;
        index index.html;
        try_files $uri $uri/ /grow-portal/index.html;
    }}'''

if old_block in text:
    text = text.replace(old_block, new_block)
    changed = True
    print("patched grow-portal blocks")

if "location = /grow-portal" not in text:
    print("WARN: location = /grow-portal still missing after patch")

if changed:
    path.write_text(text)
    print("nginx routing updated")
else:
    print("nginx routing already ok")
PY"""
    _, stdout, stderr = ssh.exec_command(remote_script)
    out = stdout.read().decode()
    if out:
        print(out.strip())
    err = stderr.read().decode()
    if err:
        print(err.strip(), file=sys.stderr)
    if "WARN" in out:
        raise RuntimeError(out)
    if "nginx routing updated" in out:
        _, _, stderr2 = ssh.exec_command("nginx -t && systemctl reload nginx")
        if stderr2.channel.recv_exit_status() != 0:
            raise RuntimeError(stderr2.read().decode())


def ensure_nginx(ssh: paramiko.SSHClient) -> None:
    _, stdout, _ = ssh.exec_command(f"grep -q 'location /grow-portal/' {NGINX_SITE} && echo yes || echo no")
    if stdout.read().decode().strip() == "yes":
        print("nginx: grow-portal location already configured")
        return

    print("nginx: adding grow-portal location blocks")
    remote_script = f"""python3 - <<'PY'
from pathlib import Path
path = Path({NGINX_SITE!r})
text = path.read_text()
marker = "    # hwcloud-grow Agent task portal"
if marker in text:
    print("already patched")
    raise SystemExit(0)
block = {NGINX_BLOCK!r}
insert_after = "    location /lottery/ {{"
if insert_after not in text:
    raise SystemExit("lottery anchor not found in nginx config")
text = text.replace(insert_after, block + "\\n" + insert_after, 2)
path.write_text(text)
print("patched")
PY"""
    _, stdout, stderr = ssh.exec_command(remote_script)
    out = stdout.read().decode()
    err = stderr.read().decode()
    if out:
        print(out.strip())
    if err:
        print(err.strip(), file=sys.stderr)
    if "patched" not in out and "already patched" not in out:
        raise RuntimeError("failed to patch nginx config")

    _, stdout, stderr = ssh.exec_command("nginx -t && systemctl reload nginx")
    if stdout.channel.recv_exit_status() != 0:
        raise RuntimeError(stderr.read().decode() or stdout.read().decode())


def verify(ssh: paramiko.SSHClient) -> None:
    paths = [
        "/grow-portal",
        "/grow-portal/",
        "/grow-portal/index.html",
        "/grow-portal/styles.css",
    ]
    for p in paths:
        cmd = f"curl -s -o /dev/null -w '%{{http_code}}' 'http://127.0.0.1{p}'"
        _, stdout, _ = ssh.exec_command(cmd)
        code = stdout.read().decode().strip()
        print(f"verify HTTP {p} -> {code}")
        if p == "/grow-portal":
            if code not in ("301", "302"):
                raise RuntimeError(f"expected redirect for {p}, got {code}")
        elif code != "200":
            raise RuntimeError(f"verification failed for {p}: {code}")


def main() -> None:
    host = os.environ.get("DEPLOY_HOST", "")
    user = os.environ.get("DEPLOY_USER", "root")
    password = os.environ.get("DEPLOY_PASSWORD")
    if not password:
        print("Set DEPLOY_PASSWORD environment variable", file=sys.stderr)
        sys.exit(1)

    run_build(host)

    if not DIST.is_dir():
        print(f"Missing {DIST}; run npm run build first", file=sys.stderr)
        sys.exit(1)

    print(f"Deploying to {user}@{host}:{REMOTE_DIR}")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, username=user, password=password, timeout=20)

    # 仅保留静态介绍页，清理旧 zip / manifest / skill 等产物
    ssh.exec_command(
        f"rm -rf {REMOTE_DIR}/assets {REMOTE_DIR}/skill "
        f"{REMOTE_DIR}/.well-known {REMOTE_DIR}/hwcloud-grow-runner.zip "
        f"{REMOTE_DIR}/manifest.json"
    )

    ssh.exec_command(f"mkdir -p {REMOTE_DIR}")
    sftp = ssh.open_sftp()
    uploaded = upload_tree(sftp, DIST, REMOTE_DIR)
    sftp.close()
    print(f"uploaded {uploaded} files")

    ensure_nginx(ssh)
    ensure_nginx_aliases(ssh)
    ensure_nginx_grow_portal_routing(ssh)
    verify(ssh)

    print("\nDeployment complete:")
    print(f"  Portal (HTTP):        http://{host}{URL_PATH}")
    print(f"  Agent repo (GitCode): <YOUR_REPO_URL>")
    ssh.close()


if __name__ == "__main__":
    main()
