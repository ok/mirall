// The content-backend seam. A backend owns the publish/list/serve/download
// operations for one share's contentMode. 'overlay' (serve straight from the
// source file, no second copy) is the only backend; every other contentMode —
// absent, an 'eager'/'deferred' mode written by older releases, or unknown —
// resolves to UNSUPPORTED and is rendered as unavailable, never routed to a
// nonexistent path. Every backend implements the same shape; the conformance
// suite exercises this contract.

import { overlayBackend } from './backends/overlay/index.js'

// A share this build can't serve: an 'eager'/'deferred' share from an older
// release, an absent contentMode, or an unknown future mode. Callers render it
// as unavailable.
export const UNSUPPORTED = Symbol('unsupported-content-mode')

export function getContentBackend(share) {
  return share?.contentMode === 'overlay' ? overlayBackend : UNSUPPORTED
}

export function hasContentBackend(share) {
  return getContentBackend(share) !== UNSUPPORTED
}

export function isUnsupportedShare(share) {
  return getContentBackend(share) === UNSUPPORTED
}

// Periodic missed-event backstop (e.g. tombstone catalog entries whose source vanished without a
// chokidar unlink).
export async function sweepBackends() {
  await overlayBackend.sweepPresence()
}
