#!/usr/bin/env bash
# Test-deadline hygiene for test/: the poll/wait helpers scale the `ms` they receive
# (peer.waitFor, peer.until, fixtures.waitForFile all do `scaled(ms)` internally), so a
# call site must pass a BASE value. Passing scaled() in as well squares the scale factor:
# under CI's MIRALL_TEST_TIMEOUT_SCALE=3 a scaled(120000) deadline becomes 1,080,000ms,
# far past brittle's per-test timeout — so the helper's diagnostic (which carries the
# worker stderr tail) can never fire and a hang degrades into a bare "timed out" with no
# indication of what it was waiting for.
#
# Only brittle's per-test `{ timeout: scaled(...) }` takes a scaled value; it is not a helper.
#
# Usage: scripts/check-test-timing.sh
set -euo pipefail

cd "$(dirname "$0")/.."

# `ms:` options feed until()/waitForFile(); the third arg of waitFor() is its deadline.
hits="$(grep -rnE "ms: scaled\(|\.waitFor\([^)]*\)[^)]*, *scaled\(" test/ || true)"
# The waitFor pattern above misses predicates containing parens, so catch those too.
hits="$hits$(grep -rnE "\.waitFor\(.*scaled\(" test/ || true)"

if [ -n "$(printf '%s' "$hits" | tr -d '[:space:]')" ]; then
  echo "ERROR: double-scaled test deadline — helpers already scale, pass a base value:" >&2
  printf '%s\n' "$hits" | sort -u >&2
  echo >&2
  echo "  fix: B.waitFor(type, pred, scaled(60000))  ->  B.waitFor(type, pred, 60000)" >&2
  echo "       { ms: scaled(60000) }                 ->  { ms: 60000 }" >&2
  echo "  (keep scaled() on brittle's per-test { timeout: scaled(...) })" >&2
  exit 1
fi

echo "test-timing: clean."
