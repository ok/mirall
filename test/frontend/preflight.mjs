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
//          work again.
//   0.7.0  an over-budget snapshot stopped being a TIMEOUT error and became
//          ok:true + `complete:false`. instance.snap() reads that flag; on an
//          older CLI the flag is simply absent, so a truncated tree would be
//          silently asserted against. That makes 0.7.0 a correctness floor.
//   0.8.0  refs became snapshot-qualified (`@<snapshot_id>:eN`) and ref actions
//          gained their own --timeout-ms budget, which agent.mjs now sets.
//          This is the floor the harness requires.
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
