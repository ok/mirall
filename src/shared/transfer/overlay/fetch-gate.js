import { createSemaphore } from '../../core/concurrency.js'
import { getDownloadConcurrency } from '../../core/runtime-config.js'
// Who is fetching a given transferId right now, across every producer — the engine's registry
// answers for its own fetches only. The engine is registered as a PROBE rather than copied into a
// second map: its registry already has exactly the lifetime of its fetch. Only a producer with no
// registry of its own — the mirror — holds a claim here, so there is one place that adds and one
// that removes, plus dropFetchClaim for a pass abandoned rather than finished.
const held = new Map()
const probes = new Map()

export function registerFetchOwner(label, has) {
  probes.set(label, has)
}

export function fetchClaimedBy(transferId) {
  const claim = held.get(transferId)
  if (claim) return claim.owner
  for (const [label, has] of probes) {
    if (has(transferId)) return label
  }
  return null
}

// Returns a release, or null when someone else already owns the file. The release is guarded on
// the claim's own token rather than its owner label: a restart drops the claim of the pass it
// abandons, and that pass may still run its finally afterwards — with a label guard it would then
// free the claim the fresh pass had already taken.
export function claimFetch(transferId, owner) {
  const holder = fetchClaimedBy(transferId)
  // Re-entrant for one owner: the question here is cross-producer (may the mirror fetch what an
  // engine is fetching); a mirror's own overlapping passes are serialised by activeOverlayFetches.
  if (holder === owner) return () => {}
  if (holder) return null
  const token = {}
  held.set(transferId, { owner, token })
  return () => {
    if (held.get(transferId)?.token === token) held.delete(transferId)
  }
}

// A pass abandoned by a stop or a restart never reaches its finally, so whoever abandons it has to
// drop the claim. Without this the restart that exists to un-wedge a mount is refused by the dead
// claim of the very pass it gave up on, and that file is never fetched again this lifetime.
export function dropFetchClaim(transferId) {
  held.delete(transferId)
}

// Module state outlives the subsystem that fills it, so a leaked claim would block one transferId
// for the life of the worker. Cleared with the rest of the overlay's per-lifetime state; the probes
// go with it, since they close over the engine this lifetime is about to drop.
export function resetFetchClaims() {
  held.clear()
  probes.clear()
}

// One gate for every overlay fetch in the process — the download engine and every mirror. The
// limit bounds what an in-flight fetch owns (a chunk scheduler, a watchdog, an fd and a ticker),
// and that cost is per fetch, not per producer. Every producer holds its slot through
// runGatedFetch (fetch-run.js).
//
// Named fetch-gate rather than admission: src/shared/network/ already has admission-gates.js and
// deferred-admission.js, and both are about admitting PEERS.

// The mirror's waiter tag. ForeignMirrors closes before OverlayBackend, so its close must release
// its own parked passes WITHOUT releasing the engine's backlog into a still-live overlay.
export const FETCH_OWNER_MIRROR = 'mirror'

// Two user-initiated fetches may jump a backlog at once (createSemaphore's default is one).
const build = () => createSemaphore({ limit: () => getDownloadConcurrency(), expressLanes: 2 })
let gate = build()

export const acquireFetchSlot = (opts) => gate.acquire(opts)
export const drainFetchSlots = (owner) => gate.drain(owner)
/** @internal */
export const fetchSlotStats = () => gate.stats()

// A per-instance semaphore died with the engine that owned it; a module singleton does not.
// OverlayBackend builds a fresh engine on every _open, so a slot whose release was lost would
// shrink the cap for the life of the worker, across every later open.
export function resetFetchSlots() {
  gate = build()
}
