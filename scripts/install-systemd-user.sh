#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit_source="$repo_root/systemd/user"
unit_dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
runtime_dest="${XDG_CONFIG_HOME:-$HOME/.config}/ai-workbench/runtime.env"
action="${1:-install}"
enable="${2:-}"
dry_run=false
[[ "$action" == "--dry-run" ]] && { dry_run=true; action="install"; }
[[ "$enable" == "--dry-run" ]] && dry_run=true

units=(ai-workbench.service ai-workbench-worker.service ai-workbench.target)

run() {
  if [[ "$dry_run" == true ]]; then
    printf 'dry-run:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

case "$action" in
  install)
    run mkdir -p "$unit_dest" "$(dirname "$runtime_dest")"
    for unit in "${units[@]}"; do
      run install -m 0644 "$unit_source/$unit" "$unit_dest/$unit"
    done
    if [[ ! -e "$runtime_dest" ]]; then
      run install -m 0600 "$repo_root/systemd/runtime.env.example" "$runtime_dest"
    fi
    run systemctl --user daemon-reload
    if [[ "$enable" == "--enable" ]]; then
      run systemctl --user enable --now ai-workbench.target
    fi
    printf 'Installed AI Workbench user units. Start with: systemctl --user start ai-workbench.target\n'
    ;;
  uninstall)
    run systemctl --user disable --now ai-workbench.target || true
    for unit in "${units[@]}"; do
      if [[ -e "$unit_dest/$unit" ]]; then
        run rm -- "$unit_dest/$unit"
      fi
    done
    run systemctl --user daemon-reload
    printf 'Removed AI Workbench user units. Runtime configuration was preserved at %s\n' "$runtime_dest"
    ;;
  status)
    systemctl --user status ai-workbench.target ai-workbench.service ai-workbench-worker.service --no-pager
    ;;
  *)
    printf 'Usage: %s [install [--enable]|uninstall|status|--dry-run]\n' "$0" >&2
    exit 2
    ;;
esac
