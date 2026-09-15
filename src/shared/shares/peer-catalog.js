// Other peers' catalogs, opened read-only by the key their share or member record publishes
// and decrypted with the space SCK. Every read is bounded and fault-tolerant, so an offline
// owner or a corrupt core degrades a listing instead of hanging or blanking it. Open bees are
// cached behind a refcounted LRU: one Hyperbee + Hypercore session per (peer, space), each
// replicating to every socket, so the cache is bounded and a bee is pinned for as long as a
// read or a watcher holds it.
import Hyperbee from 'hyperbee'
import b4a from 'b4a'
import { getStore } from '../core/store.js'
import { getSpace, getSpaceContentKey } from '../spaces/space.js'
import { withReadTimeout, peerReadTimeoutMs, remainingMs } from '../core/with-timeout.js'
import { getRuntimeConfig, getPeerCatalogCacheLimit } from '../core/runtime-config.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { createRefCountedLru } from '../core/lru.js'
import { prefixRange } from '../core/bee-keys.js'
import { fileKey, sharePrefixKey, catalogEntry, isValidCatalogKey, readCatalogKey, classifyEntryNode } from './catalog-keys.js'
import { entryTally } from './catalog-tally.js'

const log = createLogger('peer-catalog')

// PIN before any await and while a watcher is armed: inserting into the LRU can evict — and
// close — an unpinned entry, and an evicted watched catalog silently stops the mirror loop its
// append listener drives.
const peerCatalogs = createRefCountedLru({
  limit: () => getPeerCatalogCacheLimit(),
  onEvict: (keyHex, bee) => { bee.close().catch(() => {}) },
})

// ONE per-(owner, space) catalog backs every share in that space, so a single key needs
// MULTIPLE listeners: one core 'append' hook fans out to every registered callback, deduped by
// listenerId so repeated browse/download calls don't double-register.
const peerCatalogWatchers = new Map() // catalogKeyHex -> { ids: Set<string>, cbs: Set<fn>, bee }

// The single sink every peer-catalog read funnels through. Returns null on an invalid key so a
// self-asserted bad key degrades to "no such catalog" instead of crashing the listing. sck=null
// opens the plaintext catalog a not-yet-migrated peer still publishes; encrypted and plaintext
// cores have distinct keys, so the first open fixes the mode.
function openPeerCatalog(catalogKeyHex, sck = null) {
  if (!isValidCatalogKey(catalogKeyHex)) return null
  const cached = peerCatalogs.get(catalogKeyHex)
  if (cached) return cached
  const core = getStore().get({ key: b4a.from(catalogKeyHex, 'hex'), ...(sck ? { encryptionKey: sck } : {}) })
  const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  peerCatalogs.set(catalogKeyHex, bee)
  return bee
}

// Resolve which catalog to read for a record + with what key. `readable` folds the whole gate:
// false when there's no key, or the catalog is encrypted but we hold no SCK (a pending joiner) —
// callers return their empty value. `space` may be injected to skip a getSpace read in hot loops.
export async function resolvePeerCatalog(spaceId, rec, { space } = {}) {
  const { keyHex, encrypted } = readCatalogKey(rec)
  const sck = encrypted && keyHex ? getSpaceContentKey(spaceId, space || await getSpace(spaceId)) : null
  return { keyHex, sck, encrypted, readable: !!keyHex && (!encrypted || !!sck) }
}

// Notify when a peer's catalog grows: the core's 'append' fires when new blocks replicate in,
// so a browsing peer live-refreshes instead of only seeing the snapshot present at first open.
// Returns the watched bee so a caller that needs to know WHAT changed can read its history.
export function watchPeerCatalog(catalogKeyHex, listenerId, onAppend, sck = null) {
  let w = peerCatalogWatchers.get(catalogKeyHex)
  if (!w) {
    const bee = openPeerCatalog(catalogKeyHex, sck)
    if (!bee) return null
    w = { ids: new Set(), cbs: new Set(), bee }
    peerCatalogWatchers.set(catalogKeyHex, w)
    peerCatalogs.acquire(catalogKeyHex)
    bee.core.on('append', () => { for (const cb of w.cbs) cb(bee) })
  }
  if (!w.ids.has(listenerId)) {
    w.ids.add(listenerId)
    w.cbs.add(onAppend)
  }
  return w.bee
}

// Pull the owner's latest catalog head before reading: a read-only core opened by key starts at
// length 0, and bee.ready() does NOT fetch the remote head. Bounded so an offline owner doesn't
// hang the listing.
const HEAD_TIMED_OUT = Symbol('head-timed-out')
async function syncPeerHead(bee, timeoutMs = peerReadTimeoutMs()) {
  await bee.ready()
  const res = await withReadTimeout(bee.core.update({ wait: true }), timeoutMs, HEAD_TIMED_OUT)
  return res !== HEAD_TIMED_OUT
}

// Runaway guard for a drain whose budget went to the head sync, and the floor for one left with
// a sliver of budget, so a call exceeds `timeoutMs` by at most this much. A 5k-row catalog walks
// in tens of milliseconds; a slower machine that hits the timer truncates the read, which is
// reported complete:false and stalled, so the renderer keeps its previous list for that owner.
const LOCAL_DRAIN_MS = 250

const EMPTY_STALLED = { entries: [], complete: false, stalled: true, total: 0, totalBytes: 0 }

// Single-pass peer read: head-sync, then drain the prefix. ONE `timeoutMs` covers both; a budget
// spent on the head degrades the drain to a local-only read, so an unreachable owner costs one
// budget, not two. `complete` needs a full drain, the head landed, and blocks in the core; a
// partial read is flagged so the renderer keeps its last list.
export async function collectPeerShare(catalogKeyHex, shareId, { sck = null, limit = Infinity, timeoutMs = peerReadTimeoutMs(), onEach = null } = {}) {
  const bee = openPeerCatalog(catalogKeyHex, sck)
  if (!bee) return { ...EMPTY_STALLED }
  peerCatalogs.acquire(catalogKeyHex)
  try {
    const deadlineAt = Date.now() + timeoutMs
    let headSynced = false
    try { headSynced = await syncPeerHead(bee, timeoutMs) } catch { return { ...EMPTY_STALLED } }
    const prefix = sharePrefixKey(shareId)
    const left = remainingMs(deadlineAt)
    // Budget spent on the head: read only what is already on disk. hyperbee forwards `wait` to
    // core.get, so a missing block throws instead of parking for a peer — rows replicated before
    // still surface, and the drain can never park for a second budget.
    const stream = bee.createReadStream({ ...prefixRange(prefix), wait: left > 0 })
    const { entries, complete, total, totalBytes } = await drainWithTimeout(stream, prefix, Math.max(left, LOCAL_DRAIN_MS), limit, onEach)
    // `complete` also requires blocks (length>0) so the renderer keeps its last list over an
    // empty read; `stalled` is the narrower "the read could not finish" signal — a legitimately
    // empty catalog is fully read, NOT stalled, so a re-poll keyed on stalled won't churn.
    const traversed = headSynced && complete
    return { entries, total, totalBytes, complete: traversed && bee.core.length > 0, stalled: !traversed }
  } finally {
    peerCatalogs.release(catalogKeyHex)
  }
}

// The bounded drain: `complete` is false on timeout or read fault, and the rows read so far are
// still returned. `onEach` observes every counted entry regardless of `limit`.
function drainWithTimeout(stream, prefix, timeoutMs, limit = Infinity, onEach = null) {
  return new Promise((resolve) => {
    const tally = entryTally(limit, onEach)
    const truncateAfter = getRuntimeConfig().testTruncatePeerDrainAfter
    let settled = false
    const finish = (complete) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!complete) { try { stream.destroy() } catch {} }
      resolve({ ...tally.result(), complete })
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    ;(async () => {
      try {
        for await (const node of stream) {
          if (settled) break
          if (node.value?.deletedAt) continue
          tally.add(catalogEntry(node.key.slice(prefix.length), node.value))
          if (truncateAfter > 0 && tally.result().total >= truncateAfter) { finish(false); break }
        }
        finish(true)
      } catch (err) {
        log.debug('peer catalog drain error:', err.message)
        finish(false)
      }
    })()
  })
}

// The version of a peer catalog we already hold, WITHOUT a network wait: a connected reader's
// core.length follows the writer on its own (hypercore eagerUpgrade), so this answers "has the
// owner appended since we last converged?" for the price of a property read.
//
// null means UNKNOWN — no key, no SCK, or a core never opened. Callers must read null as "walk",
// never as "unchanged": the fail-safe direction is more work, never less.
export async function peerCatalogVersion(spaceId, rec, { space } = {}) {
  try {
    const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, rec, { space })
    if (!readable) return null
    const bee = openPeerCatalog(keyHex, sck)
    if (!bee) return null
    peerCatalogs.acquire(keyHex)
    try {
      await bee.ready()
      return bee.version
    } finally {
      peerCatalogs.release(keyHex)
    }
  } catch (err) {
    // Never throws: failing to answer costs work rather than correctness, and a rejection
    // escaping here would abort the mirror pass before it did anything.
    log.debug('peer catalog version unavailable:', err.message)
    return null
  }
}

// Surfaces a tombstone as { removed: true } instead of collapsing it to null, so a deliberate
// removal is distinguishable from a transient null (mid-rehash / offline owner / replication lag).
export async function getPeerEntryState(catalogKeyHex, shareId, relPath, { sck = null } = {}) {
  const bee = openPeerCatalog(catalogKeyHex, sck)
  if (!bee) return null
  peerCatalogs.acquire(catalogKeyHex)
  try {
    try { await syncPeerHead(bee) } catch { return null }
    const node = await withReadTimeout(bee.get(fileKey(shareId, relPath)), peerReadTimeoutMs(), null)
    const state = classifyEntryNode(node)
    return state ? { relPath, ...state } : null
  } finally {
    peerCatalogs.release(catalogKeyHex)
  }
}

export async function getPeerEntry(catalogKeyHex, shareId, relPath, opts = {}) {
  const state = await getPeerEntryState(catalogKeyHex, shareId, relPath, opts)
  return state && !state.removed ? { ...catalogEntry(relPath, state), seq: state.seq } : null
}

// test seam
export function peerCatalogCacheStats() {
  return { size: peerCatalogs.size(), keys: peerCatalogs.keys(), refsOf: (k) => peerCatalogs.refsOf(k) }
}

// Closed, not just forgotten: every open core replicates to every socket. Fire-and-forget
// because every caller is synchronous; a close failure means the store is already going down.
// test seam
export function dropPeerCatalog(catalogKeyHex) {
  if (peerCatalogWatchers.delete(catalogKeyHex)) peerCatalogs.release(catalogKeyHex)
  peerCatalogs.delete(catalogKeyHex)?.close().catch(() => {})
}

export class PeerCatalogs extends Subsystem {
  // A leftover handle is dead by definition — its store is gone — so it is dropped rather than
  // refused: throwing here would turn a shutdown that ran out of budget into an app that will
  // not start.
  async _open() {
    if (peerCatalogs.size()) {
      this.log.warn(`dropping ${peerCatalogs.size()} peer catalog handle(s) left by a previous instance`)
      await this._closeAll()
    }
  }

  // The watchers hold the same bees peerCatalogs does, and their 'append' listeners sit on the
  // core session, so closing the bee drops them too.
  async _closeAll() {
    const open = peerCatalogs.values()
    peerCatalogs.clear()
    peerCatalogWatchers.clear()
    await Promise.allSettled(open.map((bee) => bee.close()))
  }

  async _close() { await this._closeAll() }
}
