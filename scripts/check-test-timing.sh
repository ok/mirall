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

echo "test-timing: clean."

# test/integration runs under Bare, which has no `process` — its scale knob is read through
# test/helpers/bare-timing.js. A deadline there that never passes through scaled() keeps its
# dev-box value on a CI runner three times slower, which is the timing half of what makes that
# suite flake. The four shapes that carry a deadline in that suite:
#   a poll deadline          const deadline = Date.now() + scaled(ms)
#   a poll bound             while (Date.now() - t0 < scaled(ms))
#   a settle/quiet window    const settle = (ms = 400) => … setTimeout(r, scaled(ms))
#   brittle's own budget     test('…', { timeout: scaled(60000) }, …)
# Production option budgets passed INTO the code under test (fetchFile({ timeout: 6000 })) are
# part of the assertion, not a test deadline, and are deliberately not matched here.
INT=test/integration
unscaled="$(grep -rnE "Date\.now\(\) \+ [A-Za-z_]*([Mm]s|[Tt]imeout|[Dd]eadline) *$" "$INT" | grep -v 'scaled(' || true)"
unscaled="$unscaled$(grep -rnE "Date\.now\(\) - [A-Za-z0-9_]+ < [A-Za-z_]*([Mm]s|[Tt]imeout|[Dd]eadline)\b" "$INT" | grep -v 'scaled(' || true)"
unscaled="$unscaled$(grep -rnE "const (settle|tick|quiet|pause|idle) = \(.*=> new Promise.*setTimeout\([^,]+, *([0-9]{2,}|[A-Za-z_]+)\)" "$INT" | grep -v 'scaled(' || true)"
unscaled="$unscaled$(grep -rnE "^test\(.*\{ *timeout: *[0-9]{3,}" "$INT" | grep -v 'scaled(' || true)"

if [ -n "$(printf '%s' "$unscaled" | tr -d '[:space:]')" ]; then
  echo "ERROR: un-scaled deadline in test/integration — it ignores MIRALL_TEST_TIMEOUT_SCALE:" >&2
  printf '%s\n' "$unscaled" | sort -u >&2
  echo >&2
  echo "  fix: Date.now() + ms            ->  Date.now() + scaled(ms)" >&2
  echo "       { timeout: 60000 }         ->  { timeout: scaled(60000) }" >&2
  echo "  (import { scaled } from '../helpers/bare-timing.js')" >&2
  exit 1
fi

echo "test-timing: integration deadlines scaled."
