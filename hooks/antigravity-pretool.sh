#!/usr/bin/env bash
# Antigravity PreToolUse hook for agent briefs: checks subagent briefs and
# worker messages against the recorded plan.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$root/scripts/vibecheck-jev.sh" hook pretool --client antigravity
