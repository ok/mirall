// agent-desktop floor for this harness. Observations and actions run in SEPARATE CLI processes, so a
// ref taken from a snapshot must resolve in a later one: 0.8.0 is where refs became
// snapshot-qualified (`@<snapshot_id>:eN`) and ref actions gained their own --timeout-ms budget.
export const MIN_AGENT_DESKTOP = '0.8.0'

// True if `version` is older than the floor (or unparseable). Only the
// major/minor are significant — every break above was a minor-line change.
const MIN_MINOR = Number(MIN_AGENT_DESKTOP.split('.')[1])
export function agentDesktopTooOld(version) {
  const [major, minor] = String(version).split('.').map(Number)
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return true
  if (major > 0) return false
  return minor < MIN_MINOR
}
