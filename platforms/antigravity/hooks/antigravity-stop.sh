#!/usr/bin/env bash
# Antigravity Stop hook: checks the final reply against the recorded plan
# and open claims in the ledger before allowing termination.
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$root/scripts/vibecheck-jev.sh" hook stop --client antigravity
