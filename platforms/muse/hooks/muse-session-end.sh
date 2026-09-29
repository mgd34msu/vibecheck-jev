#!/usr/bin/env bash
# Muse SessionEnd hook: runs the reply checks on the session's final reply
# and records the verdicts in the ledger. Muse does not send the session back
# to work at SessionEnd, so this hook never blocks. Each Muse hook needs its
# own file, so this wrapper exists beside the launcher.
set -euo pipefail
root="${MUSE_PLUGIN_ROOT:-${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
if [[ -z "$root" ]]; then
  root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
fi
exec bash "$root/scripts/vibecheck-jev.sh" hook session-end --client muse
