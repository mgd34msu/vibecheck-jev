#!/usr/bin/env bash
# Runs the bundled vibecheck-jev runtime under Bun or Node.js 24+. The MCP
# server, the hooks and every command go through this one launcher.
set -euo pipefail
if [[ -z "${TYPESAFE_API_KEY:-}" ]]; then
  # Every MCP start and hook run waits on this read, and an interactive
  # shell can stall on anything in its rc files, so bound it: without a
  # quick answer the server runs with its checks degraded instead of
  # hanging past the caller's startup budget.
  vibecheck_jev_harvest=(bash -ic 'printf "%s" "${TYPESAFE_API_KEY:-}" >&3')
  if command -v timeout >/dev/null 2>&1; then
    vibecheck_jev_harvest=(timeout -s KILL 5 "${vibecheck_jev_harvest[@]}")
  fi
  vibecheck_jev_harvest_status=0
  vibecheck_jev_shell_key="$(NO_AUTO_TMUX=1 "${vibecheck_jev_harvest[@]}" 3>&1 </dev/null >/dev/null 2>/dev/null)" || vibecheck_jev_harvest_status=$?
  if [[ -n "$vibecheck_jev_shell_key" ]]; then
    export TYPESAFE_API_KEY="$vibecheck_jev_shell_key"
  elif [[ "$vibecheck_jev_harvest_status" -ne 0 ]]; then
    printf 'vibecheck-jev: no TYPESAFE_API_KEY from the interactive shell (exit %s); continuing without it.\n' "$vibecheck_jev_harvest_status" >&2
  fi
  unset vibecheck_jev_shell_key vibecheck_jev_harvest vibecheck_jev_harvest_status
fi
vibecheck_jev_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
vibecheck_jev_runtime="${VIBECHECK_JEV_RUNTIME:-auto}"
case "$vibecheck_jev_runtime" in
  auto)
    if command -v bun >/dev/null 2>&1; then
      vibecheck_jev_runtime=bun
    else
      vibecheck_jev_runtime=node
    fi
    ;;
  bun|node) ;;
  *) printf 'VIBECHECK_JEV_RUNTIME must be auto, bun, or node.\n' >&2; exit 2 ;;
esac
if ! command -v "$vibecheck_jev_runtime" >/dev/null 2>&1; then
  printf 'vibecheck-jev requires Bun or Node.js 24 or newer.\n' >&2
  exit 1
fi
if [[ "$vibecheck_jev_runtime" == node ]]; then
  node -e 'if (Number(process.versions.node.split(".")[0]) < 24) { process.stderr.write("vibecheck-jev requires Node.js 24 or newer.\n"); process.exit(1); }'
fi
if [[ ! -f "$vibecheck_jev_root/runtime/vibecheck-jev.mjs" ]]; then
  printf 'The vibecheck-jev runtime bundle is missing. In a source checkout, run bun install --frozen-lockfile and bun run build:release.\n' >&2
  exit 1
fi
exec "$vibecheck_jev_runtime" "$vibecheck_jev_root/runtime/vibecheck-jev.mjs" "$@"
