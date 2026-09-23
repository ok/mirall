// Pure status derivation for a consumer-side file row — loose, folder-share and mirrored alike —
// given the on-device verdict, the durable pending row and whether a transfer is in flight for it.
// The overlay download engine takes pauseReasonFor.
import { COPY_VERDICT } from './verified-copy.js'
import { FILE_STATUS } from '../contract/statuses.js'

/** @internal */
export function pausedStatusFor({ pendingRow, isActive, ownerOnline }) {
  if (!pendingRow || isActive) return null
  return {
    status: ownerOnline ? 'paused-interrupted' : 'paused-offline',
    pendingBytes: pendingRow.bytesTransferred || 0,
  }
}

// The reason carried on a transfer-paused event, following the same presence predicate as
// pausedStatusFor: a reachable owner means the pause is an interruption (content evicted,
// re-indexing, holder churn), not an offline owner.
export function pauseReasonFor(ownerOnline) {
  return ownerOnline ? 'interrupted' : 'offline'
}

// A null-contentHash entry is advertised before hashing finished → 'preparing', but only while
// the owner is reachable: once offline the placeholder is frozen (no completing/tombstoning
// append can arrive), so it degrades to 'unavailable' like any other file from an offline owner.
/** @internal */
export function unhashedStatusFor(ownerOnline) {
  return ownerOnline ? 'preparing' : 'unavailable'
}

// Consumer-side row status as an ORDER of rules. A copy on this device outranks everything, whatever
// a stale pending row or an in-flight fetch says (a just-completed row can hold both for a moment).
// `onDeviceStatus` is the caller's spelling of "here" — a download is 'downloaded', a mirror is
// 'synced' — and MODIFIED is the one verdict that overrides it.
//
// Below that, the unhashed check sits ahead of the pending-row ones because the republish park
// deliberately keeps a (zeroed) pending row through the owner's re-hash — read paused-first, that
// wait would surface as a "Paused" row offering Resume against a hash that no longer exists.
//
// It yields to a row that still holds PARTIAL BYTES and an owner who has gone offline: that wait
// cannot resolve until they return, and 'unavailable' would strip the partial's Discard and leave
// the bytes on disk unmanageable. While the owner is reachable the wait wins either way — the
// materialized-hash append restarts the download, and the stale partial goes with it.
export function consumerRowStatusFor({ copyVerdict = null, onDeviceStatus = FILE_STATUS.DOWNLOADED, hashed, isActive, pendingRow, ownerOnline }) {
  if (copyVerdict === COPY_VERDICT.MODIFIED) return { status: FILE_STATUS.MODIFIED, verified: false }
  if (copyVerdict) return { status: onDeviceStatus, verified: copyVerdict === COPY_VERDICT.VERIFIED }
  if (isActive) return { status: FILE_STATUS.DOWNLOADING, pendingBytes: pendingRow?.bytesTransferred || 0 }
  const partial = pendingRow?.bytesTransferred > 0
  if (!hashed && (ownerOnline || !partial)) return { status: unhashedStatusFor(ownerOnline) }
  if (pendingRow?.errorCode) return { status: FILE_STATUS.ERROR, errorCode: pendingRow.errorCode }
  const paused = pausedStatusFor({ pendingRow, isActive, ownerOnline })
  if (paused) return { status: paused.status, pendingBytes: paused.pendingBytes }
  return { status: ownerOnline ? FILE_STATUS.REMOTE : FILE_STATUS.UNAVAILABLE }
}
