// The gated half of a download: past the fetch gate a transfer owns a chunk scheduler, a watchdog,
// an fd and a ticker, which is what the limit exists to bound — and that cost is per fetch, not per
// producer, which is why the gate is process-wide (fetch-gate.js). The engine has already reserved
// the registry slot synchronously, so a queued job reads as active while this waits.
//
// A finished fetch is settled by reading the LIVE slot: a pause, cancel, supersede or republish may
// have landed while the bytes were in flight, and settle-verdict.js ranks those against the result.
// One function per verdict below; the durable order inside `settleDone` is pinned by
// test/integration/download-completion-ordering.
import fs from 'bare-fs'
import path from 'bare-path'
import { acquireFetchSlot } from './fetch-gate.js'
import { makeFetchInstruments } from './fetch-run.js'
import { FETCH_OUTCOME } from './fetch-outcome.js'
import { SETTLE, ABANDON, settleVerdict, abandonReason } from './settle-verdict.js'
import { terminalFault } from './download-faults.js'
import { CODES } from '../../../contract/errors.js'
import { markDownloaded, markVerified } from '../../files.js'
import { clearPending, updatePendingProgress } from '../../pending-transfers.js'
import { recordTransferOutcome } from '../../../audit/transfer-audit.js'

export function createFetchSettle({
  registry, terminalCodes, retries, channel, log,
  fetchImpl, hasOverlay, ownerOnline, destProbeFor, discardPartial, pauseReasonFor,
  recordTerminal, failTerminal, restartAfterSupersede,
}) {
  async function run(slot, job) {
    const releaseSlot = await acquireFetchSlot({ express: !!job.express })
    try {
      // The wait above is unbounded, so every reason the pre-fetch guard checked is re-checked —
      // plus the overlay itself: drainFetchSlots() releases parked waiters so close() is not held
      // open, and they must not then fetch into a torn-down overlay.
      const reason = abandonReason(slot, { ownerOnline, hasOverlay })
      if (reason) { abandon(slot, job, reason); return }
      // Set past the gate so it keeps meaning "a fetch is in flight in the vendor layer", which is
      // what gates every abortFetch.
      slot.fetching = true
      // The overlay scheduler reports CUMULATIVE bytes already seeded with the resumed on-disk
      // bytes, so the ticker needs no resume offset.
      const { diag, callbacks } = makeFetchInstruments({
        label: channel.diagLabel,
        relPath: job.relPath,
        size: job.size,
        contentHash: job.contentHash,
        onProgress: ({ bytes, total, speed, eta }) => {
          channel.emitProgress(job, { bytes, total, speed, eta })
          updatePendingProgress(job.spaceId, job.pendingKey, bytes).catch(() => {})
        },
        onVerify: (fraction) => channel.emitVerifying?.(job, fraction),
      })
      const result = await fetchImpl(job.contentHash, { finalPath: job.finalPath, ...callbacks })
      await settle(job, result, diag)
    } finally {
      releaseSlot()
    }
  }

  function abandon(slot, job, reason) {
    registry.delete(job.transferId)
    if (reason === ABANDON.RESTART) { restartAfterSupersede(slot.restartJob); return }
    if (reason === ABANDON.CANCELLED) return
    channel.emitUpdated(job.spaceId)
  }

  async function settle(job, result, diag) {
    const { transferId } = job
    const slot = registry.get(transferId)
    const verdict = settleVerdict(slot, result)
    if (verdict === SETTLE.PARK) {
      diag.finish(FETCH_OUTCOME.AWAITING_REPUBLISH)
      retries.cancel(transferId)
      releasePark(transferId, slot)
      return
    }
    registry.delete(transferId)
    // Only a code-less stall keeps its retry history; every other outcome ends the intent this
    // record belongs to.
    if (result.ok || result.code) retries.cancel(transferId)
    switch (verdict) {
      case SETTLE.RESTART:
        // The stable transferId's slot is free now, and start() re-reserves it synchronously, so
        // has() never observes a gap.
        diag.finish(FETCH_OUTCOME.SUPERSEDED)
        restartAfterSupersede(slot.restartJob)
        return
      case SETTLE.CANCELLED:
        settleCancelled(job, diag)
        return
      case SETTLE.DISCARDED:
        diag.finish(FETCH_OUTCOME.CANCELLED)
        return
      case SETTLE.PAUSED:
        diag.finish(FETCH_OUTCOME.PAUSED)
        channel.emitUpdated(job.spaceId)
        channel.emitDecorationDone?.(job)
        return
      case SETTLE.STALLED:
        await settleStalled(job, diag)
        return
      case SETTLE.FAILED:
        await settleFailed(job, result, diag)
        return
      default:
        await settleDone(job, diag)
    }
  }

  // The republish park's release: drop every trace of the OLD content (partial, journal, a
  // finalPath the fetch may have completed before the abort) but keep the pending ROW, so status
  // derives 'preparing' and the materialized-hash append restarts it.
  function releasePark(transferId, slot) {
    registry.delete(transferId)
    discardPartial(slot.finalPath)
    try { fs.unlinkSync(slot.finalPath) } catch {}
    updatePendingProgress(slot.spaceId, slot.pendingKey, 0).catch(() => {})
    channel.emitDecorationDone?.(slot.job)
    channel.emitUpdated(slot.spaceId)
  }

  // A cancel raced the fetch to completion. cancelByKey already cleared the row and emitted, so
  // drop any bytes that landed — never re-mark a cancelled file as downloaded — and re-emit: the
  // earlier emit fired while the slot was still registered, so a list read racing the abort could
  // re-derive 'downloading'.
  function settleCancelled(job, diag) {
    diag.finish(FETCH_OUTCOME.CANCELLED)
    try { fs.unlinkSync(job.finalPath) } catch {}
    discardPartial(job.finalPath)
    channel.emitUpdated(job.spaceId)
  }

  // The holder went away or was throttled past the watchdog: keep the partial and the row so the
  // status derives paused and a reconnect or the stall retry re-fetches. `retrying` withholds the
  // OS notification only — the paused emit still fires, because it also terminates the decoration.
  async function settleStalled(job, diag) {
    diag.finish(FETCH_OUTCOME.NO_HOLDER)
    log.debug('overlay fetch interrupted — holder gone or throttled:', job.relPath, 'at', job.prevBytes || 0, 'bytes')
    const retrying = await retries.schedule(job)
    channel.emitPaused?.(job, pauseReasonFor(job), { retrying })
    channel.emitUpdated(job.spaceId)
  }

  async function settleFailed(job, result, diag) {
    diag.finish(FETCH_OUTCOME.FAILED)
    const code = terminalFault(result, destProbeFor(job))
    if (code === CODES.TRANSFER_CHECKSUM) log.warn('overlay integrity failure — holder served bytes that do not match the content hash:', job.relPath)
    else if (code === CODES.TRANSFER_DISK_FULL) log.warn('overlay fetch failed — disk full:', job.relPath)
    else if (code === CODES.TRANSFER_DEST_UNAVAILABLE) log.warn('overlay fetch failed — download folder unavailable:', path.dirname(job.finalPath))
    else log.debug('overlay fetch failed:', job.relPath, '-', result.code)
    await recordTerminal(job, code)
    failTerminal(job, code)
  }

  // Durable positive fact FIRST: a crash inside this window must re-derive 'downloaded', never
  // 'remote' — which would re-download and duplicate the file. The claim decides the status; the
  // row only matters to the resume scan, which drops a claimed row itself, so a failed clear
  // degrades to one extra read at the next reconcile — but it has to be visible.
  async function settleDone(job, diag) {
    diag.finish(FETCH_OUTCOME.DONE)
    terminalCodes.delete(job.transferId)
    await markDownloaded(job.spaceId, job.pendingKey, job.finalPath, { hash: job.contentHash })
    // The verified record fingerprints the bytes the transfer proved rather than whatever sits at
    // the path later; a stat we cannot take costs the record its fingerprint, never its hash.
    let landed = null
    try {
      landed = fs.statSync(job.finalPath)
    } catch (err) {
      log.debug('could not fingerprint a landed download:', job.relPath, '-', err.message)
    }
    await markVerified(job.spaceId, job.verifyKey, job.contentHash, { local: job.finalPath, stat: landed })
    try {
      await clearPending(job.spaceId, job.pendingKey)
    } catch (err) {
      log.warn('could not clear the pending row of a completed download:', job.relPath, '-', err.message)
    }
    channel.emitUpdated(job.spaceId)
    recordTransferOutcome(job, 'ok', null)
    channel.emitComplete(job, job.finalPath)
  }

  return { run, releasePark }
}
