// The overlay content-backend adapter: the content-backend contract (index.js)
// implemented over the single HyperOverlayV2 instance + the per-share catalog.
// The canonical bytes are the user's REAL file on disk; nothing is copied into
// a core. Lifecycle: PUBLISH (stream the file once → whole-file content hash +
// chunk map) → ADVERTISE (entry into the share's replicated catalog, encrypted
// with the space content key) → SERVE (register path+hash so the membership-
// gated protocol can stream chunks to holders' requests) → FETCH (a consumer
// pulls by content hash from any online holder, verified chunk-by-chunk).
// Also here: the owner-side presence sweep, index compaction, and boot
// rehydrate of the in-memory serve maps.
import fs from 'bare-fs'
import path from 'bare-path'
import { createStreamingHasher } from './vendor/chunker.js'
import { getOverlay } from './overlay-instance.js'
import { createOverlayDownloadEngine } from './overlay-download.js'
import { serveIndex } from './overlay-serve-index.js'
import { makeSharesRefresh } from './overlay-refresh.js'
import {
  advertise as catalogAdvertise,
  tombstone as catalogTombstone,
  setMaterializedHash,
  getOwnEntry,
  listOwnShare,
  collectOwnShare,
  collectPeerShare,
  getPeerEntry,
  getPeerEntryState,
  watchPeerCatalog,
  resolvePeerCatalog,
  catalogKeyField,
} from '../../../shares/share-catalog.js'
import { getOwnedMount } from '../../../folders/mount-store.js'
import { fileExactlyPresent } from '../../../folders/disk-presence.js'
import { readOwnShares, readPeerShareEntry } from '../../../shares/shares.js'
import { listSpaces, clearAndPurgeCore } from '../../../spaces/space.js'
import { getStore } from '../../../core/store.js'
import { compactStore } from '../../swarm.js'
import { pathFromMount } from '../../path-guard.js'
import { shareDecoKey } from '../../decoration-key.js'
import { makeProgressTicker } from '../../progress-ticker.js'
import { reuseDest } from '../../download-dest.js'
import { supersedeDecision, republishDecision } from '../../supersede-decision.js'
import { getPendingFor } from '../../pending-transfers.js'
import { LOOSE_SHARE_ID, transferIdFor } from '../../transfer-id.js'
import { getDownloadDir } from '../../../core/paths.js'
import { AppError, ErrorCodes } from '../../../core/errors.js'
import { createLogger } from '../../../core/logger.js'

const log = createLogger('overlay')

// === fetch diagnostics ===

// The deliberate-stop outcomes finish() recognizes — normal control flow, logged
// at debug (never the give-up WARN). 'done' and 'failed' are handled explicitly;
// anything NOT in this set is treated as a give-up and WARNed, so a typo'd or
// renamed outcome can never silently downgrade a real give-up to an invisible
// debug line.
const DELIBERATE_STOPS = new Set(['paused', 'cancelled', 'superseded', 'no-holder'])

// Download instrumentation: logs fetch start, throttled mid-download progress
// (every 5s), the scheduler's terminal reason (timeout vs complete, with
// bytes/chunks transferred), and the final outcome — so a stalled large-file
// transfer reveals exactly where and why it stopped.
//
// finish(outcome): 'done' on success; a deliberate stop ('paused' / 'cancelled' /
// 'superseded' / 'no-holder') is normal control flow and logs at debug — NOT a
// WARN "gave up", which would make a user pausing a download read as a failure.
// Only a genuine give-up ('failed' — timeout / stall / no live holder / hash
// mismatch) warrants the WARN. An unrecognized outcome (caller bug) is fail-safe:
// it WARNs rather than silently logging at debug.
export function makeFetchDiag(label, relPath, total, contentHash) {
  const t0 = Date.now()
  let lastLog = 0
  let lastBytes = 0
  log.info(`${label} start:`, relPath, `size=${total}`, `hash=${(contentHash || '').slice(0, 12)}`)
  return {
    onProgress(bytes) {
      lastBytes = bytes
      const now = Date.now()
      if (now - lastLog < 5000) return
      lastLog = now
      const elapsed = (now - t0) / 1000
      const pct = total ? Math.floor((bytes / total) * 100) : 0
      const rate = elapsed > 0 ? (bytes / elapsed / 1048576).toFixed(1) : '0'
      log.info(`${label} progress:`, relPath, `${bytes}/${total} (${pct}%)`, `${rate} MB/s`, `elapsed=${elapsed.toFixed(0)}s`)
    },
    onEnd(info) {
      log.info(`${label} scheduler end:`, relPath, info.reason,
        `${info.receivedBytes}/${info.totalBytes} bytes`,
        `chunks ${info.totalChunks - info.chunksRemaining}/${info.totalChunks}`,
        `peers=${info.peers}`, `elapsed=${(info.elapsedMs / 1000).toFixed(0)}s`)
    },
    finish(outcome) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0)
      if (outcome === 'done') {
        log.info(`${label} done:`, relPath, `${total} bytes in ${elapsed}s`)
      } else if (DELIBERATE_STOPS.has(outcome)) {
        // Deliberate stop (paused / cancelled / superseded / no holder yet) — expected, not a failure.
        log.debug(`${label} ${outcome}:`, relPath, `at ${lastBytes}/${total} bytes after ${elapsed}s`)
      } else {
        // 'failed', or — fail-safe — any unrecognized outcome (a caller typo / renamed
        // state): WARN. A possible give-up must never be silently downgraded to debug.
        const tag = outcome !== 'failed' ? ` [outcome='${outcome}']` : ''
        log.warn(`${label} INCOMPLETE:`, relPath, `gave up after ${elapsed}s at ${lastBytes}/${total} bytes${tag}`)
      }
    },
  }
}

// === worker wiring: IPC emitter + cross-module hooks ===

let ipcRef = null
let peerPrepareBroadcast = null
// Set on graceful shutdown so every in-flight publish's hash aborts promptly (the loop frees the
// event loop for teardown to win the parent's SIGKILL race). The half-advertised null-hash entry
// is intentionally left in place — boot rehydration re-hashes it, so a quit mid-index doesn't lose
// a file the user added.
let publishesAborting = false
const sharesRefresh = makeSharesRefresh(
  (spaceId, shareId) => ipcRef?.emit('event:share-files-updated', { spaceId, shareId }),
)
export function initContentBackendOverlay(ipc) { ipcRef = ipc }
export function _resetContentBackendOverlay() { ipcRef = null; sharesRefresh.reset(); peerPrepareBroadcast = null; pendingPublishProbe = null; presenceGone.clear(); publishesAborting = false }
export function abortInFlightPublishes() { publishesAborting = true }
export function setSharePrepareBroadcast(fn) { peerPrepareBroadcast = fn }
// Installed by owned-folders: (spaceId, shareId, relPath) → true while a publish for that path is
// queued or running, so the presence sweep never reclaims a file whose publish has not started.
let pendingPublishProbe = null
export function setPendingPublishProbe(fn) { pendingPublishProbe = fn }

// Notified with (spaceId) whenever an owner's catalog appends, so a foreign mirror can
// materialize the change promptly instead of waiting for its poll. (The catalog is the
// only replicated signal of overlay content changes — no drive carries the file bytes.)
let catalogChangeHook = null
export function setOverlayCatalogChangeHook(fn) { catalogChangeHook = fn }
export function broadcastSharePrepare(spaceId, payload) { peerPrepareBroadcast?.(spaceId, payload) }

// === publish/fetch core: hash + advertise + register servable ===

// Hashing: stream the file through the wire-compatible blake2b (size REQUIRED,
// or the digest is a plain blake2b that won't match registerFile / the consumer
// verify). No bytes enter any core — this is overlay's only sender-side cost.
// onProgress(len) receives the incremental byte count of each read chunk. `signal` is polled
// per chunk like the serve-prep hasher's: a cancelled publish must not hold its slot for the
// rest of a multi-gigabyte read. Rejects with ECANCELLED, the same code prepareForServe uses.
async function hashOnDisk(absPath, size, onProgress, signal) {
  const h = createStreamingHasher({ size })
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(absPath)
    rs.on('data', (c) => {
      if (signal?.aborted) {
        const err = new Error('hash aborted')
        err.code = 'ECANCELLED'
        rs.destroy(err)
        return
      }
      h.update(c)
      onProgress?.(c.length)
    })
    rs.on('end', resolve)
    rs.on('error', reject)
  })
  return h.digest()
}

// The overlay content hash of an on-disk file (size-bound, wire-compatible). The
// mirror MUST use this — NOT a plain blake2b — to compare an on-disk copy against
// a catalog `contentHash`, or the comparison never matches (overlay hashes are
// leaf/size-prefixed). statSync for the size.
export async function overlayHashFile(absPath, onProgress, signal) {
  return hashOnDisk(absPath, fs.statSync(absPath).size, onProgress, signal)
}

// ── make a local file servable by its content hash + indexed for the serve gate.
// relPath is the advertising path: the serve index refcounts by (space, path) so
// content-addressed dedup (two paths, one hash) survives a per-path delete.
export async function makeServable(spaceId, shareId, relPath, absPath, contentHash, size) {
  const overlay = getOverlay()
  if (!overlay) return
  // Publish is always lazy-serve: register the path+hash but skip the eager chunk-map
  // (a full second read). _onContentRequest builds + caches it on the first peer fetch.
  // registerFile returns null if the source vanished at register time — don't claim a
  // serve we can't back (serveIndex and the overlay's path map must stay in lockstep).
  const registered = await overlay.registerFile('/mir/' + contentHash, absPath, { contentHash, size, prepare: false })
  if (!registered) return
  serveIndex.add(contentHash, spaceId, shareId, relPath)
}

// The reconcile's self-heal for a file it will NOT re-publish (size+mtime+hash unchanged): a
// transient registerFile failure, or anything else that left the catalog advertising a hash the
// serve gate does not hold, is repaired on the next pass. Free when the reference is present.
export async function ensureServable(spaceId, shareId, relPath, absPath, contentHash, size) {
  if (serveIndex.hasRef(contentHash, spaceId, shareId, relPath)) return
  await makeServable(spaceId, shareId, relPath, absPath, contentHash, size)
}

// Shared publish core (folder + loose), no IPC emit. Advertise FIRST with
// contentHash:null so the entry is visible to members the instant it is added
// (consumer status `preparing`), then hash and backfill (catalog update
// replicates → consumer flips preparing→remote). onAdvertised(size) fires right
// after the advertise, before the slow hash, so a caller can refresh its UI at
// advertise-time; onProgress(len) gets the incremental hashed-byte count. Returns
// { changed, contentHash } — contentHash null only when the source is gone / not a file.
const directCatalog = { advertise: catalogAdvertise, setMaterializedHash, tombstone: catalogTombstone, get: getOwnEntry }

export async function publishContent(spaceId, shareId, relPath, absPath, { onAdvertised, onProgress, signal, catalog = directCatalog, force = false } = {}) {
  let st
  try { st = fs.statSync(absPath) } catch { return { changed: false, contentHash: null } }
  if (!st.isFile()) return { changed: false, contentHash: null }

  // Read through the catalog this publish writes through: a bulk batch can hold a materialized
  // hash for up to its flush window, and reading the bee instead would re-hash that file.
  // `force` is the deep pass having already proven the content changed under an unchanged
  // size+mtime — the one case this fast path is blind to.
  const prev = await catalog.get(spaceId, shareId, relPath)
  if (!force && prev && prev.size === st.size && prev.mtime === st.mtimeMs && prev.contentHash) {
    // Unchanged + already hashed — only ensure it is servable (e.g. after a
    // restart dropped the in-memory serve maps). No catalog write.
    await makeServable(spaceId, shareId, relPath, absPath, prev.contentHash, st.size)
    return { changed: false, contentHash: prev.contentHash }
  }

  await catalog.advertise(spaceId, shareId, relPath, { size: st.size, mtime: st.mtimeMs, contentHash: null })
  // Awaited: the loose path records the owned-source link here, and it must commit BEFORE the
  // multi-minute hash so a quit mid-hash stays recoverable (the folder callback is synchronous).
  await onAdvertised?.(st.size)
  // Build the content hash AND the FastCDC chunk map in a single streaming read, so
  // the first peer fetch serves immediately instead of paying a full-file re-chunk
  // before the first byte. The by-hash map is durable in FileIndex (survives restart).
  //
  // The entry is now half-advertised (contentHash:null). If the hash fails or yields
  // nothing — a chunk-map persist that threw on a huge file, a cancel, a vanished source
  // — undo it so it doesn't linger as a stuck "preparing"/"adding" entry: a re-publish
  // reverts to the prior version, a first publish is tombstoned. Reverting HERE covers
  // both the loose (runLoosePublish) and folder (publishOne) callers, which
  // both advertise through this function. Once setMaterializedHash writes the real hash
  // the entry is no longer stuck; a later makeServable failure self-heals on the next
  // reconcile, so it stays outside the revert window.
  let contentHash
  try {
    const prep = await getOverlay()?.prepareForServe(absPath, { onProgress, signal: { get aborted () { return publishesAborting || Boolean(signal?.aborted) } } })
    if (!prep?.contentHash) {
      // Same guard as the catch below: on shutdown (incl. getOverlay() gone null mid-teardown)
      // leave the null-hash entry for boot re-hash instead of unsharing the file.
      if (!publishesAborting) await revertHalfAdvertised(spaceId, shareId, relPath, prev, catalog)
      return { changed: false, contentHash: null }
    }
    contentHash = prep.contentHash
    await catalog.setMaterializedHash(spaceId, shareId, relPath, contentHash)
  } catch (err) {
    // On shutdown, leave the half-advertised null-hash entry so boot rehydration re-hashes it;
    // only a real failure/cancel reverts (tombstone/prior-version).
    if (!publishesAborting) await revertHalfAdvertised(spaceId, shareId, relPath, prev, catalog)
    throw err
  }
  await makeServable(spaceId, shareId, relPath, absPath, contentHash, st.size)
  return { changed: true, contentHash }
}

// Undo a half-advertised (contentHash:null) catalog entry after a failed publish:
// re-advertise the prior version on a re-publish, or tombstone a first publish.
// Non-throwing on purpose: the caller is about to rethrow the publish error, which this must not
// replace. A revert that fails leaves the entry visible to members as 'preparing' until the next
// scan or boot rehydrate re-hashes it, so the operator has to be told.
async function revertHalfAdvertised(spaceId, shareId, relPath, prev, catalog = directCatalog) {
  try {
    if (prev?.contentHash) {
      await catalog.advertise(spaceId, shareId, relPath, { size: prev.size, mtime: prev.mtime, contentHash: prev.contentHash })
    } else {
      await catalog.tombstone(spaceId, shareId, relPath)
    }
  } catch (err) {
    log.warn('could not revert a half-advertised entry — members see it as preparing until the next scan:', shareId, relPath, '-', err.message)
  }
}

// Folder publish for one file (no view-refresh emit — callers batch that; the terminal decoration
// `done` fires here in a finally, on success AND throw, so a failed hash can't strand a preparing bar).
async function publishOne(spaceId, share, relPath, absPath, { catalog = directCatalog, signal, deep = false } = {}) {
  let ticker = null
  try {
    let force = false
    if (deep) {
      const verdict = await deepVerdict(spaceId, share, relPath, absPath, catalog, signal)
      if (verdict === 'unchanged') return false
      force = verdict === 'changed'
    }
    const { changed } = await publishContent(spaceId, share.id, relPath, absPath, {
      catalog,
      signal,
      force,
      // Refresh the owner's view NOW (the `preparing` row) + start the hashing-progress
      // ticker — the same instant the consumer's peer-catalog append surfaces it.
      onAdvertised: (size) => {
        sharesRefresh.touch(spaceId, share.id)
        ticker = makeProgressTicker(size, ({ bytes, total, speed, eta }) => {
          ipcRef?.emit('event:decoration', { channel: 'transfer', spaceId, key: shareDecoKey(share.id, relPath), phase: 'preparing', bytes, total, speed, eta })
          broadcastSharePrepare(spaceId, { shareId: share.id, relPath, bytes, total, eta })
        })
      },
      onProgress: (len) => ticker?.push(len),
    })
    return changed
  } finally {
    ipcRef?.emit('event:decoration', { channel: 'transfer', spaceId, key: shareDecoKey(share.id, relPath), done: true })
  }
}

// Shared consumer fetch (folder + loose): pull by content hash to finalPath, no
// second copy, integrity-verified during the transfer. A local hit returns the
// source path → copy it to finalPath so the download is real. Returns
// { ok:true } | { ok:false, code, cause? } (EHASHMISMATCH or an error message, cause = the
// underlying Error for classification) | { ok:false } (no holder).
export async function fetchContentToFile(contentHash, { finalPath, onProgress, onVerify, onEnd }) {
  const overlay = getOverlay()
  if (!overlay) return { ok: false }
  let res
  try {
    res = await overlay.fetchFile(contentHash, { destPath: finalPath, onProgress, onVerify, onEnd, reSeed: false })
  } catch (err) {
    if (err?.code === 'EHASHMISMATCH') return { ok: false, code: 'EHASHMISMATCH' }
    if (err?.code === 'ECANCELLED') return { ok: false, code: 'ECANCELLED' }
    return { ok: false, code: err?.message || 'fetch-failed', cause: err }
  }
  if (!res) return { ok: false }
  if (res.local && res.destPath !== finalPath) {
    try { fs.copyFileSync(res.destPath, finalPath) } catch (err) { return { ok: false, code: err?.message || 'copy-failed', cause: err } }
  }
  return { ok: true }
}

// === owner: contract methods + catalog reconcile ===

export async function overlayPublishAdd(spaceId, share, relPath, absPath, opts = {}) {
  try {
    return await publishOne(spaceId, share, relPath, absPath, opts)
  } finally {
    // Refresh on success AND on a reverted failure (publishContent undoes the half-advertised
    // entry on throw). A batched bulk publish coalesces; a direct one flushes now.
    if (opts.catalog) sharesRefresh.touch(spaceId, share.id)
    else sharesRefresh.flush(spaceId, share.id)
  }
}

// Drop THIS path's serve reference; content-addressed dedup keeps the hash servable
// while any other path advertises it (refcount-by-path). When this was the last
// reference the durable chunk map is now garbage — evict it so it doesn't accumulate.
export async function evictIfUnreferenced(contentHash, spaceId, shareId, relPath) {
  if (!contentHash) return
  if (!serveIndex.remove(contentHash, spaceId, shareId, relPath)) return
  try { await getOverlay()?.evictContent(contentHash) } catch (err) { log.warn('evictContent failed:', err.message) }
}

// A bulk retire writes through the space's catalog batch like a bulk publish (one head for a
// thousand deletions, not a thousand). The serve reference is dropped only once the tombstone
// has LANDED — a peer must never see a file still advertised but no longer servable — and for a
// batched write that wait is off the executor's critical path: the item settles at once, the
// eviction follows the flush.
export async function overlayPublishDelete(spaceId, share, relPath, { catalog = directCatalog } = {}) {
  const prev = await catalog.get(spaceId, share.id, relPath)
  const staged = await catalog.tombstone(spaceId, share.id, relPath)
  const evict = () => evictIfUnreferenced(prev?.contentHash, spaceId, share.id, relPath)
  if (staged?.landed) void staged.landed.then(evict)
  else await evict()
  if (catalog === directCatalog) sharesRefresh.flush(spaceId, share.id)
  else sharesRefresh.touch(spaceId, share.id)
}

// Reclaim the overlay index: rebuild it without chunk maps for content no longer
// shared or held, then return the freed disk to the OS. Non-destructive — a dropped
// map is content-addressed and re-chunks on the next serve.
// Single-flight so two reclaims can't race the same core purge. A transfer write
// that lands mid-compaction is rebuildable (chunk maps re-chunk, file:/sync:/tree:
// re-derive from the catalog/source), so no user data is at risk.
let compactingIndex = false
export async function compactOverlayIndex() {
  const overlay = getOverlay()
  if (!overlay || compactingIndex) return { compacted: false }
  compactingIndex = true
  try {
    // Authoritative "still served" set = the live owned-catalog hashes. serveIndex is
    // rebuilt from it on boot but accumulates superseded hashes across a session, so it
    // can't be trusted to decide which content-addressed maps are dead.
    const served = new Set()
    const addCatalogHashes = async (spaceId, shareId) => {
      for await (const entry of listOwnShare(spaceId, shareId)) {
        if (entry.contentHash) served.add(entry.contentHash)
      }
    }
    for (const space of await listSpaces()) {
      for (const share of await readOwnShares(space.spaceId)) await addCatalogHashes(space.spaceId, share.id)
      // Loose single-file shares aren't in readOwnShares — they live under the loose
      // pseudo-share. Miss them here and compaction drops the chunk maps of files still
      // being shared, forcing a re-chunk on the next serve.
      await addCatalogHashes(space.spaceId, LOOSE_SHARE_ID)
    }
    const oldCore = await overlay.compactIndex({ isServed: (hash) => served.has(hash) })
    if (!oldCore) return { compacted: false } // nothing droppable — index left untouched
    const cs = getStore()
    await clearAndPurgeCore(cs, cs.storage.db, oldCore)
    await compactStore()
    return { compacted: true }
  } finally {
    compactingIndex = false
  }
}

// Deep-scan (relocate, the Nth periodic pass) verdict for one file, by content hash:
//   'unchanged' — same size + same hash: serving is re-pointed at the path, a drifted mtime is
//                 refreshed without re-advertising (no mirror churn), and the publish is skipped;
//   'changed'   — same size, different hash: an in-place rewrite. The publish MUST run even when
//                 the mtime is unchanged too (the fast path would call that "already published");
//   'unknown'   — nothing to compare against (no hash yet, size differs, unreadable): the
//                 ordinary size+mtime publish decides.
async function compareDeep(spaceId, share, relPath, abs, info, prev, catalog, signal) {
  if (!prev?.contentHash || prev.size !== info.size) return 'unknown'
  let diskHash
  try { diskHash = await overlayHashFile(abs, undefined, signal) } catch (err) {
    if (err?.code === 'ECANCELLED') throw err
    return 'unknown'
  }
  if (diskHash !== prev.contentHash) return 'changed'
  await makeServable(spaceId, share.id, relPath, abs, prev.contentHash, info.size)
  if (prev.mtime !== info.mtime) await catalog.advertise(spaceId, share.id, relPath, { size: info.size, mtime: info.mtime, contentHash: prev.contentHash })
  return 'unchanged'
}

async function deepVerdict(spaceId, share, relPath, abs, catalog, signal) {
  let st
  try { st = fs.statSync(abs) } catch { return 'unknown' }
  const prev = await catalog.get(spaceId, share.id, relPath)
  return await compareDeep(spaceId, share, relPath, abs, { size: st.size, mtime: st.mtimeMs }, prev, catalog, signal)
}

export async function overlayListOwn(spaceId, shareId, limit = Infinity) {
  // One tolerant pass returns the capped rows AND the true {total, totalBytes} (folder-info
  // passes limit=0 to count only). A corrupt catalog core degrades to a partial result
  // instead of blanking the share; mutating callers above keep listOwnShare and fail loud.
  return await collectOwnShare(spaceId, shareId, limit)
}

// === consumer: listing + downloads ===

// Per-share listenerId: the per-(owner,space) catalog is shared by every folder
// share + the loose channel, so each needs its own append reconcile (one fans out).
function ensurePeerCatalogWatch(spaceId, share, keyHex, sck) {
  watchPeerCatalog(keyHex, 'folder:' + share.id, () => {
    ipcRef?.emit('event:files-updated', { spaceId })
    catalogChangeHook?.(spaceId)
    reconcileActiveOverlayTransfers(spaceId, share).catch((err) => log.debug('overlay source-change reconcile failed:', err.message))
    // One reconcile pass over our inactive pending rows: tear down downloads for a source the owner
    // tombstoned OR re-published (so a re-add does NOT auto-resume), and re-drive interrupted ones.
    folderEngine.reconcileOnAppend(share.owner, spaceId).catch((err) => log.debug('overlay catalog-append reconcile failed:', err.message))
  }, sck)
}

// Display read: one pass carries the capped rows, the completeness flag (so the renderer
// keeps its last good list on a partial/timed-out peer read instead of blanking), and the
// true {total, totalBytes} (folder-info passes limit=0 to count only). `onEach` observes
// every counted entry regardless of the cap — the space-storage summary sums a mirror's
// verified bytes through it without retaining rows.
export async function overlayListPeerWithMeta(spaceId, share, limit = Infinity, onEach = null) {
  const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, share)
  if (!readable) return { entries: [], complete: true, total: 0, totalBytes: 0 }
  ensurePeerCatalogWatch(spaceId, share, keyHex, sck)
  return await collectPeerShare(keyHex, share.id, { sck, limit, onEach })
}

// On an owner-catalog append, re-resolve every active overlay-folder transfer from THIS
// owner/share. If the owner re-published a file under a new contentHash, supersede the
// stale fetch and restart it against the new content (same as the loose path).
async function reconcileActiveOverlayTransfers(spaceId, share) {
  const { keyHex, sck, encrypted, readable } = await resolvePeerCatalog(spaceId, share)
  if (!readable) return
  const prefix = '/' + share.name + '/'
  for (const [transferId, slot] of folderEngine.activeSlots()) {
    if (slot.spaceId !== spaceId || slot.ownerPublicKey !== share.owner || !slot.pendingKey.startsWith(prefix)) continue
    const relPath = slot.pendingKey.slice(prefix.length)
    const inflightHash = slot.contentHash
    const state = await getPeerEntryState(keyHex, share.id, relPath, { sck })
    const decision = republishDecision(inflightHash, state, slot.sourceSeq)
    // Tombstoned, or re-added with identical content → terminate; don't silently continue the
    // old partial. A genuine content change falls through to the supersede below.
    if (decision === 'drop') { await folderEngine.dropRemoved(spaceId, slot.pendingKey, transferId).catch((err) => log.debug('overlay active drop-removed failed:', err.message)); continue }
    // Mid-rehash: a new version is advertised, its hash not materialized yet. Park the transfer as
    // 'preparing' (abort the doomed old-hash fetch, keep the row) — the setMaterializedHash append
    // restarts it on the new content via runReconcile.
    if (decision === 'pending') { folderEngine.releaseForRepublish(transferId); continue }
    if (decision !== 'restart' && supersedeDecision(inflightHash, state?.contentHash) !== 'restart') continue
    folderEngine.supersede(transferId, {
      spaceId, pendingKey: slot.pendingKey, path: slot.pendingKey, relPath, shareId: share.id, ...catalogKeyField(keyHex, encrypted),
      transferId,
      contentHash: state.contentHash, size: state.size || 0, sourceSeq: state.seq,
      ownerPublicKey: share.owner, verifyKey: share.id + '|' + relPath,
      finalPath: slot.finalPath,
    }, inflightHash)
  }
}

async function peerEntry(spaceId, share, relPath) {
  const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, share)
  if (!readable) return null
  return await getPeerEntry(keyHex, share.id, relPath, { sck })
}

// Non-mirrored overlay folder downloads run on the shared overlay consumer engine
// (single-flight, real pause/resume, stop/cancel, auto-resume) — the same engine the
// space-root loose path uses. This is the folder "channel": share-file-* event names
// + the catalog/ownerKey/pending-key specifics. The pending row carries catalogKey so
// reconnect-resume can re-look-up the entry without a share descriptor.
// Folder-share progress is DECORATION on the unified 'transfer' channel, keyed shareId:relPath
// (parity with the loose path's per-space path keys). The renderer merges it at render, gated on
// the worker-derived status, so a lingering entry after a missed `done` stays invisible.
const shareDeco = (job, p) => ipcRef?.emit('event:decoration', { channel: 'transfer', spaceId: job.spaceId, key: shareDecoKey(job.shareId, job.relPath), ...p })

const folderEngine = createOverlayDownloadEngine({
  diagLabel: 'overlay download',
  inPlace: false,
  ownsPendingRow: (row) => row.overlayShare === true,
  pendingExtra: (job) => ({ overlayShare: true, shareId: job.shareId, relPath: job.relPath, ...catalogKeyField(job.catalogKeyEnc || job.catalogKey, !!job.catalogKeyEnc) }),
  emitProgress: (job, p) => shareDeco(job, { bytes: p.bytes, total: p.total, speed: p.speed, eta: p.eta }),
  emitVerifying: (job, fraction) => shareDeco(job, { phase: 'verifying', verifyFraction: fraction, bytes: job.prevBytes || 0, total: job.size }),
  // Folder rows surface errors via the list refresh (Resume retries); only the terminal
  // failures cross the wire — disk-full, an integrity mismatch and an unreachable download
  // folder need the user's attention (toast + notification) and no automatic retry can fix any
  // of them. The membership of this set and the auto-resume suppression in overlay-download.js
  // are the same judgement: a fault the user must clear before a retry can ever succeed.
  emitError: (job, errorCode) => {
    if (errorCode === ErrorCodes.TRANSFER_DISK_FULL || errorCode === ErrorCodes.TRANSFER_CHECKSUM
      || errorCode === ErrorCodes.TRANSFER_DEST_UNAVAILABLE) {
      ipcRef?.emit('event:transfer-error', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, errorCode })
    }
    shareDeco(job, { done: true })
  },
  emitComplete: (job, localPath) => { ipcRef?.emit('event:transfer-complete', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, localPath }); shareDeco(job, { done: true }) },
  // The cancel path has no job, but the pending row carries shareId/relPath (pendingExtra) —
  // emit the terminal done frame so the entry can't resurrect a stale bar when the same key
  // later re-derives 'downloading' (re-download, or a mirror fetch of the same file).
  emitCancelled: (spaceId, transferId, pendingKey, row) => {
    if (row?.shareId && row?.relPath) ipcRef?.emit('event:decoration', { channel: 'transfer', spaceId, key: shareDecoKey(row.shareId, row.relPath), done: true })
  },
  emitPaused: (job) => shareDeco(job, { done: true }),
  emitDecorationDone: (job) => shareDeco(job, { done: true }),
  transferIdForRow: (spaceId, row) => transferIdFor(spaceId, row.shareId, row.relPath),
  emitSuperseded: (job) => { ipcRef?.emit('event:transfer-superseded', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, fileName: path.basename(job.relPath) }); shareDeco(job, { bytes: 0, total: job.size, speed: 0, eta: null }) },
  emitUpdated: (spaceId) => ipcRef?.emit('event:share-files-updated', { spaceId }),
  resolvePendingRow: async (spaceId, row) => {
    // Prefer the owner's CURRENT share record over the persisted row's key: when an owner
    // migrates its catalog to SCK encryption the catalog key changes (plaintext→encrypted)
    // and the plaintext core is purged, so a row-only resolve would open the dead core.
    // Fall back to the row when the descriptor is unreadable (owner offline). Mirrors the
    // loose path, which re-derives from the live member.
    const share = await readPeerShareEntry(row.ownerKey, spaceId, row.shareId)
    const { keyHex, sck, encrypted, readable } = await resolvePeerCatalog(spaceId, share || row)
    if (!readable) return { removed: false, seq: undefined, job: null }
    const state = await getPeerEntryState(keyHex, row.shareId, row.relPath, { sck })
    if (state?.removed) return { removed: true, seq: undefined, job: null }
    if (!state?.contentHash) return { removed: false, seq: state?.seq, job: null }
    // Re-anchor to the space's CURRENT download folder: a row pinned before the user
    // re-pointed the space would otherwise resume into the old one. A re-anchored row starts
    // from zero — its bytes live in the old folder's partial, which the boot sweep reclaims.
    const finalPath = reuseDest(row.finalPath, getDownloadDir(spaceId), path.basename(row.relPath))
    return {
      removed: false, seq: state.seq,
      job: {
        spaceId, pendingKey: row.filePath, path: row.filePath, relPath: row.relPath, shareId: row.shareId, ...catalogKeyField(keyHex, encrypted),
        transferId: transferIdFor(spaceId, row.shareId, row.relPath),
        contentHash: state.contentHash, size: state.size || 0, sourceSeq: state.seq,
        ownerPublicKey: row.ownerKey, verifyKey: row.shareId + '|' + row.relPath,
        finalPath, prevBytes: finalPath === row.finalPath ? row.bytesTransferred : 0,
      },
    }
  },
  emitRemovedByOwner: (spaceId, pendingKey, row, transferId) =>
    ipcRef?.emit('event:transfer-removed', { spaceId, transferId, path: pendingKey, fileName: path.basename(row?.relPath || pendingKey) }),
})

// Consumer single-file download: fetch by contentHash straight from a holder and
// write to the downloads folder. No second copy stored (reSeed:false). When the
// hash is not yet advertised (owner still hashing), report queued.
export async function overlayRequestDownload(spaceId, share, relPath) {
  // Doubles as the manual resume, so retire any pause marker before the guards below can return
  // early — a marker left set suppresses every later auto-resume for this row.
  folderEngine.clearPauseMarker(transferIdFor(spaceId, share.id, relPath))
  if (!getOverlay()) return { queued: true }
  const { keyHex, sck, encrypted, readable } = await resolvePeerCatalog(spaceId, share)
  if (!readable) return { queued: true }
  const entry = await getPeerEntry(keyHex, share.id, relPath, { sck })
  if (!entry?.contentHash) return { queued: true }
  const drivePath = '/' + share.name + '/' + relPath
  const prev = await getPendingFor(spaceId, drivePath)
  const finalPath = reuseDest(prev?.finalPath, getDownloadDir(spaceId), path.basename(relPath))
  return folderEngine.start({
    spaceId, pendingKey: drivePath, path: drivePath, relPath, shareId: share.id, ...catalogKeyField(keyHex, encrypted),
    transferId: transferIdFor(spaceId, share.id, relPath),
    contentHash: entry.contentHash, size: entry.size || 0, sourceSeq: entry.seq,
    ownerPublicKey: share.owner, verifyKey: share.id + '|' + relPath,
    finalPath, prevBytes: finalPath === prev?.finalPath ? prev.bytesTransferred : 0,
  })
}

export const overlayPause = (transferId) => folderEngine.pause(transferId)
export const overlayCancel = (transferId) => folderEngine.cancel(transferId)
export const overlayCancelByKey = (spaceId, drivePath, transferId) => folderEngine.cancelByKey(spaceId, drivePath, transferId)
// Cancel + discard every in-flight overlay-folder download for a space (leave teardown):
// the engine keeps fetching a started transfer even after its pending row is cleared, so
// without this the partial is orphaned and a late completion re-writes purged meta rows.
export async function overlayCancelSpace (spaceId) {
  const ids = []
  for (const [transferId, slot] of folderEngine.activeSlots()) {
    if (slot.spaceId === spaceId) ids.push(transferId)
  }
  // Per-id best-effort: cancel now throws when the row cannot be cleared, and the leave's own
  // clearPendingForSpace purges the rows a beat later — one failed discard must not abort the leave.
  await Promise.all(ids.map((id) => folderEngine.cancel(id).catch((err) => log.warn('cancel on leave failed:', id, '-', err.message))))
}
export const resumeOverlayForOwner = (ownerKey, spaceId) => folderEngine.resumeForOwner(ownerKey, spaceId)
export const overlayHasTransfer = (transferId) => folderEngine.has(transferId)

// Foreign-mirror variant: confirm the file is advertised + hashed and return its
// contentHash. The overlay mirror read-to-mount (a fetchFile to the mount path)
// is wired in foreign-folders for backend.mode==='overlay' — there is no
// peer drive to read from.
export async function overlayEnsureRemote(spaceId, share, relPath) {
  const entry = await peerEntry(spaceId, share, relPath)
  if (!entry?.contentHash) throw new AppError(ErrorCodes.NOT_FOUND, 'not advertised / not yet hashed')
  return entry.contentHash
}

export function overlayReleaseRemote() {
  // No-op — overlay stores nothing on the owner to release; it serves straight
  // from the source file.
}

// === boot rehydrate + presence sweep ===

// Boot rehydrate: the facade serve maps (_contentHashPaths) are NOT persisted,
// so after a worker restart owned files stop being servable until re-registered.
// Re-register every owned overlay file whose source still exists.
async function rehydrateShare(spaceId, shareId, mountPath) {
  for await (const entry of listOwnShare(spaceId, shareId)) {
    if (!entry.contentHash) continue
    try {
      const abs = pathFromMount(mountPath, entry.relPath)
      if (!fs.statSync(abs).isFile()) continue
      await makeServable(spaceId, shareId, entry.relPath, abs, entry.contentHash, entry.size)
    } catch (err) {
      log.debug('rehydrate skipped:', entry.relPath, '-', err.message)
    }
  }
}

// Walk every owned overlay share that has a mount, invoking cb(spaceId, shareId,
// mountPath). Shared by rehydrate (boot) and the presence sweep (backstop).
async function forEachOwnedOverlayShare(cb) {
  for (const space of await listSpaces()) {
    let shares
    try { shares = await readOwnShares(space.spaceId) } catch { continue }
    for (const share of shares) {
      if (share.contentMode !== 'overlay') continue
      const mount = await getOwnedMount(space.spaceId, share.id)
      if (mount?.mountPath) await cb(space.spaceId, share.id, mount.mountPath)
    }
  }
}

export async function rehydrateOwnedFiles() {
  await forEachOwnedOverlayShare(rehydrateShare)
}

// Confirm-gone-twice (a path must be missing on two consecutive sweeps) so an
// atomic-save window (editor rename-over / delete+recreate) doesn't transiently
// tombstone a still-present file — which would cascade the deletion to every
// mirror peer. Mirrors the loose sweep's sweepGone guard (loose-overlay.js).
const presenceGone = new Set()
const presenceGoneKey = (spaceId, shareId, relPath) => spaceId + '\0' + shareId + '\0' + relPath

// Backstop: tombstone catalog entries whose source file vanished but whose
// chokidar unlink event was missed. Mount-root guarded — a temporarily-
// unavailable mount must never mass-tombstone a share.
export async function overlaySweepPresence() {
  await forEachOwnedOverlayShare(async (spaceId, shareId, mountPath) => {
    try { if (!fs.statSync(mountPath).isDirectory()) return } catch { return } // root gone → skip
    let changed = false
    for await (const entry of listOwnShare(spaceId, shareId)) {
      const key = presenceGoneKey(spaceId, shareId, entry.relPath)
      if (pendingPublishProbe?.(spaceId, shareId, entry.relPath)) { presenceGone.delete(key); continue }
      // Exact-name presence, like the retire executor: a following stat would keep a case-only
      // rename's old key alive forever on a case-folding volume.
      let exists = false
      try { exists = fileExactlyPresent(pathFromMount(mountPath, entry.relPath)) } catch {}
      if (exists) { presenceGone.delete(key); continue }
      if (!presenceGone.has(key)) { presenceGone.add(key); continue } // arm; reclaim only on a 2nd consecutive miss
      presenceGone.delete(key)
      await catalogTombstone(spaceId, shareId, entry.relPath)
      await evictIfUnreferenced(entry.contentHash, spaceId, shareId, entry.relPath)
      changed = true
    }
    if (changed) ipcRef?.emit('event:share-files-updated', { spaceId, shareId })
  })
}
