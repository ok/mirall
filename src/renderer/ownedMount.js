// What FolderView and SpaceView each read out of the one `owned-folder:list-all` listing. Both
// projections live here rather than in the hook so they are one declaration for two screens — and
// so the precedence below is testable without React.

import { MOUNT_STATUS } from '../shared/contract/statuses.js'
import { ownedMountStatus, isHealthyOwnedStatus } from '../shared/contract/mount-precedence.js'

// Which states deserve a badge: the resolved status, unless it is one nothing is wrong with.
export function unhealthyOwnedStatus(m) {
  const status = ownedMountStatus(m)
  return status && !isHealthyOwnedStatus(status) ? status : null
}

// Settled means an answer LANDED — data or error — not `!loading`: the store settles an entry on an
// error too, so a failed read is loading:false with no data, and FolderView takes this projection
// outright once loaded. Undefined is unsettled whatever the reason; a never-mounted share is [].
export function ownedMountSettled(enabled, rows) {
  return Boolean(enabled) && rows !== undefined
}

// The full FolderView projection, over the listing rather than a per-share read.
//
// `settled` is the store's "a value has landed for this entry", which is NOT the same as "this
// share has a row": a folder that was never mounted legitimately has no row, and reporting
// loaded:false for it would pin FolderView to its frozen navigation snapshot forever. Settled with
// no row is a healthy answer, not a missing one.
//
// Nothing here latches. Every field is read from the row on each call, so a share change re-derives
// rather than carrying the previous folder's state into this one's header.
export function projectOwnedMount(rows, spaceId, shareId, settled) {
  if (!settled || !spaceId || !shareId) return NO_OWNED_MOUNT
  const m = (rows || []).find((x) => x.spaceId === spaceId && x.shareId === shareId)
  const resolved = ownedMountStatus(m)
  return {
    status: unhealthyOwnedStatus(m),
    lastError: m?.lastError ?? null,
    loaded: true,
    paused: resolved === MOUNT_STATUS.PAUSED,
    scanning: resolved === MOUNT_STATUS.SCANNING,
    mountPath: m?.mountPath ?? null,
  }
}

// test seam
export const NO_OWNED_MOUNT = Object.freeze({
  status: null, lastError: null, loaded: false, paused: false, scanning: false, mountPath: null,
})
