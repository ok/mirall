#!/usr/bin/env bash
# node_modules must never be tracked. A worktree checkout leaves a node_modules symlink in the
# tree; `git add -A` from that worktree commits it as a symlink blob, and every later
# `git checkout` of that commit then fails to populate the tree. It has happened.
set -euo pipefail

cd "$(dirname "$0")/.."

if tracked=$(git ls-files --error-unmatch node_modules 2>/dev/null); then
  echo "ERROR: node_modules is tracked by git:" >&2
  echo "$tracked" >&2
  echo "       run: git rm --cached -r node_modules" >&2
  exit 1
fi
