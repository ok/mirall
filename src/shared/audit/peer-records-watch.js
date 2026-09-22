// Wires the pure peer-observer diff into the data layer: resolves names, applies the relevance
// gates, and writes the rows. Split from peer-records-observer.js so the key grammar and the dedupe stay
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
import { createLogger, fields } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { ownedScheduler } from '../core/timers.js'
import { record } from './audit-log.js'
import { getSeenVersion, setSeenVersion, getPeerSubjectState, setPeerSubjectState } from './audit-watch-state.js'
import { classifyProfileChange, classifyCatalogChange, isTransition, readChangesSince, stateOf, subjectKey } from './peer-records-observer.js'
import { TARGET_KIND } from '../contract/audit-kinds.js'
import { peerActor, spaceRef, targetRef } from './audit-record.js'

const log = createLogger('peer-watch')

// Serialized per bee: two appends landing together would otherwise both read the same watermark
// and record the same operations twice.
const sweeps = new Map()
let closed = false

// A failed row holds its bee's watermark AT that row and stops the sweep there, so no row is applied
// twice or ahead of an earlier one. The held row is retried by the next append and by its own
// backoff timer, and given up with a warn only once it has failed `attempts` times AND is at least
// `giveUpAgeMs` old, so neither a burst of appends nor a quiet peer decides it.
// beeId → { seq, attempts, firstAt, causes, handle }.
const RETRY_DELAYS_MS = Object.freeze([5000, 30000, 120000])
const DEFAULT_RETRY = Object.freeze({
  delaysMs: RETRY_DELAYS_MS,
  attempts: RETRY_DELAYS_MS.length,
  giveUpAgeMs: RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0),
})
const CAUSES_NAMED = 5
const holds = new Map()
let retry = DEFAULT_RETRY
let timers = null
const scheduler = ownedScheduler(() => timers)

function resetPeerWatch() {
  sweeps.clear()
  holds.clear()
  retry = DEFAULT_RETRY
  closed = false
}

/** @internal */
export function _sweepRetryForTests(policy) {
  retry = { ...DEFAULT_RETRY, ...policy }
}

// Stop accepting sweeps and let the ones in flight finish (bounded). A chain still READING a
// peer bee when the store closes fails inside its own catch, but a chain still WRITING a
// watermark would land on a closed audit bee — so the drain is what makes closing the bees safe.
async function closePeerWatch({ settleMs = 3000 } = {}) {
  closed = true
  const inFlight = [...sweeps.values()]
  sweeps.clear()
  for (const hold of holds.values()) scheduler.clear(hold.handle)
  holds.clear()
  if (inFlight.length === 0) return
  await Promise.race([
    Promise.allSettled(inFlight),
    new Promise((resolve) => { setTimeout(resolve, settleMs).unref?.() }),
  ])
}

// The watch itself is a set of free functions called from the profile watch, the loose channel and boot; this
// owns only the accept/drain gate, so shutdown has one thing to await.
export class PeerWatch extends Subsystem {
  // Clears the refuse-new-sweeps latch a previous close set.
  async _open() {
    resetPeerWatch()
    timers = this.timers
  }
  async _close() { await closePeerWatch() }
}

// A row is emitted only when the subject's state actually flips, and the previous state is read
// from disk — a peer re-writes a mirror record on every sync-state change and again at their own
// boot, so an in-memory guard would let either side's restart emit a duplicate.
// Returns a commit thunk on a genuine transition, or null. The caller commits only after
// record() reports the row was admitted: record() no-ops when the log is disabled or the
// kind is rate-limited, and mirroring "recorded" for a row that never existed would
// permanently suppress that subject's next standing-state row.
async function transitioned(kind, personKey, spaceId, id, removed) {
  const key = subjectKey(kind, personKey, spaceId, id)
  const next = stateOf(removed)
  const previous = await getPeerSubjectState(key)
  if (!isTransition(previous, next)) return null
  return () => setPeerSubjectState(key, next)
}

// The row is already admitted, so a failed state write must not fail the node: a retry would record
// the row twice. The cost is that the subject's next repeat may record once more.
async function commitRecorded(commit) {
  try {
    await commit()
  } catch (err) {
    log.warn('peer subject state not saved after its row was recorded:', err.message)
  }
}

function peerName(space, personKey) {
  return (space?.members || []).find((m) => m.publicKey === personKey)?.displayName || null
}

async function applyProfileChange(personKey, change) {
  const space = await getSpace(change.spaceId)
  // Not a space we are in — their records for it are none of our business.
  if (!space || space.leaving) return
  const actor = peerActor(personKey, peerName(space, personKey))
  const ref = spaceRef(space.spaceId, space.name)

  if (change.kind === 'share') {
    const commit = await transitioned('share', personKey, change.spaceId, change.shareId, change.removed)
    if (!commit) return
    const written = record(change.removed ? 'peer.share_deleted' : 'peer.share_created', {
      actor,
      space: ref,
      target: targetRef(TARGET_KIND.SHARE, change.shareId, change.name),
    })
    if (written) await commitRecorded(commit)
    return
  }

  // A mirror of someone else's share tells us nothing about our own data.
  const own = (await readOwnShares(change.spaceId)).find((s) => s.id === change.shareId)
  if (!own) return
  const commit = await transitioned('mirror', personKey, change.spaceId, change.shareId, change.removed)
  if (!commit) return
  const written = record(change.removed ? 'mirror.peer_unmirrored' : 'mirror.peer_mirrored', {
    actor,
    space: ref,
    target: targetRef(TARGET_KIND.SHARE, change.shareId, own.name ?? null),
  })
  if (written) await commitRecorded(commit)
}

async function applyCatalogChange(personKey, spaceId, change) {
  const space = await getSpace(spaceId)
  if (!space || space.leaving) return
  // Keyed on the path, not the content hash, so a peer re-publishing an edited file does not
  // record a second "shared" row — matching how our own side records files:add once.
  const commit = await transitioned('file', personKey, spaceId, change.relPath, change.removed)
  if (!commit) return
  const written = record(change.removed ? 'peer.file_unshared' : 'peer.file_shared', {
    actor: peerActor(personKey, peerName(space, personKey)),
    space: spaceRef(space.spaceId, space.name),
    target: targetRef(TARGET_KIND.FILE, change.relPath, change.relPath),
  })
  if (written) await commitRecorded(commit)
}

// One sweep of a peer bee: read what changed since our watermark, turn it into rows, advance the
// watermark. On first sight it only adopts the baseline — see peer-records-observer.js.
//
// The baseline is taken at REGISTRATION, not lazily on the first append. Two failures otherwise:
// adopting on the first append silently swallows it (the very act we wanted to record), and
// adopting before the head has replicated makes a peer's entire existing catalog arrive later as
// a flood of "just shared" rows. So registration syncs the head first, then baselines; a bee
// already seen is swept, which also retries a row held before a restart.
/** @internal */
export async function sweep(beeId, bee, apply, rerun = null) {
  const seen = await getSeenVersion(beeId)
  if (seen === null) {
    await syncHead(bee)
    await setSeenVersion(beeId, bee.version)
    return
  }
  const { version, nodes, skipped } = await readChangesSince(bee, seen)
  const heldAt = await applyUntilHeld(beeId, nodes, apply)
  if (heldAt !== null) {
    scheduleRetry(beeId, rerun)
    if (heldAt !== seen) await setSeenVersion(beeId, heldAt)
    return
  }
  if (skipped) log.warn('peer bee gained more ops than one sweep records — skipping to head:', beeId.slice(0, 12))
  await setSeenVersion(beeId, version)
  clearHold(beeId)
}

// Applies in order and returns the seq of the row the sweep holds at, or null when it got through.
async function applyUntilHeld(beeId, nodes, apply) {
  for (const node of nodes) {
    try {
      await apply(node)
    } catch (err) {
      if (!givesUp(beeId, node.seq, err)) return node.seq
    }
  }
  return null
}

function causeOf(err) {
  return (err?.code || err?.name || 'Error') + ': ' + err?.message
}

// Counts a failure of one row and answers whether to advance past it. Warns when the row is first
// held and when it is given up, so a stuck row logs twice rather than once per attempt.
function givesUp(beeId, seq, err) {
  const prior = holds.get(beeId)
  const hold = prior?.seq === seq
    ? prior
    : { seq, attempts: 0, firstAt: Date.now(), causes: new Set(), handle: prior?.handle ?? null }
  hold.attempts += 1
  if (hold.causes.size < CAUSES_NAMED) hold.causes.add(causeOf(err))
  holds.set(beeId, hold)
  const bee = beeId.slice(0, 20)
  if (hold.attempts >= retry.attempts && Date.now() - hold.firstAt >= retry.giveUpAgeMs) {
    log.warn('peer row lost — advancing past it', fields({ bee, row: seq, attempts: hold.attempts, causes: [...hold.causes].join('; ') }))
    return true
  }
  if (hold.attempts === 1) log.warn('peer row failed — holding the watermark to retry it', fields({ bee, row: seq, cause: causeOf(err) }))
  return false
}

function scheduleRetry(beeId, rerun) {
  const hold = holds.get(beeId)
  if (!hold || !rerun) return
  scheduler.clear(hold.handle)
  const delay = retry.delaysMs[Math.min(hold.attempts, retry.delaysMs.length) - 1]
  hold.handle = scheduler.schedule(rerun, delay)
}

function clearHold(beeId) {
  scheduler.clear(holds.get(beeId)?.handle)
  holds.delete(beeId)
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
  // Refuse new sweeps once closing: replication keeps calling in until destroySwarm, and a sweep
  // started from a cleared map is not chained behind the one still running for the same bee — the
  // duplicate-row race the chain exists to prevent. The watermark cannot advance on a closed bee.
  if (closed) return Promise.resolve()
  const prev = sweeps.get(beeId) ?? Promise.resolve()
  const next = prev.then(fn, fn).catch((err) => log.debug('peer sweep failed:', err.message))
  sweeps.set(beeId, next.then(() => {}, () => {}))
  return next
}

function watch(beeId, bee, apply) {
  const run = () => serialize(beeId, () => sweep(beeId, bee, apply, run))
  return run()
}

export function observePeerProfile(personKey, bee) {
  return watch('profile:' + personKey, bee, async (node) => {
    const change = classifyProfileChange(node)
    if (change) await applyProfileChange(personKey, change)
  })
}

export function observePeerCatalog(personKey, spaceId, catalogKey, bee, looseShareId) {
  return watch('catalog:' + catalogKey, bee, async (node) => {
    const change = classifyCatalogChange(node, looseShareId)
    if (change) await applyCatalogChange(personKey, spaceId, change)
  })
}
