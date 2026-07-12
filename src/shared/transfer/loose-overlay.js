// In-place loose files: the loose-file primitive served through the overlay
// instance instead of copied into the per-space drive. A reserved share id groups
// loose entries in the per-(owner,space) catalog; the bytes stay at the user's
// original file on disk, resolved per file via the source map (not a mount root).
// The publish/fetch cores live in overlay-backend.js and are shared with folder
// shares — this module is the loose-specific glue (source map, watch, cap, naming).
import fs from 'bare-fs'
import path from 'bare-path'
import { getOverlay } from './backends/overlay/overlay-instance.js'
import { publishContent, broadcastSharePrepare, evictIfUnreferenced } from './backends/overlay/overlay-backend.js'
import { createOverlayDownloadEngine } from './backends/overlay/overlay-download.js'
import {
  tombstone as catalogTombstone, getOwnEntry, listOwnShare, listOwnShareForDisplay, collectPeerShare, getPeerEntry, getPeerEntryState, watchPeerCatalog, resolvePeerCatalog,
} from '../shares/share-catalog.js'
import { markListIncomplete } from './list-deficits.js'
import { markOwnedSource, getOwnedSourcePath, clearOwnedSource } from './files.js'
import { getPendingFor, recordPending } from './pending-transfers.js'
import { resolveDest } from './download-dest.js'
import { getDownloadDir } from '../core/paths.js'
import { listSpaces, getSpace } from '../spaces/space.js'
import { makeProgressTicker } from './progress-ticker.js'
import { nextFreeName } from '../folders/path-keys.js'
import { AppError, ErrorCodes } from '../core/errors.js'
import { createKeyedLock } from '../core/keyed-lock.js'
import { createLogger } from '../core/logger.js'
import { supersedeDecision, republishDecision } from './supersede-decision.js'
import { LOOSE_SHARE_ID, looseTransferIdFor } from './transfer-id.js'

const log = createLogger('loose-overlay')

export { LOOSE_SHARE_ID }
export const MAX_LOOSE_FILES_PER_SPACE = 100

// abs source path -> (spaceId -> relPath). The same file can be shared in several
// spaces, so a watcher event must fan out to every space that holds it.
export const looseSources = new Map()

function trackSource (abs, spaceId, relPath) {
  let m = looseSources.get(abs)
  if (!m) looseSources.set(abs, (m = new Map()))
  m.set(spaceId, relPath)
}
function untrackSource (abs, spaceId) {
  const m = looseSources.get(abs)
  if (!m) return
  m.delete(spaceId)
  if (m.size === 0) looseSources.delete(abs)
}
export function looseSourceFor (abs, spaceId) {
  return looseSources.get(abs)?.get(spaceId) || null
}

let ipcRef = null
export function initLooseOverlay (ipc) { ipcRef = ipc }

const rel = (drivePath) => drivePath.replace(/^\//, '')
const drivePathOf = (relPath) => '/' + relPath

function armWatch (spaceId, absPath) {
  ipcRef?.emit('main-request', { command: 'loose-file:watch', args: { spaceId, absPath } })
}
function disarmWatch (spaceId, absPath) {
  ipcRef?.emit('main-request', { command: 'loose-file:unwatch', args: { spaceId, absPath } })
}

// Serialize every per-space mutation (publish, unshare, sweep) so a share and a
// concurrent unshare can't interleave and the cap + name checks stay atomic.
const withSpaceLock = createKeyedLock()

// Pick the relPath for a new/changed share under the lock: an already-tracked
// source keeps its name with NO catalog scan (the hot change-event path); a new
// source does ONE catalog pass yielding both the count (cap) and the taken names
// (suffix-on-collision). Returns { relPath, isNew }.
async function resolveLooseName (spaceId, absPath, fileName) {
  const tracked = looseSourceFor(absPath, spaceId)
  if (tracked) return tracked

  const base = fileName || path.basename(absPath)
  const takenNames = new Set()
  let count = 0
  for await (const e of listOwnShare(spaceId, LOOSE_SHARE_ID)) { takenNames.add(e.relPath); count++ }

  let relPath = base
  let isNew = true
  if (takenNames.has(base)) {
    const existingSrc = await getOwnedSourcePath(spaceId, drivePathOf(base))
    if (existingSrc === absPath) isNew = false // same source, untracked (e.g. pre-rehydrate) → reuse name
    else relPath = nextFreeName(base, (c) => takenNames.has(c))
  }
  // Cap applies only to genuinely new entries; an update at the cap is allowed.
  if (isNew && count >= MAX_LOOSE_FILES_PER_SPACE) {
    throw new AppError(ErrorCodes.LOOSE_FILE_LIMIT, `Limit of ${MAX_LOOSE_FILES_PER_SPACE} shared files per space reached`)
  }
  return relPath
}

export function looseShareFile (spaceId, absPath, fileName) {
  return withSpaceLock(spaceId, () => doLooseShareFile(spaceId, absPath, fileName))
}

// (spaceId|relPath) -> { aborted } signal for an in-flight publish (the long hash).
const activePublishes = new Map()
const publishKey = (spaceId, relPath) => spaceId + '|' + relPath

export async function looseCancelPublish (spaceId, drivePath) {
  const relPath = rel(drivePath)
  const sig = activePublishes.get(publishKey(spaceId, relPath))
  if (sig) { sig.aborted = true; return }
  // No live task — the publish was orphaned by a restart before any boot resume re-registered it.
  // Removing the half-advertised entry makes the cancel control mean something instead of no-opping.
  // Re-read the entry UNDER the lock and bail if it is no longer a null-hash placeholder: a boot
  // resume that completed while this cancel waited for the lock must not have its finished, already
  // replicated share torn down by a stale click.
  await withSpaceLock(spaceId, async () => {
    const entry = await getOwnEntry(spaceId, LOOSE_SHARE_ID, relPath)
    if (!entry || entry.contentHash) return
    const src = await getOwnedSourcePath(spaceId, drivePath)
    await unshareEntry(spaceId, relPath, null, src)
  })
  ipcRef?.emit('event:files-updated', { spaceId })
}

function isPublishActive (spaceId, relPath) {
  return activePublishes.has(publishKey(spaceId, relPath))
}

async function doLooseShareFile (spaceId, absPath, fileName) {
  const relPath = await resolveLooseName(spaceId, absPath, fileName)
  await runLoosePublish(spaceId, relPath, absPath)
}

// The publish body shared by a fresh share, a change re-publish and a boot resume: register a
// cancellable signal, advertise + drive a live progress ticker, record the advertise-time source,
// and clean up a reverted/aborted publish. Lock-free — the caller holds the space lock.
async function runLoosePublish (spaceId, relPath, absPath) {
  const key = publishKey(spaceId, relPath)
  const signal = { aborted: false }
  activePublishes.set(key, signal)
  let ticker = null
  try {
    const { changed, contentHash } = await publishContent(spaceId, LOOSE_SHARE_ID, relPath, absPath, {
      signal,
      onAdvertised: async (size) => {
        ticker = makeProgressTicker(size, ({ bytes, total, speed, eta }) => {
          deco(spaceId, drivePathOf(relPath), { phase: 'publishing', bytes, total, speed, eta })
          broadcastSharePrepare(spaceId, { shareId: LOOSE_SHARE_ID, relPath, bytes, total, eta })
        })
        // Persist the source link BEFORE the (minutes-long) hash, so a quit mid-hash is
        // recoverable: boot rehydration finds the source and re-hashes the null-hash entry
        // instead of stranding it as a permanent "Adding". Persist before the emit so a
        // consumer refreshing on it already sees the link.
        try { await markOwnedSource(spaceId, drivePathOf(relPath), absPath) } catch (err) {
          log.debug('advertise-time source record failed:', err.message)
        }
        ipcRef?.emit('event:files-updated', { spaceId })
      },
      onProgress: (len) => ticker?.push(len),
    })
    if (!contentHash) {
      // The source vanished mid-publish (deleted/moved during the hash). publishContent
      // already reverted its half-advertised entry, so treat it as a benign abort —
      // the file is simply not shared — rather than a worker-crashing throw.
      await clearOwnedSourceIfUnshared(spaceId, relPath)
      log.debug('loose publish aborted — source vanished mid-hash:', absPath)
      ipcRef?.emit('event:files-updated', { spaceId })
      return
    }

    trackSource(absPath, spaceId, relPath)
    armWatch(spaceId, absPath)
    // Only refresh when the catalog actually changed (a fresh/changed publish). An unchanged
    // healthy entry re-registered at boot advertised nothing new, so emitting would be one
    // needless refresh per loose file across the whole store.
    if (changed) ipcRef?.emit('event:files-updated', { spaceId })
  } catch (err) {
    // publishContent undoes its own half-advertised contentHash:null placeholder on any
    // failure (shared with the folder path) — and leaves a successfully-published entry
    // alone — so here we only drop a now-dangling source link and refresh the view. A
    // cancel is not a failure (the user stopped it) — swallow it; any real error propagates.
    await clearOwnedSourceIfUnshared(spaceId, relPath)
    ipcRef?.emit('event:files-updated', { spaceId })
    if (signal.aborted || err?.code === 'ECANCELLED') return
    throw err
  } finally {
    activePublishes.delete(key)
    // Only clear a bar we actually raised: a fast-pathed healthy entry never created a ticker,
    // so a terminal 'done' would be a spurious decoration for a key that showed nothing.
    if (ticker) deco(spaceId, drivePathOf(relPath), { done: true })
  }
}

// After a failed/aborted publish the catalog entry either reverted to its prior version
// (the advertise-time source link still backs it — keep it) or was tombstoned (a first
// publish — drop the link so no source dangles for an unshared file).
async function clearOwnedSourceIfUnshared (spaceId, relPath) {
  try {
    if (!(await getOwnEntry(spaceId, LOOSE_SHARE_ID, relPath))) {
      await clearOwnedSource(spaceId, drivePathOf(relPath))
    }
  } catch (err) {
    log.debug('post-failure source cleanup skipped:', err.message)
  }
}

async function unshareEntry (spaceId, relPath, contentHash, src) {
  await catalogTombstone(spaceId, LOOSE_SHARE_ID, relPath)
  await evictIfUnreferenced(contentHash, spaceId, LOOSE_SHARE_ID, relPath)
  await clearOwnedSource(spaceId, drivePathOf(relPath))
  if (src) { untrackSource(src, spaceId); disarmWatch(spaceId, src) }
}

export async function looseUnshareFile (spaceId, drivePath) {
  await withSpaceLock(spaceId, async () => {
    const relPath = rel(drivePath)
    const prev = await getOwnEntry(spaceId, LOOSE_SHARE_ID, relPath)
    const src = await getOwnedSourcePath(spaceId, drivePath)
    await unshareEntry(spaceId, relPath, prev?.contentHash || null, src)
  })
  ipcRef?.emit('event:files-updated', { spaceId })
}

export async function looseListOwn (spaceId) {
  // Display path: tolerate a corrupt catalog core as a partial listing (resolveLooseName
  // / sweeps keep listOwnShare and fail loud — they must not act on partial data).
  return await listOwnShareForDisplay(spaceId, LOOSE_SHARE_ID)
}

export async function looseHasOwn (spaceId, drivePath) {
  return !!(await getOwnEntry(spaceId, LOOSE_SHARE_ID, rel(drivePath)))
}

// Watcher dispatch (one event per (space, path) the file is shared in). Resolves
// the file's assigned name from the reverse map so a change re-publishes under the
// same name and an unlink tombstones the right entry; an untracked path is ignored.
export async function handleLooseFsEvent ({ spaceId, absPath, action }) {
  const relPath = looseSourceFor(absPath, spaceId)
  if (!relPath) return
  if (action === 'unlink') {
    if (fs.existsSync(absPath)) return // atomic-save: path reappeared before we acted
    await looseUnshareFile(spaceId, drivePathOf(relPath))
    return
  }
  await looseShareFile(spaceId, absPath, relPath)
}

export async function looseListPeer (spaceId, member, timeoutMs, space) {
  const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, member, { space })
  if (!readable) return []
  ensureLooseCatalogWatch(spaceId, member, keyHex, sck)
  const { entries, stalled } = await collectPeerShare(keyHex, LOOSE_SHARE_ID, { sck, timeoutMs })
  // A stalled read (head-sync failed or the traversal timed out) self-heals on the peer's
  // next append — unless the stream stays stalled; flag it so the convergence tick re-pokes
  // the listing as the level-triggered backstop. A legitimately-empty catalog is NOT stalled,
  // so a zero-share peer doesn't trigger a perpetual re-poke.
  if (stalled) markListIncomplete(spaceId)
  return entries
}

// Register the peer-catalog append watch once per catalog key. The append fires when
// the owner advertises/changes a file: refresh the list AND reconcile any in-flight
// transfer whose content the owner just replaced.
function ensureLooseCatalogWatch (spaceId, member, keyHex, sck) {
  if (!keyHex) return
  watchPeerCatalog(keyHex, 'loose', () => {
    ipcRef?.emit('event:files-updated', { spaceId })
    reconcileActiveLooseTransfers(spaceId, member).catch((err) => log.debug('loose source-change reconcile failed:', err.message))
    // One reconcile pass over our inactive pending rows: tear down downloads for a source the
    // owner tombstoned OR re-published (so a re-add does NOT auto-resume), and re-drive genuinely
    // interrupted ones — the owner may never have disconnected.
    looseEngine.reconcileOnAppend(member.publicKey, spaceId).catch((err) => log.debug('loose catalog-append reconcile failed:', err.message))
  }, sck)
}

// On an owner-catalog append, re-resolve every active loose transfer from THIS owner.
// If the owner re-published a file under a new contentHash, supersede the stale fetch
// and restart it against the new content from byte 0 (the partial is discarded, so the
// restart job must NOT inherit the old row's prevBytes). The expected-hash guard makes
// the supersede a no-op if the slot completed or was replaced during the awaits above.
async function reconcileActiveLooseTransfers (spaceId, member) {
  const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, member)
  if (!readable) return
  for (const [transferId, slot] of looseEngine.activeSlots()) {
    if (slot.spaceId !== spaceId || slot.ownerPublicKey !== member.publicKey) continue
    const drivePath = slot.pendingKey
    const inflightHash = slot.contentHash
    const state = await getPeerEntryState(keyHex, LOOSE_SHARE_ID, rel(drivePath), { sck })
    const decision = republishDecision(inflightHash, state, slot.sourceSeq)
    // Tombstoned, or re-added with identical content → terminate; don't silently continue the
    // old partial. A genuine content change falls through to the supersede below.
    if (decision === 'drop') { await looseEngine.dropRemoved(spaceId, drivePath, transferId).catch((err) => log.debug('loose active drop-removed failed:', err.message)); continue }
    // Mid-rehash: a new version is advertised, its hash not materialized yet. Park the transfer as
    // 'preparing' (abort the doomed old-hash fetch, keep the row) — the setMaterializedHash append
    // restarts it on the new content via runReconcile.
    if (decision === 'pending') { looseEngine.releaseForRepublish(transferId); continue }
    if (decision !== 'restart' && supersedeDecision(inflightHash, state?.contentHash) !== 'restart') continue
    const newJob = await buildLooseJob(spaceId, member, drivePath)
    if (newJob) looseEngine.supersede(transferId, { ...newJob, prevBytes: 0 }, inflightHash)
  }
}

// Loose downloads run on the shared overlay consumer engine (single-flight, real
// pause/resume, stop/cancel, auto-resume). This module supplies the loose "channel":
// the space-root event names + the catalog/ownerKey/pending-key specifics.
async function buildLooseJob (spaceId, member, drivePath, prevPending, entry) {
  const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, member)
  if (!readable) return null
  ensureLooseCatalogWatch(spaceId, member, keyHex, sck) // guarantee change-detection even for an auto-resumed transfer
  const relPath = rel(drivePath)
  entry = entry || await getPeerEntry(keyHex, LOOSE_SHARE_ID, relPath, { sck })
  if (!entry?.contentHash) return null
  const pending = prevPending || await getPendingFor(spaceId, drivePath)
  const finalPath = pending?.finalPath || resolveDest(getDownloadDir(), path.basename(relPath))
  return {
    spaceId, pendingKey: drivePath, path: drivePath, relPath,
    transferId: looseTransferIdFor(spaceId, relPath),
    contentHash: entry.contentHash, size: entry.size || 0, sourceSeq: entry.seq,
    ownerPublicKey: member.publicKey, verifyKey: LOOSE_SHARE_ID + '|' + relPath,
    finalPath, prevBytes: pending?.bytesTransferred,
  }
}

// Decoration frames carry spaceId: job.path is the bare drive path ('/'+relPath), unique per
// space only — without the field two spaces downloading the same-named loose file would mix
// bytes in the renderer's per-key decoration map.
const deco = (spaceId, key, p) => ipcRef?.emit('event:decoration', { channel: 'transfer', spaceId, key, ...p })

const looseEngine = createOverlayDownloadEngine({
  diagLabel: 'loose download',
  inPlace: true,
  ownsPendingRow: (row) => row.inPlace === true && row.shareId === LOOSE_SHARE_ID,
  pendingExtra: (job) => ({ shareId: LOOSE_SHARE_ID, relPath: job.relPath }),
  // Progress is DECORATION (never status). Lifecycle events (complete/error/paused/superseded)
  // remain as signals for notifications; the row's status is re-derived from files:list.
  emitProgress: (job, p) => deco(job.spaceId, job.path, { bytes: p.bytes, total: p.total, speed: p.speed, eta: p.eta }),
  emitVerifying: (job, fraction) => deco(job.spaceId, job.path, { phase: 'verifying', verifyFraction: fraction, bytes: job.prevBytes || 0, total: job.size }),
  emitError: (job, errorCode) => { ipcRef?.emit('event:transfer-error', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, errorCode }); deco(job.spaceId, job.path, { done: true }) },
  emitComplete: (job, localPath) => { ipcRef?.emit('event:transfer-complete', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, localPath }); deco(job.spaceId, job.path, { done: true }) },
  emitCancelled: (spaceId, transferId, pendingKey) => deco(spaceId, pendingKey, { done: true }),
  emitSuperseded: (job) => { ipcRef?.emit('event:transfer-superseded', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, fileName: path.basename(job.relPath) }); deco(job.spaceId, job.path, { bytes: 0, total: job.size, speed: 0, eta: null }) },
  emitPaused: (job, reason) => { ipcRef?.emit('event:transfer-paused', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, reason }); deco(job.spaceId, job.path, { done: true }) },
  emitDecorationDone: (job) => deco(job.spaceId, job.path, { done: true }),
  emitUpdated: (spaceId) => ipcRef?.emit('event:files-updated', { spaceId }),
  transferIdForRow: (spaceId, row) => looseTransferIdFor(spaceId, row.relPath),
  resolvePendingRow: async (spaceId, row) => {
    const space = await getSpace(spaceId)
    const member = (space?.members || []).find((m) => m.publicKey === row.ownerKey)
    if (!member) return { removed: false, seq: undefined, job: null }
    const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, member, { space })
    if (!readable) return { removed: false, seq: undefined, job: null }
    const state = await getPeerEntryState(keyHex, LOOSE_SHARE_ID, row.relPath, { sck })
    if (state?.removed) return { removed: true, seq: undefined, job: null }
    const job = state?.contentHash ? await buildLooseJob(spaceId, member, drivePathOf(row.relPath), row, state) : null
    return { removed: false, seq: state?.seq, job }
  },
  emitRemovedByOwner: (spaceId, pendingKey, row, transferId) =>
    ipcRef?.emit('event:transfer-removed', { spaceId, transferId, path: pendingKey, fileName: path.basename(row?.relPath || rel(pendingKey)) }),
})

export function looseHasTransfer (transferId) { return looseEngine.has(transferId) }
export function looseTransferActive (spaceId, relPath) { return looseEngine.has(looseTransferIdFor(spaceId, relPath)) }

export async function looseDownload (spaceId, member, drivePath) {
  const relPath = rel(drivePath)
  // This is the manual resume path too, so retire any pause marker up front — start() clears it
  // as well, but the guards below can return before we ever reach start().
  looseEngine.clearPauseMarker(looseTransferIdFor(spaceId, relPath))
  if (!getOverlay() || !(member?.looseCatalogKey || member?.looseCatalogKeyEnc)) return { queued: true }
  const job = await buildLooseJob(spaceId, member, drivePath)
  if (!job) {
    // The catalog entry is unreadable right now (owner offline, or the read budget expired under
    // reconnect churn). Record the intent so the reconnect machinery owns the retry: with no row,
    // nothing would ever retry and the click is silently lost.
    await recordPending(spaceId, drivePath, {
      inPlace: true, shareId: LOOSE_SHARE_ID, relPath, ownerKey: member.publicKey, total: 0,
    }).catch((err) => log.debug('loose intent row failed:', relPath, err.message))
    ipcRef?.emit('event:files-updated', { spaceId })
    return { queued: true }
  }
  return looseEngine.start(job)
}

export function loosePause (transferId) { return looseEngine.pause(transferId) }
export function looseCancelTransfer (transferId) { return looseEngine.cancel(transferId) }
export function looseCancel (spaceId, drivePath) {
  return looseEngine.cancelByKey(spaceId, drivePath, looseTransferIdFor(spaceId, rel(drivePath)))
}
// Cancel + discard every in-flight loose download for a space (leave teardown): the
// engine keeps fetching a started transfer even after its pending row is cleared, so
// without this the partial is orphaned and a late completion re-writes purged meta rows.
export async function looseCancelSpace (spaceId) {
  const ids = []
  for (const [transferId, slot] of looseEngine.activeSlots()) {
    if (slot.spaceId === spaceId) ids.push(transferId)
  }
  await Promise.all(ids.map((id) => looseEngine.cancel(id)))
}
export function resumeLooseForOwner (ownerKey, spaceId) { return looseEngine.resumeForOwner(ownerKey, spaceId) }

// Boot: in-memory serve maps + reverse map are not persisted. Re-register every
// own loose file whose source still exists (re-hashing if it changed while
// offline) and re-arm its watch.
export async function rehydrateLooseFiles () {
  for (const space of await listSpaces()) {
    // Per-space isolation: opening the catalog can throw (a pending joiner holds no SCK — space
    // content key — for a v2 space, so it can't open even its own SCK-encrypted catalog), and the
    // generator throws when first pulled, OUTSIDE the per-file guard. Isolate it so one such space
    // doesn't abort rehydration for every other space.
    try {
      for await (const e of listOwnShare(space.spaceId, LOOSE_SHARE_ID)) await rehydrateLooseEntry(space.spaceId, e)
    } catch (err) {
      log.debug('skip loose rehydrate for space', space.spaceId, '-', err.message)
    }
  }
}

// Per-file isolation (parity with overlayScan + the Hyperdrive path): one file whose publish
// re-throws a non-vanish error must not abort re-registration of the later loose files in its space.
// Decisions re-read the catalog under the space lock so a concurrent cancel is neither lost nor
// resurrected — a tombstoned entry is skipped, a resumable one registers a cancellable signal.
async function rehydrateLooseEntry (spaceId, e) {
  try {
    await withSpaceLock(spaceId, async () => {
      const entry = await getOwnEntry(spaceId, LOOSE_SHARE_ID, e.relPath)
      if (!entry) return
      const src = await getOwnedSourcePath(spaceId, drivePathOf(e.relPath))
      if (!src) {
        // A never-hashed entry with no recorded source is an unrecoverable half-publish (an install
        // predating the advertise-time link, or a crash inside the advertise-then-link window):
        // revert it so it stops showing "Adding" forever instead of abandoning it. A finished entry
        // that merely lost its source is left as-is — it still displays as an owned file.
        if (!entry.contentHash) {
          await unshareEntry(spaceId, e.relPath, null, null)
          ipcRef?.emit('event:files-updated', { spaceId })
        }
        return
      }
      // Resume through the same visible, cancellable body a user share takes: silent for a healthy
      // entry (publishContent fast-paths before the advertise), a live bar for a null-hash/changed one.
      await runLoosePublish(spaceId, e.relPath, src)
    })
  } catch (err) {
    log.warn('skip loose file during rehydrate:', e.relPath, '-', err.message)
  }
}

// Backstop: tombstone loose entries whose source vanished without a watcher
// unlink. Confirm-gone-twice (a path must be missing on two consecutive sweeps)
// so an atomic-save window doesn't transiently unshare a still-present file.
const sweepGone = new Set()
const goneKey = (spaceId, relPath) => spaceId + '\0' + relPath

export async function sweepLoosePresence () {
  for (const space of await listSpaces()) {
    let changed = false
    try {
    for await (const e of listOwnShare(space.spaceId, LOOSE_SHARE_ID)) {
      const key = goneKey(space.spaceId, e.relPath)
      // A publish in flight records its source at advertise-time (before the multi-minute hash),
      // so the sweep can now SEE it — but statSync on a flaky/network source can throw
      // transiently, and two such ticks would tombstone a healthy file the instant its publish
      // finishes. Never sweep an entry whose publish is still active; disk-presence decides only
      // for settled entries.
      if (isPublishActive(space.spaceId, e.relPath)) { sweepGone.delete(key); continue }
      const src = await getOwnedSourcePath(space.spaceId, drivePathOf(e.relPath))
      // No recorded source → either a crash inside the tiny advertise→link window or a
      // stranded entry from an install that predates the advertise-time link (those are
      // reverted by the boot rehydrate, not the sweep). The sweep only reclaims a RECORDED
      // source that disappeared from disk — never an entry it cannot attribute.
      if (!src) { sweepGone.delete(key); continue }
      let exists = false
      try { exists = fs.statSync(src).isFile() } catch {}
      if (exists) { sweepGone.delete(key); continue }
      if (!sweepGone.has(key)) { sweepGone.add(key); continue }
      sweepGone.delete(key)
      await withSpaceLock(space.spaceId, () => unshareEntry(space.spaceId, e.relPath, e.contentHash, src))
      changed = true
    }
    } catch (err) {
      log.debug('skip loose presence sweep for space', space.spaceId, '-', err.message)
    }
    if (changed) ipcRef?.emit('event:files-updated', { spaceId: space.spaceId })
  }
}

export function _resetLooseOverlay () {
  ipcRef = null
  looseSources.clear()
  sweepGone.clear()
  looseEngine._registry.clear()
  activePublishes.clear()
}
