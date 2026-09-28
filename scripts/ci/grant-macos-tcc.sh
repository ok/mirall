#!/usr/bin/env bash
# Grant Accessibility and Screen Recording to the processes that drive the frontend suite on a
# throwaway macOS machine (a GitHub-hosted runner or a local CI VM), where no one is there to click
# through System Settings. It writes the TCC databases directly, which only works with System
# Integrity Protection disabled — true on GitHub's macOS images and on the cirruslabs Tart images.
# Never run this on a workstation.
#
# macOS attributes an AX client to its responsible process, which on a runner can be the agent, the
# shell or the binary itself, so every candidate path gets the grant.
#
# Usage: scripts/ci/grant-macos-tcc.sh <client-path>...
set -euo pipefail

if [ "$(csrutil status 2>/dev/null | grep -c disabled)" = 0 ]; then
  echo "SIP is enabled: the TCC databases are read-only here" >&2
  exit 1
fi

SYSTEM_DB="/Library/Application Support/com.apple.TCC/TCC.db"
USER_DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
NOW=$(date +%s)

grant() {
  local db="$1" service="$2" client="$3" sudo_cmd="$4"
  # Named columns: the access table grows columns between macOS releases, and the ones left out
  # all have defaults.
  $sudo_cmd sqlite3 "$db" "INSERT OR REPLACE INTO access
    (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier, flags, last_modified)
    VALUES ('$service', '$client', 1, 2, 4, 1, 'UNUSED', 0, $NOW);"
}

for client in "$@"; do
  [ -e "$client" ] || { echo "skip (missing): $client"; continue; }
  resolved=$(readlink -f "$client")
  for path in "$client" "$resolved"; do
    grant "$SYSTEM_DB" kTCCServiceAccessibility "$path" sudo
    grant "$SYSTEM_DB" kTCCServiceScreenCapture "$path" sudo
    [ -f "$USER_DB" ] && grant "$USER_DB" kTCCServiceAccessibility "$path" ""
    echo "granted: $path"
  done
done
