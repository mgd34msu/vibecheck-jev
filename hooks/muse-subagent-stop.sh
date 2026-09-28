#!/usr/bin/env bash
# Muse SubagentStop hook: sends a subagent back to work when its final reply
# puts required work off, claims done while its claims show work left, or
# states as fact what the turn's tool output does not show. Each Muse hook
# needs its own file, so this wrapper exists beside the launcher.
set -euo pipefail
root="${MUSE_PLUGIN_ROOT:-${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
if [[ -z "$root" ]]; then
  root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
fi
exec bash "$root/scripts/vibecheck-jev.sh" hook stop --client muse
