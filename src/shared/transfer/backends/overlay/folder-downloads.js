// The folder share's consumer side: the peer-catalog listing and watch, and the non-mirrored
// folder downloads that run on the shared overlay consumer engine (single-flight, real
// pause/resume, stop/cancel, auto-resume) — the same engine the space-root loose path uses, driven
// by a channel built from the same factory. The pending row carries catalogKey so reconnect-resume
// can re-look-up the entry without a share descriptor.
import path from 'bare-path'
import { shareDecoKey } from '../../../contract/decoration-key.js'
import { catalogKeyField, readCatalogEpoch } from '../../../shares/catalog-keys.js'
import { collectPeerShare, getPeerEntry, getPeerEntryState, watchPeerCatalog, resolvePeerCatalog } from '../../../shares/peer-catalog.js'
import { readPeerShareEntry } from '../../../shares/shares.js'
import { getDownloadDir } from '../../../core/paths.js'
import { getForeignMount } from '../../../folders/mount-store.js'
import { createLogger } from '../../../core/logger.js'
import { getPendingFor } from '../../pending-transfers.js'
import { reuseDest } from '../../download-dest.js'
import { transferIdFor } from '../../transfer-id.js'
import { memberWaits } from '../../../network/share-wait.js'
import { SHARE_WAIT_SOURCE } from '../../share-wait-set.js'
import { getOverlay } from './overlay-instance.js'
import { createOverlayChannel } from './overlay-channel.js'
import { folderJob } from './folder-job.js'
import { cancelSpaceOn, reconcileActiveSlots } from './active-transfers.js'

const log = createLogger('folder-downloads')

let ipcRef = null
let folderEngine = null
// Notified with (spaceId) whenever an owner's catalog appends, so a foreign mirror can
// materialize the change promptly instead of waiting for its poll. (The catalog is the
// only replicated signal of overlay content changes — no drive carries the file bytes.)
let catalogChangeHook = null

export function initFolderDownloads({ ipc }) { ipcRef = ipc }
export function resetFolderDownloads() { ipcRef = null }
export function setFolderEngine(next) { folderEngine = next }
export function setOverlayCatalogChangeHook(fn) { catalogChangeHook = fn }

function engine() {
  if (!folderEngine) throw new Error('folder downloads: not started')
  return folderEngine
}

// Per-share listenerId: the per-(owner,space) catalog is shared by every folder
// share + the loose channel, so each needs its own append reconcile (one fans out).
function ensurePeerCatalogWatch(spaceId, share, keyHex, sck) {
  watchPeerCatalog(keyHex, 'folder:' + share.id, () => {
    ipcRef?.emit('event:files-updated', { spaceId })
    catalogChangeHook?.(spaceId)
    reconcileActiveFolderTransfers(spaceId, share).catch((err) => log.debug('overlay source-change reconcile failed:', err.message))
    // One reconcile pass over our inactive pending rows: tear down downloads for a source the owner
    // tombstoned OR re-published (so a re-add does NOT auto-resume), and re-drive interrupted ones.
    engine().reconcileOnAppend(share.owner, spaceId).catch((err) => log.debug('overlay catalog-append reconcile failed:', err.message))
  }, sck)
}

// Display read: one pass carries the capped rows, the completeness flag (so the renderer
// keeps its last good list on a partial/timed-out peer read instead of blanking), and the
// true {total, totalBytes} (folder-info passes limit=0 to count only). `onEach` observes
// every counted entry regardless of the cap — the space-storage summary sums a mirror's
// verified bytes through it without retaining rows.
export async function folderListPeerWithMeta(spaceId, share, limit = Infinity, onEach = null) {
  const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, share)
  if (!readable) return { entries: [], complete: true, total: 0, totalBytes: 0 }
  ensurePeerCatalogWatch(spaceId, share, keyHex, sck)
  return await collectPeerShare(keyHex, share.id, { sck, limit, onEach })
}

// On an owner-catalog append, re-resolve every active overlay-folder transfer from THIS
// owner/share. If the owner re-published a file under a new contentHash, supersede the
// stale fetch and restart it against the new content (same as the loose path).
async function reconcileActiveFolderTransfers(spaceId, share) {
  const { keyHex, sck, encrypted, epoch, readable } = await resolvePeerCatalog(spaceId, share)
  if (!readable) return
  const prefix = '/' + share.name + '/'
  const relOf = (slot) => slot.pendingKey.slice(prefix.length)
  await reconcileActiveSlots({
    engine: engine(),
    spaceId,
    log,
    ownsSlot: (slot) => slot.ownerKey === share.owner && slot.pendingKey.startsWith(prefix),
    entryStateFor: (slot) => getPeerEntryState(keyHex, share.id, relOf(slot), { sck }),
    buildJob: (slot, state) => folderJob({
      spaceId, share, shareId: share.id, ownerKey: share.owner, relPath: relOf(slot), pendingKey: slot.pendingKey,
      keyHex, encrypted, epoch, entry: state, finalPath: slot.finalPath,
    }),
  })
}

async function resolveFolderPendingRow(spaceId, row) {
  // Prefer the owner's CURRENT share record over the persisted row's key: when an owner
  // migrates its catalog to SCK encryption the catalog key changes (plaintext to encrypted)
  // and the plaintext core is purged, so a row-only resolve would open the dead core.
  // Fall back to the row when the descriptor is unreadable (owner offline).
  const share = await readPeerShareEntry(row.ownerKey, spaceId, row.shareId)
  const { keyHex, sck, encrypted, epoch, readable } = await resolvePeerCatalog(spaceId, share || row)
  if (!readable) return { removed: false, seq: undefined, job: null }
  const state = await getPeerEntryState(keyHex, row.shareId, row.relPath, { sck })
  if (state?.removed) return { removed: true, seq: undefined, job: null }
  if (!state?.contentHash) return { removed: false, seq: state?.seq, job: null, awaitingHash: !!state }
  // Re-anchor to the space's CURRENT download folder: a row pinned before the user re-pointed the
  // space would otherwise resume into the old one.
  const finalPath = reuseDest(row.finalPath, getDownloadDir(spaceId), path.basename(row.relPath))
  return {
    removed: false,
    seq: state.seq,
    job: folderJob({
      spaceId, share, shareId: row.shareId, ownerKey: row.ownerKey, relPath: row.relPath, pendingKey: row.filePath,
      keyHex, encrypted, epoch, entry: state, finalPath, prevFinalPath: row.finalPath, prevBytes: row.bytesTransferred,
    }),
  }
}

// Folder-share progress is DECORATION on the unified 'transfer' channel, keyed shareId:relPath
// (parity with the loose path's per-space path keys). The renderer merges it at render, gated on
// the worker-derived status, so a lingering entry after a missed `done` stays invisible.
export const folderChannel = createOverlayChannel({
  diagLabel: 'overlay download',
  inPlace: false,
  // A folder row surfaces its error inline in the file list (Resume retries), so only the codes no
  // automatic retry can fix cross the wire as a toast + notification.
  surfaceAllErrors: false,
  updatedEvent: 'event:share-files-updated',
  emit: (name, payload) => ipcRef?.emit(name, payload),
  decoKeyFor: (job) => shareDecoKey(job.shareId, job.relPath),
  decoKeyForRow: (row) => (row?.shareId && row?.relPath ? shareDecoKey(row.shareId, row.relPath) : null),
  ownsPendingRow: (row) => row.overlayShare === true,
  pendingExtra: (job) => ({ overlayShare: true, shareId: job.shareId, relPath: job.relPath, ...catalogKeyField(job.catalogKeyEnc || job.catalogKey, !!job.catalogKeyEnc, 'catalogKey', readCatalogEpoch(job)) }),
  transferIdForRow: (spaceId, row) => transferIdFor(spaceId, row.shareId, row.relPath),
  resolvePendingRow: resolveFolderPendingRow,
})

// Consumer single-file download: fetch by contentHash straight from a holder and write to the
// downloads folder. No second copy stored. When the hash is not yet advertised (owner still
// hashing), report queued. A mirrored share syncs itself, paused or not, so it is refused before
// the engine is touched: a second copy in the downloads folder would also overwrite the mirror's
// verified record for the path.
export async function folderRequestDownload(spaceId, share, relPath) {
  if (await getForeignMount(spaceId, share.id)) return { ok: true, mirrored: true }
  // Doubles as the manual resume, so retire any pause marker before the guards below can return
  // early — a marker left set suppresses every later auto-resume for this row.
  engine().clearPauseMarker(transferIdFor(spaceId, share.id, relPath))
  if (!getOverlay()) return { queued: true }
  const { keyHex, sck, encrypted, readable } = await resolvePeerCatalog(spaceId, share)
  if (!readable) return { queued: true }
  const entry = await getPeerEntry(keyHex, share.id, relPath, { sck })
  if (!entry?.contentHash) {
    if (entry) memberWaits.wait(share.owner, transferIdFor(spaceId, share.id, relPath), SHARE_WAIT_SOURCE.CLICK)
    return { queued: true }
  }
  const drivePath = '/' + share.name + '/' + relPath
  const prev = await getPendingFor(spaceId, drivePath)
  const finalPath = reuseDest(prev?.finalPath, getDownloadDir(spaceId), path.basename(relPath))
  return engine().start({
    express: true,
    ...folderJob({
      spaceId, share, shareId: share.id, ownerKey: share.owner, relPath, pendingKey: drivePath,
      keyHex, encrypted, entry, finalPath, prevFinalPath: prev?.finalPath, prevBytes: prev?.bytesTransferred,
    }),
  })
}

export const folderPause = (transferId) => engine().pause(transferId)
export const folderCancel = (transferId) => engine().cancel(transferId)
export async function folderCancelSpace(spaceId) {
  await cancelSpaceOn(engine(), spaceId, log)
}
export const resumeFolderForOwner = (ownerKey, spaceId) => engine().resumeForOwner(ownerKey, spaceId)
export const folderHasTransfer = (transferId) => engine().has(transferId)
