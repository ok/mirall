// An owned mount holds two independent facts — the last pass's outcome and the user's pause — and
// shows exactly one of them. This is the order they resolve in.
//
// mount-point-gone tops it because its remedy is a different verb: "Locate folder…", not "Try
// again". A fault outranks a pause because the fault is the one the user can act on; the pause is
// kept in its own field, so it resurfaces when the fault clears.
import { MOUNT_STATUS, HEALTHY_OWNED_STATUSES } from './statuses.js'

const RANK = Object.freeze({
  [MOUNT_STATUS.MOUNT_POINT_GONE]: 5,
  [MOUNT_STATUS.PAUSED_ENOSPC]: 4,
  [MOUNT_STATUS.PAUSED_ERROR]: 4,
  [MOUNT_STATUS.PAUSED]: 3,
  [MOUNT_STATUS.SCANNING]: 2,
  [MOUNT_STATUS.ACTIVE]: 1,
  [MOUNT_STATUS.IDLE]: 0,
})

// A status no writer may clear by asserting activity alone — only a pass that ran, a probe or a
// relocate clears it.
export function isFaultStatus(status) {
  return RANK[status] >= RANK[MOUNT_STATUS.PAUSED_ENOSPC]
}

// `mountPointMissing` is the live probe result and outranks the record, which can still read
// 'active' between the path vanishing and the next probe.
export function ownedMountStatus(record) {
  if (!record) return null
  if (record.mountPointMissing) return MOUNT_STATUS.MOUNT_POINT_GONE
  if (isFaultStatus(record.status)) return record.status
  if (record.indexPaused) return MOUNT_STATUS.PAUSED
  return record.status ?? MOUNT_STATUS.SCANNING
}

export function isHealthyOwnedStatus(status) {
  return HEALTHY_OWNED_STATUSES.includes(status)
}

// test seam — the ordering test reads the table rather than re-listing it
export const _rankForTests = RANK
