#!/usr/bin/env bash
# The poll helpers (peer.waitFor / peer.until / waitForFile / waitForCatalogEntry) scale the
# `ms` they receive, so a call site that also wraps it in scaled() stretches the deadline by
# the square of MIRALL_TEST_TIMEOUT_SCALE. That is silently permissive: on CI the poll deadline
# then outlives brittle's per-test timeout, so the helper's diagnostic (worker stderr tail,
# "saw N event(s)") never fires and a hang degrades to a bare "timed out after N ms".
#
# Legitimate scaled() positions, which this guard must NOT flag:
#   { timeout: scaled(N) }         brittle's per-test timeout — brittle does not scale
#   waitForWorkerExit(pid, scaled(N))  helper does not scale internally
#   setTimeout / sleep / manual Date.now() deadlines
# A deadline that must stay absolute (racing an un-scaled production constant) uses unscaled().
set -euo pipefail

if grep -rnE '\.(waitFor|until)\(.*[^a-zA-Z_]scaled\(|ms:[[:space:]]*(Math\.[a-z]+\()?scaled\(' test/; then
  echo "" >&2
  echo "ERROR: double-scaled deadline above — the helper already scales; pass a BASE value." >&2
  echo "       (need an absolute bound? use unscaled() from test/helpers/timing.js)" >&2
  exit 1
fi
