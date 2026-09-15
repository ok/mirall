import { stallVerdict } from '../core/pass-liveness.js'

// Every mirror-side map is keyed by this pair — the loop registry, the synced sets, the fetch
// ledgers. One spelling, so a grep for a key finds every holder of one.
export function mirrorKey(spaceId, shareId) {
  return spaceId + ':' + shareId
}
// Whose bytes are on disk? Comparing the local file against the owner's CURRENT hash answers "is
// it up to date?" and nothing else: a mismatch is either the owner moving on or the user editing
// our copy, and those need opposite handling. The ANCESTOR separates them — the hash the mirror
// itself last delivered for that path, recorded by markVerified() on every landing and durable for
// the life of the mount. Disk === ancestor means our copy is untouched, so a difference from the
// owner is the owner's doing; disk !== ancestor means someone else wrote those bytes.

// test seam
export const LOCAL_COPY = {
  // The local file already IS the owner's current content — nothing to fetch.
  OWNER_CURRENT: 'owner-current',
  // Exactly the bytes we last delivered, so the difference from the owner is the OWNER's edit.
  OURS: 'ours',
  // Neither the owner's current content nor what we delivered: the USER edited our copy.
  DIVERGED: 'diverged',
  // No ancestor on record, or the local file could not be read. Not proof of anything.
  UNKNOWN: 'unknown',
}

export function classifyLocalCopy({ diskHash = null, ownerHash = null, ancestorHash = null } = {}) {
  // An unreadable local file is not an invitation to replace it.
  if (!diskHash) return LOCAL_COPY.UNKNOWN
  // Checked before the ancestor: when all three agree the file is current, and that is the more
  // useful answer than "ours".
  if (ownerHash && diskHash === ownerHash) return LOCAL_COPY.OWNER_CURRENT
  if (!ancestorHash) return LOCAL_COPY.UNKNOWN
  return diskHash === ancestorHash ? LOCAL_COPY.OURS : LOCAL_COPY.DIVERGED
}

// Only a copy we can PROVE is ours may be written over in place.
//
// UNKNOWN deliberately fails closed. A missing ancestor is an absence of evidence, not evidence of
// ownership, and the two mistakes are not symmetric: a needless sibling is a file the user can
// delete in a second, while a wrong overwrite is unrecoverable — there is no trash on this path and
// no audit row to reconstruct from.
export function mayOverwriteInPlace(verdict) {
  return verdict === LOCAL_COPY.OURS || verdict === LOCAL_COPY.OWNER_CURRENT
}

// Whether a mirror tick must walk.
//
// The order is the safety argument: every branch that cannot prove nothing changed costs a walk.
// A skip is only ever authorised by a known version that matches a watermark a converged pass set.
// test seam
export const DEFAULT_FULL_WALK_EVERY = 10

export function shouldWalk({ watermark = null, version = null, skipped = 0, fullWalkEvery = DEFAULT_FULL_WALK_EVERY } = {}) {
  if (watermark === null) return { walk: true, reason: 'no-watermark' }
  if (version === null) return { walk: true, reason: 'version-unknown' }
  if (version !== watermark) return { walk: true, reason: 'catalog-appended' }
  if (!(fullWalkEvery > 1)) return { walk: true, reason: 'backstop-disabled' }
  if (skipped + 1 >= fullWalkEvery) return { walk: true, reason: 'backstop' }
  return { walk: false, reason: null }
}

// Whether a mirror pass may reach for content at all.
//
// A self-mirror is always reachable: presence leases track REMOTE peers only, so our own key is
// never in the map and a bare isOwnerOnline(ownerKey) reads every self-mirror as permanently
// offline. share-listing.js carries the same special case for the same reason.
export function mirrorMayFetch({ ownerKey = null, localKey = null, ownerOnline = false } = {}) {
  // Unknown falls open: a mirror that goes quiet on a missing field is a silent sync outage, where
  // a wasted pass is a log line.
  if (!ownerKey) return true
  if (localKey && ownerKey === localKey) return true
  return !!ownerOnline
}

// The stalled/healthy rule for a mirror loop. runMaterializeTick serialises passes per mount by
// handing every later tick the in-flight promise, so a pass that never settles wedges the mount
// permanently while the interval keeps firing.

// test seam
export const STALL_FACTOR = 20

export function mirrorVerdict(liveness, { now, pollIntervalMs, stallFactor = STALL_FACTOR }) {
  return stallVerdict(liveness, { now, windowMs: pollIntervalMs * stallFactor })
}
