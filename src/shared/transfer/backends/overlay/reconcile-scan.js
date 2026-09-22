// The level-triggered recovery of the engine's INACTIVE pending rows, run when an owner's catalog
// appends or the owner (re)connects. ONE catalog read per row decides its fate through
// republishDecision: a tombstone or a re-add of identical content terminates the intent (a
// deliberate remove+re-add must not auto-resume); a still-mid-rehash null hash holds the row; a
// genuinely new materialized hash restarts on the new content; else an interrupted download resumes.
//
// `deep` is the catalog-APPEND path: the owner is online and its head is present, so paused and
// errored rows are read too, and a deliberate removal terminates them. The RECONNECT path is
// shallow — a manually-paused or terminally-errored row costs zero I/O, because it will not resume
// anyway; its removal is caught on the next append. Both drivers are single-flighted per
// (owner, space) so overlapping pokes cannot stack.
import { isDownloadedFile, isDownloadedWithHash } from '../../files.js'
import { recordPending, clearPending, listPendingForSpace } from '../../pending-transfers.js'
import { republishDecision } from '../../supersede-decision.js'
import { isTerminalFault } from './fetch-policy.js'
import { makeSingleFlightScan } from './single-flight-scan.js'
import { memberWaits } from '../../../network/share-wait.js'
import { SHARE_WAIT_SOURCE } from '../../share-wait-set.js'

export function createReconcile({ registry, pausedHashes, terminalCodes, retries, channel, log, hasOverlay, start, cancelByKey, discardPartial, faultCleared }) {
  async function runReconcile(ownerKey, spaceId, deep) {
    if (!hasOverlay()) return
    for (const row of await listPendingForSpace(spaceId)) {
      if (!channel.ownsPendingRow(row) || row.ownerKey !== ownerKey) continue
      const transferId = channel.transferIdForRow(spaceId, row)
      if (registry.has(transferId)) continue // active → active-transfers.js owns supersede + removal
      const errorCode = row.errorCode ?? terminalCodes.get(transferId)
      const suppressed = pausedHashes.has(transferId) || (isTerminalFault(errorCode) && !faultCleared(errorCode, row))
      if (suppressed && !deep) continue
      if (await clearIfLanded(spaceId, row)) continue
      await reconcileRow(spaceId, row, transferId, suppressed)
    }
  }

  // A completed download whose row outlived its claim (a failed clear, or a crash between the
  // claim and the clear): the file is on disk and claimed, so finish the intent instead of
  // fetching a file we already have — and before the catalog read, which is the expensive step.
  async function clearIfLanded(spaceId, row) {
    if (!await isDownloadedWithHash(spaceId, row.filePath, row.contentHash)) return false
    memberWaits.resolve(channel.transferIdForRow(spaceId, row))
    await clearPending(spaceId, row.filePath).catch((err) => log.warn('could not clear a stale pending row:', row.filePath, '-', err.message))
    return true
  }

  async function reconcileRow(spaceId, row, transferId, suppressed) {
    const { removed, seq, job, awaitingHash } = await channel.resolvePendingRow(spaceId, row)
    const decision = republishDecision(row.contentHash, { removed, seq, contentHash: job?.contentHash ?? null }, row.sourceSeq)
    if (decision === 'drop') {
      await dropRemoved(spaceId, row.filePath, transferId).catch((err) => log.warn('overlay drop-removed failed:', row.filePath, '-', err.message))
      return
    }
    // The owner is still hashing. A paused or terminal row is not waiting for anything.
    if (awaitingHash && !suppressed) memberWaits.wait(row.ownerKey, transferId, SHARE_WAIT_SOURCE.ROW)
    // Mid-rehash: setMaterializedHash is a second append that re-runs this scan with the real hash.
    if (decision === 'pending') return
    if (decision === 'restart') { await restartOnRepublished(spaceId, row, job, transferId); return }
    if (suppressed) return // live + same source → keep the manual pause / terminal error
    if (job) start(job).catch((err) => log.debug('overlay auto-resume failed:', row.filePath, err.message))
  }

  // The source changed while this download was inactive. The partial holds the OLD content's
  // bytes, which can never verify against the new hash — reset to zero and re-point the row at
  // the new version so any resume starts clean. A prior terminal errorCode belonged to the old
  // content, so it goes too; a manual pause is the user's intent and stays — the cleared row
  // resumes on the new content when they hit Resume, not automatically.
  async function restartOnRepublished(spaceId, row, job, transferId) {
    discardPartial(job.finalPath)
    retries.cancel(transferId)
    const { errorCode: _priorCode, erroredAt: _priorAt, ...cleanRow } = row
    try {
      await recordPending(spaceId, row.filePath, { ...cleanRow, sourceSeq: job.sourceSeq, contentHash: job.contentHash, bytesTransferred: 0 })
    } catch (err) {
      // The row still names the old hash, so the next scan derives a restart again and retries
      // this write; starting now would fail the same write inside start().
      log.warn('could not re-point the pending row at the republished content:', row.filePath, '-', err.message)
      return
    }
    terminalCodes.delete(transferId)
    if (pausedHashes.has(transferId)) return
    // One continuous "the file was updated, re-downloading", whether the change was caught here
    // or by the active-slot reconcile's supersede().
    channel.emitSuperseded?.(job)
    start({ ...job, prevBytes: 0 }).catch((err) => log.debug('overlay republish-restart failed:', row.filePath, err.message))
  }

  // Teardown for a deliberately removed or re-published source: the same mechanics as a user
  // discard, then a signal so the renderer can tell the user why the download stopped. A download
  // that COMPLETED under the reconcile's read window is left alone — it is genuinely on disk.
  async function dropRemoved(spaceId, pendingKey, transferId) {
    if (await isDownloadedFile(spaceId, pendingKey)) return
    const pending = await cancelByKey(spaceId, pendingKey, transferId)
    if (pending) channel.emitRemovedByOwner?.(spaceId, pendingKey, pending, transferId)
  }

  const pokeResume = makeSingleFlightScan((ownerKey, spaceId) => runReconcile(ownerKey, spaceId, false), log)
  const pokeAppend = makeSingleFlightScan((ownerKey, spaceId) => runReconcile(ownerKey, spaceId, true), log)

  return {
    resumeForOwner: async (ownerKey, spaceId) => { pokeResume(ownerKey, spaceId) },
    reconcileOnAppend: async (ownerKey, spaceId) => { pokeAppend(ownerKey, spaceId) },
    dropRemoved,
  }
}
