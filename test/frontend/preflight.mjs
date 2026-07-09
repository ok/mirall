// agent-desktop version compatibility for this AX-driven harness.
//
// This suite makes its observations and actions in SEPARATE CLI processes
// (snapshot in one process, then click/type/get in the next), so a ref taken
// from a snapshot must still resolve in a later process. The version history:
//
//   0.1.x  stable cross-process refs, but a single global refmap with a hard
//          "RefMap exceeds 1MB" cap that a large window's AX tree can blow past.
//   0.2.x  rewrote refs into per-command "semantic AX paths" with no persisted
//          refmap — every cross-process ref came back STALE_REF and the suite hung.
//   0.3.0+ reintroduced persisted, session-scoped snapshots (a per-`snapshot_id`
//          refmap addressable via --session / --snapshot), so cross-process refs
//          work again. This is the floor the harness now requires.
export const MIN_AGENT_DESKTOP = '0.3.0'

// True if `version` is older than the 0.3.0 floor (or unparseable). Only the
// major/minor are significant — the pre-0.3 break was a minor-line change.
export function agentDesktopTooOld(version) {
  const [major, minor] = String(version).split('.').map(Number)
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return true
  if (major > 0) return false
  return minor < 3
}
