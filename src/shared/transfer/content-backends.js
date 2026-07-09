// The content-backend seam. A backend owns the publish/list/serve/download
// operations for one share's contentMode. 'overlay' (serve straight from the
// source file, no second copy) is the only backend; every other contentMode —
// absent, an 'eager'/'deferred' mode written by older releases, or unknown —
// resolves to UNSUPPORTED and is rendered as unavailable, never routed to a
// nonexistent path. Every backend implements the same shape; the conformance
// suite exercises this contract.

import { overlayBackend } from './backends/overlay/index.js'
import { initContentBackendOverlay } from './backends/overlay/overlay-backend.js'
import { isOverlayEnabled } from '../core/runtime-config.js'

// A share this build can't serve: an `overlay` share met by a flag-off /
// pre-overlay (version-skew) build, an 'eager'/'deferred' share from an older
// release, an absent contentMode, or an unknown future mode. Callers render it
// as unavailable.
export const UNSUPPORTED = Symbol('unsupported-content-mode')

export function getContentBackend(share) {
  if (share?.contentMode === 'overlay') return isOverlayEnabled() ? overlayBackend : UNSUPPORTED
  return UNSUPPORTED
}

// True iff a usable backend object exists (i.e. not UNSUPPORTED).
export function hasContentBackend(share) {
  return getContentBackend(share) !== UNSUPPORTED
}

export function isUnsupportedShare(share) {
  return getContentBackend(share) === UNSUPPORTED
}

// Backends with lifecycle hooks (init/attach/teardown). Overlay is the only one.
const LIFECYCLE = [overlayBackend]

// Called once at worker boot. Sets each backend's IPC ref and runs its init.
export async function initBackends(ipc) {
  if (!isOverlayEnabled()) return
  initContentBackendOverlay(ipc) // overlay: IPC ref
  for (const b of LIFECYCLE) await b.init?.()
}

// Called per swarm connection (synchronous) so overlay can bind its channel.
export function fanoutAttach(mux, socket) {
  if (!isOverlayEnabled()) return
  for (const b of LIFECYCLE) b.attach?.(mux, socket)
}

export async function teardownBackends() {
  for (const b of LIFECYCLE) await b.teardown?.()
}

// Periodic missed-event backstop fan-out (e.g. tombstone catalog entries whose
// source vanished without a chokidar unlink). No-ops for backends without it.
export async function sweepBackends() {
  if (!isOverlayEnabled()) return
  for (const b of LIFECYCLE) await b.sweepPresence?.()
}
