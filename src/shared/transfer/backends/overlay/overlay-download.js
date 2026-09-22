// One overlay consumer download engine, shared by space-root loose files and (non-mirrored)
// overlay folder shares. The two differ only in event names, transferId scheme, catalog lookup,
// ownerKey, and pending-row key/marker — all injected via a `channel` (overlay-channel.js). The
// engine owns: single-flight, real pause/resume (continue a partial), stop/cancel + discard, and
// auto-resume on owner reconnect.
//
// This file is the root: the registry, the memories that outlive a slot, the user verbs and the
// wiring. How a download begins is download-start.js; what a finished fetch means is
// fetch-settle.js; what an inactive row does on a reconnect or an append is reconcile-scan.js;
// which ErrorCode a refusal gets is download-faults.js; the precedence rules are
// settle-verdict.js. The last two are pure.
import fs from 'bare-fs'
import path from 'bare-path'
import { getOverlay, getJournalDir } from './overlay-instance.js'
import { journalNameFor } from './vendor/transfer.js'
import { PARTIAL_SUFFIX, partialPathFor } from '../../partial-suffix.js'
import { isOwnerOnline } from '../../../network/presence-leases.js'
import { clearPending, recordPendingError, getPendingFor, listPendingForSpace } from '../../pending-transfers.js'
import { createPausedHolders } from './paused-holders.js'
import { recordTransferOutcome } from '../../../audit/transfer-audit.js'
import { pauseReasonFor as ownerPauseReason } from '../../transfer-status.js'
import { createStallRetry } from './stall-retry.js'
import { createLogger } from '../../../core/logger.js'
import { isTerminalFault } from './fetch-policy.js'
import { freeBytesFor } from '../../free-space-probe.js'
import { createStart } from './download-start.js'
import { createFetchSettle } from './fetch-settle.js'
import { createReconcile } from './reconcile-scan.js'
import { memberWaits } from '../../../network/share-wait.js'
import { faultAwaitsOwner, faultCleared } from './download-faults.js'

const log = createLogger('overlay-download')

// The engine's default fetch: pull by content hash to finalPath, no second copy, integrity-verified
// during the transfer. A local hit returns the source path → copy it to finalPath so the download
// is real. Returns { ok:true } | { ok:false, code, cause? } (EHASHMISMATCH or an error message,
// cause = the underlying Error for classification) | { ok:false } (no holder).
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

// Anything other than a live directory — missing, or a plain file sitting where the folder
// belongs — reads as unavailable.
function defaultDirExists(dir) {
  try { return fs.statSync(dir).isDirectory() } catch { return false }
}

// Whether a file can be created in the folder. Only a refusal counts: any other failure is not
// evidence the folder is read-only. The probe carries the partial suffix, so the boot sweep reclaims
// one a crash left behind.
function defaultDirWritable(dir) {
  const probe = path.join(dir, '.mirall-write-probe' + PARTIAL_SUFFIX)
  try {
    fs.closeSync(fs.openSync(probe, 'wx'))
    fs.unlinkSync(probe)
    return true
  } catch (err) {
    return !['EACCES', 'EPERM', 'EROFS'].includes(err?.code)
  }
}

// Whether a file can be created in the folder, believed only when one actually is: a folder that is
// gone or unreadable has not been fixed.
function defaultDirAcceptsWrite(dir) {
  const probe = path.join(dir, '.mirall-write-probe' + PARTIAL_SUFFIX)
  try {
    fs.closeSync(fs.openSync(probe, 'w'))
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

// The stalled-owner rescue asks on every convergence tick, and each probe is a synchronous
// create/delete in the user's folder, so it reads a verdict at most this old.
const FOLDER_VERDICT_TTL_MS = 60_000

// The two questions the convergence tick asks about a row, both answered from the kept folder
// verdict: whether the stalled-owner rescue should keep reaching for its owner (a manual pause and
// a fault only the user can clear wait on the user, not the owner), and whether the user has since
// cleared that fault, which is the tick's cue to re-drive the row through the reconcile. A cleared
// row is handed out once: a re-drive the reconcile could not start (a member gone from the roster,
// a catalog it cannot read) is not repeated every tick, and the reconnect and catalog-append paths
// still reach the row. The owner gate is the one start() reads, so a re-drive cannot rewrite the
// row only to park it as owner-offline. The reconcile's own faultCleared probes the folder afresh.
function createOwnerWait({ channel, registry, pausedHashes, terminalCodes, ownerOnline, dirAcceptsWrite, now }) {
  const folderVerdicts = new Map() // dir -> { writable, at }
  function probeFolder(finalPath) {
    const dir = path.dirname(finalPath)
    const writable = dirAcceptsWrite(dir)
    folderVerdicts.set(dir, { writable, at: now() })
    return writable
  }
  function keptFolderVerdict(finalPath) {
    const kept = folderVerdicts.get(path.dirname(finalPath))
    return kept && now() - kept.at < FOLDER_VERDICT_TTL_MS ? kept.writable : probeFolder(finalPath)
  }
  function faultOf(row) {
    if (!channel.ownsPendingRow(row)) return null
    const transferId = channel.transferIdForRow(row.spaceId, row)
    if (pausedHashes.has(transferId)) return null
    return { transferId, code: row.errorCode ?? terminalCodes.get(transferId) }
  }
  function awaitsOwner(row) {
    const fault = faultOf(row)
    return !!fault && faultAwaitsOwner(fault.code, row.finalPath, keptFolderVerdict)
  }
  const redriven = new Set() // transferIds handed to the tick, until their fault is no longer cleared
  // An active row waits on nothing: the fetch the last re-drive started owns it.
  function takeUnblocked(row) {
    const fault = faultOf(row)
    if (!fault) return false
    if (registry.has(fault.transferId) || !faultCleared(fault.code, row.finalPath, keptFolderVerdict)) {
      redriven.delete(fault.transferId)
      return false
    }
    if (!ownerOnline(row.ownerKey) || redriven.has(fault.transferId)) return false
    redriven.add(fault.transferId)
    return true
  }
  return { awaitsOwner, takeUnblocked, faultCleared: (code, row) => faultCleared(code, row.finalPath, probeFolder) }
}

function partialAllocatedBytes(finalPath) {
  try { return fs.statSync(partialPathFor(finalPath)).blocks * 512 || 0 } catch { return 0 }
}

// Remove a partial + its app-private journal by destination path, independent of whether the
// overlay singleton is currently live (cancel/discard can race startup or teardown).
function discardPartial(finalPath) {
  try { fs.unlinkSync(partialPathFor(finalPath)) } catch {}
  const jd = getJournalDir()
  if (jd) { try { fs.unlinkSync(path.join(jd, journalNameFor(finalPath))) } catch {} }
}

// The one place an abort reaches the vendor, and only once a fetch is in flight there.
function abortFetch(slot, opts) {
  if (slot.fetching) getOverlay()?.cancelFetch(slot.contentHash, opts)
}

// job: { spaceId, pendingKey, path, relPath, transferId, contentHash, size, sourceSeq, ownerKey,
//        verifyKey, finalPath, prevBytes, ...channel-specific } — built by folder-job.js and
// loose-overlay.js.
//
// Three memories deliberately outlive the slot: pausedHashes (the user's pause), terminalCodes
// (a terminal verdict whose durable write failed) and the stall retries (a retry in flight); the
// fourth is the durable pending row. The durable-write policy is not uniform — the table is in
// solution-architecture.md under pause / resume transfers.
export function createOverlayDownloadEngine(channel, { fetchImpl = fetchContentToFile, hasOverlay = () => !!getOverlay(), freeBytes = freeBytesFor, stallRetry = {}, dirExists = defaultDirExists, dirWritable = defaultDirWritable, dirAcceptsWrite = defaultDirAcceptsWrite, now = Date.now } = {}) {
  const registry = new Map() // transferId -> slot (download-start.js makeSlot)
  // The marker is the user's intent — it outranks every automatic resume — and its hash lets a
  // later discard still tell the holder we stopped.
  const pausedHashes = createPausedHolders({ notifyStopped: (hash) => getOverlay()?.notifyTransferStopped(hash) })
  // transferId -> ErrorCode for a terminal failure (isTerminalFault) whose durable write FAILED.
  // The row is the only thing that keeps a terminal row out of the next re-drive; when it cannot
  // be written, this keeps the verdict for the life of the process. Cleared by the same three
  // things that clear a durable errorCode: the user's Resume click, a discard, and a restart on
  // republished content.
  const terminalCodes = new Map()

  const ownerOnline = (pk) => (channel.isOwnerOnline ?? isOwnerOnline)(pk)
  const pauseReasonFor = (job) => ownerPauseReason(ownerOnline(job.ownerKey))
  const destProbeFor = (job) => {
    const dir = path.dirname(job.finalPath)
    return {
      dirExists: () => dirExists(dir),
      dirWritable: () => dirWritable(dir),
      freeBytes: () => freeBytes(dir),
      allocatedBytes: () => partialAllocatedBytes(job.finalPath),
    }
  }

  // Never throws: the caller still emits the error (the transfer DID fail); the warn adds that the
  // failure is not durable. Only the codes isTerminalFault names are remembered — anything else
  // would grow the map for the life of the worker without ever being read.
  async function recordTerminal(job, code) {
    try {
      await recordPendingError(job.spaceId, job.pendingKey, code)
      terminalCodes.delete(job.transferId)
    } catch (err) {
      if (isTerminalFault(code)) terminalCodes.set(job.transferId, code)
      log.warn('could not persist the transfer error — auto-resume is suppressed only until restart:', job.relPath, code, '-', err.message)
    }
  }

  // The single terminal-failure exit, so the audit row cannot depend on which channel is driving.
  // recordTerminal stays at its call sites: the supersede-restart deliberately does not await it.
  function failTerminal(job, code) {
    recordTransferOutcome(job, 'error', code)
    channel.emitError(job, code)
    channel.emitUpdated(job.spaceId)
  }

  // One timer per stalled transfer, cleared on pause, cancel, supersede and teardown. pokeResume
  // is taken by reference because the reconcile is built below this.
  const retries = createStallRetry({
    registry,
    pausedHashes,
    ownerOnline,
    channel,
    pokeResume: (ownerKey, spaceId) => reconcile.resumeForOwner(ownerKey, spaceId),
    getPendingFor,
    pauseReasonFor,
    log,
    opts: stallRetry,
  })

  // A deliberate Resume/download click, or a discard, ends every automatic memory of the transfer:
  // an inherited dry counter would park the click after one try, a kept marker would suppress
  // every later auto-resume.
  function forgetIntent(transferId) {
    pausedHashes.supersede(transferId)
    terminalCodes.delete(transferId)
    retries.cancel(transferId)
  }

  const settle = createFetchSettle({
    registry, terminalCodes, retries, channel, log,
    fetchImpl, hasOverlay, ownerOnline, destProbeFor, discardPartial, pauseReasonFor,
    recordTerminal, failTerminal, restartAfterSupersede: (job) => starter.restartAfterSupersede(job),
  })
  const starter = createStart({
    registry, pausedHashes, channel, log, hasOverlay, ownerOnline, destProbeFor,
    pauseReasonFor, recordTerminal, failTerminal, runFetch: settle.run,
  })
  const ownerWait = createOwnerWait({ channel, registry, pausedHashes, terminalCodes, ownerOnline, dirAcceptsWrite, now })
  const reconcile = createReconcile({
    registry, pausedHashes, terminalCodes, retries, channel, log, hasOverlay, start: starter.start, cancelByKey, discardPartial, faultCleared: ownerWait.faultCleared,
  })

  // The owner re-published this source (advertise with a null hash → hash → setMaterializedHash)
  // and cannot serve the OLD content in between, so the in-flight fetch is doomed: abort it
  // WITHOUT a terminal event and release the slot to the pending row — files.js derives
  // 'preparing' / 'unavailable' from the null-hash head, and the materialized-hash append restarts
  // the download via the reconcile, however long the re-hash takes. A user pause/cancel or a
  // supersede that already claimed the slot outranks this.
  function releaseForRepublish(transferId) {
    const slot = registry.get(transferId)
    if (!slot || slot.cancelled || slot.paused || slot.restartJob || slot.republishing) return false
    slot.republishing = true
    log.debug('overlay download parked — owner is re-hashing the source:', slot.job.relPath)
    if (slot.fetching) abortFetch(slot, { discardPartial: true, signal: false })
    else settle.releasePark(transferId, slot) // no fetch to settle it → release now
    return true
  }

  // Stop the fetch but KEEP the partial + pending row so a later start() resumes it. With no
  // slot the fetch already settled (a dropped connection beat the click) — the row is still
  // pending, so record the intent anyway: without the marker the next reconnect auto-resumes a
  // download the user just paused.
  function pause(transferId) {
    const slot = registry.get(transferId)
    retries.cancel(transferId)
    memberWaits.cancel(transferId)
    if (!slot) { pausedHashes.remember(transferId, null); return true }
    slot.paused = true
    pausedHashes.remember(transferId, slot.contentHash) // so a later discard can signal STOPPED
    abortFetch(slot, { discardPartial: false })
    return true
  }

  // A user's explicit download/resume click outranks a manual-pause marker. Cleared HERE rather
  // than only in start(), because an attempt that dies before start() (an unreadable catalog, an
  // owner that just went offline) would otherwise leave the marker set — and a set marker makes
  // the reconcile skip the row as "manually paused" forever.
  function clearPauseMarker(transferId) {
    forgetIntent(transferId)
  }

  // Discard: stop + drop the partial + pending row. Works in-flight (the slot is left for the
  // fetch task to honor `cancelled`) and on a paused/restart-orphaned row (no slot; partial
  // resolved from the pending finalPath).
  async function cancelByKey(spaceId, pendingKey, transferId) {
    memberWaits.cancel(transferId)
    const slot = registry.get(transferId)
    const pending = await getPendingFor(spaceId, pendingKey)
    if (slot) {
      slot.cancelled = true
      abortFetch(slot, { discardPartial: true })
    } else {
      // The slot is gone but the holder still shows us paused: tell it we stopped.
      pausedHashes.notify(transferId)
    }
    retries.cancel(transferId)
    // The durable row FIRST. Everything after it is destructive and in-memory-only, so a failed
    // clear must not leave the row alive with its partial deleted and its manual-pause marker
    // dropped — that combination auto-resumes from zero a transfer the user paused and discarded.
    try {
      await clearPending(spaceId, pendingKey)
    } catch (err) {
      log.warn('could not clear the pending row on discard:', pendingKey, '-', err.message)
      channel.emitUpdated(spaceId)
      throw err
    }
    forgetIntent(transferId)
    const finalPath = pending?.finalPath
    if (finalPath) discardPartial(finalPath)
    channel.emitCancelled(spaceId, transferId, pendingKey, pending)
    channel.emitUpdated(spaceId)
    return pending
  }

  // Stop + discard a transfer addressed by its id alone. A live slot carries the spaceId +
  // pending key; with none the fetch already settled, so resolve them from the pending ROW — the
  // id names the row but cannot rebuild a folder pendingKey, which embeds the share NAME the id
  // does not carry. A folder click on an unhashed file leaves only a wait; false when none exist.
  async function cancel(transferId) {
    const slot = registry.get(transferId)
    if (slot) {
      await cancelByKey(slot.spaceId, slot.pendingKey, transferId)
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
    return memberWaits.cancel(transferId)
  }

  // The source file changed under an in-flight transfer. Abort the stale fetch + discard the
  // partial, then restart against the new contentHash from byte 0 — WITHOUT a terminal event, so
  // the UI shows a continuous "restarting". The restart runs from the aborted fetch's settle (or
  // start()'s pre-fetch guard), so the stable transferId is never reused while the old fetch is
  // still settling. expectedHash guards the read-decide-supersede gap: if the slot completed or
  // was replaced during the caller's awaits, the supersede is a no-op.
  function supersede(transferId, newJob, expectedHash) {
    const slot = registry.get(transferId)
    if (!slot || !newJob) return false
    if (expectedHash !== undefined && slot.contentHash !== expectedHash) return false
    // restartJob outranks a republish-park (settle-verdict.js), so a supersede that lands while
    // the slot is parking still restarts on the new hash.
    slot.cancelled = true
    // The new job is rebuilt from the catalog, so carry the lane the original was admitted on: a
    // supersede is not the user changing their mind about how urgent this download is.
    slot.restartJob = { ...newJob, express: newJob.express ?? slot.job?.express }
    // signal:false — a system-initiated restart on a new hash, not a user stop. The restart's
    // content-request re-establishes the holder's serve row on the same path, so STOPPED would
    // only blink the downloader's avatar off.
    abortFetch(slot, { discardPartial: true, signal: false })
    channel.emitSuperseded?.(newJob)
    return true
  }

  return {
    start: starter.start,
    pause,
    clearPauseMarker,
    cancel,
    cancelByKey,
    resumeForOwner: reconcile.resumeForOwner,
    reconcileOnAppend: reconcile.reconcileOnAppend,
    dropRemoved: reconcile.dropRemoved,
    supersede,
    releaseForRepublish,
    has: (transferId) => registry.has(transferId),
    awaitsOwner: ownerWait.awaitsOwner,
    takeUnblocked: ownerWait.takeUnblocked,
    activeSlots: () => registry.entries(),
    // test seam
    _registry: registry,
    _stallRetries: retries.records,
  }
}
