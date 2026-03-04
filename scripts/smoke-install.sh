#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROFILE="ci-smoke-${RANDOM}-$$"
STATE_DIR="$HOME/.openclaw-$PROFILE"
TARBALL=""

cleanup() {
  if [[ -n "$TARBALL" && -f "$TARBALL" ]]; then
    rm -f "$TARBALL"
  fi
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

TARBALL="$(npm pack --silent | tail -n 1)"

echo "Installing packed plugin artifact: $TARBALL"
npx openclaw --profile "$PROFILE" --log-level error plugins install "./$TARBALL"

echo "Validating OpenClaw status in isolated profile"
npx openclaw --profile "$PROFILE" --log-level error status >/dev/null

echo "Validating plugin discovery"
PLUGIN_LIST_OUTPUT="$(npx openclaw --profile "$PROFILE" --log-level error plugins list --verbose 2>&1)"
printf '%s\n' "$PLUGIN_LIST_OUTPUT"

if ! grep -qi 'openclaw-sentinel' <<<"$PLUGIN_LIST_OUTPUT"; then
  echo "Smoke test failed: openclaw-sentinel not found in plugin list output" >&2
  exit 1
fi

echo "OpenClaw install smoke test passed"
