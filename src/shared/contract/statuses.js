// The status vocabularies the worker produces and the renderer renders. Frozen arrays rather than
// TypeScript unions so all three runtimes can read them; types.ts derives its unions from these.

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
// Three fields sit beside `status`, and none is derivable from it: `enabled` is the mirror's loop
// switch (false plus an auto-pause status is what isAutoPaused reads), `indexPaused` is the owner's
// durable pause — a field rather than a status, because four writers overwrite status and a pause
// recorded there would be lost at the next settle — and `lastError` is the code a fault status
// names itself by. folders/mount-store.js is the only write path; folders/foreign-folders.js and
// worker/mounts-runtime.js are the callers that decide.
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
