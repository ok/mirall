#!/usr/bin/env bash
# Comment hygiene for src/: comments must be purpose-driven and self-contained.
# Blocks references a contributor cannot resolve from this repository — internal
# tracker/fix ids, private planning docs, section cites, issue numbers — and warns
# (non-blocking) on history narration that describes past code instead of the rule.
#
# Scope is src/ only, on purpose. test/ is exempt: a regression test's NAME carries
# the id it pins (`REGRESSION (FIX-n: …)`), and that is the one place an id is the
# reusable pointer. scripts/ and config are covered by review, not by this gate.
#
# Usage: scripts/check-comment-hygiene.sh
#   exit 1 when any blocking finding exists (lint:ci runs it)
set -euo pipefail

cd "$(dirname "$0")/.."

INCLUDES=(--include='*.js' --include='*.ts' --include='*.tsx' --include='*.css')
SRC=src
# The vendored overlay subset defines its own markers here; it is the one .md the
# gate reads, and only for planning-doc references.
PROVENANCE=src/shared/transfer/backends/overlay/vendor/PROVENANCE.md
# A line in comment context: `//`, the opening of a block comment, or a block
# comment's continuation line.
COMMENT='(//|/\*|^\s*\*)'

fail=0

section() { printf '\n== %s ==\n' "$1"; }

report() {
  local label="$1" hits="$2"
  if [ -n "$hits" ]; then
    section "BLOCKING: $label"
    printf '%s\n' "$hits"
    fail=1
  fi
}

check_blocking() {
  local label="$1" pattern="$2" extra="${3:-}" exclude="${4:-}"
  local hits
  # shellcheck disable=SC2086
  hits=$(grep -rnE "${INCLUDES[@]}" $extra -e "$pattern" "$SRC" || true)
  if [ -n "$hits" ] && [ -n "$exclude" ]; then
    hits=$(printf '%s\n' "$hits" | grep -vE "$exclude" || true)
  fi
  report "$label" "$hits"
}

# Internal tracker/audit/fix identifiers, alphanumeric suffixes included (FIX-BW9,
# FIX-R09-2, LIFECYCLE-3d). Uppercase-only on purpose: lowercase occurrences (e.g.
# frozen on-disk marker strings) are identifiers, not comments; the leading class
# keeps PREFIX-… from matching. vendor/ is exempt: its [mirall] FIX-BW tags are
# divergence markers defined in PROVENANCE.md.
check_blocking "internal audit/fix identifiers (MIR-n / FIX-n / LIFECYCLE-n)" '(^|[^A-Z])(MIR|FIX|LIFECYCLE)-[A-Z0-9]' '--exclude-dir=vendor'

# References to the planning workspace, in code and in PROVENANCE.md. The shipped
# architecture reference (.claude/solution-architecture.md) is the one allowed
# pointer target.
PLAN_DOCS='\.claude/|plan-[a-z0-9-]+\.md|plans?/[A-Za-z0-9_./-]+\.md'
check_blocking "references to .claude/ or plan docs" "$PLAN_DOCS" '' '\.claude/solution-architecture\.md'
if [ -f "$PROVENANCE" ]; then
  report "references to .claude/ or plan docs in vendor/PROVENANCE.md" \
    "$(grep -HnE -e "$PLAN_DOCS" "$PROVENANCE" | grep -vE '\.claude/solution-architecture\.md' || true)"
fi

# Section cites into non-shipped docs. The vendored overlay subset is exempt:
# its § tags mark local divergence from upstream and are defined in PROVENANCE.md.
check_blocking "section cites (§) outside vendor/" '§' '--exclude-dir=vendor'

# Issue/PR numbers in comment context.
check_blocking "issue/PR number references in comments" "$COMMENT"'.*#[0-9]{2,4}\b'

# History narration — warning only: migration modules legitimately describe the
# older on-disk/wire format they migrate from.
warn_hits=$(grep -rniE "${INCLUDES[@]}" -e "$COMMENT"'.*(legacy|used to |previously|hand-rolled|the old |before this|slipped|no longer)' "$SRC" || true)
if [ -n "$warn_hits" ]; then
  section "WARNING (review, non-blocking): history narration"
  printf '%s\n' "$warn_hits"
fi

echo
if [ "$fail" -eq 1 ]; then
  echo "comment-hygiene: blocking findings present." >&2
  exit 1
fi
echo "comment-hygiene: clean."
