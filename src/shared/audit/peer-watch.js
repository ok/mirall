// Wires the pure peer-observer diff into the data layer: resolves names, applies the relevance
// gates, and writes the rows. Split from peer-observer.js so the key grammar and the dedupe stay
// unit-testable without a Corestore.
//
// Relevance gates, both deliberate:
//   - A share/file event only counts for a space we are actually in. A peer's bee carries their
//     records for every space they belong to, most of which are none of our business.
//   - A mirror event only counts when the mirrored share is OURS. "Bob mirrored your Designs
//     folder" is the signal the owner asked for; "Bob mirrored Carol's folder" is noise on a
//     third party's activity.
import { getSpace } from '../spaces/space.js'
import { readOwnShares } from '../shares/shares.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { record, getSeenVersion, setSeenVersion, getPeerSubjectState, setPeerSubjectState } from './audit-log.js'
import { classifyProfileChange, classifyCatalogChange, isTransition, readChangesSince, stateOf, subjectKey } from './peer-observer.js'

const log = createLogger('peer-watch')

// Serialized per bee: two appends landing together would otherwise both read the same watermark
// and record the same operations twice.
const sweeps = new Map()
let closed = false

export function resetPeerWatch() {
  sweeps.clear()
  closed = false
}

// Stop accepting sweeps and let the ones in flight finish (bounded). A chain still READING a
// peer bee when the store closes fails inside its own catch, but a chain still WRITING a
// watermark would land on a closed audit bee — so the drain is what makes closing the bees safe.
async function closePeerWatch({ settleMs = 3000 } = {}) {
  closed = true
  const inFlight = [...sweeps.values()]
  sweeps.clear()
  if (inFlight.length === 0) return
  await Promise.race([
    Promise.allSettled(inFlight),
    new Promise((resolve) => { setTimeout(resolve, settleMs).unref?.() }),
  ])
}

// The watch itself is a set of free functions called from swarm.js and share-catalog.js; this
// owns only the accept/drain gate, so shutdown has one thing to await.
export class PeerWatch extends Subsystem {
  // Lifts the refuse-new-sweeps flag a previous close left set — a module-level latch nothing
  // else clears, so a second boot in the same process would accept no sweeps at all.
  async _open() { resetPeerWatch() }
  async _close() { await closePeerWatch() }
}

// A row is emitted only when the subject's state actually flips, and the previous state is read
// from disk — a peer re-writes a mirror record on every sync-state change and again at their own
// boot, so an in-memory guard would let either side's restart emit a duplicate.
// Returns a commit thunk on a genuine transition, or null. The caller commits only after
// record() reports the row was admitted: record() no-ops when the log is disabled or the
// kind is rate-limited, and mirroring "recorded" for a row that never existed would
// permanently suppress that subject's next standing-state row.
async function transitioned(kind, peerKey, spaceId, id, removed) {
  const key = subjectKey(kind, peerKey, spaceId, id)
  const next = stateOf(removed)
  const previous = await getPeerSubjectState(key)
  if (!isTransition(previous, next)) return null
  return () => setPeerSubjectState(key, next)
}

async function ownsShare(spaceId, shareId) {
  try {
    return (await readOwnShares(spaceId)).some((s) => s.id === shareId)
  } catch {
    return false
  }
}

function peerName(space, peerKey) {
  return (space?.members || []).find((m) => m.publicKey === peerKey)?.displayName || null
}

async function applyProfileChange(peerKey, change) {
  const space = await getSpace(change.spaceId)
  // Not a space we are in — their records for it are none of our business.
  if (!space || space.leaving) return
  const actor = { type: 'peer', key: peerKey, name: peerName(space, peerKey) }
  const spaceRef = { id: space.spaceId, name: space.name ?? null }

  if (change.kind === 'share') {
    const commit = await transitioned('share', peerKey, change.spaceId, change.shareId, change.removed)
    if (!commit) return
    const written = record(change.removed ? 'peer.share_deleted' : 'peer.share_created', {
      actor,
      space: spaceRef,
      target: { kind: 'share', id: change.shareId, name: change.name },
    })
    if (written) await commit()
    return
  }

  // A mirror of someone else's share tells us nothing about our own data.
  if (!(await ownsShare(change.spaceId, change.shareId))) return
  const commit = await transitioned('mirror', peerKey, change.spaceId, change.shareId, change.removed)
  if (!commit) return
  const own = (await readOwnShares(change.spaceId)).find((s) => s.id === change.shareId)
  const written = record(change.removed ? 'mirror.peer_unmirrored' : 'mirror.peer_mirrored', {
    actor,
    space: spaceRef,
    target: { kind: 'share', id: change.shareId, name: own?.name ?? null },
  })
  if (written) await commit()
}

async function applyCatalogChange(peerKey, spaceId, change) {
  const space = await getSpace(spaceId)
  if (!space || space.leaving) return
  // Keyed on the path, not the content hash, so a peer re-publishing an edited file does not
  // record a second "shared" row — matching how our own side records files:add once.
  const commit = await transitioned('file', peerKey, spaceId, change.relPath, change.removed)
  if (!commit) return
  const written = record(change.removed ? 'peer.file_unshared' : 'peer.file_shared', {
    actor: { type: 'peer', key: peerKey, name: peerName(space, peerKey) },
    space: { id: space.spaceId, name: space.name ?? null },
    target: { kind: 'file', id: change.relPath, name: change.relPath },
  })
  if (written) await commit()
}

// One sweep of a peer bee: read what changed since our watermark, turn it into rows, advance the
// watermark. On first sight it only adopts the baseline — see peer-observer.js.
//
// The baseline is taken at REGISTRATION, not lazily on the first append. Two failures otherwise:
// adopting on the first append silently swallows it (the very act we wanted to record), and
// adopting before the head has replicated makes a peer's entire existing catalog arrive later as
// a flood of "just shared" rows. So registration syncs the head first, then baselines.
async function sweep(beeId, bee, apply, { baselineOnly = false } = {}) {
  const seen = await getSeenVersion(beeId)
  if (seen === null) {
    await syncHead(bee)
    await setSeenVersion(beeId, bee.version)
    return { adopted: true, recorded: 0 }
  }
  if (baselineOnly) return { adopted: false, recorded: 0 }
  const { version, nodes, skipped } = await readChangesSince(bee, seen)
  if (skipped) log.warn('peer bee gained more ops than one sweep records — skipping to head:', beeId.slice(0, 12))
  for (const node of nodes) {
    try { await apply(node) } catch (err) { log.debug('peer change skipped:', err.message) }
  }
  await setSeenVersion(beeId, version)
  return { adopted: false, recorded: nodes.length }
}

// Pull the peer's current head before baselining, so their existing records are adopted rather
// than replayed as new once replication catches up. Bounded and best-effort: a peer that never
// answers just yields an early baseline, and their later appends record normally.
const HEAD_SYNC_MS = 4000

async function syncHead(bee) {
  try {
    await Promise.race([
      bee.core.update({ wait: true }),
      new Promise((resolve) => setTimeout(resolve, HEAD_SYNC_MS)),
    ])
  } catch { /* an unreachable peer baselines at whatever we hold */ }
}

function serialize(beeId, fn) {
  // Refuse new sweeps once the watch is closing. Swarm connections stay live until destroySwarm,
  // which runs well after this closes, so replication keeps calling in: without the flag a late
  // sweep would start from a cleared map — i.e. NOT chained behind the one still running for the
  // same bee — which is exactly the duplicate-row race the chain exists to prevent. And once the
  // audit bee is closed the watermark cannot advance anyway, so the work is pure cost.
  if (closed) return Promise.resolve()
  const prev = sweeps.get(beeId) ?? Promise.resolve()
  const next = prev.then(fn, fn).catch((err) => log.debug('peer sweep failed:', err.message))
  sweeps.set(beeId, next.then(() => {}, () => {}))
  return next
}

export function observePeerProfile(peerKey, bee, opts) {
  const beeId = 'profile:' + peerKey
  return serialize(beeId, () => sweep(beeId, bee, async (node) => {
    const change = classifyProfileChange(node)
    if (change) await applyProfileChange(peerKey, change)
  }, opts))
}

export function observePeerCatalog(peerKey, spaceId, catalogKey, bee, looseShareId, opts) {
  const beeId = 'catalog:' + catalogKey
  return serialize(beeId, () => sweep(beeId, bee, async (node) => {
    const change = classifyCatalogChange(node, looseShareId)
    if (change) await applyCatalogChange(peerKey, spaceId, change)
  }, opts))
}
