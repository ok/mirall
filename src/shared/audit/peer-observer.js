// Turns "a peer's bee appended" into "here is exactly what changed".
//
// A peer's profile bee and share catalog are append-only logs, so the diff needs no snapshot of
// their records — just the version we last processed plus createHistoryStream, which replays the
// put/del operations since then. That is why this is cheap: one integer per bee, and no drift
// between a stored copy and reality.
//
// Two rules keep it honest:
//   1. BASELINE ON FIRST SIGHT. The first time we see a bee we store its current version and
//      emit nothing. Without this, adopting a peer would replay their entire history stamped
//      "now" — a log full of events that did not just happen.
//   2. TRANSITION DEDUPE, DURABLY. One logical act is many puts — a mirror record is re-written
//      on every sync-state change and again by ensureMirror at the peer's boot — so a row is
//      emitted only when the subject's state actually flips. The last recorded state is stored,
//      not held in memory: an in-memory guard lets a restart on either side emit a duplicate.
//
// Classification is pure and exported separately so the key grammar is unit-testable without a
// Corestore.

// The two record families do NOT share a tombstone field: a share is retired with `deletedAt`
// (shares.js) and a mirror with `unmirroredAt` (mirror-records.js). Reading the wrong one is
// silently destructive — an unmirror then looks like a fresh mirror, which both loses the
// "stopped mirroring" event and invents a duplicate "mirrored" one. Declared per prefix so the
// coupling is visible rather than assumed.
export const PROFILE_RECORDS = [
  { kind: 'share', prefix: 'share/', tombstoneField: 'deletedAt' },
  { kind: 'mirror', prefix: 'mirror/', tombstoneField: 'unmirroredAt' },
]

// `share/<spaceId>/<shareId>` and `mirror/<spaceId>/<shareId>` — anything else in the profile
// bee (membership records, avatars, capability flags) is not a peer content action.
export function classifyProfileChange(node) {
  const key = node?.key
  if (typeof key !== 'string') return null
  const removedByDel = node.type === 'del'
  const value = node.value || null

  for (const { kind, prefix, tombstoneField } of PROFILE_RECORDS) {
    if (!key.startsWith(prefix)) continue
    const rest = key.slice(prefix.length).split('/')
    if (rest.length !== 2 || !rest[0] || !rest[1]) return null
    return {
      kind,
      spaceId: rest[0],
      shareId: rest[1],
      removed: removedByDel || !!value?.[tombstoneField],
      name: value?.name || null,
    }
  }
  return null
}

// Catalog keys are `file/<shareId>/<relPath>`. relPath may itself contain slashes, so only the
// first segment is the share id.
export function classifyCatalogChange(node, looseShareId) {
  const key = node?.key
  if (typeof key !== 'string' || !key.startsWith('file/')) return null
  const rest = key.slice('file/'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const shareId = rest.slice(0, slash)
  const relPath = rest.slice(slash + 1)
  if (!relPath) return null
  // Folder-share contents are deliberately excluded: a peer mounting a 5,000-file folder is one
  // act, already summarised by their share record, not five thousand file events.
  if (shareId !== looseShareId) return null
  return {
    shareId,
    relPath,
    removed: node.type === 'del' || !!node.value?.deletedAt,
  }
}

// The durable key under which we remember the last state we RECORDED for one subject. Dedupe
// has to survive a restart: a peer's mirror record is re-put on every sync-state change
// (syncing/synced/paused) and again by ensureMirror at their boot, so an in-memory guard lets a
// restart on either side emit a duplicate "mirrored" row.
export function subjectKey(kind, peerKey, spaceId, id) {
  return [kind, peerKey, spaceId, id].join('|')
}

export const STATE_ON = 'on'
export const STATE_OFF = 'off'

export function stateOf(removed) {
  return removed ? STATE_OFF : STATE_ON
}

// Record only on a genuine transition. An unknown previous state counts as a transition, so the
// first observation of a subject is recorded.
export function isTransition(previous, next) {
  return previous !== next
}

// Read the operations a bee gained since `sinceVersion`. Bounded: a peer that appended a huge
// number of records while we were away must not stall the worker or flood the log — past the cap
// we skip to the head, because the alternative (replaying thousands of stale ops as if they just
// happened) is worse than a gap.
export const MAX_OPS_PER_SWEEP = 500

export async function readChangesSince(bee, sinceVersion, { maxOps = MAX_OPS_PER_SWEEP } = {}) {
  const version = bee.version
  if (!Number.isInteger(sinceVersion) || sinceVersion >= version) return { version, nodes: [], skipped: false }
  const nodes = []
  let skipped = false
  for await (const node of bee.createHistoryStream({ gte: sinceVersion })) {
    if (nodes.length >= maxOps) { skipped = true; break }
    nodes.push({ type: node.type, key: node.key, value: node.value })
  }
  return { version, nodes, skipped }
}
