#!/usr/bin/env bash

set -euo pipefail

unit_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
unit_path="${unit_dir}/safe-route-keeper.service"

systemctl --user disable --now safe-route-keeper.service 2>/dev/null || true
if [[ -f "${unit_path}" ]]; then
  rm -- "${unit_path}"
fi
systemctl --user daemon-reload

echo "已卸载 safe-route-keeper 用户服务。"
echo "凭据文件不会被自动删除。"
