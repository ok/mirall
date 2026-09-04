// What FolderView and SpaceView each read out of the one `owned-folder:list-all` listing. Both
// projections live here rather than in the hook so they are one declaration for two screens — and
// so the precedence below is testable without React.

// The badge projection of an owned mount's durable state: a live missing path wins, then any
// persisted non-healthy status (paused-error / mount-point-gone survive a restart); healthy states
// (active / scanning) render no badge.
export function unhealthyOwnedStatus (m) {
  if (!m) return null
  if (m.mountPointMissing) return 'mount-point-gone'
  if (m.status && m.status !== 'active' && m.status !== 'scanning') return m.status
  return null
}

// Has an answer for this listing landed? Deliberately NOT given the store's `loading`: the store
// settles an entry on an ERROR as well as on data, so a failed read reports loading:false with no
// data — which the old expression read as "settled", i.e. as a healthy folder with no row. A
// durably paused-error or mount-point-gone folder then painted with no fault strip at all, because
// FolderView takes this projection outright once it says loaded. Undefined data is the unsettled
// answer whatever the reason; a share that was simply never mounted still arrives as [].
export function ownedMountSettled (enabled, rows) {
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
export function projectOwnedMount (rows, spaceId, shareId, settled) {
  if (!settled || !spaceId || !shareId) return NO_OWNED_MOUNT
  const m = (rows || []).find((x) => x.spaceId === spaceId && x.shareId === shareId)
  // Both from one row: the badge projection AND the durable intent behind it. The status alone
  // cannot carry the pause — a scan settle overwrites it, and 'mount-point-gone' legitimately
  // outranks it while the source is missing.
  return {
    status: unhealthyOwnedStatus(m),
    lastError: m?.lastError ?? null,
    loaded: true,
    indexPaused: !!m?.indexPaused,
    scanning: m?.status === 'scanning',
    mountPath: m?.mountPath ?? null,
  }
}

export const NO_OWNED_MOUNT = Object.freeze({
  status: null, lastError: null, loaded: false, indexPaused: false, scanning: false, mountPath: null,
})
