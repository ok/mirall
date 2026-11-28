#!/usr/bin/env bash
# Runs one flow shard the way CI grades it: every file in its own runner process, so one file's
# crash cannot abort the rest, then ONLY the failed files once more. A file that passes on the
# retry is a flake, recorded in flake-report/flake-<shard>.json in the shape
# scripts/ci/flake-ledger.mjs reads; a file that fails twice fails the shard. The first attempt's
# output of every failed file is kept under flake-report/logs: a flake that only reproduces in CI
# cannot be diagnosed from an annotation.
#
# The transport is not an argument: test/helpers/peer.js reads MIRALL_TEST_IPC_TRANSPORT.
#
# Usage: scripts/ci/run-flow-shard.sh <shard label> <1-based slice> <slice total> [name]
#   <shard label>  a number; names the report file and the annotations
#   <slice>        which partition of test/flow-shard.mjs to run (differs from the label when a
#                  shard re-runs another shard's files over a second transport)
#   [name]         shown beside the label in the log and the step summary, e.g. "socket, windows"
set -euo pipefail

cd "$(dirname "$0")/../.."

shard="${1:?usage: run-flow-shard.sh <shard label> <slice> <slice total> [name]}"
slice="${2:?missing slice}"
total="${3:?missing slice total}"
name="${4:-${MIRALL_TEST_IPC_TRANSPORT:-pipe}}"

files="$(node test/flow-shard.mjs "$slice" "$total")"
# One spelling of a path on every system: the report's file names are compared across runs, and a
# backslash is neither a path separator to bash nor a legal character in the JSON written below.
files="${files//\\//}"
echo "Shard $shard ($name):"; echo "$files" | tr ' ' '\n'
mkdir -p flake-report/logs

failed=""
for f in $files; do
  log="flake-report/logs/$(echo "$f" | tr '/' '_').log"
  if node test/flow-runner.mjs "$f" >"$log" 2>&1; then rm -f "$log"; else cat "$log"; failed="$failed $f"; fi
done

entries=""
status=0
if [ -n "$failed" ]; then
  echo "::warning title=Flow shard $shard ($name) flaked::retried$failed (a pass-on-retry is a residual flake — the failed attempt's output is in the flake-report artifact)"
  for f in $failed; do
    if node test/flow-runner.mjs "$f"; then passed=true; else passed=false; status=1; fi
    entries="$entries{\"file\":\"$f\",\"attempts\":2,\"passedOnRetry\":$passed},"
  done
fi

printf '{"shard":%s,"files":[%s]}\n' "$shard" "${entries%,}" > "flake-report/flake-$shard.json"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Flow shard $shard ($name)"; if [ -z "$failed" ]; then echo "No retries."; else echo "Retried:$failed"; fi; } >> "$GITHUB_STEP_SUMMARY"
fi
exit $status
