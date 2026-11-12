#!/bin/bash
# 把面板源码同步到部署目录并重启服务。
# panel/index.html 是源（在这改），部署目录是产物。
# 实时数据文件（points-data*.json / scan-qr*.png / gitcode-status*.json）只在
# 部署目录由采集脚本写入，**不要**从 panel/ 反向覆盖过去——那边是旧副本。
#
# 路径按本脚本位置推导，不写死绝对路径（发布/换目录部署都能用）。
# 可用环境变量覆盖：PANEL_SRC / PANEL_DST / PANEL_SERVICE
set -e
_SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_HERE="$(dirname "$_SELF_DIR")"
SRC_DIR="${PANEL_SRC_DIR:-$_HERE/panel}"
DST="${PANEL_DST:-/usr/share/novnc}"
SVC="${PANEL_SERVICE:-hw-points-panel}"

# 同步**所有页面**（不只 index.html）。
# 早先这里只 cp index.html，导致 gitcode.html / scan.html 的改动永远上不了线
# （2026-11-11 改 GitCode 授权页时踩到：改完页面没变化）。
mkdir -p "$DST"
for f in "$SRC_DIR"/*.html; do
  [ -f "$f" ] || continue
  cp "$f" "$DST/$(basename "$f")"
done
echo "已同步页面: $(ls "$SRC_DIR"/*.html | xargs -n1 basename | tr '\n' ' ')"

if systemctl list-unit-files 2>/dev/null | grep -q "^${SVC}\.service"; then
  systemctl restart "$SVC"
  sleep 1
  systemctl is-active "$SVC"
else
  echo "（未找到 ${SVC}.service，仅同步文件，未重启服务）"
fi
echo "已部署 $(date '+%F %T')"
