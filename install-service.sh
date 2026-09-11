#!/usr/bin/env bash

set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
node_bin="$(command -v node || true)"
unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
unit_path="${unit_dir}/safe-route-keeper.service"
template_path="${project_dir}/safe-route-keeper.service.in"
credentials_file="${SAFE_ROUTE_CREDENTIALS_FILE:-${XDG_CONFIG_HOME:-${HOME}/.config}/safe-route-keeper/credentials.env}"

if [[ -z "${node_bin}" ]]; then
  echo "错误：未找到 Node.js，请先安装 Node.js 22 或更高版本。" >&2
  exit 1
fi

node_major="$("${node_bin}" -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  echo "错误：当前 Node.js 版本过低，需要 Node.js 22 或更高版本。" >&2
  exit 1
fi

if [[ ! -r "${credentials_file}" && -r /etc/profile.d/huierdun.sh ]]; then
  credentials_file=/etc/profile.d/huierdun.sh
fi

if [[ ! -r "${credentials_file}" ]]; then
  echo "错误：未找到凭据文件。" >&2
  echo "请创建 ~/.config/safe-route-keeper/credentials.env，并设置 HRD_USERNAME 和 HRD_PASSWD。" >&2
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
  -e "s|@CREDENTIALS_FILE@|${credentials_file//&/\\&}|g" \
  "${template_path}" > "${unit_path}"

systemctl --user daemon-reload
systemctl --user enable --now safe-route-keeper.service
systemctl --user restart safe-route-keeper.service

echo "已安装并启动：${unit_path}"
echo "凭据来源：${credentials_file}"
echo "查看状态：systemctl --user status safe-route-keeper.service"
echo "查看日志：journalctl --user -u safe-route-keeper.service -f"
