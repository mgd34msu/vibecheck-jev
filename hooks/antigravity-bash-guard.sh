#!/usr/bin/env bash
# Antigravity PreToolUse hook for the shell: refuses a delete through an
# unguarded variable before execution.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$root/scripts/vibecheck-jev.sh" hook bash-guard --client antigravity
