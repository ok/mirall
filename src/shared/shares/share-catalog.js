// Share catalogs: the replicated Hyperbee listing of a share's files (path, size,
// mtime, content hash — metadata only; bytes are served by the overlay backend).
// Owner side writes and (on leave) purges its own catalog; consumer side opens
// peers' catalogs read-only by key, with bounded, fault-tolerant reads so an
// offline owner or a corrupt core degrades a listing instead of hanging or
// blanking it. v2 catalogs are encrypted with the SCK (space content key).
import Hyperbee from 'hyperbee'
import b4a from 'b4a'
import { createBee, getStore, isStorageInconsistency } from '../core/store.js'
import { getSpace, getSpaceContentKey, purgeCoreDk, purgeAlias } from '../spaces/space.js'
import { withReadTimeout, peerReadTimeoutMs } from '../core/with-timeout.js'
import { relKeyEscapes } from '../folders/path-keys.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('share-catalog')

// One replicated catalog Hyperbee per (owner, space) — same cardinality as the
// per-space drive, so a share with N files is N keys, not N cores. Entries are
// metadata only (no bytes): the bytes stay in the owner's mounted folder and are
// materialised into the drive on demand. The catalog core key is published in the
// share record so peers open it read-only by key and replicate it.
export const FILE_PREFIX = 'file/'

const ownCatalogs = new Map()   // spaceId -> Hyperbee (writable)
const peerCatalogs = new Map()  // catalogKeyHex -> Hyperbee (read-only)

export function fileKey(shareId, relPath) {
  return FILE_PREFIX + shareId + '/' + relPath
}

function sharePrefixKey(shareId) {
  return FILE_PREFIX + shareId + '/'
}

// v2 (encrypted) catalog cores live under a distinct name so they get a fresh keyPair/key —
// hypercore can't retro-encrypt an existing plaintext core, so encryption requires a new core.
const ENC_SUFFIX = '-e1'

function plaintextCatalogName(space, spaceId) {
  const suffix = space?.driveSuffix
  return suffix ? 'space-catalog-' + spaceId + '-' + suffix : 'space-catalog-' + spaceId
}

function catalogNameForSpace(space, spaceId) {
  const base = plaintextCatalogName(space, spaceId)
  return space?.schemaVersion === 2 ? base + ENC_SUFFIX : base
}

// Tolerant of a missing record by design: purgeOwnCatalog() resolves this name during
// space-leave AFTER the space record is deleted. Publish/advertise callers must ensure
// the record exists first (see space.js publishLooseCatalogKey) — never call this to
// derive a name to WRITE into before the record is saved, or you fork a divergent core.
export async function catalogNameFor(spaceId) {
  return catalogNameForSpace(await getSpace(spaceId), spaceId)
}

// The plaintext core name for a space that is now v2 — used only by the catalog-encryption
// migration to read/purge the superseded pre-encryption core.
export async function legacyPlaintextCatalogName(spaceId) {
  return plaintextCatalogName(await getSpace(spaceId), spaceId)
}

export async function ownCatalog(spaceId) {
  const cached = ownCatalogs.get(spaceId)
  if (cached) return cached
  const space = await getSpace(spaceId)
  const sck = getSpaceContentKey(spaceId, space)
  // A v2 space's catalog MUST be SCK-encrypted; an OWN catalog always has an SCK
  // (created ⇒ derivable, joined+approved ⇒ vault), so a missing one is a fault, not plaintext.
  if (space?.schemaVersion === 2 && !sck) throw new Error('ownCatalog: v2 space ' + spaceId + ' has no SCK')
  const bee = createBee(catalogNameForSpace(space, spaceId), sck ? { encryptionKey: sck } : {})
  await bee.ready()
  ownCatalogs.set(spaceId, bee)
  return bee
}

export async function ownCatalogKeyHex(spaceId) {
  const bee = await ownCatalog(spaceId)
  return b4a.toString(bee.core.key, 'hex')
}

// The own catalog key + whether it is the SCK-encrypted (v2) core. Callers publish the key
// into the matching field (…Enc for encrypted, the bare field for plaintext) so a reader
// knows from the FIELD whether to apply the SCK — the cross-version dual-read signal.
export async function ownCatalogPublish(spaceId) {
  const space = await getSpace(spaceId)
  const keyHex = await ownCatalogKeyHex(spaceId)
  return { keyHex, encrypted: space?.schemaVersion === 2 }
}

export async function advertise(spaceId, shareId, relPath, { size, mtime, contentHash = null }) {
  const bee = await ownCatalog(spaceId)
  await bee.put(fileKey(shareId, relPath), { size, mtime, contentHash })
}

export async function tombstone(spaceId, shareId, relPath) {
  const bee = await ownCatalog(spaceId)
  const key = fileKey(shareId, relPath)
  const node = await bee.get(key)
  if (!node) return
  await bee.put(key, { ...node.value, deletedAt: Date.now() })
}

export async function setMaterializedHash(spaceId, shareId, relPath, contentHash) {
  const bee = await ownCatalog(spaceId)
  const key = fileKey(shareId, relPath)
  const node = await bee.get(key)
  if (!node?.value || node.value.deletedAt) return
  if (node.value.contentHash === contentHash) return
  await bee.put(key, { ...node.value, contentHash })
}

export async function getOwnEntry(spaceId, shareId, relPath) {
  const bee = await ownCatalog(spaceId)
  const state = classifyEntryNode(await bee.get(fileKey(shareId, relPath)))
  return state && !state.removed ? { relPath, size: state.size, mtime: state.mtime, contentHash: state.contentHash } : null
}

export async function* listOwnShare(spaceId, shareId) {
  const bee = await ownCatalog(spaceId)
  yield* streamShare(bee, shareId)
}

// Tolerant listing for DISPLAY paths only (the renderer's file list). A storage
// inconsistency in the catalog's backing core ("Expected tree node N from storage")
// yields the partial listing read so far instead of throwing, so a corrupt core
// degrades the file list rather than blanking the share. MUTATING callers (scan,
// reconcile, resolveLooseName, presence sweeps, boot rehydrate) keep listOwnShare and
// still throw — they must never act on a partial listing (e.g. tombstone or overwrite
// based on entries the fault hid). Any non-inconsistency error propagates here too.
// Single-pass tolerant fold over an own share: count + sum EVERY non-deleted entry while
// retaining only the first `limit` rows. The display list AND folder-info both read from
// this one traversal, so the count can never disagree with the rows it shows, and capping
// `entries` bounds the worker heap on huge shares without losing the true total. An
// entry whose relPath would escape the mount is skipped from BOTH the count and the rows so
// the total matches what the display can actually render. A storage inconsistency degrades
// to a partial result (the display contract); any other error propagates.
export async function collectOwnShare(spaceId, shareId, limit = Infinity) {
  const entries = []
  let total = 0
  let totalBytes = 0
  try {
    for await (const entry of listOwnShare(spaceId, shareId)) {
      if (relKeyEscapes(entry.relPath)) continue
      total += 1
      if (Number.isFinite(entry.size)) totalBytes += entry.size
      if (entries.length < limit) entries.push(entry)
    }
  } catch (err) {
    if (!isStorageInconsistency(err)) throw err
    let dk = '?'
    try { const bee = await ownCatalog(spaceId); dk = b4a.toString(bee.core.discoveryKey, 'hex').slice(0, 16) } catch {}
    log.warn(`own catalog read aborted (core ${dk}…): ${err.message} — returning partial listing for display`)
  }
  return { entries, total, totalBytes }
}

// Array contract for the loose listing + the read-resilience callers (no cap/count needed).
export async function listOwnShareForDisplay(spaceId, shareId) {
  return (await collectOwnShare(spaceId, shareId)).entries
}

// A canonical 32-byte core key in lowercase hex. Rejects both malformed hex and non-string
// types: a peer's catalog key is self-asserted (its handshake or profile bee), and a
// wrong-length/typed value would throw synchronously out of store.get and break the whole listing.
const CATALOG_KEY_HEX = /^[0-9a-f]{64}$/

export function isValidCatalogKey(catalogKeyHex) {
  return typeof catalogKeyHex === 'string' && CATALOG_KEY_HEX.test(catalogKeyHex)
}

// The single sink every peer-catalog read funnels through. Returns null on an invalid key so a
// self-asserted bad key from any peer degrades to "no such catalog" instead of crashing the listing
// (store.get on a non-32-byte key throws). A v2 catalog is opened with the space SCK so only approved
// members decrypt it; a v1 plaintext catalog is opened with sck=null. Canonical
// lowercase-only, so one catalog opens one core regardless of hex case — and encrypted vs plaintext
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

// The catalog-key field convention has ONE owner (read + write) so a future variant can't drift
// across the many sites that touch it. A v2 (SCK-encrypted) key lives in the '<prefix>Enc'
// field, a v1/plaintext key in '<prefix>'; prefix is 'catalogKey' for share records/jobs,
// 'looseCatalogKey' for profile/handshake/member records.
export function catalogKeyField(keyHex, encrypted, prefix = 'catalogKey') {
  return { [encrypted ? prefix + 'Enc' : prefix]: keyHex }
}

// Read the catalog key + whether it's encrypted from a share/member/job/pending record. The …Enc
// field wins; a v1/plaintext key falls back. Recognises both the 'catalogKey' and 'looseCatalogKey'
// field pairs so one reader serves shares, members, and persisted rows.
export function readCatalogKey(rec) {
  const enc = rec?.catalogKeyEnc || rec?.looseCatalogKeyEnc || null
  if (enc) return { keyHex: enc, encrypted: true }
  return { keyHex: rec?.catalogKey || rec?.looseCatalogKey || null, encrypted: false }
}

// Resolve which catalog to read for a record + with what key. `readable` folds the whole gate:
// false when there's no key, or the catalog is encrypted but we hold no SCK (a pending joiner) —
// callers return their empty value. `space` may be injected to skip a getSpace read in hot loops.
export async function resolvePeerCatalog(spaceId, rec, { space } = {}) {
  const { keyHex, encrypted } = readCatalogKey(rec)
  const sck = encrypted && keyHex ? getSpaceContentKey(spaceId, space || await getSpace(spaceId)) : null
  return { keyHex, sck, encrypted, readable: !!keyHex && (!encrypted || !!sck) }
}

// Notify when a peer's catalog grows (owner advertised/changed a file). Mirrors
// the peer-drive append listener in swarm.js: the core's 'append' fires when new
// blocks replicate in, so a browsing peer live-refreshes instead of only seeing
// the snapshot present at first open. ONE per-(owner,space) catalog backs every
// share in that space (loose + each folder share), so a single key needs MULTIPLE
// listeners — one core 'append' hook fans out to every registered callback, deduped
// by listenerId so repeated browse/download calls don't double-register.
const peerCatalogWatchers = new Map() // catalogKeyHex -> { ids: Set<string>, cbs: Set<fn> }
export function watchPeerCatalog(catalogKeyHex, listenerId, onAppend, sck = null) {
  let w = peerCatalogWatchers.get(catalogKeyHex)
  if (!w) {
    const bee = openPeerCatalog(catalogKeyHex, sck)
    if (!bee) return
    w = { ids: new Set(), cbs: new Set() }
    peerCatalogWatchers.set(catalogKeyHex, w)
    bee.core.on('append', () => { for (const cb of w.cbs) cb() })
  }
  if (w.ids.has(listenerId)) return
  w.ids.add(listenerId)
  w.cbs.add(onAppend)
}

// Pull the owner's latest catalog head before reading. A read-only core opened
// by key starts at length 0 — bee.ready() does NOT fetch the remote head, so a
// createReadStream would scan an empty tree and return nothing until replication
// catches up on its own. Mirrors shares.js::collectPeerShares. Bounded so an
// offline owner (head never arrives) doesn't hang the listing.
const HEAD_TIMED_OUT = Symbol('head-timed-out')
async function syncPeerHead(bee, timeoutMs = peerReadTimeoutMs()) {
  await bee.ready()
  const res = await withReadTimeout(bee.core.update({ wait: true }), timeoutMs, HEAD_TIMED_OUT)
  return res !== HEAD_TIMED_OUT
}

// Single-pass peer read (the consumer analogue of collectOwnShare): head-sync, then drain
// the prefix retaining the first `limit` rows while counting + summing ALL of them in the one
// traversal, bounded by peerReadTimeoutMs. Because `total` and `entries` come from the same
// pass, total >= entries.length always — the renderer can never show a count below the rows it
// displays. `complete` requires the prefix to drain fully AND the head update to land before the
// budget AND the core to hold blocks (the per-(owner,space) catalog is shared across shares + the
// loose channel, so length>0 alone is only a global proxy); a not-yet-replicated, mid-tree-timed-out,
// or owner-unreachable read is flagged incomplete so the renderer keeps its last good list.
export async function collectPeerShare(catalogKeyHex, shareId, { sck = null, limit = Infinity, timeoutMs = peerReadTimeoutMs(), onEach = null } = {}) {
  const bee = openPeerCatalog(catalogKeyHex, sck)
  if (!bee) return { entries: [], complete: false, stalled: true, total: 0, totalBytes: 0 }
  let headSynced = false
  try { headSynced = await syncPeerHead(bee, timeoutMs) } catch { return { entries: [], complete: false, stalled: true, total: 0, totalBytes: 0 } }
  const prefix = sharePrefixKey(shareId)
  const stream = bee.createReadStream({ gte: prefix, lt: prefix + '\xff' })
  const { entries, complete, total, totalBytes } = await drainWithTimeout(stream, prefix, timeoutMs, limit, onEach)
  // `complete` also requires blocks (length>0) so the renderer keeps its last list over an
  // empty read; `stalled` is the narrower "the read could not finish" signal (head-sync
  // failed or the traversal timed out) — a legitimately-empty catalog is fully read, NOT
  // stalled, so a re-poll backstop keyed on stalled won't churn on a zero-share peer.
  const traversed = headSynced && complete
  return { entries, total, totalBytes, complete: traversed && bee.core.length > 0, stalled: !traversed }
}

export async function listPeerShareMeta(catalogKeyHex, shareId, { sck = null } = {}) {
  const { entries, complete } = await collectPeerShare(catalogKeyHex, shareId, { sck })
  return { entries, complete }
}

export async function listPeerShare(catalogKeyHex, shareId, { sck = null, timeoutMs } = {}) {
  return (await collectPeerShare(catalogKeyHex, shareId, { sck, timeoutMs })).entries
}

// Map a raw catalog node to the consumer-visible entry state — the one place that encodes
// tombstone vs. mid-rehash vs. absent. null = absent/unreadable (UNKNOWN, never "removed").
// `seq` is the Hyperbee block the value lives at: monotonic per key, bumped by every re-write
// (so a remove+re-add lands a higher seq even for identical content), replicated identically
// across peers — the migration-free generation marker a receiver uses to spot a re-publish.
export function classifyEntryNode(node) {
  if (!node?.value) return null
  if (node.value.deletedAt) return { removed: true }
  return { removed: false, seq: node.seq, size: node.value.size, mtime: node.value.mtime, contentHash: node.value.contentHash ?? null }
}

// Like getPeerEntry but surfaces a tombstone as { removed: true } instead of collapsing it
// to null, so a deliberate removal is distinguishable from a transient null (mid-rehash /
// offline owner / replication lag).
export async function getPeerEntryState(catalogKeyHex, shareId, relPath, { sck = null } = {}) {
  const bee = openPeerCatalog(catalogKeyHex, sck)
  if (!bee) return null
  try { await syncPeerHead(bee) } catch { return null }
  const node = await withReadTimeout(bee.get(fileKey(shareId, relPath)), peerReadTimeoutMs(), null)
  const state = classifyEntryNode(node)
  return state ? { relPath, ...state } : null
}

export async function getPeerEntry(catalogKeyHex, shareId, relPath, opts = {}) {
  const state = await getPeerEntryState(catalogKeyHex, shareId, relPath, opts)
  return state && !state.removed ? { relPath: state.relPath, size: state.size, mtime: state.mtime, contentHash: state.contentHash, seq: state.seq } : null
}

export function dropCatalog(spaceId, catalogKeyHex) {
  if (spaceId) ownCatalogs.delete(spaceId)
  if (catalogKeyHex) {
    peerCatalogs.delete(catalogKeyHex)
    peerCatalogWatchers.delete(catalogKeyHex)
  }
}

// Delete this space's own catalog core on leave. Closes the bee first so the purge can release
// its RocksDB session, then drops the alias so a same-name reopen after a rejoin doesn't resolve
// the deleted core. The leave flow deletes the space record BEFORE this runs, so it passes the
// record it already read — needed to resolve the v2 encrypted name ("-e1"). The discovery key is
// name-derived and independent of encryption, so no SCK is needed just to purge.
export async function purgeOwnCatalog(spaceId, space = null) {
  const rec = space || await getSpace(spaceId)
  const name = catalogNameForSpace(rec, spaceId)
  const bee = ownCatalogs.get(spaceId) || createBee(name)
  dropCatalog(spaceId)
  await purgeCatalogCore(bee, name)
}

// Close a catalog bee and delete its core + alias. Shared by leave (purgeOwnCatalog) and the
// catalog-encryption migration (purging the superseded plaintext core). The discovery key is name-derived and
// independent of encryption, so opening plaintext to read it is fine even for a v2 core.
async function purgeCatalogCore(bee, name) {
  const cs = getStore()
  await bee.ready()
  const dk = b4a.toString(bee.core.discoveryKey, 'hex')
  try { await bee.close() } catch {}
  await purgeCoreDk(cs, cs.storage.db, dk)
  await purgeAlias(cs, cs.ns, name)
}

// The pre-encryption plaintext catalog bee for a now-v2 space — opened by the catalog-encryption
// migration to COPY its entries into the encrypted core (so nothing is lost) before
// purgeLegacyPlaintextCatalog deletes it. A distinct name from the "-e1" core, so no alias collision.
export function openLegacyPlaintextCatalog(space, spaceId) {
  return createBee(plaintextCatalogName(space, spaceId))
}

export async function purgeLegacyPlaintextCatalog(space, spaceId) {
  const name = plaintextCatalogName(space, spaceId)
  await purgeCatalogCore(createBee(name), name)
}

async function* streamShare(bee, shareId) {
  const prefix = sharePrefixKey(shareId)
  for await (const node of bee.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
    if (node.value?.deletedAt) continue
    yield {
      relPath: node.key.slice(prefix.length),
      size: node.value.size,
      mtime: node.value.mtime,
      contentHash: node.value.contentHash ?? null,
    }
  }
}

// The single bounded-drain primitive: traverses the whole prefix to count + sum every
// non-deleted, in-mount entry, while retaining only the first `limit` rows. One traversal
// feeds both the (capped) display list and its true total, so they can never disagree, and
// nothing is held that scales past `limit`. `complete` is false on timeout or read fault.
// `onEach` (synchronous) observes EVERY counted entry regardless of `limit`, so an
// aggregate (e.g. the space-storage on-device sum) rides the same pass without
// retaining rows.
function drainWithTimeout(stream, prefix, timeoutMs, limit = Infinity, onEach = null) {
  return new Promise((resolve) => {
    const entries = []
    let total = 0
    let totalBytes = 0
    let settled = false
    const finish = (complete) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!complete) { try { stream.destroy() } catch {} }
      resolve({ entries, complete, total, totalBytes })
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
    ;(async () => {
      try {
        for await (const node of stream) {
          if (settled) break
          if (node.value?.deletedAt) continue
          const relPath = node.key.slice(prefix.length)
          if (relKeyEscapes(relPath)) continue
          total += 1
          if (Number.isFinite(node.value.size)) totalBytes += node.value.size
          if (onEach || entries.length < limit) {
            const entry = { relPath, size: node.value.size, mtime: node.value.mtime, contentHash: node.value.contentHash ?? null }
            onEach?.(entry)
            if (entries.length < limit) entries.push(entry)
          }
        }
        finish(true)
      } catch (err) {
        log.debug('peer catalog drain error:', err.message)
        finish(false)
      }
    })()
  })
}
