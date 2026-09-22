// The loose consumer side: the peer-catalog listing and watch, and the space-root downloads that
// run on the shared overlay consumer engine (single-flight, real pause/resume, stop/cancel,
// auto-resume), driven by a channel built from the same factory as the folder side. A loose row
// has no file list to surface an error inline in, so every error code crosses the wire.
import path from 'bare-path'
import { collectPeerShare, getPeerEntry, getPeerEntryState, watchPeerCatalog, resolvePeerCatalog } from '../../../shares/peer-catalog.js'
import { observePeerCatalog } from '../../../audit/peer-records-watch.js'
import { getDownloadDir } from '../../../core/paths.js'
import { getSpace } from '../../../spaces/space.js'
import { createLogger } from '../../../core/logger.js'
import { markListIncomplete } from '../../list-deficits.js'
import { getPendingFor, recordPending } from '../../pending-transfers.js'
import { reuseDest } from '../../download-dest.js'
import { LOOSE_SHARE_ID, looseTransferIdFor } from '../../transfer-id.js'
import { memberWaits } from '../../../network/share-wait.js'
import { SHARE_WAIT_SOURCE } from '../../share-wait-set.js'
import { getOverlay } from './overlay-instance.js'
import { createOverlayChannel } from './overlay-channel.js'
import { cancelSpaceOn, reconcileActiveSlots } from './active-transfers.js'
import { looseJob, looseRelPath, looseDrivePath } from './loose-job.js'

const log = createLogger('loose-downloads')

let ipcRef = null
let looseEngine = null

export function initLooseDownloads({ ipc }) { ipcRef = ipc }
export function resetLooseDownloads() { ipcRef = null }
export function setLooseEngine(next) { looseEngine = next }

function engine() {
  if (!looseEngine) throw new Error('loose downloads: not started')
  return looseEngine
}

export async function looseListPeer(spaceId, member, { timeoutMs, space } = {}) {
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
function ensureLooseCatalogWatch(spaceId, member, keyHex, sck) {
  if (!keyHex) return
  const watched = watchPeerCatalog(keyHex, 'loose', (bee) => {
    ipcRef?.emit('event:files-updated', { spaceId })
    // A peer publishing or removing a loose file in a space we share. The append is a bare poke,
    // so the observer diffs the catalog's own history to find what actually changed.
    observePeerCatalog(member.publicKey, spaceId, keyHex, bee, LOOSE_SHARE_ID)
    reconcileActiveLooseTransfers(spaceId, member).catch((err) => log.debug('loose source-change reconcile failed:', err.message))
    // One reconcile pass over our inactive pending rows: tear down downloads for a source the
    // owner tombstoned OR re-published (so a re-add does NOT auto-resume), and re-drive genuinely
    // interrupted ones — the owner may never have disconnected.
    engine().reconcileOnAppend(member.publicKey, spaceId).catch((err) => log.debug('loose catalog-append reconcile failed:', err.message))
  }, sck)
  // Baseline at registration so the peer's existing catalog is adopted, not replayed, and the
  // next file they publish is the first thing recorded.
  if (watched) observePeerCatalog(member.publicKey, spaceId, keyHex, watched, LOOSE_SHARE_ID, { baselineOnly: true })
}

// On an owner-catalog append, re-resolve every active loose transfer from THIS owner.
// If the owner re-published a file under a new contentHash, supersede the stale fetch
// and restart it against the new content from byte 0 (the partial is discarded, so the
// restart job must NOT inherit the old row's prevBytes). The expected-hash guard makes
// the supersede a no-op if the slot completed or was replaced during the awaits above.
async function reconcileActiveLooseTransfers(spaceId, member) {
  const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, member)
  if (!readable) return
  await reconcileActiveSlots({
    engine: engine(),
    spaceId,
    log,
    ownsSlot: (slot) => slot.ownerKey === member.publicKey,
    entryStateFor: (slot) => getPeerEntryState(keyHex, LOOSE_SHARE_ID, looseRelPath(slot.pendingKey), { sck }),
    buildJob: async (slot, state) => {
      const job = await buildLooseJob({ spaceId, member, drivePath: slot.pendingKey, keyHex, sck, entry: state })
      return job ? { ...job, prevBytes: 0 } : null
    },
  })
}

// The destination is re-anchored when the recorded one no longer sits in the space's download
// folder (the user re-pointed the space while this row was paused) — see reuseDest.
async function buildLooseJob({ spaceId, member, drivePath, keyHex, sck, entry, pending }) {
  const relPath = looseRelPath(drivePath)
  entry = entry || await getPeerEntry(keyHex, LOOSE_SHARE_ID, relPath, { sck })
  if (!entry?.contentHash) return null
  pending = pending || await getPendingFor(spaceId, drivePath)
  const finalPath = reuseDest(pending?.finalPath, getDownloadDir(spaceId), path.basename(relPath))
  return looseJob({
    spaceId, ownerKey: member.publicKey, relPath, pendingKey: drivePath, entry,
    finalPath, prevFinalPath: pending?.finalPath, prevBytes: pending?.bytesTransferred,
  })
}

async function resolveLoosePendingRow(spaceId, row) {
  const space = await getSpace(spaceId)
  const member = (space?.members || []).find((m) => m.publicKey === row.ownerKey)
  if (!member) return { removed: false, seq: undefined, job: null }
  const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, member, { space })
  if (!readable) return { removed: false, seq: undefined, job: null }
  // An auto-resumed transfer needs change detection as much as a clicked one.
  ensureLooseCatalogWatch(spaceId, member, keyHex, sck)
  const state = await getPeerEntryState(keyHex, LOOSE_SHARE_ID, row.relPath, { sck })
  if (state?.removed) return { removed: true, seq: undefined, job: null }
  const job = state?.contentHash
    ? await buildLooseJob({ spaceId, member, drivePath: looseDrivePath(row.relPath), keyHex, sck, entry: state, pending: row })
    : null
  return { removed: false, seq: state?.seq, job, awaitingHash: !!state && !state.contentHash }
}

export const looseChannel = createOverlayChannel({
  diagLabel: 'loose download',
  inPlace: true,
  surfaceAllErrors: true,
  updatedEvent: 'event:files-updated',
  emit: (name, payload) => ipcRef?.emit(name, payload),
  decoKeyFor: (job) => job.path,
  decoKeyForRow: (_row, pendingKey) => pendingKey,
  ownsPendingRow: (row) => row.inPlace === true && row.shareId === LOOSE_SHARE_ID,
  pendingExtra: (job) => ({ shareId: LOOSE_SHARE_ID, relPath: job.relPath }),
  transferIdForRow: (spaceId, row) => looseTransferIdFor(spaceId, row.relPath),
  resolvePendingRow: resolveLoosePendingRow,
})

export function looseTransferActive(spaceId, relPath) { return engine().has(looseTransferIdFor(spaceId, relPath)) }

export async function looseDownload(spaceId, member, drivePath) {
  const relPath = looseRelPath(drivePath)
  // This is the manual resume path too, so retire any pause marker up front — start() clears it
  // as well, but the guards below can return before we ever reach start().
  engine().clearPauseMarker(looseTransferIdFor(spaceId, relPath))
  if (!getOverlay() || !(member?.looseCatalogKey || member?.looseCatalogKeyEnc)) return { queued: true }
  const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, member)
  if (readable) ensureLooseCatalogWatch(spaceId, member, keyHex, sck)
  const entry = readable ? await getPeerEntry(keyHex, LOOSE_SHARE_ID, relPath, { sck }) : null
  const job = entry ? await buildLooseJob({ spaceId, member, drivePath, keyHex, sck, entry }) : null
  if (!job) {
    if (entry) memberWaits.wait(member.publicKey, looseTransferIdFor(spaceId, relPath), SHARE_WAIT_SOURCE.ROW)
    // The catalog entry is unreadable right now (owner offline, or the read budget expired under
    // reconnect churn). Record the intent so the reconnect machinery owns the retry: with no row,
    // nothing would ever retry and the click is silently lost.
    await recordPending(spaceId, drivePath, {
      inPlace: true, shareId: LOOSE_SHARE_ID, relPath, ownerKey: member.publicKey, total: 0,
    }).catch((err) => log.debug('loose intent row failed:', relPath, err.message))
    ipcRef?.emit('event:files-updated', { spaceId })
    return { queued: true }
  }
  // The user clicked download: express, so it never queues behind a reconnect backlog.
  return engine().start({ ...job, express: true })
}

export function loosePause(transferId) { return engine().pause(transferId) }
export function looseCancelTransfer(transferId) { return engine().cancel(transferId) }
export function looseCancelByKey(spaceId, drivePath) {
  return engine().cancelByKey(spaceId, drivePath, looseTransferIdFor(spaceId, looseRelPath(drivePath)))
}
export async function looseCancelSpace(spaceId) {
  await cancelSpaceOn(engine(), spaceId, log)
}
export function resumeLooseForOwner(ownerKey, spaceId) { return engine().resumeForOwner(ownerKey, spaceId) }
