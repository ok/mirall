#!/usr/bin/env bash
# Release artifacts must be uploaded to R2 with an explicit Content-Type. R2 serves the
# stored contentType verbatim and `aws s3 cp` derives nothing for .msix/.dmg/.AppImage
# (Python's mimetypes knows none of them), so a bare `aws s3 cp` publishes an artifact
# with NO Content-Type header. Microsoft requires application/msix for HTTP-delivered
# MSIX; a wrong or missing type is a documented App Installer failure mode.
#
# This failure is silent: the build stays green and the artifact is quietly wrong. Hence
# a static guard on every PR, in addition to the post-upload head-object assertion that
# only runs on a real release.
#
# Usage: scripts/check-release-mime.sh
set -euo pipefail

cd "$(dirname "$0")/.."

WF=".github/workflows/build-electron.yml"
fail=0

if [ ! -f "$WF" ]; then
  echo "ERROR: $WF not found — did the workflow move?" >&2
  exit 1
fi

if ! grep -q 'aws s3 cp .* --content-type' "$WF"; then
  echo "ERROR: $WF uploads to R2 without --content-type." >&2
  echo "  fix: aws s3 cp \"artifact/Mirall.\$EXT\" \"\$DEST\" --content-type \"\$CT\"" >&2
  fail=1
fi

# Every ext the build matrix produces needs an arm in the Content-Type map.
for pair in "msix:application/msix" \
            "dmg:application/x-apple-diskimage" \
            "AppImage:application/vnd.appimage"; do
  ext="${pair%%:*}"
  ct="${pair#*:}"
  if ! grep -qE "^[[:space:]]*$ext\)[[:space:]]+CT=\"$ct\"" "$WF"; then
    echo "ERROR: $WF has no Content-Type arm mapping .$ext -> $ct" >&2
    fail=1
  fi
done

# An unmapped extension must fail the build, not fall back to octet-stream.
if ! grep -qE '^[[:space:]]*\*\)[[:space:]]+echo "::error::no Content-Type mapping' "$WF"; then
  echo "ERROR: $WF has no hard-failure arm for an unmapped extension." >&2
  fail=1
fi

if ! grep -q 'aws s3api head-object' "$WF"; then
  echo "ERROR: $WF has no post-upload Content-Type assertion (aws s3api head-object)." >&2
  fail=1
fi

[ "$fail" -eq 0 ] || exit 1
echo "release-mime: clean."
