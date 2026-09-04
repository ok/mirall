// Who is fetching a given transferId right now, across every producer. The download engine's
// registry answers only for its own instance, which is why the mirror had to probe it defensively
// — and why the answer was wrong for the loose engine's rows anyway.
//
// An engine is registered as a PROBE rather than copied into a second map: its registry already has
// exactly the lifetime of its fetch, and mirroring that into a claims map would mean clearing it at
// each of start()'s bail sites. Only a producer with no registry of its own — the mirror — holds a
// claim here, so there is one place that adds and one that removes — plus dropFetchClaim, for the
// pass that is abandoned rather than finished.
const held = new Map()
const probes = new Map()

export const FETCH_OWNER_MIRROR = 'mirror'

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

export const isFetchClaimed = (transferId) => fetchClaimedBy(transferId) !== null

// Returns a release, or null when someone else already owns the file. The release is guarded on
// the claim's own token rather than its owner label: a restart drops the claim of the pass it
// abandons, and that pass may still run its finally afterwards — with a label guard it would then
// free the claim the fresh pass had already taken.
export function claimFetch(transferId, owner) {
  const holder = fetchClaimedBy(transferId)
  // Re-entrant for one owner. The question this registry answers is cross-producer — may the mirror
  // fetch what an engine is already fetching — and a mirror's own overlapping passes (a poll tick
  // and an adopted initial scan) are serialised by activeOverlayFetches, not by this. Refusing them
  // here would change behaviour FIX-R09-2 pins, which is out of scope for the guard this replaces.
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
// go with it, since they close over engines this lifetime is about to drop.
export function resetFetchClaims() {
  held.clear()
  probes.clear()
}
