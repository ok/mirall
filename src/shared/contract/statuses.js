// The status vocabularies the worker produces and the renderer renders. Each is a name→value
// object so a producer imports the spelling instead of writing it, beside a frozen tuple that is
// Object.values of that object — the tuple is what types.ts derives its unions from, and deriving
// it here is what keeps the two from disagreeing.

export const FILE_STATUS = Object.freeze({
  MINE: 'mine',
  DOWNLOADED: 'downloaded',
  REMOTE: 'remote',
  PREPARING: 'preparing',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  PUBLISHING: 'publishing',
  PAUSED_INTERRUPTED: 'paused-interrupted',
  PAUSED_OFFLINE: 'paused-offline',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error',
})

export const BADGE_STATUS = Object.freeze({
  MINE: 'mine',
  ON_DEVICE: 'on-device',
  AVAILABLE: 'available',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  PREPARING: 'preparing',
  PUBLISHING: 'publishing',
  PAUSED: 'paused',
  OWNER_OFFLINE: 'owner-offline',
  UNAVAILABLE: 'unavailable',
  ERROR: 'error',
})

export const SHARE_FILE_STATUS = Object.freeze({
  REMOTE: 'remote',
  PREPARING: 'preparing',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  PUBLISHING: 'publishing',
  DOWNLOADED: 'downloaded',
  SYNCED: 'synced',
  UNAVAILABLE: 'unavailable',
  PAUSED_INTERRUPTED: 'paused-interrupted',
  PAUSED_OFFLINE: 'paused-offline',
  ERROR: 'error',
})

export const FILE_STATUSES = Object.freeze(Object.values(FILE_STATUS))
export const BADGE_STATUSES = Object.freeze(Object.values(BADGE_STATUS))
export const SHARE_FILE_STATUSES = Object.freeze(Object.values(SHARE_FILE_STATUS))

// The file statuses that mean the bytes are on this disk. A caller asking "is it here?" asks this
// rather than naming the two members, which is how the renderer came to hold two copies of the set.
export const ON_DEVICE_STATUSES = Object.freeze([SHARE_FILE_STATUS.DOWNLOADED, SHARE_FILE_STATUS.SYNCED])

// A mirror record's sync state, which is not a mount status: it is what the OWNER and every member
// see about a mirror, replicated in the mirror record, while a mount status is local to the device
// that holds the mount.
export const MIRROR_STATE = Object.freeze({
  SYNCING: 'syncing',
  SYNCED: 'synced',
  PAUSED: 'paused',
})

export const MIRROR_STATES = Object.freeze(Object.values(MIRROR_STATE))

// A mount's durable status, per role. Two vocabularies rather than one: 'idle' is a mirror-only
// state, and the two roles mean different things by a fault — a mirror's pause stops its loop,
// while an owner's fault only labels the last pass and the ordinary cadence keeps retrying.
//
// The transitions the tuples alone do not give:
//
//   mirror  idle → scanning → active, and back to scanning on each poll tick. active → paused is
//           the user's decision and only an explicit resume lifts it; active → paused-enospc /
//           paused-error / mount-point-gone is a local I/O fault, which also stops the poll loop.
//           A resume or a relocate re-enters at scanning.
//   owner   scanning → active on a clean pass, scanning → paused-* when the pass hit a fault. The
//           cadence keeps retrying either way.
//
// The two roles' status fields are differently authoritative. A MIRROR's is assigned: `enabled` is
// its loop switch, and false plus an auto-pause status is what isAutoPaused reads. An OWNER's is
// derived by contract/mount-precedence.js from the two facts beside it — `indexPaused`, the user's
// durable pause, and `lastError`, the code a fault status names itself by — so an owner's pause and
// its fault are both recorded while only one of them shows.
export const MOUNT_STATUS = Object.freeze({
  IDLE: 'idle',
  SCANNING: 'scanning',
  ACTIVE: 'active',
  PAUSED: 'paused',
  PAUSED_ENOSPC: 'paused-enospc',
  PAUSED_ERROR: 'paused-error',
  MOUNT_POINT_GONE: 'mount-point-gone',
})

// Listed rather than derived: 'idle' is mirror-only, so the owned tuple is a deliberate subset of
// the object above and not all of it.
export const OWNED_MOUNT_STATUSES = Object.freeze([
  MOUNT_STATUS.SCANNING,
  MOUNT_STATUS.ACTIVE,
  MOUNT_STATUS.PAUSED,
  MOUNT_STATUS.PAUSED_ENOSPC,
  MOUNT_STATUS.PAUSED_ERROR,
  MOUNT_STATUS.MOUNT_POINT_GONE,
])

export const FOREIGN_MOUNT_STATUSES = Object.freeze(Object.values(MOUNT_STATUS))

// The owned statuses that mean nothing is wrong. A row shows a status only when it is not one of
// these, so the pair is a vocabulary rather than two comparisons at each caller.
export const HEALTHY_OWNED_STATUSES = Object.freeze([MOUNT_STATUS.ACTIVE, MOUNT_STATUS.SCANNING])
