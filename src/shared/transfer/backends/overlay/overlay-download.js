// One overlay consumer download engine, shared by space-root loose files and
// (non-mirrored) overlay folder shares. The two differ only in event names,
// transferId scheme, catalog lookup, ownerKey, and pending-row key/marker — all
// injected via a `channel`. The engine owns: single-flight, real pause/resume
// (continue a partial), stop/cancel + discard, and auto-resume on owner reconnect.
import fs from 'bare-fs'
import path from 'bare-path'
import { getOverlay, getJournalDir } from './overlay-instance.js'
import { fetchContentToFile, makeFetchDiag } from './overlay-backend.js'
import { journalNameFor } from './vendor/transfer.js'
import { partialPathFor } from '../../partial-suffix.js'
import { isOwnerOnline } from '../../swarm.js'
import { markDownloaded, markVerified, isDownloadedFile, isDownloadedWithHash } from '../../files.js'
import {
  recordPending, clearPending, recordPendingError, getPendingFor, updatePendingProgress, listPendingForSpace,
} from '../../pending-transfers.js'
import { makeProgressTicker } from '../../progress-ticker.js'
import { createPausedHolders } from './paused-holders.js'
import { recordTransferOutcome } from '../../transfer-audit.js'
import { pauseReasonFor as reasonForOwnerOnline } from '../../transfer-status.js'
import { republishDecision } from '../../supersede-decision.js'
import { makeKeyedCoalescer } from '../../../state/coalesce.js'
import { createSemaphore } from '../../../core/concurrency.js'
import { getDownloadConcurrency } from '../../../core/runtime-config.js'
import { ErrorCodes, classifyTransferError, isLocalDestFault } from '../../../core/errors.js'
import { createLogger } from '../../../core/logger.js'

const log = createLogger('overlay-download')

// Keep some headroom beyond the file itself: the journal, rocksdb writes and the OS all
// need working space — filling the volume to the last byte would wedge more than the transfer.
const FREE_SPACE_HEADROOM = 64 * 1024 * 1024

// [mirall] FIX-BW9 — stall auto-retry. A code-less fetch failure means "the bytes stopped":
// a holder that dropped, or one whose UPLOAD cap kept it silent past our 30 s no-progress
// watchdog. The two are indistinguishable here, and a holder that never disconnects fires
// NEITHER auto-resume trigger (owner reconnect, catalog append) — so the throttled case used
// to park the row until the user clicked Resume, and each click bought about one chunk. Retry
// it here while the owner is still online, and keep retrying only while the retries bank
// bytes: a genuinely wedged holder banks none and parks after STALL_RETRY_DRY_LIMIT attempts.
// Keep-alives (message 14) keep a NEW holder off this path for as long as its keep-alive budget
// lasts, but not forever — a holder serving many transfers at once can outlast it — so this is
// the backstop for both cases, not only for peers that predate the frame.
const STALL_RETRY_BASE_MS = 3000
// Binds only if STALL_RETRY_DRY_LIMIT is raised: at 3 the backoff reaches 3s/6s/12s and stops.
const STALL_RETRY_MAX_MS = 60000
const STALL_RETRY_DRY_LIMIT = 3

// Available bytes for the volume holding `dir`. Fails OPEN (Infinity) — a probe error must
// never block a download; the fetch itself still surfaces a real ENOSPC.
function defaultFreeBytes (dir) {
  try {
    const s = fs.statfsSync(dir)
    return s.bavail * s.bsize
  } catch {
    return Infinity
  }
}

// Is `dir` a usable destination folder right now? Anything other than a live directory —
// missing, or a plain file sitting where the folder belongs — reads as unavailable.
function defaultDirExists (dir) {
  try { return fs.statSync(dir).isDirectory() } catch { return false }
}

// A terminal fetch failure's ErrorCode. Disk-full/permission/removed classify specifically
// (the renderer has dedicated messages and disk-full is excluded from auto-resume); anything
// unrecognized stays the generic DOWNLOAD_FAILED rather than masquerading as a network error.
//
// The download folder is checked FIRST, because a local-fs errno on its own is ambiguous: the
// very same ENOENT/ENOTDIR/EACCES arise from a transient fault and from a download folder the
// user deleted, ejected, or replaced with a file. Only probing the folder separates them, and
// without that the whole class lands on DOWNLOAD_FAILED — the generic "Transfer failed" that
// tells the user nothing they can act on. macOS makes the ambiguity concrete: /Volumes is
// root-owned, so a fetch into an ejected volume fails EACCES and would otherwise report
// "Permission denied" and send the user to check permissions that are perfectly fine.
function terminalCodeFor (r, job, dirExists) {
  if (r.code === 'EHASHMISMATCH') return ErrorCodes.TRANSFER_CHECKSUM
  if (isLocalDestFault(r.cause?.code) && !dirExists(path.dirname(job.finalPath))) {
    return ErrorCodes.TRANSFER_DEST_UNAVAILABLE
  }
  const classified = classifyTransferError(r.cause)
  return classified === ErrorCodes.TRANSFER_NETWORK ? ErrorCodes.DOWNLOAD_FAILED : classified
}

// Remove a partial + its app-private journal by destination path, independent of
// whether the overlay singleton is currently live (cancel/discard can race startup
// or teardown). Reuses the vendor path helpers so the naming stays in one place.
function discardPartial (finalPath) {
  try { fs.unlinkSync(partialPathFor(finalPath)) } catch {}
  const jd = getJournalDir()
  if (jd) { try { fs.unlinkSync(path.join(jd, journalNameFor(finalPath))) } catch {} }
}

// channel: {
//   diagLabel, inPlace,
//   ownsPendingRow(row), pendingExtra(job),
//   emitProgress(job, { bytes, total, speed, eta }), emitError(job, code),
//   emitComplete(job, localPath), emitCancelled(spaceId, transferId, pendingKey, pendingRow),
//   emitUpdated(spaceId), transferIdForRow(spaceId, row),
//   resolvePendingRow(spaceId, row) → { removed, seq, job }, emitRemovedByOwner?(spaceId, pendingKey, row, transferId),
//   emitSuperseded?(job), emitPaused?(job, reason), emitDecorationDone?(job),
// }
// job: { spaceId, pendingKey, path, relPath, transferId, contentHash, size, sourceSeq,
//        ownerPublicKey, verifyKey, finalPath, prevBytes, ...channel-specific }
export function createOverlayDownloadEngine (channel, { fetchImpl = fetchContentToFile, hasOverlay = () => !!getOverlay(), freeBytes = defaultFreeBytes, stallRetry = {}, dirExists = defaultDirExists } = {}) {
  const registry = new Map() // transferId -> { contentHash, finalPath, paused, cancelled, fetching, spaceId, pendingKey, ownerPublicKey, restartJob }
  // Paused-transfer markers whose single-flight slot was released (the fetch IIFE deletes it on
  // settle). The marker is the user's intent — it outranks every automatic resume — and its hash
  // lets a later discard still tell the holder we stopped.
  const pausedHashes = createPausedHolders({ notifyStopped: (hash) => getOverlay()?.notifyTransferStopped(hash) })
  // transferId -> ErrorCode for a terminal failure whose durable write FAILED. The row is the
  // only thing that keeps a checksum / disk-full / dest-unavailable row out of the next
  // level-triggered re-drive; when it cannot be written, this map keeps the verdict for the
  // life of the process. Cleared by the user's Resume click, by a discard, and by a restart on
  // republished content — the same three things that clear a durable errorCode.
  const terminalCodes = new Map()

  // Record a terminal verdict on the row. Never throws: the caller still emits the error (the
  // transfer DID fail); what the warn adds is that the failure is not durable.
  // Only the codes runReconcile actually suppresses are worth remembering; anything else would
  // grow the map for the life of the worker without ever being read.
  const SUPPRESSED_CODES = new Set([ErrorCodes.TRANSFER_CHECKSUM, ErrorCodes.TRANSFER_DISK_FULL, ErrorCodes.TRANSFER_DEST_UNAVAILABLE])

  async function recordTerminal (job, code) {
    try {
      await recordPendingError(job.spaceId, job.pendingKey, code)
      terminalCodes.delete(job.transferId)
    } catch (err) {
      if (SUPPRESSED_CODES.has(code)) terminalCodes.set(job.transferId, code)
      log.warn('could not persist the transfer error — auto-resume is suppressed only until restart:', job.relPath, code, '-', err.message)
    }
  }

  // The single terminal-failure exit. Every failing path lands here so the audit row cannot
  // depend on which channel is driving — the divergence that left folder-share downloads
  // unrecorded for the whole life of the Activity Log. `recordTerminal` stays at its own call
  // sites: three of the four await it and the supersede-restart deliberately does not.
  function failTerminal (job, code) {
    recordTransferOutcome(job, 'error', code)
    channel.emitError(job, code)
    channel.emitUpdated(job.spaceId)
  }

  const ownerOnline = (pk) => (channel.isOwnerOnline ?? isOwnerOnline)(pk)
  // transferId -> { dry, bytes, timer } for a stall being retried. `dry` counts CONSECUTIVE
  // attempts that banked no new bytes, so a throttled holder (which always banks some) retries
  // indefinitely while a wedged one gives up.
  const stallRetries = new Map()
  // Bounds how many fetches own a chunk scheduler, a watchdog, an fd and a ticker at once.
  // A user-initiated job takes the express lane so a click never queues behind a reconnect backlog.
  const admission = createSemaphore({ limit: () => getDownloadConcurrency() })

  const pauseReasonFor = (job) => reasonForOwnerOnline(ownerOnline(job.ownerPublicKey))

  function has (transferId) { return registry.has(transferId) }

  function cancelStallRetry (transferId) {
    const st = stallRetries.get(transferId)
    if (!st) return
    clearTimeout(st.timer)
    stallRetries.delete(transferId)
  }

  // Schedule a retry of a stalled fetch. TRUE means one is pending, and the caller passes
  // `retrying` to emitPaused so the row still settles its decoration while the OS notification
  // is withheld — one notification per attempt would turn a slow transfer into a stream of them.
  async function scheduleStallRetry (job) {
    const { transferId } = job
    // Read here, not in the factory body: overlay-backend.js and loose-overlay.js both build an
    // engine at module top level, and overlay-download <-> overlay-backend is a direct import
    // cycle, so the module-level constants below are still in their temporal dead zone then.
    const retryBaseMs = stallRetry.baseMs ?? STALL_RETRY_BASE_MS
    const retryMaxMs = stallRetry.maxMs ?? STALL_RETRY_MAX_MS
    const retryDryLimit = stallRetry.dryLimit ?? STALL_RETRY_DRY_LIMIT
    // Every bail DELETES the record. A leftover is keyed by a stable transferId
    // (spaceId|shareId|relPath), so an unrelated download of the same file hours later would
    // read it as `prev` and inherit an exhausted budget it never spent.
    if (!ownerOnline(job.ownerPublicKey)) { cancelStallRetry(transferId); return false } // reconnect re-drives this
    if (pausedHashes.has(transferId)) { cancelStallRetry(transferId); return false }     // the user's pause outranks a retry
    const row = await getPendingFor(job.spaceId, job.pendingKey).catch(() => null)
    if (!row) { cancelStallRetry(transferId); return false }                             // row gone: nothing to resume
    const bytes = row.bytesTransferred || 0
    const prev = stallRetries.get(transferId)
    // Progress since the last attempt clears the counter — that is what lets a paced transfer
    // keep going, one attempt at a time, without a retry budget it can exhaust.
    const dry = prev && bytes <= prev.bytes ? prev.dry + 1 : 0
    if (dry >= retryDryLimit) { cancelStallRetry(transferId); return false }
    // Replacing a record must clear its timer, or the old one fires unreachable: cancelStallRetry
    // only ever sees the map's CURRENT record, so an orphan survives pause, discard and leave —
    // and re-creates the row they just purged.
    cancelStallRetry(transferId)
    const st = { dry, bytes, timer: null }
    st.timer = setTimeout(() => {
      st.timer = null
      retryNow(job, bytes, dry).catch((err) => log.debug('overlay stall-retry failed:', err.message))
    }, Math.min(retryMaxMs, retryBaseMs * 2 ** dry))
    st.timer.unref?.()
    stallRetries.set(transferId, st)
    return true
  }

  // The retry itself. It re-drives the SAME level-triggered recovery scan a reconnect uses
  // rather than replaying the job captured before the stall, because everything that can change
  // across a backoff is re-derived there and nowhere else: `resolvePendingRow` re-reads the
  // owner's catalog, re-anchors the destination against the space's CURRENT download folder
  // (resetting prevBytes when it moves), and `republishDecision` handles a source that was
  // tombstoned, re-added or re-hashed under us. Replaying the stale job silently undid all four
  // — and, worse, its `recordPending` re-created rows that leaving a space had just purged,
  // because during a backoff there is no registry slot for any teardown path to find.
  async function retryNow (job, bytes, dry) {
    const { transferId } = job
    // A manual resume, a reconcile-driven start, or a pause may have landed in the window; all
    // of them outrank this. The record stays so the dry counter keeps measuring
    // attempts-without-progress no matter who started them.
    if (registry.has(transferId) || pausedHashes.has(transferId)) return
    if (!ownerOnline(job.ownerPublicKey)) return settleRetryAsPaused(job)
    // Bookkeeping only — the scan itself iterates rows, so a purged one starts nothing either
    // way; this is what releases the record so it cannot be inherited by a later transfer of
    // the same path (the key is a stable spaceId|shareId|relPath).
    const row = await getPendingFor(job.spaceId, job.pendingKey).catch(() => null)
    if (!row) { cancelStallRetry(transferId); return }
    log.debug('overlay download stall-retry:', job.relPath, '— attempt', dry + 1, 'at', bytes, 'bytes')
    pokeResume(job.ownerPublicKey, job.spaceId)
  }

  // Give up on a retry without a fetch to settle it: the row must still land in a terminal paused
  // state, or the transfer is left with no event at all — emitPaused is what terminates the
  // decoration, on either channel.
  function settleRetryAsPaused (job) {
    cancelStallRetry(job.transferId)
    channel.emitPaused?.(job, pauseReasonFor(job))
    channel.emitUpdated(job.spaceId)
  }

  // === awaiting-republish: the owner is re-hashing this source ===
  // A re-publish is TWO catalog appends (advertise with a null hash → hash the source →
  // setMaterializedHash). In the window between them the owner cannot serve the OLD content
  // (it has already overwritten the file on disk), so our in-flight fetch is doomed: it dies as a
  // no-holder stall or a chunk-verification failure, neither of which is a real failure.
  //
  // Rather than hold the slot on a timer, we RELEASE it to the pending row and let the machinery
  // that already exists carry the wait: a null-hash catalog head derives status 'preparing'
  // (owner online) / 'unavailable' (offline) in files.js, and the owner's setMaterializedHash
  // append — whenever it lands, seconds or hours later for a multi-terabyte source — restarts the
  // download via runReconcile ('restart'). No timer to size against the hash; reconnect is covered
  // by resumeForOwner re-evaluating the pending row. The doomed fetch is aborted so it cannot
  // surface a terminal error or (on a lucky completion) land stale OLD content as downloaded.

  // Finish releasing a slot whose fetch has stopped: drop every trace of the OLD content (partial,
  // journal, and a finalPath the fetch may have completed before we aborted it), keep the pending
  // ROW so the status derives 'preparing' and the materialized-hash append can restart it.
  function finishRepublishRelease (transferId, tr) {
    registry.delete(transferId)
    discardPartial(tr.finalPath)
    try { fs.unlinkSync(tr.finalPath) } catch {} // a completed old-content file is stale — abandon it
    updatePendingProgress(tr.spaceId, tr.pendingKey, 0).catch(() => {})
    channel.emitDecorationDone?.(tr.job)
    channel.emitUpdated(tr.spaceId)
  }

  // The owner re-published this source but has not materialized the new hash yet. Abort the doomed
  // old-hash fetch WITHOUT a terminal event and release the slot to the pending row (above). A
  // user pause/cancel or a supersede that already claimed the slot outranks this.
  function releaseForRepublish (transferId) {
    const tr = registry.get(transferId)
    if (!tr || tr.cancelled || tr.paused || tr.restartJob || tr.republishing) return false
    tr.republishing = true
    log.debug('overlay download parked — owner is re-hashing the source:', tr.job.relPath)
    if (tr.fetching) getOverlay()?.cancelFetch(tr.contentHash, { discardPartial: true, signal: false })
    else finishRepublishRelease(transferId, tr) // no fetch to settle it → release now
    return true
  }

  // A fetch that ended with { ok:false }: either the holder went away (no r.code → keep the partial
  // + row so the status derives paused and auto-resume re-fetches on reconnect) or a terminal
  // failure (disk-full / checksum / permission → record + surface the error).
  async function settleFailed (job, r, diag) {
    if (!r.code) {
      diag.finish('no-holder')
      log.debug('overlay fetch interrupted — holder gone or throttled:', job.relPath, 'at', job.prevBytes || 0, 'bytes')
      // `retrying` withholds the OS notification only — the paused emit still fires, because it
      // also terminates the decoration, and withholding it strands a progress bar that then
      // samples speed across the whole backoff.
      const retrying = await scheduleStallRetry(job)
      channel.emitPaused?.(job, pauseReasonFor(job), { retrying })
      channel.emitUpdated(job.spaceId)
      return
    }
    diag.finish('failed')
    const code = terminalCodeFor(r, job, dirExists)
    if (code === ErrorCodes.TRANSFER_CHECKSUM) log.warn('overlay integrity failure — holder served bytes that do not match the content hash:', job.relPath)
    else if (code === ErrorCodes.TRANSFER_DISK_FULL) log.warn('overlay fetch failed — disk full:', job.relPath)
    else if (code === ErrorCodes.TRANSFER_DEST_UNAVAILABLE) log.warn('overlay fetch failed — download folder unavailable:', path.dirname(job.finalPath))
    else log.debug('overlay fetch failed:', job.relPath, '-', r.code)
    await recordTerminal(job, code)
    failTerminal(job, code)
  }

  // The gated half of a download: everything past this point owns a chunk scheduler, a watchdog,
  // an fd and a ticker, which is what the admission limit exists to bound. start() has already
  // reserved the registry slot synchronously, so a queued job still reads as active and a second
  // trigger cannot start a duplicate fetch while this waits.
  async function runFetchTask (slot, job, transferId) {
    const releaseSlot = await admission.acquire({ express: !!job.express })
    try {
      // The wait above is unbounded, so re-check every reason to abandon that the pre-fetch path
      // already checked — the same window recordPending guards against, only wider.
      if (slot.cancelled) {
        registry.delete(transferId)
        if (slot.restartJob) restartAfterSupersede(slot.restartJob)
        return
      }
      // hasOverlay() covers the shutdown path: drainAdmission() releases parked waiters so close()
      // is not held open, and they must not then fetch into a torn-down overlay.
      if (slot.paused || !hasOverlay() || !ownerOnline(job.ownerPublicKey)) {
        registry.delete(transferId)
        channel.emitUpdated(job.spaceId)
        return
      }
      // Set past the gate so it keeps meaning "a fetch is in flight in the vendor layer" — the four
      // cancel/pause sites gate their cancelFetch call on it.
      slot.fetching = true
      // The overlay scheduler reports CUMULATIVE bytes already seeded with the resumed on-disk
      // bytes (chunk-scheduler.js), so the ticker needs no resume offset.
      const ticker = makeProgressTicker(job.size, ({ bytes, total, speed, eta }) => {
        channel.emitProgress(job, { bytes, total, speed, eta })
        updatePendingProgress(job.spaceId, job.pendingKey, bytes).catch(() => {})
      })
      const diag = makeFetchDiag(channel.diagLabel, job.relPath, job.size, job.contentHash)
      const r = await fetchImpl(job.contentHash, { finalPath: job.finalPath, onProgress: (b) => { ticker.pushTo(b); diag.onProgress(b) }, onVerify: (fraction) => channel.emitVerifying?.(job, fraction), onEnd: diag.onEnd })
      await settleFetch(transferId, job, r, diag)
    } finally {
      releaseSlot()
    }
  }

  // Resolve a finished fetch. Reads the LIVE slot, because a pause/cancel/supersede/republish may
  // have landed while the bytes were in flight — the fetch's own result is only half the story, and
  // which of these applies decides whether the slot is restarted or released.
  async function settleFetch (transferId, job, r, diag) {
    const s = registry.get(transferId)
    const wasPaused = s?.paused
    const wasCancelled = s?.cancelled
    const restartJob = s?.restartJob
    // A supersede or an explicit user pause/cancel outranks the republish-park (they carry a
    // stronger intent), so they are handled below first. Otherwise, the owner is mid-rehash:
    // release the slot to the pending row WITHOUT a terminal event — regardless of how the doomed
    // fetch settled (a no-holder stall, a checksum failure, or even a lucky completion of the OLD
    // bytes) — and let the status derive 'preparing' + the materialized-hash append restart it.
    const parkForRepublish = s?.republishing && !restartJob && !wasCancelled && !wasPaused
    if (parkForRepublish) { diag.finish('awaiting-republish'); cancelStallRetry(transferId); finishRepublishRelease(transferId, s); return }
    registry.delete(transferId)
    // [mirall] FIX-BW9 — only a code-less stall keeps its retry history; every other outcome
    // (done, cancelled, superseded, terminal error) ends the intent this record belongs to.
    if (r.ok || r.code) cancelStallRetry(transferId)
    if (restartJob) {
      // Source content changed mid-fetch (supersede): the stale fetch was aborted
      // and its partial discarded. Re-enter on the NEW contentHash now that the
      // stable transferId's slot is free — start() re-reserves it synchronously,
      // so has()/looseTransferActive never observes a gap.
      diag.finish('superseded')
      restartAfterSupersede(restartJob)
      return
    }
    if (wasCancelled) {
      // A cancel raced the fetch to completion (the abort couldn't reach it in
      // time). cancelByKey already cleared the row + emitted, so just drop any
      // bytes that landed — never re-mark a cancelled file as downloaded.
      diag.finish('cancelled')
      try { fs.unlinkSync(job.finalPath) } catch {}
      discardPartial(job.finalPath)
      // Settle-time re-derive: cancelByKey's emit fired while the slot was still
      // registered, so a list read racing the abort can re-derive 'downloading';
      // this emit lands after the registry delete and corrects it.
      channel.emitUpdated(job.spaceId)
      return
    }
    if (r.code === 'ECANCELLED') {
      diag.finish(wasPaused ? 'paused' : 'cancelled')
      // Pause keeps the pending row + partial → re-list so the row derives a
      // paused state. A discard already cleared the row + emitted in cancelByKey.
      if (wasPaused) { channel.emitUpdated(job.spaceId); channel.emitDecorationDone?.(job) }
      return
    }
    if (!r.ok) { await settleFailed(job, r, diag); return }
    diag.finish('done')
    // Durable positive fact FIRST: a crash inside this window must re-derive
    // 'downloaded' (a lingering resume row is masked by the downloaded status),
    // never 'remote' — which would re-download and duplicate the file.
    terminalCodes.delete(job.transferId)
    await markDownloaded(job.spaceId, job.pendingKey, job.finalPath, { hash: job.contentHash })
    await markVerified(job.spaceId, job.verifyKey, job.contentHash)
    // The claim above already decides the status; the row only matters to the resume scan,
    // which drops a claimed row itself (runReconcile). So a failed clear degrades to one extra
    // read at the next reconcile — but it has to be visible.
    try {
      await clearPending(job.spaceId, job.pendingKey)
    } catch (err) {
      log.warn('could not clear the pending row of a completed download:', job.relPath, '-', err.message)
    }
    channel.emitUpdated(job.spaceId)
    recordTransferOutcome(job, 'ok', null)
    channel.emitComplete(job, job.finalPath)
  }

  function missingFreeSpaceFor (job) {
    let allocated = 0
    try { allocated = fs.statSync(partialPathFor(job.finalPath)).blocks * 512 || 0 } catch {}
    const needed = Math.max(0, job.size - allocated) + FREE_SPACE_HEADROOM
    return freeBytes(path.dirname(job.finalPath)) < needed
  }

  async function start (job) {
    if (!hasOverlay() || !job.contentHash) return { queued: true }
    const { transferId } = job
    pausedHashes.supersede(transferId) // a fresh start (resume) supersedes any paused marker
    const existing = registry.get(transferId)
    if (existing) return { transferId, finalPath: existing.finalPath }

    // Reserve the single-flight slot SYNCHRONOUSLY (before any await) so a duplicate
    // trigger can't start a second fetch that collides on the per-hash scheduler.
    // contentHash is known up front so a pause/cancel can target the right hash; the
    // `fetching` flag gates cancelFetch so an abort only reaches the (vendor) layer
    // once a fetch is actually in flight.
    const slot = { contentHash: job.contentHash, finalPath: job.finalPath, paused: false, cancelled: false, fetching: false, spaceId: job.spaceId, pendingKey: job.pendingKey, ownerPublicKey: job.ownerPublicKey, sourceSeq: job.sourceSeq, restartJob: null, republishing: false, job }
    registry.set(transferId, slot)
    try {
      // Record the pending row up front (carrying ownerKey + the content hash it is fetching) so
      // the download survives an owner-offline gap and auto-resumes on reconnect, and so a later
      // reconcile can tell a re-added-identical entry (drop) from changed content (restart).
      // recordPending OVERWRITES the row, so the resumed byte count has to be carried through
      // explicitly: a start() that then bails (owner offline) would otherwise reset a part-
      // downloaded row's progress to zero.
      await recordPending(job.spaceId, job.pendingKey, {
        total: job.size, inPlace: channel.inPlace, ownerKey: job.ownerPublicKey,
        finalPath: job.finalPath, sourceSeq: job.sourceSeq, contentHash: job.contentHash,
        bytesTransferred: job.prevBytes || 0, ...channel.pendingExtra(job),
      })

      // A pause/cancel/supersede may have landed during the await above, before any
      // fetch existed. A supersede restarts on the new hash; a plain cancel just drops.
      if (slot.cancelled) {
        registry.delete(transferId)
        if (slot.restartJob) { const rj = slot.restartJob; restartAfterSupersede(rj); return { transferId, finalPath: rj.finalPath } }
        return { queued: true } // cancelByKey already cleared the row + emitted
      }
      if (slot.paused) { registry.delete(transferId); channel.emitUpdated(job.spaceId); return { queued: true } }
      if (!ownerOnline(job.ownerPublicKey)) {
        registry.delete(transferId)
        log.debug('overlay download queued — owner not present on the control plane:', job.relPath)
        channel.emitUpdated(job.spaceId)
        return { queued: true }
      }

      // Preflight: the download folder must still be there. This is not redundant with the
      // terminal classification below — the receive path mkdir -p's the destination
      // (vendor/transfer.js), so a folder the user simply DELETED is silently recreated and the
      // download completes into a resurrected empty folder with no error to classify at all.
      // Downloads are flat (finalPath is always <root>/<basename>), so dirname IS the root.
      // Runs BEFORE the free-space gate on purpose: defaultFreeBytes fails open on a statfs
      // error, so a gone root sails straight past that check.
      if (!dirExists(path.dirname(job.finalPath))) {
        registry.delete(transferId)
        log.warn('overlay download refused — download folder unavailable:', path.dirname(job.finalPath))
        await recordTerminal(job, ErrorCodes.TRANSFER_DEST_UNAVAILABLE)
        failTerminal(job, ErrorCodes.TRANSFER_DEST_UNAVAILABLE)
        return { queued: true }
      }

      // Preflight: the size is known up front, so refuse a download the volume cannot hold
      // BEFORE any scheduler/holder work. On NTFS the receive path's full-size preallocation
      // would fail in seconds anyway (with a generic error); on sparse filesystems it would
      // otherwise fail only after filling the disk mid-transfer. A resumed partial's already-
      // allocated bytes (st.blocks) count against the requirement.
      if (missingFreeSpaceFor(job)) {
        registry.delete(transferId)
        log.warn('overlay download refused — not enough free disk space:', job.relPath, 'needs', job.size, 'bytes')
        await recordTerminal(job, ErrorCodes.TRANSFER_DISK_FULL)
        failTerminal(job, ErrorCodes.TRANSFER_DISK_FULL)
        return { queued: true }
      }

      // Flip the row to 'downloading' immediately: emitUpdated re-derives the list (the engine
      // holds the slot from here, admitted or queued), emitProgress seeds the bar before the
      // first byte. Status derives from the registry slot, not from `fetching`.
      channel.emitProgress(job, { bytes: job.prevBytes || 0, total: job.size, speed: 0, eta: null })
      channel.emitUpdated(job.spaceId)
      runFetchTask(slot, job, transferId)
        .catch((err) => log.warn('overlay download task failed after the fetch settled:', job.relPath, '-', err.message))

      return { transferId, finalPath: job.finalPath }
    } catch (err) {
      registry.delete(transferId) // release the reserved slot if a pre-fetch read threw
      throw err
    }
  }

  // Stop the fetch but KEEP the partial + pending row so a later start() resumes it. With no
  // slot the fetch already settled (a dropped connection beat the click) — the row is still
  // pending, so record the intent anyway: without the marker the next reconnect auto-resumes a
  // download the user just paused.
  function pause (transferId) {
    const tr = registry.get(transferId)
    if (!tr) {
      cancelStallRetry(transferId)   // [mirall] FIX-BW9 — a pause during the retry backoff
      pausedHashes.remember(transferId, null)
      return true
    }
    tr.paused = true
    cancelStallRetry(transferId)
    pausedHashes.remember(transferId, tr.contentHash) // remember the hash so a later discard can signal STOPPED
    if (tr.fetching) getOverlay()?.cancelFetch(tr.contentHash, { discardPartial: false })
    return true
  }

  // A user's explicit download/resume click outranks a manual-pause marker. Cleared HERE rather
  // than only in start(), because an attempt that dies before start() (an unreadable catalog, an
  // owner that just went offline) would otherwise leave the marker set — and a set marker makes
  // runReconcile skip the row as "manually paused" forever, so no reconnect ever resumes it.
  function clearPauseMarker (transferId) {
    pausedHashes.supersede(transferId)
    terminalCodes.delete(transferId)
    // [mirall] FIX-BW9 — a deliberate Resume/download click starts a fresh retry budget.
    // Inheriting a dry counter from earlier automatic attempts makes the click park after one
    // try, which is precisely the symptom this fix set out to remove.
    cancelStallRetry(transferId)
  }

  // Discard: stop + drop the partial + pending row. Works in-flight (the slot is left
  // for start()'s guard / the fetch IIFE to honor `cancelled`) and on a paused/restart-
  // orphaned row (no slot; partial resolved from the pending finalPath).
  async function cancelByKey (spaceId, pendingKey, transferId) {
    const tr = registry.get(transferId)
    const pending = await getPendingFor(spaceId, pendingKey)
    if (tr) {
      tr.cancelled = true
      if (tr.fetching) getOverlay()?.cancelFetch(tr.contentHash, { discardPartial: true })
    } else {
      // Discarding an already-paused row (its single-flight slot is gone): the holder
      // still shows us paused, so tell it we stopped.
      pausedHashes.notify(transferId)
    }
    cancelStallRetry(transferId)
    // Clear the durable row FIRST. Everything after it is destructive and in-memory-only, so a
    // failed clear must not leave the row alive with its partial deleted and its manual-pause
    // marker dropped — that combination auto-resumes from zero a transfer the user paused and
    // then discarded.
    try {
      await clearPending(spaceId, pendingKey)
    } catch (err) {
      log.warn('could not clear the pending row on discard:', pendingKey, '-', err.message)
      channel.emitUpdated(spaceId)
      throw err
    }
    pausedHashes.supersede(transferId)
    const finalPath = pending?.finalPath
    if (finalPath) discardPartial(finalPath)
    terminalCodes.delete(transferId)
    channel.emitCancelled(spaceId, transferId, pendingKey, pending)
    channel.emitUpdated(spaceId)
    return pending
  }

  // Stop + discard a transfer addressed by its id alone. A live slot carries the spaceId +
  // pending key; with none the fetch already settled (a dropped connection beat the click), so
  // resolve them from the pending ROW instead — the id names the row but cannot rebuild a folder
  // pendingKey, which embeds the share NAME the id does not carry. Bailing out here (the old
  // behavior) left the partial and the row behind, and the row auto-resumed on the next reconnect.
  // false only when neither a slot nor a row exists: a transfer that is genuinely gone.
  async function cancel (transferId) {
    const tr = registry.get(transferId)
    if (tr) {
      await cancelByKey(tr.spaceId, tr.pendingKey, transferId)
      return true
    }
    if (typeof transferId !== 'string') return false
    const spaceId = transferId.split('|')[0]
    for (const row of await listPendingForSpace(spaceId)) {
      if (!channel.ownsPendingRow(row)) continue // one bee, both engines: never discard the other's row
      if (channel.transferIdForRow(spaceId, row) !== transferId) continue
      await cancelByKey(spaceId, row.filePath, transferId)
      return true
    }
    return false
  }

  // The source file changed under an in-flight transfer. Abort the stale fetch (its
  // bytes are for the old content) + discard the partial, then restart against the new
  // contentHash from byte 0 — WITHOUT a terminal cancelled/error event, so the UI shows
  // a continuous "restarting", not a failure. The restart itself runs from the aborted
  // fetch's IIFE (or start()'s pre-fetch guard), so the stable transferId is never reused
  // while the old fetch is still settling. expectedHash guards the read-decide-supersede
  // gap: if the slot completed or was replaced (id reused) during the caller's awaits,
  // tr.contentHash no longer matches and the supersede is a no-op.
  function supersede (transferId, newJob, expectedHash) {
    const tr = registry.get(transferId)
    if (!tr || !newJob) return false
    if (expectedHash !== undefined && tr.contentHash !== expectedHash) return false
    // Setting restartJob outranks a republish-park (settleFetch checks restartJob first), so a
    // supersede that lands while the slot is parking still restarts on the new hash.
    tr.cancelled = true
    // The new job is rebuilt from the catalog, so carry the lane the original was admitted on:
    // a supersede is not the user changing their mind about how urgent this download is.
    tr.restartJob = { ...newJob, express: newJob.express ?? tr.job?.express }
    // signal:false — a supersede is a system-initiated restart on a new hash, not a
    // user stop. The restart's content-request re-establishes the holder's serve row
    // on the same path, so don't emit STOPPED (it would blink the downloader's avatar off).
    if (tr.fetching) getOverlay()?.cancelFetch(tr.contentHash, { discardPartial: true, signal: false })
    channel.emitSuperseded?.(newJob)
    return true
  }

  // Run a supersede restart and resolve its outcome so the UI never sticks on the
  // "restarting" state: a fetch that begins drives its own progress/terminal events,
  // but one that can't start (owner went offline → queued) surfaces as paused-offline,
  // and one that throws surfaces as an error. Without this the row stays at the zeroed
  // 'preparing' state forever with no follow-up event.
  function restartAfterSupersede (job) {
    start(job).then(
      (res) => { if (res && res.queued) channel.emitPaused?.(job, pauseReasonFor(job)) },
      (err) => {
        log.debug('overlay supersede-restart failed:', err.message)
        failTerminal(job, ErrorCodes.DOWNLOAD_FAILED)
      },
    )
  }

  // Keyed, single-flighted, debounced scan scaffold: the first poke per (owner, space) fires
  // after the debounce; overlapping scans can't stack (one queued trailing re-run absorbs pokes
  // that land mid-scan). Shared by the resume (reconnect) and reconcile (append) drivers below.
  function makeSingleFlightScan (fn) {
    let inFlight = false
    const queued = new Map()
    const poke = makeKeyedCoalescer((ownerKey, spaceId) => { run(ownerKey, spaceId) },
      { intervalMs: 250, keyOf: (ownerKey, spaceId) => ownerKey + '|' + spaceId })
    async function run (ownerKey, spaceId) {
      if (inFlight) { queued.set(ownerKey + '|' + spaceId, [ownerKey, spaceId]); return }
      inFlight = true
      try { await fn(ownerKey, spaceId) } catch (err) { log.debug('overlay reconcile scan failed:', err.message) }
      finally {
        inFlight = false
        if (queued.size) { const q = [...queued.values()]; queued.clear(); for (const [o, s] of q) poke.flush(o, s) }
      }
    }
    return (ownerKey, spaceId) => poke.poke(ownerKey, spaceId)
  }

  // Reconcile our pending downloads from an owner whose catalog changed or who (re)connected.
  // ONE read per inactive row decides its fate (republishDecision): a tombstone or a re-add of
  // IDENTICAL content terminates the intent (FIX-REMOVE-1: a deliberate remove+re-add must not
  // auto-resume); a still-mid-rehash null hash HOLDS the row (waits for the materialized append);
  // a genuinely NEW materialized hash restarts on the new content (the re-publish / owner-return
  // resume — this is the intended behavior per the mid-transfer source-change fix, and the reason
  // the identical-content case above stays a drop); else resume an interrupted/offline download.
  //
  // `deep` is the catalog-APPEND path (reconcileOnAppend): the owner is online and its head is
  // present, so paused/errored rows are read too, so a deliberate removal terminates a
  // manually-paused or errored download. The RECONNECT path (resumeForOwner) is shallow — a
  // manually-paused (pausedHashes) or terminally-errored row costs zero I/O (FIX-EDA-14: no 8s
  // head-pull for a row that won't resume anyway); its removal is caught on the next append.
  async function runReconcile (ownerKey, spaceId, deep) {
    if (!hasOverlay()) return
    for (const row of await listPendingForSpace(spaceId)) {
      if (!channel.ownsPendingRow(row) || row.ownerKey !== ownerKey) continue
      const transferId = channel.transferIdForRow(spaceId, row)
      if (registry.has(transferId)) continue // active → reconcileActive* owns supersede + removal
      const errorCode = row.errorCode ?? terminalCodes.get(transferId)
      const suppressed = pausedHashes.has(transferId) || errorCode === ErrorCodes.TRANSFER_CHECKSUM || errorCode === ErrorCodes.TRANSFER_DISK_FULL || errorCode === ErrorCodes.TRANSFER_DEST_UNAVAILABLE
      if (suppressed && !deep) continue
      // A completed download whose row outlived its claim (a failed clear, or a crash between
      // the claim and the clear): the file is on disk and claimed, so finish the intent here
      // instead of fetching a file we already have. Placed after the suppressed check so a
      // paused or terminally-errored row still costs zero I/O, and before the catalog read
      // below, which is the expensive step this saves.
      if (await isDownloadedWithHash(spaceId, row.filePath, row.contentHash)) {
        await clearPending(spaceId, row.filePath).catch((err) => log.warn('could not clear a stale pending row:', row.filePath, '-', err.message))
        continue
      }
      const { removed, seq, job } = await channel.resolvePendingRow(spaceId, row)
      const decision = republishDecision(row.contentHash, { removed, seq, contentHash: job?.contentHash ?? null }, row.sourceSeq)
      if (decision === 'drop') { // tombstoned, or re-added with identical content
        await dropRemoved(spaceId, row.filePath, transferId).catch((err) => log.warn('overlay drop-removed failed:', row.filePath, '-', err.message))
        continue
      }
      // The owner advertised a new version but has not materialized its hash yet. KEEP the row
      // and wait: setMaterializedHash is a second append that re-runs this scan with the real
      // hash. Dropping it here (the old behavior) killed the download outright.
      if (decision === 'pending') continue
      if (decision === 'restart') {
        // The source changed while this download was inactive. The partial holds the OLD
        // content's bytes, which can never verify against the new hash — reset to zero and
        // re-point the row at the new version so any resume, auto or manual, starts clean. Drop a
        // prior terminal errorCode too: it belonged to the old content, and leaving it keeps the
        // row 'suppressed' (checksum/disk-full never auto-resume) so it would never restart.
        discardPartial(job.finalPath)
        cancelStallRetry(transferId)   // [mirall] FIX-BW9 — new content, fresh retry budget
        const { errorCode: _priorCode, erroredAt: _priorAt, ...cleanRow } = row
        try {
          await recordPending(spaceId, row.filePath, { ...cleanRow, sourceSeq: job.sourceSeq, contentHash: job.contentHash, bytesTransferred: 0 })
        } catch (err) {
          // The row still names the old hash, so the next scan derives a restart again and
          // retries this write; starting now would fail the same write inside start().
          log.warn('could not re-point the pending row at the republished content:', row.filePath, '-', err.message)
          continue
        }
        terminalCodes.delete(transferId)
        if (pausedHashes.has(transferId)) continue // a manual pause is the user's intent — the cleared row resumes on the new content when they hit Resume, not automatically
        // Surface a supersede so the UI shows one continuous "the file was updated, re-downloading",
        // whether the source-change was caught here (a transfer parked on the null-hash window, now
        // restarting on the materialized hash) or by the active-transfer reconcile's supersede().
        channel.emitSuperseded?.(job)
        start({ ...job, prevBytes: 0 }).catch((err) => log.debug('overlay republish-restart failed:', row.filePath, err.message))
        continue
      }
      if (suppressed) continue // live + same source → keep the manual pause / terminal error
      if (job) start(job).catch((err) => log.debug('overlay auto-resume failed:', row.filePath, err.message))
    }
  }

  const pokeResume = makeSingleFlightScan((ownerKey, spaceId) => runReconcile(ownerKey, spaceId, false))
  const pokeAppend = makeSingleFlightScan((ownerKey, spaceId) => runReconcile(ownerKey, spaceId, true))
  async function resumeForOwner (ownerKey, spaceId) { pokeResume(ownerKey, spaceId) }
  async function reconcileOnAppend (ownerKey, spaceId) { pokeAppend(ownerKey, spaceId) }

  // Teardown for a deliberately removed OR re-published source: same mechanics as a user discard
  // (abort the fetch + discard the partial + clear the row + pause marker), then signal it so the
  // renderer can tell the user why the download stopped. cancelByKey returns the row it cleared
  // (it names the file for the toast). A download that COMPLETED under the reconcile's read window
  // is left alone — it is genuinely on disk (marked downloaded), not removed.
  async function dropRemoved (spaceId, pendingKey, transferId) {
    if (await isDownloadedFile(spaceId, pendingKey)) return
    const pending = await cancelByKey(spaceId, pendingKey, transferId)
    if (pending) channel.emitRemovedByOwner?.(spaceId, pendingKey, pending, transferId)
  }

  return { start, pause, clearPauseMarker, cancel, cancelByKey, resumeForOwner, reconcileOnAppend, dropRemoved, supersede, releaseForRepublish, has, activeSlots: () => registry.entries(), drainAdmission: () => admission.drain(), admissionStats: () => admission.stats(), _registry: registry, _stallRetries: stallRetries }
}
