#!/usr/bin/env bash
# Drives the running Mirall window through a basic smoke flow via agent-desktop.
# Requires: macOS, agent-desktop CLI on PATH, Accessibility permission granted,
# Mirall (or the dev "Electron" build) already running.
#
# Usage: scripts/smoke-test.sh [app-name]   # defaults to "Mirall"; pass "Electron" for the dev build.

set -euo pipefail

APP="${1:-Mirall}"

ad() { agent-desktop "$@"; }

expect_ok() {
  local label="$1"; shift
  local out
  out=$(ad "$@") || { echo "FAIL [$label]: command exited non-zero" >&2; echo "$out" >&2; exit 1; }
  if [[ "$(jq -r .ok <<<"$out")" != "true" ]]; then
    echo "FAIL [$label]:" >&2
    jq .error <<<"$out" >&2
    exit 1
  fi
  printf '%s' "$out"
}

pass() { echo "PASS: $*"; }

# 1. Pre-flight
status=$(expect_ok "status" status)
[[ "$(jq -r .data.permissions.accessibility.state <<<"$status")" == "granted" ]] \
  || { echo "FAIL: Accessibility permission not granted. Run: agent-desktop permissions --request" >&2; exit 1; }
pass "Accessibility permission granted"

# 2. App reachable
snap=$(expect_ok "snapshot" snapshot --skeleton --app "$APP" -i --compact)
ref_count=$(jq -r .data.ref_count <<<"$snap")
pass "Window for '$APP' reached ($ref_count refs)"

# 3. Sidebar buttons present (matches name OR description, since aria-label maps either way)
all_labels=$(jq -r '.. | objects | select(.role=="button") | (.name // "") + "\n" + (.description // "")' <<<"$snap")
for label in "Send Feedback" "All Spaces" "Favorites" "Create Space" "Join Space"; do
  grep -qFx "$label" <<<"$all_labels" \
    || { echo "FAIL: sidebar button '$label' not found" >&2; exit 1; }
  pass "sidebar: $label"
done

# 4. Pick first space card — buttons whose description starts with "Open "
first_ref=$(jq -r '.. | objects | select(.role=="button" and ((.description // "") | startswith("Open "))) | .ref_id' <<<"$snap" | head -1)
[[ -n "$first_ref" ]] || { echo "FAIL: no space cards found (no buttons with description 'Open …')" >&2; exit 1; }
first_label=$(jq -r --arg r "$first_ref" '.. | objects | select(.ref_id==$r) | .description' <<<"$snap")
pass "space card found: $first_label ($first_ref)"

# 5. Click it
expect_ok "click" click "$first_ref" >/dev/null
pass "clicked $first_ref"

# 6. Brief settle, then re-snapshot
expect_ok "wait" wait 500 >/dev/null
snap2=$(expect_ok "snapshot post-nav" snapshot --skeleton --app "$APP" -i --compact)

# 7. Assert navigation happened — Create/Join buttons belong to the SharedSpaces
#    screen and should be gone, and at least one space-screen indicator should be present.
post_labels=$(jq -r '.. | objects | (.name // "") + "\n" + (.description // "")' <<<"$snap2")

if grep -qFx "Create Space" <<<"$post_labels" || grep -qFx "Join Space" <<<"$post_labels"; then
  echo "FAIL: still on SharedSpaces screen after click" >&2
  exit 1
fi
pass "left SharedSpaces screen"

# Match either English or German space-screen indicators.
matched=""
for indicator in "Files Shared" "Geteilte Dateien" "Invite to Space" "Zum Raum einladen" "Members" "Mitglieder"; do
  if grep -qFx "$indicator" <<<"$post_labels"; then
    matched="$indicator"
    break
  fi
done
[[ -n "$matched" ]] || { echo "FAIL: no space-screen indicator (Files Shared / Members / Invite) found" >&2; exit 1; }
pass "on space screen ($matched)"

echo
echo "All smoke checks passed against '$APP'."
