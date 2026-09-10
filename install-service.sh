#!/usr/bin/env bash

set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node_bin="$(command -v node || true)"
unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
unit_path="${unit_dir}/safe-route-keeper.service"
template_path="${project_dir}/safe-route-keeper.service.in"

if [[ -z "${node_bin}" ]]; then
  echo "错误：未找到 Node.js，请先安装 Node.js 22 或更高版本。" >&2
  exit 1
fi

node_major="$("${node_bin}" -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "错误：当前 Node.js 版本过低，需要 Node.js 22 或更高版本。" >&2
  exit 1
fi

if [[ "${project_dir}" == *'"'* || "${node_bin}" == *'"'* ]]; then
  echo "错误：项目路径或 Node.js 路径不能包含双引号。" >&2
  exit 1
fi

mkdir -p "${unit_dir}"
sed \
  -e "s|@NODE_BIN@|${node_bin//&/\\&}|g" \
  -e "s|@PROJECT_DIR@|${project_dir//&/\\&}|g" \
  "${template_path}" > "${unit_path}"

systemctl --user import-environment \
  DISPLAY WAYLAND_DISPLAY XAUTHORITY DBUS_SESSION_BUS_ADDRESS 2>/dev/null || true
systemctl --user daemon-reload
systemctl --user enable --now safe-route-keeper.service

echo "已安装并启动：${unit_path}"
echo "查看状态：systemctl --user status safe-route-keeper.service"
echo "查看日志：journalctl --user -u safe-route-keeper.service -f"
