#!/bin/sh
set -eu

command_name="${1:-}"
if [ -z "$command_name" ]; then
  echo "Agentree package-manager guard was invoked without a command name." >&2
  exit 97
fi
shift || true

deny() {
  echo "Agentree blocked \`$command_name $*\` because dependency directories are shared across worktrees. Ask the user to install or modify dependencies outside the agent worktree." >&2
  exit 96
}

sub1="${1:-}"
sub2="${2:-}"

case "$command_name" in
  npm)
    case "$sub1" in
      install|i|add|remove|rm|uninstall|update|upgrade|rebuild|dedupe|prune|ci)
        deny "$@"
        ;;
    esac
    ;;
  pnpm)
    case "$sub1" in
      install|i|add|remove|rm|update|up|upgrade|prune|rebuild|dlx)
        deny "$@"
        ;;
    esac
    ;;
  yarn)
    case "${sub1:-install}" in
      install|add|remove|up|upgrade|set|dlx|plugin)
        deny "$@"
        ;;
    esac
    ;;
  bun)
    case "${sub1:-install}" in
      install|add|remove|update|upgrade)
        deny "$@"
        ;;
      pm)
        deny "$@"
        ;;
    esac
    ;;
  pip|pip3)
    case "$sub1" in
      install|uninstall)
        deny "$@"
        ;;
    esac
    ;;
  poetry)
    case "${sub1:-install}" in
      install|add|remove|update|lock|sync)
        deny "$@"
        ;;
    esac
    ;;
  uv)
    case "$sub1" in
      add|remove|sync|lock)
        deny "$@"
        ;;
      pip)
        case "$sub2" in
          install|uninstall|sync)
            deny "$@"
            ;;
        esac
        ;;
    esac
    ;;
  cargo)
    case "$sub1" in
      add|remove|install)
        deny "$@"
        ;;
    esac
    ;;
esac

PATH="${AGENTREE_GUARD_REAL_PATH:-$PATH}" exec "$command_name" "$@"
