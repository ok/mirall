// How a download begins: reserve the slot synchronously, record the durable row, re-check the
// intents that landed during that write, refuse what the destination cannot take, then hand the
// slot to the fetch task. The supersede restart lives here too, because it is a start whose
// outcome must be resolved for the UI.
import fs from 'bare-fs'
import path from 'bare-path'
import { recordPending } from '../pending-transfers.js'
import { fetchClaimedBy } from './fetch-gate.js'
import { abandonReason, ABANDON } from './settle-verdict.js'
import { preflightFault } from './download-faults.js'
import { LAYOUT } from './download-job.js'
import { CODES } from '../../contract/errors.js'
import { memberWaits } from '../../network/share-wait.js'
import { noteLandedFolders } from '../../core/paths.js'

// A download's slot IS its registry entry: start() reserves it before any await, so a duplicate
// trigger cannot open a second fetch on the same hash; the fetch task holds it; settling deletes
// it. `fetching` means a fetch is in flight in the engine — it gates every abort, so an
// abort only reaches the engine once there is something to abort. `waiting` means the slot is
// parked behind the fetch gate, which the listing reads as the Waiting status.
export function makeSlot(job) {
  return {
    job,
    contentHash: job.contentHash,
    finalPath: job.finalPath,
    spaceId: job.spaceId,
    pendingKey: job.pendingKey,
    ownerKey: job.ownerKey,
    sourceSeq: job.sourceSeq,
    paused: false,
    cancelled: false,
    waiting: false,
    fetching: false,
    republishing: false,
    restartJob: null,
  }
}

export function createStart({
  registry, pausedHashes, channel, log, hasOverlay, ownerOnline, destProbeFor,
  pauseReasonFor, recordTerminal, failTerminal, runFetch,
}) {
  // PERSISTED: `layout` is written only for a TREE job; a flat row carries no layout field.
  // `destDir` is the download folder the row lands under, which a resume keeps.
  const pendingRowFor = (job) => ({
    total: job.size, ownerKey: job.ownerKey,
    finalPath: job.finalPath, destDir: job.destRoot, sourceSeq: job.sourceSeq, contentHash: job.contentHash,
    bytesTransferred: job.prevBytes || 0, ...channel.pendingExtra(job),
    ...(job.layout === LAYOUT.TREE ? { layout: LAYOUT.TREE } : {}),
  })

  async function start(job) {
    if (!hasOverlay() || !job.contentHash) return { queued: true }
    const { transferId } = job
    memberWaits.resolve(transferId)
    pausedHashes.supersede(transferId)
    const existing = registry.get(transferId)
    if (existing) return { transferId, finalPath: existing.finalPath }
    const holder = fetchClaimedBy(transferId)
    if (holder) return attachToHolder(job, holder)

    const slot = makeSlot(job)
    registry.set(transferId, slot)
    try {
      // The row up front (carrying ownerKey + the content hash it is fetching) is what lets the
      // download survive an owner-offline gap and lets a later reconcile tell a re-added-identical
      // entry from changed content. recordPending OVERWRITES the row, so the resumed byte count is
      // carried through explicitly: a start() that then bails would otherwise zero it.
      await recordPending(job.spaceId, job.pendingKey, pendingRowFor(job))
      noteLandedFolders([job.destRoot])
      const reason = abandonReason(slot, { ownerOnline })
      if (reason) return bailBeforeFetch(slot, job, reason)
      // A TREE job's probe asks about the download root; its own folders are created under it once
      // the root is known to exist, so a deleted root is refused rather than recreated.
      const fault = preflightFault(job.size, destProbeFor(job))
      if (fault) return refuse(job, fault)
      if (job.layout === LAYOUT.TREE) await fs.promises.mkdir(path.dirname(job.finalPath), { recursive: true })
      // Flip the row to 'downloading' immediately: emitUpdated re-derives the list (the engine
      // holds the slot from here, admitted or queued), emitProgress seeds the bar before the
      // first byte. Status derives from the registry slot, not from `fetching`.
      channel.emitProgress(job, { bytes: job.prevBytes || 0, total: job.size, speed: 0, eta: null })
      channel.emitUpdated(job.spaceId, job.shareId)
      runFetch(slot, job)
        .catch((err) => log.warn('overlay download task failed after the fetch settled:', job.relPath, '-', err.message))
      return { transferId, finalPath: job.finalPath }
    } catch (err) {
      registry.delete(transferId) // release the reserved slot if a pre-fetch read threw
      throw err
    }
  }

  // A producer with no registry of its own — the mirror — may already be fetching this content.
  // Attach to it rather than starting a second fetch: both write the same decoration key, so the
  // user sees the bar that is already moving. The row is still recorded, so the next reconcile
  // re-drives this destination once the claim frees (the mirror writes into the mount, not the
  // download folder).
  async function attachToHolder(job, holder) {
    await recordPending(job.spaceId, job.pendingKey, pendingRowFor(job))
    log.debug('overlay download attached to an in-flight', holder, 'fetch:', job.relPath)
    channel.emitUpdated(job.spaceId, job.shareId)
    return { transferId: job.transferId, finalPath: job.finalPath }
  }

  // A supersede restarts on the new hash; a plain cancel just drops (cancelByKey already cleared
  // the row + emitted); a pause or an owner gone offline leaves the row for the reconcile.
  function bailBeforeFetch(slot, job, reason) {
    registry.delete(job.transferId)
    if (reason === ABANDON.RESTART) {
      const restartJob = slot.restartJob
      restartAfterSupersede(restartJob)
      return { transferId: job.transferId, finalPath: restartJob.finalPath }
    }
    if (reason === ABANDON.CANCELLED) return { queued: true }
    if (reason === ABANDON.OFFLINE) log.debug('overlay download queued — owner not present on the control plane:', job.relPath)
    channel.emitUpdated(job.spaceId, job.shareId)
    return { queued: true }
  }

  async function refuse(job, code) {
    registry.delete(job.transferId)
    if (code === CODES.TRANSFER_DISK_FULL) log.warn('overlay download refused — not enough free disk space:', job.relPath, 'needs', job.size, 'bytes')
    else log.warn('overlay download refused — download folder unavailable:', path.dirname(job.finalPath))
    await recordTerminal(job, code, { refusedByPreflight: true })
    failTerminal(job, code)
    return { queued: true, refused: true }
  }

  // Resolve a supersede restart's outcome so the UI never sticks on "restarting": a fetch that
  // begins drives its own events, one that can't start (owner went offline → queued) surfaces as
  // paused-offline, and one that throws surfaces as an error.
  function restartAfterSupersede(job) {
    start(job).then(
      (res) => { if (res && res.queued) channel.emitPaused?.(job, pauseReasonFor(job)) },
      (err) => {
        log.debug('overlay supersede-restart failed:', err.message)
        failTerminal(job, CODES.DOWNLOAD_FAILED)
      },
    )
  }

  return { start, restartAfterSupersede }
}
