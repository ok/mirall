// The label for one mirrorer's participation state.
//
// `state` is what that peer published about itself — the replicated mirror record's
// syncing | synced | paused. Whether the owner is reachable is our own observation and is
// deliberately not part of that record: two mirrors of the same folder can legitimately disagree
// (one shares a LAN with the owner, one does not), so a replicated `offline` would be one peer
// asserting a fact on another's behalf. Applied here instead, at read time, against our own
// presence view.
//
// Only `syncing` moves. A peer that holds every file still holds it while the owner is away, and
// a paused mirror is the user's own intent — neither depends on reachability.
export function mirrorStateLabelKey (state, ownerOnline) {
  if (state === 'paused') return 'folder.mirrorStatePaused'
  if (state === 'synced') return 'folder.mirrorStateSynced'
  if (ownerOnline === false) return 'folder.mirrorStateWaiting'
  return 'folder.mirrorStateSyncing'
}
