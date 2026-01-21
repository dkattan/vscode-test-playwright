#!/usr/bin/env bash
set -euo pipefail

log() {
  # ISO-ish timestamp for easy grepping in CI logs.
  # Avoid bash 5-specific printf time formats so this runs on macOS' default bash (3.2).
  echo "[$(date +'%Y-%m-%dT%H:%M:%S%z')] $*"
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    log "error: required command not found on host: $cmd"
    exit 127
  fi
}

# Run this repo's Playwright tests inside a Linux container.
# This avoids needing xvfb-run or Linux UI deps on the host.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

IMAGE="${PLAYWRIGHT_DOCKER_IMAGE:-mcr.microsoft.com/playwright:v1.52.0-jammy}"

# Per-test timeout (Playwright). Default: 15s.
PW_TEST_TIMEOUT_MS="${PW_TEST_TIMEOUT_MS:-15000}"
# Overall run timeout (Playwright). Default: 20 minutes (prevents indefinite hangs, but won't kill healthy runs).
PW_GLOBAL_TIMEOUT_MS="${PW_GLOBAL_TIMEOUT_MS:-1200000}"

# Hard timeout on the host for the entire docker invocation.
# This is a last-resort guard in case docker pull/run hangs before Playwright even starts.
HOST_WATCHDOG_S="${HOST_WATCHDOG_S:-1800}"

require_cmd docker
require_cmd bash

log "Starting Linux container test run"
log "Repo: ${ROOT_DIR}"
log "Docker image: ${IMAGE}"
log "Per-test timeout: ${PW_TEST_TIMEOUT_MS}ms"
log "Global timeout: ${PW_GLOBAL_TIMEOUT_MS}ms"
log "Host watchdog: ${HOST_WATCHDOG_S}s"
if [ $# -gt 0 ]; then
  log "Playwright args: $*"
else
  log "Playwright args: (none)"
fi

INNER_SCRIPT="/work/scripts/test-linux-inner.sh"
if [ ! -f "${ROOT_DIR}/scripts/test-linux-inner.sh" ]; then
  log "error: missing ${ROOT_DIR}/scripts/test-linux-inner.sh"
  exit 127
fi

# The Playwright Docker image already includes browsers + xvfb-run.
# Delegate all container-side validation + timeouts to the inner script.
log "Launching container..."

# Give the container a deterministic name so a watchdog can stop it.
CONTAINER_NAME="vscode-test-playwright-$(date +%s)-$$"

docker run --rm -t --ipc=host --name "${CONTAINER_NAME}" \
  --user pwuser \
  -v "${ROOT_DIR}:/work" \
  -w /work \
  -e CI=1 \
  -e HOME=/home/pwuser \
  -e npm_config_cache=/tmp/npm-cache \
  -e PW_TEST_TIMEOUT_MS="${PW_TEST_TIMEOUT_MS}" \
  -e PW_GLOBAL_TIMEOUT_MS="${PW_GLOBAL_TIMEOUT_MS}" \
  "${IMAGE}" \
  bash "${INNER_SCRIPT}" "$@" \
  2>&1 &

docker_pid=$!

(
  sleep "${HOST_WATCHDOG_S}" || true
  if kill -0 "${docker_pid}" >/dev/null 2>&1; then
    log "WATCHDOG: docker run exceeded ${HOST_WATCHDOG_S}s; stopping container ${CONTAINER_NAME}"
    docker stop -t 5 "${CONTAINER_NAME}" >/dev/null 2>&1 || true
    # Also kill the local docker client process if still around.
    kill -TERM "${docker_pid}" >/dev/null 2>&1 || true
    sleep 2 || true
    kill -KILL "${docker_pid}" >/dev/null 2>&1 || true
  fi
) &

wait "${docker_pid}"
status=$?

log "Container run finished (exit code: ${status})"
exit "${status}"
