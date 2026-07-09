// One overlay consumer download engine, shared by space-root loose files and
// (non-mirrored) overlay folder shares. The two differ only in event names,
// transferId scheme, catalog lookup, ownerKey, and pending-row key/marker — all
// injected via a `channel`. The engine owns: single-flight, real pause/resume
// (continue a partial), stop/cancel + discard, and auto-resume on owner reconnect.
import fs from 'bare-fs'
import path from 'bare-path'
import { getOverlay, getJournalDir } from './overlay-instance.js'
import { fetchContentToFile, makeFetchDiag } from './overlay-backend.js'
import { partialPathFor, journalNameFor } from './vendor/transfer.js'
import { isOwnerOnline } from '../../swarm.js'
import { markDownloaded, markVerified, isDownloadedFile } from '../../files.js'
import {
  recordPending, clearPending, recordPendingError, getPendingFor, updatePendingProgress, listPendingForSpace,
} from '../../pending-transfers.js'
import { makeProgressTicker } from '../../progress-ticker.js'
import { pauseReasonFor as reasonForOwnerOnline } from '../../transfer-status.js'
import { isRepublished } from '../../supersede-decision.js'
import { makeKeyedCoalescer } from '../../../state/coalesce.js'
import { ErrorCodes, classifyTransferError } from '../../../core/errors.js'
import { createLogger } from '../../../core/logger.js'

const log = createLogger('overlay-download')

// Keep some headroom beyond the file itself: the journal, rocksdb writes and the OS all
// need working space — filling the volume to the last byte would wedge more than the transfer.
const FREE_SPACE_HEADROOM = 64 * 1024 * 1024

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

// A terminal fetch failure's ErrorCode. Disk-full/permission/removed classify specifically
// (the renderer has dedicated messages and disk-full is excluded from auto-resume); anything
// unrecognized stays the generic DOWNLOAD_FAILED rather than masquerading as a network error.
function terminalCodeFor (r) {
  if (r.code === 'EHASHMISMATCH') return ErrorCodes.TRANSFER_CHECKSUM
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
export function createOverlayDownloadEngine (channel, { fetchImpl = fetchContentToFile, hasOverlay = () => !!getOverlay(), freeBytes = defaultFreeBytes } = {}) {
  const registry = new Map() // transferId -> { contentHash, finalPath, paused, cancelled, fetching, spaceId, pendingKey, ownerPublicKey, restartJob }
  // transferId -> contentHash for a paused transfer whose single-flight slot was
  // released (the fetch IIFE deletes it on settle). Lets a later discard still tell
  // the holder we stopped, since the registry no longer carries the hash.
  const pausedHashes = new Map()
  const ownerOnline = (pk) => (channel.isOwnerOnline ?? isOwnerOnline)(pk)

  const pauseReasonFor = (job) => reasonForOwnerOnline(ownerOnline(job.ownerPublicKey))

  function has (transferId) { return registry.has(transferId) }

  function missingFreeSpaceFor (job) {
    let allocated = 0
    try { allocated = fs.statSync(partialPathFor(job.finalPath)).blocks * 512 || 0 } catch {}
    const needed = Math.max(0, job.size - allocated) + FREE_SPACE_HEADROOM
    return freeBytes(path.dirname(job.finalPath)) < needed
  }

  async function start (job) {
    if (!hasOverlay() || !job.contentHash) return { queued: true }
    const { transferId } = job
    pausedHashes.delete(transferId) // a fresh start (resume) supersedes any paused marker
    const existing = registry.get(transferId)
    if (existing) return { transferId, finalPath: existing.finalPath }

    // Reserve the single-flight slot SYNCHRONOUSLY (before any await) so a duplicate
    // trigger can't start a second fetch that collides on the per-hash scheduler.
    // contentHash is known up front so a pause/cancel can target the right hash; the
    // `fetching` flag gates cancelFetch so an abort only reaches the (vendor) layer
    // once a fetch is actually in flight.
    const slot = { contentHash: job.contentHash, finalPath: job.finalPath, paused: false, cancelled: false, fetching: false, spaceId: job.spaceId, pendingKey: job.pendingKey, ownerPublicKey: job.ownerPublicKey, sourceSeq: job.sourceSeq, restartJob: null }
    registry.set(transferId, slot)
    try {
      // Record the pending row up front (carrying ownerKey) so the download survives
      // an owner-offline gap and auto-resumes on reconnect.
      await recordPending(job.spaceId, job.pendingKey, {
        total: job.size, inPlace: channel.inPlace, ownerKey: job.ownerPublicKey,
        finalPath: job.finalPath, sourceSeq: job.sourceSeq, ...channel.pendingExtra(job),
      })

      // A pause/cancel/supersede may have landed during the await above, before any
      // fetch existed. A supersede restarts on the new hash; a plain cancel just drops.
      if (slot.cancelled) {
        registry.delete(transferId)
        if (slot.restartJob) { const rj = slot.restartJob; restartAfterSupersede(rj); return { transferId, finalPath: rj.finalPath } }
        return { queued: true } // cancelByKey already cleared the row + emitted
      }
      if (slot.paused) { registry.delete(transferId); channel.emitUpdated(job.spaceId); return { queued: true } }
      if (!ownerOnline(job.ownerPublicKey)) { registry.delete(transferId); channel.emitUpdated(job.spaceId); return { queued: true } }

      // Preflight: the size is known up front, so refuse a download the volume cannot hold
      // BEFORE any scheduler/holder work. On NTFS the receive path's full-size preallocation
      // would fail in seconds anyway (with a generic error); on sparse filesystems it would
      // otherwise fail only after filling the disk mid-transfer. A resumed partial's already-
      // allocated bytes (st.blocks) count against the requirement.
      if (missingFreeSpaceFor(job)) {
        registry.delete(transferId)
        log.warn('overlay download refused — not enough free disk space:', job.relPath, 'needs', job.size, 'bytes')
        await recordPendingError(job.spaceId, job.pendingKey, ErrorCodes.TRANSFER_DISK_FULL).catch(() => {})
        channel.emitError(job, ErrorCodes.TRANSFER_DISK_FULL)
        channel.emitUpdated(job.spaceId)
        return { queued: true }
      }

      slot.fetching = true
      // Flip the row to 'downloading' immediately: emitUpdated re-derives the list (now that the
      // engine has an active slot), emitProgress seeds the decoration bar before the first byte.
      channel.emitProgress(job, { bytes: job.prevBytes || 0, total: job.size, speed: 0, eta: null })
      channel.emitUpdated(job.spaceId)
      // The overlay scheduler reports CUMULATIVE bytes already seeded with the
      // resumed on-disk bytes (chunk-scheduler.js), so the ticker needs no resume
      // offset — pushTo carries the true cumulative.
      const ticker = makeProgressTicker(job.size, ({ bytes, total, speed, eta }) => {
        channel.emitProgress(job, { bytes, total, speed, eta })
        updatePendingProgress(job.spaceId, job.pendingKey, bytes).catch(() => {})
      })
      const diag = makeFetchDiag(channel.diagLabel, job.relPath, job.size, job.contentHash)
      ;(async () => {
        const r = await fetchImpl(job.contentHash, { finalPath: job.finalPath, onProgress: (b) => { ticker.pushTo(b); diag.onProgress(b) }, onVerify: (fraction) => channel.emitVerifying?.(job, fraction), onEnd: diag.onEnd })
        const s = registry.get(transferId)
        const wasPaused = s?.paused
        const wasCancelled = s?.cancelled
        const restartJob = s?.restartJob
        registry.delete(transferId)
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
        if (!r.ok) {
          // No r.code → the holder went away mid-fetch (the only seeder quit, all peers
          // dropped, or the stream stalled — fetchContentToFile returns { ok:false } with
          // no code for every no-holder/stall give-up). NOT a terminal failure: keep the
          // partial + clean pending row so the status derives paused-offline (owner gone)
          // / paused-interrupted (owner still online) and auto-resume re-fetches on
          // reconnect. 'no-holder' is a DELIBERATE_STOP, so diag logs at debug, not the
          // give-up WARN.
          if (!r.code) {
            diag.finish('no-holder')
            log.debug('overlay fetch interrupted — holder gone:', job.relPath, 'at', job.prevBytes || 0, 'bytes')
            channel.emitPaused?.(job, pauseReasonFor(job))
            channel.emitUpdated(job.spaceId)
            return
          }
          diag.finish('failed')
          const code = terminalCodeFor(r)
          if (code === ErrorCodes.TRANSFER_CHECKSUM) log.warn('overlay integrity failure — holder served bytes that do not match the content hash:', job.relPath)
          else if (code === ErrorCodes.TRANSFER_DISK_FULL) log.warn('overlay fetch failed — disk full:', job.relPath)
          else log.debug('overlay fetch failed:', job.relPath, '-', r.code)
          await recordPendingError(job.spaceId, job.pendingKey, code).catch(() => {})
          channel.emitError(job, code)
          channel.emitUpdated(job.spaceId)
          return
        }
        diag.finish('done')
        // Durable positive fact FIRST: a crash inside this window must re-derive
        // 'downloaded' (a lingering resume row is masked by the downloaded status),
        // never 'remote' — which would re-download and duplicate the file.
        await markDownloaded(job.spaceId, job.pendingKey, job.finalPath, { hash: job.contentHash })
        await markVerified(job.spaceId, job.verifyKey, job.contentHash)
        await clearPending(job.spaceId, job.pendingKey).catch(() => {})
        channel.emitUpdated(job.spaceId)
        channel.emitComplete(job, job.finalPath)
      })().catch((err) => log.debug('overlay download task failed:', err.message))

      return { transferId, finalPath: job.finalPath }
    } catch (err) {
      registry.delete(transferId) // release the reserved slot if a pre-fetch read threw
      throw err
    }
  }

  // Stop the fetch but KEEP the partial + pending row so a later start() resumes it.
  function pause (transferId) {
    const tr = registry.get(transferId)
    if (!tr) return false
    tr.paused = true
    pausedHashes.set(transferId, tr.contentHash) // remember the hash so a later discard can signal STOPPED
    if (tr.fetching) getOverlay()?.cancelFetch(tr.contentHash, { discardPartial: false })
    return true
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
      const hash = pausedHashes.get(transferId)
      if (hash) getOverlay()?.notifyTransferStopped(hash)
    }
    pausedHashes.delete(transferId)
    const finalPath = pending?.finalPath
    if (finalPath) discardPartial(finalPath)
    await clearPending(spaceId, pendingKey).catch(() => {})
    channel.emitCancelled(spaceId, transferId, pendingKey, pending)
    channel.emitUpdated(spaceId)
    return pending
  }

  // Stop + discard an in-flight transfer addressed by its id (the slot carries the
  // spaceId + pending key — the caller need not know them).
  async function cancel (transferId) {
    const tr = registry.get(transferId)
    if (!tr) return false
    await cancelByKey(tr.spaceId, tr.pendingKey, transferId)
    return true
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
    tr.cancelled = true
    tr.restartJob = newJob
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
        channel.emitError(job, ErrorCodes.DOWNLOAD_FAILED)
        channel.emitUpdated(job.spaceId)
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
  // ONE read per inactive row decides its fate: the owner removed it (tombstone) OR re-published
  // it (a new catalog seq — a remove+re-add of even identical content, even one we never saw
  // tombstoned) → terminate the intent; else resume an interrupted/offline download.
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
      const suppressed = pausedHashes.has(transferId) || row.errorCode === ErrorCodes.TRANSFER_CHECKSUM || row.errorCode === ErrorCodes.TRANSFER_DISK_FULL
      if (suppressed && !deep) continue
      const { removed, seq, job } = await channel.resolvePendingRow(spaceId, row)
      if (removed || isRepublished(seq, row.sourceSeq)) {
        await dropRemoved(spaceId, row.filePath, transferId).catch((err) => log.debug('overlay drop-removed failed:', row.filePath, err.message))
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

  return { start, pause, cancel, cancelByKey, resumeForOwner, reconcileOnAppend, dropRemoved, supersede, has, activeSlots: () => registry.entries(), _registry: registry }
}
