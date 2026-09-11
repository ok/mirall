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

# The silent twin of the rule above: a flow test that declares its OWN poll/sleep helper
# owns the scaling that test/helpers would have done for it. A bare millisecond parameter
# default there never grows under MIRALL_TEST_TIMEOUT_SCALE, so the deadline stays at its
# dev-box value on a CI runner three times slower and the wait expires before the work can
# land. Such a helper carries no `scaled(` for the check above to see, so match the
# declaration instead: in test/flow a millisecond parameter default is written
# `ms = scaled(60000)` (or `unscaled(...)` where the bound must stay absolute).
own="$(grep -rnE "\([^()]*\b[A-Za-z_]*([Mm]s|[Tt]imeout|[Dd]eadline)\b *= *[0-9]{3,}" test/flow/ || true)"

if [ -n "$(printf '%s' "$own" | tr -d '[:space:]')" ]; then
  echo "ERROR: un-scaled deadline default in a flow helper — it ignores MIRALL_TEST_TIMEOUT_SCALE:" >&2
  printf '%s\n' "$own" | sort -u >&2
  echo >&2
  echo "  fix: (ms = 90000)  ->  (ms = scaled(90000))" >&2
  echo "       or drop the local copy and import the helper from test/helpers/" >&2
  exit 1
fi

# The third face of the same rule, and the reason the other two are not enough: brittle's
# per-test deadline is not a helper, so nothing scales it for the call site. A flow test whose
# ceiling is a bare number — or absent, inheriting brittle's 30s default — keeps its dev-box
# budget while every helper deadline inside it triples, so brittle kills the test before the
# helper's diagnostic (which carries the worker stderr tail) can fire. Rule 1 cannot see it:
# the defect is again the ABSENCE of scaled(. Every top-level test in test/flow therefore
# declares its ceiling as `{ timeout: scaled(N) }`, or sets it as the first statement of the
# body with `t.timeout(scaled(N))`.
missing="$(
  for f in test/flow/*.test.js; do
    awk -v file="$f" '
      # Accumulate a declaration head across lines until the body arrow, then judge it.
      /^[ 	]*test(\.skip|\.solo)?\(/ { collecting = 1; head = ""; start = FNR }
      collecting {
        head = head $0
        if (head ~ /=> \{/) {
          collecting = 0
          if (head ~ /timeout: scaled\(/) next
          want_body = 1   # no ceiling in the options object; the first body line gets the chance
          next
        }
        next
      }
      want_body {
        want_body = 0
        if ($0 !~ /^ *t\.timeout\(scaled\(/) print file ":" start ": " substr(head, 1, 100)
      }
    ' "$f"
  done
)"

if [ -n "$(printf '%s' "$missing" | tr -d '[:space:]')" ]; then
  echo "ERROR: flow test without a scaled per-test deadline — brittle's ceiling ignores MIRALL_TEST_TIMEOUT_SCALE:" >&2
  printf '%s\n' "$missing" >&2
  echo >&2
  echo "  fix: test('…', { timeout: 150000 }, …)  ->  test('…', { timeout: scaled(150000) }, …)" >&2
  echo "       test('…', async (t) => {           ->  add { timeout: scaled(N) }, sized above the" >&2
  echo "                                              longest helper wait in the body" >&2
  exit 1
fi

echo "test-timing: clean."
