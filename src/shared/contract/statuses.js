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
  'downloaded',
  'synced',
  'unavailable',
  'paused-interrupted',
  'paused-offline',
  'error',
])
