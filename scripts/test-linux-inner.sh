#!/usr/bin/env bash
set -euo pipefail

log() {
  echo "[container $(date +'%Y-%m-%dT%H:%M:%S%z')] $*"
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log "error: required command not found: $cmd"
    exit 127
  fi
}

# Timeouts
# - Per-test timeout is Playwright's own timeout.
PW_TEST_TIMEOUT_MS="${PW_TEST_TIMEOUT_MS:-15000}"
# - Global timeout is Playwright's own global timeout (overall test run).
#   Default is intentionally generous to avoid killing a healthy run while still preventing infinite hangs.
PW_GLOBAL_TIMEOUT_MS="${PW_GLOBAL_TIMEOUT_MS:-1200000}" # 20 minutes
# - Hard timeouts enforced by GNU timeout around each step.
NPM_CI_TIMEOUT_S="${NPM_CI_TIMEOUT_S:-600}"              # 10 minutes
BUILD_TIMEOUT_S="${BUILD_TIMEOUT_S:-300}"               # 5 minutes
PLAYWRIGHT_STEP_TIMEOUT_S="${PLAYWRIGHT_STEP_TIMEOUT_S:-${PW_GLOBAL_TIMEOUT_MS}}"

# Convert ms to seconds for timeout if PLAYWRIGHT_STEP_TIMEOUT_S was provided in ms by mistake.
# If it's a large number (>= 1000) and no suffix, assume ms.
if [[ "$PLAYWRIGHT_STEP_TIMEOUT_S" =~ ^[0-9]+$ ]] && [ "$PLAYWRIGHT_STEP_TIMEOUT_S" -ge 1000 ]; then
  PLAYWRIGHT_STEP_TIMEOUT_S=$((PLAYWRIGHT_STEP_TIMEOUT_S / 1000))
fi

log "node=$(node -v 2>/dev/null || true) npm=$(npm -v 2>/dev/null || true)"

require_cmd bash
require_cmd node
require_cmd npm
require_cmd npx
require_cmd xvfb-run
require_cmd Xvfb
require_cmd timeout

log "Timeouts: npm ci=${NPM_CI_TIMEOUT_S}s, build=${BUILD_TIMEOUT_S}s, per-test=${PW_TEST_TIMEOUT_MS}ms, pw-global=${PW_GLOBAL_TIMEOUT_MS}ms, step=${PLAYWRIGHT_STEP_TIMEOUT_S}s"

log "npm ci (installing deps)"
# Ensure npm ci cannot hang forever.
# --kill-after ensures we don't get stuck on TERM-ignoring children.
timeout --signal=TERM --kill-after=30s "${NPM_CI_TIMEOUT_S}s" npm ci

TSC_BIN="./node_modules/.bin/tsc"
if [ ! -x "$TSC_BIN" ]; then
  log "error: tsc binary not found at $TSC_BIN after npm ci"
  log "debug: contents of ./node_modules/.bin:";
  ls -la ./node_modules/.bin || true
  exit 127
fi

log "build (tsc -> dist/)"
timeout --signal=TERM --kill-after=30s "${BUILD_TIMEOUT_S}s" npm run -s build

# Prefer the local playwright binary after install.
PLAYWRIGHT_BIN="./node_modules/.bin/playwright"
if [ ! -x "$PLAYWRIGHT_BIN" ]; then
  log "error: playwright binary not found at $PLAYWRIGHT_BIN after npm ci"
  log "debug: contents of ./node_modules/.bin:";
  ls -la ./node_modules/.bin || true
  exit 127
fi

log "running playwright tests (xvfb)"
# Hard timeout around the entire test command to prevent indefinite hangs.
# Also pass Playwright's own global timeout.
# Use --reporter=line for continuous output.
# shellcheck disable=SC2086
set +u
timeout --signal=TERM --kill-after=60s "${PLAYWRIGHT_STEP_TIMEOUT_S}s" \
  xvfb-run -a "$PLAYWRIGHT_BIN" test --reporter=line --timeout="${PW_TEST_TIMEOUT_MS}" --global-timeout="${PW_GLOBAL_TIMEOUT_MS}" "$@"
status=$?
set -u

log "playwright exit code: ${status}"
exit "${status}"
