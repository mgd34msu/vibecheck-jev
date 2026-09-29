#!/usr/bin/env bash
# Muse PreToolUse hook for agent briefs. Muse sends every tool call to every
# PreToolUse hook, so the hook itself keeps only subagent briefs; each Muse
# hook needs its own file, so this wrapper exists beside the launcher.
set -euo pipefail
root="${MUSE_PLUGIN_ROOT:-${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
if [[ -z "$root" ]]; then
  root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
fi
exec bash "$root/scripts/vibecheck-jev.sh" hook pretool --client muse
