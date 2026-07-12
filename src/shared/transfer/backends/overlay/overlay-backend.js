// The overlay content-backend adapter: the content-backend contract (index.js)
// implemented over the single HyperOverlayV2 instance + the per-share catalog.
// The canonical bytes are the user's REAL file on disk; nothing is copied into
// a core. Lifecycle: PUBLISH (stream the file once → whole-file content hash +
// chunk map) → ADVERTISE (entry into the share's replicated catalog, encrypted
// with the space content key) → SERVE (register path+hash so the membership-
// gated protocol can stream chunks to holders' requests) → FETCH (a consumer
// pulls by content hash from any online holder, verified chunk-by-chunk).
// Also here: the sender-side "who is downloading" serve ledger, the owner-side
// scan/presence-sweep reconcile, index compaction, and boot rehydrate of the
// in-memory serve maps.
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
  listPeerShare,
  collectPeerShare,
  getPeerEntry,
  getPeerEntryState,
  watchPeerCatalog,
  resolvePeerCatalog,
  catalogKeyField,
} from '../../../shares/share-catalog.js'
import { createCatalogBatch } from '../../../shares/catalog-writer.js'
import { getOwnedMount } from '../../../folders/mount-store.js'
import { readOwnShares, readPeerShareEntry } from '../../../shares/shares.js'
import { listSpaces, clearAndPurgeCore } from '../../../spaces/space.js'
import { getStore } from '../../../core/store.js'
import { compactStore } from '../../swarm.js'
import { walkDisk } from '../../../folders/walk-disk.js'
import { pathFromMount } from '../../path-guard.js'
import { shareDecoKey } from '../../decoration-key.js'
import { makeProgressTicker } from '../../progress-ticker.js'
import { resolveDest } from '../../download-dest.js'
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
export function _resetContentBackendOverlay() { ipcRef = null; sharesRefresh.reset(); peerPrepareBroadcast = null; resetServeLedger(); presenceGone.clear(); publishesAborting = false }
export function abortInFlightPublishes() { publishesAborting = true }
export function setSharePrepareBroadcast(fn) { peerPrepareBroadcast = fn }

// Notified with (spaceId) whenever an owner's catalog appends, so a foreign mirror can
// materialize the change promptly instead of waiting for its poll. (The catalog is the
// only replicated signal of overlay content changes — no drive carries the file bytes.)
let catalogChangeHook = null
export function setOverlayCatalogChangeHook(fn) { catalogChangeHook = fn }
export function broadcastSharePrepare(spaceId, payload) { peerPrepareBroadcast?.(spaceId, payload) }

// === sender-side download indicator (serve ledger) ===

// Who is currently pulling a file WE own, and how far they've got. The overlay
// serve path (protocol-v2 _onContentRequest/_onChunkNeed) feeds three signals —
// start, per-chunk bytes, end — which we aggregate per file. Two emission tiers:
// a cheap always-on summary (peer set + aggregate bytes, drives the collapsed
// avatar stack), and a per-peer detail stream emitted ONLY for files whose row
// is expanded (detailSubs), so we never push per-peer progress nobody is looking at.
const LEDGER_SEP = String.fromCharCode(0)
const SUMMARY_THROTTLE_MS = 750
const DETAIL_THROTTLE_MS = 250
const IDLE_SWEEP_MS = 10000
const IDLE_DROP_MS = 30000
// Backstop for a paused row whose peer vanished without a clean onclose. Far longer
// than IDLE_DROP_MS (a deliberate pause should stay visible) but bounded, so a dead
// connection that never fired onclose can't leak the avatar forever.
const PAUSED_DROP_MS = 300000
// Backstop for a leaked detail subscription (a renderer reload never sends the
// unsubscribe): a sub with no download entry for this long is evicted so the sweep
// timer can't re-arm forever. A dropdown legitimately open on a file that quiet is
// already showing the empty set; reopening it re-subscribes.
const DETAIL_SUB_QUIET_MS = 300000

// `bytes` is DISPLAY-progress = max(bytes we served, the downloader's reported have) — a
// hybrid of observed serves and a downloader-asserted floor, NOT pure upload accounting.
const downloads = new Map()     // fileKey → { spaceId, path, peers: Map<profileKey, { bytes, total, lastTs, paused }> }
const detailSubs = new Map()    // fileKey → { n, spaceId, path } (a row is subscribed while n > 0; identity kept so the sweep can push an authoritative — possibly empty — snapshot)
const lastSummaryAt = new Map() // fileKey → ts (throttle)
const lastDetailAt = new Map()  // fileKey → ts (throttle)
const hashKeys = new Map()      // contentHash → fileKey[] (resolved once at serve start; the per-chunk path reads this, not the serve index)
const pendingControls = new Map() // contentHash\0from → 'paused'|'stopped' (control that arrived before the serve started; drained by onServeStart)
const pendingBaselines = new Map() // contentHash\0from → have (resume baseline that arrived before the serve started; drained by onServeStart)
let idleTimer = null

function fileKey(spaceId, path) { return spaceId + LEDGER_SEP + path }
function pcKey(contentHash, from) { return contentHash + LEDGER_SEP + from }
function rendererPath(shareId, relPath) { return shareId === LOOSE_SHARE_ID ? '/' + relPath : relPath }

function emitBoth(key, force, now = Date.now()) {
  emitSummary(key, force, now)
  if (detailSubs.has(key)) emitDetail(key, force, now)
}

// Iterate the live serve entries for (contentHash, from) — the per-row scaffold shared by
// the chunk-served, paused, and baseline updates. fn(entry, key, now); a plain return skips
// the row (the loop continues).
function forEachServeEntry(contentHash, from, fn) {
  const keys = hashKeys.get(contentHash)
  if (!keys) return
  const now = Date.now()
  for (const key of keys) {
    const d = downloads.get(key)
    const entry = d?.peers.get(from)
    if (!entry) continue
    fn(entry, key, now)
  }
}

export function onServeStart({ from, contentHash, total }) {
  if (!from) return
  // Content-addressed: one hash can back several (space, share, path) rows when
  // identical bytes are advertised under more than one name. The sender only has
  // the hash — not the requester's intended path — so the indicator legitimately
  // appears on every row advertising the served hash.
  const refs = serveIndex.refsFor(contentHash)
  if (refs.length === 0) {
    // No row advertises this hash yet — discard any stash so it can't leak onto a future
    // unrelated serve of the same hash+peer.
    const pk = pcKey(contentHash, from)
    pendingControls.delete(pk)
    pendingBaselines.delete(pk)
    return
  }
  const keys = []
  for (const { spaceId, shareId, relPath } of refs) {
    const path = rendererPath(shareId, relPath)
    const key = fileKey(spaceId, path)
    keys.push(key)
    let d = downloads.get(key)
    if (!d) downloads.set(key, (d = { spaceId, path, peers: new Map() }))
    // Preserve an already-tracked peer's accumulated bytes: a pause→resume re-issues
    // the content-request, and resetting to 0 would both rewind the bar and — since
    // resume re-fetches only the missing chunks — keep bytes below total forever.
    const prev = d.peers.get(from)
    // paused:false — resume re-issues the content-request and lands here, clearing the flag.
    d.peers.set(from, { bytes: prev?.bytes ?? 0, total: total || prev?.total || 0, lastTs: Date.now(), paused: false })
    // A fresh serve wakes a dormant detail subscription (see runIdleSweep) so an open
    // dropdown that sat quiet past the window starts streaming again without a reopen.
    const sub = detailSubs.get(key)
    if (sub) sub.quietSince = 0
    emitBoth(key, true)
  }
  // Resolve hash→keys once so the per-chunk path below never re-parses the serve index.
  hashKeys.set(contentHash, keys)
  // Apply a pause/stop that raced ahead of the serve-prep (it was stashed because
  // hashKeys wasn't populated yet).
  const pk = pcKey(contentHash, from)
  const pending = pendingControls.get(pk)
  if (pending) {
    pendingControls.delete(pk)
    if (pending === 'stopped') onServeEnd({ from, contentHash })
    else onServePaused({ from, contentHash })
  }
  const baseline = pendingBaselines.get(pk)
  if (baseline != null) {
    pendingBaselines.delete(pk)
    applyBaseline(from, contentHash, baseline)
  }
  scheduleIdleSweep()
}

// Route a downloader pause/stop control. If the serve hasn't started yet (hashKeys
// not populated), stash it so onServeStart applies it — otherwise the control races
// ahead of the async serve-prep and is lost.
export function onServeControl({ from, contentHash, state }) {
  if (!from) return
  if (!hashKeys.has(contentHash)) {
    pendingControls.set(pcKey(contentHash, from), state === 'stopped' ? 'stopped' : 'paused')
    return
  }
  if (state === 'stopped') onServeEnd({ from, contentHash })
  else onServePaused({ from, contentHash })
}

// A downloader reported its on-disk have-bytes for a hash we serve. Raise the entry's
// bytes to the reported have — never lower it (we may already have served more) — so the
// bar mirrors the downloader's true progress, not only the bytes we re-serve. The value is
// downloader-asserted, so it is DISPLAY-progress only: it caps at total and NEVER
// completes/drops the row (a peer can't self-hide by claiming have>=total) — only real
// served bytes, serve-end, or the idle sweep drop a row. Throttled like onChunkServed so a
// peer spamming frames can't flood the renderer. Stashed if the serve hasn't started yet.
export function onServeBaseline({ from, contentHash, have }) {
  if (!from || !have) return
  if (!hashKeys.has(contentHash)) {
    const pk = pcKey(contentHash, from)
    pendingBaselines.set(pk, Math.max(have, pendingBaselines.get(pk) || 0))
    return
  }
  applyBaseline(from, contentHash, have)
}

function applyBaseline(from, contentHash, have) {
  forEachServeEntry(contentHash, from, (entry, key, now) => {
    const capped = entry.total > 0 ? Math.min(have, entry.total) : have
    if (capped <= entry.bytes) return
    entry.bytes = capped
    entry.lastTs = now
    emitBoth(key, false, now)
  })
}

// A downloader paused (kept its partial). Mark the entry so the indicator shows a
// paused state; the idle sweep then keeps it for PAUSED_DROP_MS (vs IDLE_DROP_MS for
// active rows) so a deliberate pause stays visible but a vanished peer still gets reaped.
export function onServePaused({ from, contentHash }) {
  if (!from) return
  forEachServeEntry(contentHash, from, (entry, key, now) => {
    entry.paused = true
    entry.lastTs = now
    emitBoth(key, true, now)
  })
}

export function onChunkServed({ from, contentHash, bytes }) {
  if (!from) return
  forEachServeEntry(contentHash, from, (entry, key, now) => {
    // Don't clear `paused` here: trailing in-flight chunks served after a pause are
    // drain, not a resume. Resume goes through onServeStart, which clears the flag.
    entry.bytes += bytes
    entry.lastTs = now
    if (entry.total > 0 && entry.bytes >= entry.total) { dropPeer(key, from); return }
    emitBoth(key, false, now)
  })
}

export function onServeEnd({ from, contentHash }) {
  if (!from) return
  pendingControls.delete(pcKey(contentHash, from))
  pendingBaselines.delete(pcKey(contentHash, from))
  const keys = hashKeys.get(contentHash)
  if (!keys) return
  for (const key of keys) dropPeer(key, from)
  // Forget the cache once no row for this hash has a downloader left (the
  // completion path leaves a benign stale entry that the next serve overwrites).
  if (keys.every((key) => !downloads.has(key))) hashKeys.delete(contentHash)
}

function dropPeer(key, from) {
  const d = downloads.get(key)
  if (!d || !d.peers.delete(from)) return
  if (d.peers.size === 0) {
    ipcRef?.emit('event:awareness', { channel: 'serving', spaceId: d.spaceId, path: d.path, peers: [], bytes: 0, total: 0, pausedKeys: [] })
    if (detailSubs.has(key)) ipcRef?.emit('event:awareness', { channel: 'serving-detail', spaceId: d.spaceId, path: d.path, peers: [] })
    downloads.delete(key)
    lastSummaryAt.delete(key)
    lastDetailAt.delete(key)
    return
  }
  emitBoth(key, true)
}

function emitSummary(key, force, now = Date.now()) {
  const d = downloads.get(key)
  if (!d) return
  if (!force && now - (lastSummaryAt.get(key) || 0) < SUMMARY_THROTTLE_MS) return
  lastSummaryAt.set(key, now)
  ipcRef?.emit('event:awareness', { channel: 'serving', ...summaryPayload(d) })
}

// bytes/total are aggregate SUMS across the downloaders (so bytes/total is the
// average progress for the collapsed bar) — NOT a single file's size. With N
// downloaders of an F-byte file, total ≈ N·F; never read it as the file size.
function summaryPayload(d) {
  let bytes = 0
  let total = 0
  const peers = []
  const pausedKeys = []
  for (const [profileKey, e] of d.peers) { peers.push(profileKey); bytes += e.bytes; total += e.total; if (e.paused) pausedKeys.push(profileKey) }
  return { spaceId: d.spaceId, path: d.path, peers, bytes, total, pausedKeys }
}

// Snapshot of every live serve row for a space (the same payload the summary events
// carry) — requested by the renderer on mount so a view opened mid-download shows the
// indicator immediately instead of waiting for the next sweep re-announce.
export function listServeSummaries(spaceId) {
  const out = []
  for (const d of downloads.values()) {
    if (d.spaceId === spaceId) out.push(summaryPayload(d))
  }
  return out
}

function emitDetail(key, force, now = Date.now()) {
  const d = downloads.get(key)
  if (!d) return
  if (!force && now - (lastDetailAt.get(key) || 0) < DETAIL_THROTTLE_MS) return
  lastDetailAt.set(key, now)
  ipcRef?.emit('event:awareness', { channel: 'serving-detail', spaceId: d.spaceId, path: d.path, peers: serveSnapshot(key).peers })
}

function serveSnapshot(key) {
  const d = downloads.get(key)
  if (!d) return { peers: [] }
  const peers = []
  for (const [profileKey, e] of d.peers) peers.push({ peerKey: profileKey, bytes: e.bytes, total: e.total, paused: !!e.paused })
  return { peers }
}

export function subscribeServeDetail(spaceId, path) {
  const key = fileKey(spaceId, path)
  // Refcount so two open surfaces on the same row don't kill each other's stream:
  // detail flows while the count is > 0; one consumer closing only decrements.
  const cur = detailSubs.get(key)
  detailSubs.set(key, { n: (cur?.n || 0) + 1, spaceId, path })
  // A subscription on a quiet file must still get sweep-driven authoritative frames.
  scheduleIdleSweep()
  return serveSnapshot(key)
}

// Read the current serve detail without touching the subscription refcount — used by the
// integration suite to assert snapshots without arming a stream.
export function getServeDetail(spaceId, path) {
  return serveSnapshot(fileKey(spaceId, path))
}

export function unsubscribeServeDetail(spaceId, path) {
  const key = fileKey(spaceId, path)
  const cur = detailSubs.get(key)
  const n = (cur?.n || 0) - 1
  if (n > 0) detailSubs.set(key, { ...cur, n })
  else { detailSubs.delete(key); lastDetailAt.delete(key) }
  return { ok: true }
}

// Push the authoritative snapshot for a subscribed file — including the empty set, so a missed
// "peer gone" frame self-corrects on the next sweep instead of leaving a ghost row in the
// expanded dropdown. This replaces the renderer's serving:detail-get poll.
function emitDetailAuthoritative(key, now = Date.now()) {
  const sub = detailSubs.get(key)
  if (!sub) return
  lastDetailAt.set(key, now)
  ipcRef?.emit('event:awareness', { channel: 'serving-detail', spaceId: sub.spaceId, path: sub.path, peers: serveSnapshot(key).peers })
}

function scheduleIdleSweep() {
  if (idleTimer) return
  idleTimer = setTimeout(runIdleSweep, IDLE_SWEEP_MS)
  if (idleTimer && typeof idleTimer.unref === 'function') idleTimer.unref()
}

// A peer that stops requesting bytes without completing (e.g. it found the rest
// from another holder, or dropped) is evicted after IDLE_DROP_MS so its avatar
// doesn't linger; a paused peer gets the longer PAUSED_DROP_MS so a deliberate pause
// stays visible. Disconnect (onServeEnd) and completion handle the common cases; this
// is the backstop. Re-arms itself while any download is live.
function runIdleSweep(now = Date.now()) {
  idleTimer = null
  const stale = []
  for (const [key, d] of downloads) {
    for (const [from, e] of d.peers) {
      const ttl = e.paused ? PAUSED_DROP_MS : IDLE_DROP_MS
      if (now - e.lastTs > ttl) stale.push([key, from])
    }
  }
  for (const [key, from] of stale) dropPeer(key, from)
  // Re-announce every still-live row (active AND paused): the renderer's soft-state TTL only
  // survives if summaries re-arrive without chunk traffic — a paused downloader otherwise
  // emits exactly one frame and is erased at the renderer TTL while this ledger keeps it for
  // PAUSED_DROP_MS. The sweep cadence IS the re-announce throttle — for detail too: every
  // subscribed file gets its authoritative (possibly empty) snapshot pushed each tick.
  for (const key of downloads.keys()) emitSummary(key, true, now)
  // A sub quiet past the window goes DORMANT, not evicted: it stops receiving sweep
  // frames and stops holding the timer (a leaked subscription costs one map entry, not a
  // forever-armed sweep), but stays registered so a new serve for its key (onServeStart)
  // wakes it — an open dropdown is never starved after a quiet spell.
  let wakefulSubs = 0
  for (const [key, sub] of detailSubs) {
    if (downloads.has(key)) sub.quietSince = 0
    else if (!sub.quietSince) sub.quietSince = now
    if (sub.quietSince && now - sub.quietSince > DETAIL_SUB_QUIET_MS) continue
    wakefulSubs++
    emitDetailAuthoritative(key, now)
  }
  if (downloads.size > 0 || wakefulSubs > 0) scheduleIdleSweep()
}

export function _sweepServeLedgerNow(now) { runIdleSweep(now) }

function resetServeLedger() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  downloads.clear()
  detailSubs.clear()
  lastSummaryAt.clear()
  lastDetailAt.clear()
  hashKeys.clear()
  pendingControls.clear()
  pendingBaselines.clear()
}

// === publish/fetch core: hash + advertise + register servable ===

// Hashing: stream the file through the wire-compatible blake2b (size REQUIRED,
// or the digest is a plain blake2b that won't match registerFile / the consumer
// verify). No bytes enter any core — this is overlay's only sender-side cost.
// onProgress(len) receives the incremental byte count of each read chunk.
async function hashOnDisk(absPath, size, onProgress) {
  const h = createStreamingHasher({ size })
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(absPath)
    rs.on('data', (c) => { h.update(c); onProgress?.(c.length) })
    rs.on('end', resolve)
    rs.on('error', reject)
  })
  return h.digest()
}

// The overlay content hash of an on-disk file (size-bound, wire-compatible). The
// mirror MUST use this — NOT a plain blake2b — to compare an on-disk copy against
// a catalog `contentHash`, or the comparison never matches (overlay hashes are
// leaf/size-prefixed). statSync for the size.
export async function overlayHashFile(absPath, onProgress) {
  return hashOnDisk(absPath, fs.statSync(absPath).size, onProgress)
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

// Shared publish core (folder + loose), no IPC emit. Advertise FIRST with
// contentHash:null so the entry is visible to members the instant it is added
// (consumer status `preparing`), then hash and backfill (catalog update
// replicates → consumer flips preparing→remote). onAdvertised(size) fires right
// after the advertise, before the slow hash, so a caller can refresh its UI at
// advertise-time; onProgress(len) gets the incremental hashed-byte count. Returns
// { changed, contentHash } — contentHash null only when the source is gone / not a file.
const directCatalog = { advertise: catalogAdvertise, setMaterializedHash, tombstone: catalogTombstone }

export async function publishContent(spaceId, shareId, relPath, absPath, { onAdvertised, onProgress, signal, catalog = directCatalog } = {}) {
  let st
  try { st = fs.statSync(absPath) } catch { return { changed: false, contentHash: null } }
  if (!st.isFile()) return { changed: false, contentHash: null }

  const prev = await getOwnEntry(spaceId, shareId, relPath)
  if (prev && prev.size === st.size && prev.mtime === st.mtimeMs && prev.contentHash) {
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
  // both the loose (runLoosePublish) and folder (publishOne/overlayScan) callers, which
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
async function revertHalfAdvertised(spaceId, shareId, relPath, prev, catalog = directCatalog) {
  if (prev?.contentHash) {
    await catalog.advertise(spaceId, shareId, relPath, { size: prev.size, mtime: prev.mtime, contentHash: prev.contentHash }).catch(() => {})
  } else {
    await catalog.tombstone(spaceId, shareId, relPath).catch(() => {})
  }
}

// Folder publish for one file (no view-refresh emit — callers batch that; the terminal decoration
// `done` fires here in a finally, on success AND throw, so a failed hash can't strand a preparing bar).
async function publishOne(spaceId, share, relPath, absPath, catalog = directCatalog) {
  let ticker = null
  try {
    const { changed } = await publishContent(spaceId, share.id, relPath, absPath, {
      catalog,
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

export async function overlayPublishAdd(spaceId, share, relPath, absPath) {
  try {
    return await publishOne(spaceId, share, relPath, absPath)
  } finally {
    // Flush on success AND on a reverted failure (publishContent undoes the
    // half-advertised entry on throw) so the owner's view updates either way.
    sharesRefresh.flush(spaceId, share.id)
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

export async function overlayPublishDelete(spaceId, share, relPath) {
  const prev = await getOwnEntry(spaceId, share.id, relPath)
  await catalogTombstone(spaceId, share.id, relPath)
  await evictIfUnreferenced(prev?.contentHash, spaceId, share.id, relPath)
  ipcRef?.emit('event:share-files-updated', { spaceId, shareId: share.id })
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

// Full reconcile: advertise+hash current files, tombstone catalog entries whose
// source is gone. Hashes each file up front (overlay's prep) rather than leaving
// the hash for a later read.
export async function overlayScan(spaceId, share, mountPath, ignore, { deep = false } = {}) {
  const { onDisk, unreadable } = await walkDisk(mountPath, ignore)
  // A deep scan (relocate) can't trust mtimes — the tree was moved/copied so every mtime
  // differs. Hash a size-matching file and, if its content is identical, re-point serving
  // at the new path + refresh the mtime without re-advertising (no mirror churn).
  const known = new Map()
  if (deep) for await (const entry of listOwnShare(spaceId, share.id)) known.set(entry.relPath, entry)
  const catalog = createCatalogBatch(spaceId)
  let uploaded = 0
  let deleted = 0
  const unserve = []
  try {
    for (const [relPath, info] of onDisk) {
      const abs = pathFromMount(mountPath, relPath)
      if (deep && await skipIfUnchanged(spaceId, share, relPath, abs, info, known.get(relPath), catalog)) continue
      // Per-file isolation: one unreadable/vanished/erroring file must not abort the scan
      // (it would skip every later file and the tombstone pass). publishContent reverts its
      // own half-advertised entry on throw, and the file stays in onDisk so it is not
      // tombstoned this pass.
      try {
        if (await publishOne(spaceId, share, relPath, abs, catalog)) uploaded += 1
      } catch (err) {
        log.warn('skip file during overlay scan:', relPath, '-', err.message)
      }
    }
    // Commit the advertise/hash writes before reading the catalog back to decide
    // which entries to tombstone.
    await catalog.flush()
    for await (const entry of listOwnShare(spaceId, share.id)) {
      if (!onDisk.has(entry.relPath) && !unreadable.has(entry.relPath)) {
        await catalog.tombstone(spaceId, share.id, entry.relPath)
        if (entry.contentHash) unserve.push([entry.contentHash, entry.relPath])
        deleted += 1
      }
    }
    // Commit the tombstones BEFORE dropping serve-index entries, so a peer never observes a
    // file still advertised in the catalog but no longer servable.
    await catalog.flush()
    for (const [contentHash, relPath] of unserve) await evictIfUnreferenced(contentHash, spaceId, share.id, relPath)
  } finally {
    await catalog.close()
    // A mid-scan publish failure (now reverted inside publishContent) still refreshes.
    sharesRefresh.flush(spaceId, share.id)
  }
  return { uploaded, deleted, totalOnDisk: onDisk.size }
}

// Deep-scan (relocate) helper: identical content at a new path must not churn. Same size +
// same content hash → re-point serving at the new path, refresh a drifted mtime, and return
// true to skip the re-publish; otherwise false.
async function skipIfUnchanged(spaceId, share, relPath, abs, info, prev, catalog) {
  if (!prev?.contentHash || prev.size !== info.size) return false
  let diskHash
  try { diskHash = await overlayHashFile(abs) } catch { return false }
  if (diskHash !== prev.contentHash) return false
  await makeServable(spaceId, share.id, relPath, abs, prev.contentHash, info.size)
  if (prev.mtime !== info.mtime) await catalog.advertise(spaceId, share.id, relPath, { size: info.size, mtime: info.mtime, contentHash: prev.contentHash })
  return true
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

export async function overlayListPeer(spaceId, share) {
  const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, share)
  if (!readable) return []
  ensurePeerCatalogWatch(spaceId, share, keyHex, sck)
  return await listPeerShare(keyHex, share.id, { sck })
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
  // failures cross the wire — disk-full and an integrity mismatch need the user's attention
  // (toast + notification) and no automatic retry can fix either.
  emitError: (job, errorCode) => {
    if (errorCode === ErrorCodes.TRANSFER_DISK_FULL || errorCode === ErrorCodes.TRANSFER_CHECKSUM) {
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
    return {
      removed: false, seq: state.seq,
      job: {
        spaceId, pendingKey: row.filePath, path: row.filePath, relPath: row.relPath, shareId: row.shareId, ...catalogKeyField(keyHex, encrypted),
        transferId: transferIdFor(spaceId, row.shareId, row.relPath),
        contentHash: state.contentHash, size: state.size || 0, sourceSeq: state.seq,
        ownerPublicKey: row.ownerKey, verifyKey: row.shareId + '|' + row.relPath,
        finalPath: row.finalPath, prevBytes: row.bytesTransferred,
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
  const finalPath = prev?.finalPath || resolveDest(getDownloadDir(), path.basename(relPath))
  return folderEngine.start({
    spaceId, pendingKey: drivePath, path: drivePath, relPath, shareId: share.id, ...catalogKeyField(keyHex, encrypted),
    transferId: transferIdFor(spaceId, share.id, relPath),
    contentHash: entry.contentHash, size: entry.size || 0, sourceSeq: entry.seq,
    ownerPublicKey: share.owner, verifyKey: share.id + '|' + relPath,
    finalPath, prevBytes: prev?.bytesTransferred,
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
  await Promise.all(ids.map((id) => folderEngine.cancel(id)))
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
      let exists = false
      try { exists = fs.statSync(pathFromMount(mountPath, entry.relPath)).isFile() } catch {}
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
