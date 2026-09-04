// One gate for every overlay fetch in the process — both download engines and every mirror. The
// limit bounds what an in-flight fetch owns (a chunk scheduler, a watchdog, an fd and a ticker),
// and that cost is per fetch, not per producer. It used to live inside createOverlayDownloadEngine,
// which is called once per channel, so the configured cap was silently doubled and the mirrors were
// not counted against it at all.
//
// Named fetch-slots rather than admission: src/shared/transfer/ already has admission-gates.js and
// deferred-admission.js, and both are about admitting PEERS.
import { createSemaphore } from '../../../core/concurrency.js'
import { getDownloadConcurrency } from '../../../core/runtime-config.js'

// The mirror's waiter tag. ForeignMirrors closes before OverlayBackend, so its close must release
// its own parked passes WITHOUT releasing the engines' backlog into a still-live overlay.
export const FETCH_OWNER_MIRROR = 'mirror'

// expressLanes: 2, not createSemaphore's default of 1. Two engines each carried one lane, so a
// single shared gate would halve how many user-initiated fetches can jump a backlog.
const build = () => createSemaphore({ limit: () => getDownloadConcurrency(), expressLanes: 2 })
let gate = build()

export const acquireFetchSlot = (opts) => gate.acquire(opts)
export const drainFetchSlots = (owner) => gate.drain(owner)
export const fetchSlotStats = () => gate.stats()

// A per-instance semaphore died with the engine that owned it; a module singleton does not.
// OverlayBackend builds fresh engines on every _open, so a slot whose release was lost would
// shrink the cap for the life of the worker, across every later open.
export function resetFetchSlots() {
  gate = build()
}
