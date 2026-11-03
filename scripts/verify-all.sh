#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"
exec bun run "$SCRIPT_DIR/run-with-timeout.ts" \
  "${GNUTONIUM_VERIFY_TIMEOUT_SEC:-600}" bash "$SCRIPT_DIR/verify-steps.sh"
