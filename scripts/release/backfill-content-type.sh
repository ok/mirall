#!/usr/bin/env bash
# Every artifact published before the --content-type fix is stored in R2 with no
# contentType, so dl.mirall.app serves it with no Content-Type header. Fix in place with
# a self-copy plus a REPLACE metadata directive; the object bytes and the key are
# untouched.
#
# Dry-run by default. Pass --apply to actually write.
#
# Usage:
#   BUCKET=... scripts/release/backfill-content-type.sh              # list what would change
#   BUCKET=... scripts/release/backfill-content-type.sh --apply
#
# Requires AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_ENDPOINT_URL / BUCKET, with
# AWS_DEFAULT_REGION=auto.
set -euo pipefail

APPLY=0
if [ "${1:-}" = "--apply" ]; then
  APPLY=1
elif [ -n "${1:-}" ]; then
  echo "unknown argument: $1 (expected --apply or nothing)" >&2
  exit 2
fi

: "${BUCKET:?BUCKET must be set}"

ct_for() {
  case "$1" in
    *.msix)     echo "application/msix" ;;
    *.dmg)      echo "application/x-apple-diskimage" ;;
    *.AppImage) echo "application/vnd.appimage" ;;
    *)          echo "" ;;
  esac
}

changed=0
skipped=0
ok=0

# All three published prefixes. desktop/latest/ and every signed/ object come from the
# out-of-band signing tooling rather than CI, so they need this backfill too — fixing
# only the CI upload path leaves every artifact a user actually downloads untouched.
for prefix in desktop/releases/ desktop/channels/ desktop/latest/; do
  while IFS= read -r key; do
    [ -n "$key" ] || continue

    ct="$(ct_for "$key")"
    if [ -z "$ct" ]; then
      skipped=$((skipped + 1))
      continue
    fi

    current="$(aws s3api head-object --bucket "$BUCKET" --key "$key" \
                 --query 'ContentType' --output text 2>/dev/null || echo None)"
    if [ "$current" = "$ct" ]; then
      printf '  ok      %-72s %s\n' "$key" "$ct"
      ok=$((ok + 1))
      continue
    fi

    printf '  CHANGE  %-72s %s -> %s\n' "$key" "$current" "$ct"
    changed=$((changed + 1))

    if [ "$APPLY" -eq 1 ]; then
      before_len="$(aws s3api head-object --bucket "$BUCKET" --key "$key" \
                      --query 'ContentLength' --output text)"
      aws s3 cp "s3://$BUCKET/$key" "s3://$BUCKET/$key" \
        --metadata-directive REPLACE --content-type "$ct" >/dev/null
      after_ct="$(aws s3api head-object --bucket "$BUCKET" --key "$key" \
                    --query 'ContentType' --output text)"
      after_len="$(aws s3api head-object --bucket "$BUCKET" --key "$key" \
                     --query 'ContentLength' --output text)"
      if [ "$after_ct" != "$ct" ]; then
        echo "ERROR: $key still reports Content-Type '$after_ct'" >&2
        exit 1
      fi
      if [ "$after_len" != "$before_len" ]; then
        echo "ERROR: $key changed size ($before_len -> $after_len) — STOP, do not continue" >&2
        exit 1
      fi
    fi
  done < <(aws s3 ls "s3://$BUCKET/$prefix" --recursive | awk '{ $1=""; $2=""; $3=""; sub(/^ +/, ""); print }')
done

echo
if [ "$APPLY" -eq 1 ]; then
  echo "Applied to $changed object(s); $ok already correct; $skipped non-artifact key(s) skipped."
else
  echo "DRY RUN: $changed object(s) would change; $ok already correct; $skipped skipped."
  echo "Re-run with --apply to write."
fi
