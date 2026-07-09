#!/usr/bin/env bash
# Comment hygiene for src/: comments must be purpose-driven and self-contained.
# Flags references a contributor cannot resolve from this repository — internal
# tracker IDs, private planning docs, and section cites — plus (as warnings)
# history narration that describes past code instead of the current rule.
#
# Usage: scripts/check-comment-hygiene.sh [--strict]
#   default   report findings, always exit 0
#   --strict  exit 1 when any blocking finding exists (CI gate)
set -euo pipefail

cd "$(dirname "$0")/.."

STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1

INCLUDES=(--include='*.js' --include='*.ts' --include='*.tsx')
SRC=src

fail=0

section() { printf '\n== %s ==\n' "$1"; }

check_blocking() {
  local label="$1" pattern="$2" extra="${3:-}" exclude="${4:-}"
  local hits
  # shellcheck disable=SC2086
  hits=$(grep -rnE "${INCLUDES[@]}" $extra -e "$pattern" "$SRC" || true)
  if [ -n "$hits" ] && [ -n "$exclude" ]; then
    hits=$(printf '%s\n' "$hits" | grep -vE "$exclude" || true)
  fi
  if [ -n "$hits" ]; then
    section "BLOCKING: $label"
    printf '%s\n' "$hits"
    fail=1
  fi
}

# Internal tracker/audit identifiers. Uppercase-only on purpose: lowercase
# occurrences (e.g. frozen on-disk marker strings) are identifiers, not comments.
check_blocking "internal audit/fix identifiers (MIR-n / FIX-n)" '(MIR|FIX)-[0-9]'

# References to the planning workspace. The shipped architecture reference
# (.claude/solution-architecture.md) is the one allowed pointer target.
check_blocking "references to .claude/ or plan docs" '\.claude/|plan-[a-z0-9-]+\.md' '' '\.claude/solution-architecture\.md'

# Section cites into non-shipped docs. The vendored overlay subset is exempt:
# its § tags mark local divergence from upstream and are defined in
# src/shared/transfer/backends/overlay/vendor/PROVENANCE.md.
check_blocking "section cites (§) outside vendor/" '§' '--exclude-dir=vendor'

# Issue/PR numbers in comment context (a leading // or a doc-block line).
check_blocking "issue/PR number references in comments" '(//|^\s*\*).*#[0-9]{2,4}\b'

# History narration — warning only: migration modules legitimately describe the
# older on-disk/wire format they migrate from.
warn_hits=$(grep -rniE "${INCLUDES[@]}" -e '(//|^\s*\*).*(legacy|used to |previously)' "$SRC" || true)
if [ -n "$warn_hits" ]; then
  section "WARNING (review, non-blocking): history narration"
  printf '%s\n' "$warn_hits"
fi

echo
if [ "$fail" -eq 1 ]; then
  echo "comment-hygiene: blocking findings present."
  [ "$STRICT" -eq 1 ] && exit 1
else
  echo "comment-hygiene: clean."
fi
exit 0
