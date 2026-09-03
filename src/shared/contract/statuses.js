// The status vocabularies the worker produces and the renderer renders. Frozen arrays rather than
// TypeScript unions so all three runtimes can read them; types.ts derives its unions from these,
// which is what stops the two from drifting the way the review found them.

export const FILE_STATUS = Object.freeze([
  'mine',
  'downloaded',
  'remote',
  'preparing',
  'downloading',
  'verifying',
  'publishing',
  'paused-interrupted',
  'paused-offline',
  'unavailable',
  'error',
])

export const BADGE_STATUS = Object.freeze([
  'mine',
  'on-device',
  'available',
  'downloading',
  'verifying',
  'preparing',
  'publishing',
  'paused',
  'owner-offline',
  'unavailable',
  'error',
])

export const SHARE_FILE_STATUS = Object.freeze([
  'remote',
  'preparing',
  'downloading',
  'verifying',
  'publishing',
  'downloaded',
  'synced',
  'unavailable',
  'paused-interrupted',
  'paused-offline',
  'error',
])

// A mount's durable status, per role. Two vocabularies rather than one: 'idle' is a mirror-only
// state, and the two roles mean different things by a fault — a mirror's pause stops its loop,
// while an owner's fault only labels the last pass and the ordinary cadence keeps retrying.
export const OWNED_MOUNT_STATUS = Object.freeze([
  'scanning',
  'active',
  'paused',
  'paused-enospc',
  'paused-error',
  'mount-point-gone',
])

export const FOREIGN_MOUNT_STATUS = Object.freeze([
  'idle',
  'scanning',
  'active',
  'paused',
  'paused-enospc',
  'paused-error',
  'mount-point-gone',
])
