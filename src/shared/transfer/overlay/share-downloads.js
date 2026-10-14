// Every consumer download of a share's file runs here, on the one engine OverlayBackend builds: the
// peer-catalog read and append watch, the download entry point and the user verbs. A loose file is the
// LOOSE_SHARE_ID share of its owner (download-job.js). What stays per kind: the audit observer and
// the offline-intent row for a loose file; the mirrored-share refusal and the mirror's append trigger
// for a folder.
import path from 'bare-path'
import { collectPeerShare, getPeerEntryState, isPeerCatalogWatched, peerCatalogVersion, resolvePeerCatalog, watchPeerCatalog } from '../../shares/peer-catalog.js'
import { readCatalogKey } from '../../shares/catalog-keys.js'
import { readPeerShareEntry } from '../../shares/shares.js'
import { observePeerCatalog } from '../../audit/peer-records-watch.js'
import { getDownloadDir } from '../../core/paths.js'
import { getSpace } from '../../spaces/space.js'
import { verifiedMembers } from '../../spaces/member-standing.js'
import { getForeignMount } from '../../folders/mount-store.js'
import { createLogger } from '../../core/logger.js'
import { getPendingFor, recordPendingIntent } from '../pending-transfers.js'
import { reuseDest } from '../download-dest.js'
import { LOOSE_SHARE_ID, looseDrivePath, transferIdFor } from '../transfer-id.js'
import { memberWaits } from '../../network/share-wait.js'
import { SHARE_WAIT_SOURCE } from '../share-wait-set.js'
import { getOverlay } from './overlay-instance.js'
import { createOverlayChannel } from './overlay-channel.js'
import { cancelSpaceOn, reconcileActiveSlots } from './active-transfers.js'
import { downloadJob, looseShareFor, pendingKeyFor, rowShareFor, slotOwnedBy } from './download-job.js'

const log = createLogger('share-downloads')
const UNRESOLVED = Object.freeze({ removed: false, seq: undefined, job: null })

let ipcRef = null
let downloadEngine = null
// The mirror's prompt-materialize trigger: notified with (spaceId) when an owner's catalog appends,
// so a foreign mirror need not wait for its poll. Fired from folder watches only.
let catalogChangeHook = null

export function initShareDownloads({ ipc }) { ipcRef = ipc }
export function resetShareDownloads() { ipcRef = null }
export function setDownloadEngine(next) { downloadEngine = next }
export function setOverlayCatalogChangeHook(fn) { catalogChangeHook = fn }

function engine() {
  if (!downloadEngine) throw new Error('share downloads: not started')
  return downloadEngine
}

const isLoose = (share) => share.id === LOOSE_SHARE_ID
// One owner's catalog carries every share of that owner in the space, so each share registers its
// own listener on it (watchPeerCatalog fans one append out to all of them).
const catalogWatchId = (shareId) => 'download:' + shareId

function ensureCatalogWatch(spaceId, share, { keyHex, sck }) {
  if (!keyHex) return
  const watched = watchPeerCatalog(keyHex, catalogWatchId(share.id), (bee) => {
    ipcRef?.emit('event:share-files-updated', { spaceId, shareId: share.id })
    // The append is a bare poke, so the audit observer diffs the catalog's own history.
    if (isLoose(share)) observePeerCatalog(share.owner, spaceId, keyHex, bee, LOOSE_SHARE_ID)
    else catalogChangeHook?.(spaceId)
    // The emitter outlives the engine: an append that lands after the overlay closed reaches no engine
    // and does nothing, rather than throwing out of the core's 'append' listener.
    reconcileActiveTransfers(spaceId, share).catch((err) => log.debug('source-change reconcile failed:', err.message))
    // Tears down downloads whose source the owner removed or re-published (a re-add does not
    // auto-resume) and re-drives interrupted ones — the owner may never have disconnected.
    downloadEngine?.reconcileOnAppend(share.owner, spaceId).catch((err) => log.debug('catalog-append reconcile failed:', err.message))
  }, sck)
  // Baseline at registration: the existing catalog is adopted, not replayed.
  if (watched && isLoose(share)) observePeerCatalog(share.owner, spaceId, keyHex, watched, LOOSE_SHARE_ID)
}

// Display read: the capped rows, whether the read was whole (so a listing keeps its last good list
// over a partial read), the true {total, totalBytes} (a `limit` of 0 counts only), and the catalog
// version a complete read saw. `onEach` observes every counted entry regardless of the cap.
export async function listPeerWithMeta(spaceId, share, { limit = Infinity, onEach = null, timeoutMs, space } = {}) {
  const cat = await resolvePeerCatalog(spaceId, share, { space })
  if (!cat.readable) return { entries: [], complete: true, total: 0, totalBytes: 0 }
  ensureCatalogWatch(spaceId, share, cat)
  return await collectPeerShare(cat.keyHex, share.id, { sck: cat.sck, limit, onEach, timeoutMs })
}

// The live catalog version, for a listing deciding whether it may skip the read. Null — read it —
// until this share's append watch is armed: a skip is safe only when the next append pokes the next
// listing, and only a read arms the watch.
export async function watchedCatalogVersion(spaceId, share, { space } = {}) {
  if (!isPeerCatalogWatched(readCatalogKey(share).keyHex, catalogWatchId(share.id))) return null
  return await peerCatalogVersion(spaceId, share, { space })
}

// A re-published entry under an in-flight fetch: supersede it and restart on the new content from
// byte 0, into the destination the slot already holds.
async function reconcileActiveTransfers(spaceId, share) {
  const { keyHex, sck, encrypted, epoch, readable } = await resolvePeerCatalog(spaceId, share)
  const current = downloadEngine
  if (!readable || !current) return
  await reconcileActiveSlots({
    engine: current,
    spaceId,
    log,
    ownsSlot: slotOwnedBy(share),
    entryStateFor: (slot) => getPeerEntryState(keyHex, share.id, slot.job.relPath, { sck }),
    buildJob: (slot, state) => downloadJob({
      spaceId, share, relPath: slot.job.relPath, pendingKey: slot.pendingKey,
      keyHex, encrypted, epoch, entry: state, finalPath: slot.finalPath,
    }),
  })
}

// The destination is re-anchored when the recorded one no longer sits in the space's download
// folder (the user re-pointed it while the row was paused) — see reuseDest.
async function jobFor({ spaceId, share, relPath, pendingKey, cat, entry, pending }) {
  pending = pending ?? await getPendingFor(spaceId, pendingKey)
  const finalPath = reuseDest(pending?.finalPath, getDownloadDir(spaceId), path.basename(relPath))
  return downloadJob({
    spaceId, share, relPath, pendingKey, keyHex: cat.keyHex, encrypted: cat.encrypted, epoch: cat.epoch, entry,
    finalPath, prevFinalPath: pending?.finalPath, prevBytes: pending?.bytesTransferred,
  })
}

/**
 * The loose share of a space member, from the space's verified roster. Keyless when the owner is
 * not a verified member, so a download of it answers queued.
 * @returns {Promise<{ share: import('./download-job.js').DownloadShare, space: object | null, member: object | null }>}
 */
export async function looseShareOfOwner(spaceId, ownerKey) {
  const space = await getSpace(spaceId)
  const member = verifiedMembers(space?.members).find((m) => m.publicKey === ownerKey) ?? null
  return { share: looseShareFor(member), space, member }
}

// The descriptor a persisted row resolves through. A loose row: its owner's roster entry (gone →
// unresolvable). A folder row: the owner's CURRENT record, so a catalog migrated to SCK encryption
// is read under its new key, else the key the row carries. `live` — arm the append watch — holds
// only for a current, untombstoned record. Each row reads afresh: the engine's reconcile hands the
// channel one row at a time with no pass to scope a cache to.
async function shareForRow(spaceId, row) {
  if (row.shareId === LOOSE_SHARE_ID) {
    const { share, space, member } = await looseShareOfOwner(spaceId, row.ownerKey)
    return member ? { share, space, live: true } : null
  }
  const record = await readPeerShareEntry(row.ownerKey, spaceId, row.shareId)
  // The row's owner is authoritative; a record from a build that predates its `owner` field has none.
  if (record) return { share: { ...record, owner: row.ownerKey }, space: undefined, live: !record.deletedAt }
  return { share: rowShareFor(row), space: undefined, live: false }
}

async function resolvePendingRow(spaceId, row) {
  const found = await shareForRow(spaceId, row)
  if (!found) return UNRESOLVED
  const cat = await resolvePeerCatalog(spaceId, found.share, { space: found.space })
  if (!cat.readable) return UNRESOLVED
  // An auto-resumed transfer needs change detection as much as a clicked one.
  if (found.live) ensureCatalogWatch(spaceId, found.share, cat)
  const state = await getPeerEntryState(cat.keyHex, row.shareId, row.relPath, { sck: cat.sck })
  if (state?.removed) return { removed: true, seq: undefined, job: null }
  if (!state?.contentHash) return { removed: false, seq: state?.seq, job: null, awaitingHash: !!state }
  const job = await jobFor({ spaceId, share: found.share, relPath: row.relPath, pendingKey: row.filePath, cat, entry: state, pending: row })
  return { removed: false, seq: state.seq, job }
}

export const downloadChannel = createOverlayChannel({ emit: (name, payload) => ipcRef?.emit(name, payload), resolvePendingRow })

// A loose click the catalog cannot answer yet (owner offline, a read budget spent under reconnect
// churn) is kept as a durable intent row, so the reconnect reconcile owns the retry; with no row
// nothing would retry and the click is lost. A row that already holds progress is kept, so a paused
// download resumes rather than restarting. The share-wait re-drives the row, so it is armed only
// once the row landed, and a click whose row failed is not reported as queued.
async function recordLooseIntent(spaceId, share, relPath, entry) {
  try {
    // PERSISTED: the intent row's fields are what the channel's loose ownsRow and the resolve read.
    await recordPendingIntent(spaceId, looseDrivePath(relPath), { inPlace: true, shareId: LOOSE_SHARE_ID, relPath, ownerKey: share.owner, total: 0 })
  } catch (err) {
    log.warn('loose download click dropped, its intent row failed:', relPath, err.message)
    return { queued: false }
  }
  if (entry) memberWaits.wait(share.owner, transferIdFor(spaceId, LOOSE_SHARE_ID, relPath), SHARE_WAIT_SOURCE.ROW)
  downloadChannel.emitUpdated(spaceId, LOOSE_SHARE_ID)
  return { queued: true }
}

/**
 * The user's download click, and its manual resume. A mirrored share syncs itself, paused or not,
 * so it is refused before the engine is touched: a second copy in the downloads folder would also
 * overwrite the mirror's verified record for the path. A file the owner removed queues nothing.
 * @returns {Promise<import('../../contract/responses.js').ShareDownloadResult>}
 */
export async function requestShareDownload(spaceId, share, relPath) {
  if (!isLoose(share) && await getForeignMount(spaceId, share.id)) return { ok: true, mirrored: true }
  const transferId = transferIdFor(spaceId, share.id, relPath)
  // Retired before any guard can return: a marker left set suppresses every later auto-resume.
  engine().clearPauseMarker(transferId)
  if (!getOverlay() || !readCatalogKey(share).keyHex) return { queued: true }
  const cat = await resolvePeerCatalog(spaceId, share)
  if (cat.readable) ensureCatalogWatch(spaceId, share, cat)
  // Only a tombstone answers "removed": a null entry may be an owner offline or replication lag,
  // which the intent row below waits out.
  const entry = cat.readable ? await getPeerEntryState(cat.keyHex, share.id, relPath, { sck: cat.sck }) : null
  if (entry?.removed) return { queued: false, removed: true }
  if (entry?.contentHash) {
    const job = await jobFor({ spaceId, share, relPath, pendingKey: pendingKeyFor(share, relPath), cat, entry })
    // Express: a click never queues behind a reconnect backlog.
    return engine().start({ ...job, express: true })
  }
  if (isLoose(share)) return await recordLooseIntent(spaceId, share, relPath, entry)
  if (entry) memberWaits.wait(share.owner, transferId, SHARE_WAIT_SOURCE.CLICK)
  return { queued: true }
}

export const pauseShareDownload = (transferId) => engine().pause(transferId)
export const cancelShareDownload = (transferId) => engine().cancel(transferId)
export const hasShareDownload = (transferId) => engine().has(transferId)
export async function cancelSpaceDownloads(spaceId) {
  await cancelSpaceOn(engine(), spaceId, log)
}
