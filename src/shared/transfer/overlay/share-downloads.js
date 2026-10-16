// Every consumer download of a share's file runs here, on the one engine OverlayBackend builds: the
// peer-catalog read and append watch, the download entry point and the user verbs. A loose file is the
// LOOSE_SHARE_ID share of its owner (download-job.js). What stays per kind: the audit observer and
// the offline-intent row for a loose file; the mirrored-share refusal and the mirror's append trigger
// for a folder.
import os from 'bare-os'
import path from 'bare-path'
import { collectPeerShare, getPeerEntryState, isPeerCatalogWatched, peerCatalogVersion, resolvePeerCatalog, watchPeerCatalog } from '../../shares/peer-catalog.js'
import { readCatalogKey } from '../../shares/catalog-keys.js'
import { readPeerShareEntry } from '../../shares/shares.js'
import { observePeerCatalog } from '../../audit/peer-records-watch.js'
import { getDownloadDir } from '../../core/paths.js'
import { AppError } from '../../core/errors.js'
import { CODES } from '../../contract/errors.js'
import { getSpace } from '../../spaces/space.js'
import { verifiedMembers } from '../../spaces/member-standing.js'
import { getForeignMount } from '../../folders/mount-store.js'
import { relKeyEscapes } from '../../folders/path-keys.js'
import { checkWindowsSegments } from '../../folders/mount-validate.js'
import { createLogger } from '../../core/logger.js'
import { getPendingFor, recordPendingIntent } from '../pending-transfers.js'
import { pinnedDest, resolveDest, partialAllocatedBytes } from '../download-dest.js'
import { hasDownloadedCopy } from '../files.js'
import { LOOSE_SHARE_ID, looseDrivePath, transferIdFor } from '../transfer-id.js'
import { memberWaits } from '../../network/share-wait.js'
import { SHARE_WAIT_SOURCE } from '../share-wait-set.js'
import { getOverlay } from './overlay-instance.js'
import { createOverlayChannel } from './overlay-channel.js'
import { cancelSpaceOn, reconcileActiveSlots } from './active-transfers.js'
import { preflightFault } from './download-faults.js'
import { LAYOUT, downloadJob, landingRoot, layoutFor, looseShareFor, pendingKeyFor, rowShareFor, slotOwnedBy } from './download-job.js'

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

// The engine's folder probe, which the convergence tick also judges a row's folder by, so a row's
// landing and its verdict read one answer.
const dirExists = (dir) => engine().destProbe(dir).dirExists()

// The destinations every live slot holds, read at resolve time: a name a running transfer is
// writing is taken whether or not its partial exists yet. A job's resolve and its start() are
// synchronous once its row is read, so nothing can resolve the same name in between.
const liveDests = () => ({ has: (abs) => engine().activeDests().includes(abs) })
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
  if (!cat.readable) return { entries: [], complete: true, stalled: false, total: 0, totalBytes: 0 }
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
      destRoot: slot.job.destRoot, layout: slot.job.layout,
    }),
  })
}

// The folder a TREE download lands in under the download root: the share's name as one segment. A
// name that would escape, or a path that is not legal here, is refused rather than flattened: a
// flattened batch would scatter and collide silently. A click decides its layout first (clickLayout).
function assertTreeName(share) {
  if (relKeyEscapes(share.name) || share.name.includes('/')) throw new AppError(CODES.EPATH, 'unsafe folder name: ' + share.name)
}

function treeRel(share, relPath) {
  assertTreeName(share)
  const rel = share.name + '/' + relPath
  checkWindowsSegments(rel.split('/').join(path.sep), os.platform())
  return rel
}

function destRel(share, relPath, layout) {
  return layout === LAYOUT.TREE ? treeRel(share, relPath) : path.basename(relPath)
}

// A click on one file of a folder keeps its place in the folder where this host can hold that path.
// Where it cannot (a folder or subfolder name Windows reserves or forbids, a share name no host can
// use as a folder), the file lands flat by its own name and its row records no tree: one file cannot
// scatter. A batch has no such fallback (destRel refuses the file).
function clickLayout(share, relPath) {
  const layout = layoutFor(share)
  if (layout !== LAYOUT.TREE) return layout
  try {
    treeRel(share, relPath)
    return LAYOUT.TREE
  } catch (err) {
    if (err?.code === CODES.EPATH || err?.code === CODES.MOUNT_FORBIDDEN_WIN_RESERVED) return LAYOUT.FLAT
    throw err
  }
}

// The folder comes from landingRoot; the recorded destination is kept while it sits in that folder.
// A resume keeps the layout the row began with, so a tree download re-driven by a reconcile lands in
// its folder.
async function jobFor({ spaceId, share, relPath, pendingKey, cat, entry, pending, layout, destDir }) {
  pending = pending ?? await getPendingFor(spaceId, pendingKey)
  const kept = pending?.layout === LAYOUT.TREE ? LAYOUT.TREE : layout
  const destRoot = landingRoot({ row: pending, asked: destDir, spaceFolder: getDownloadDir(spaceId), dirExists })
  const reserved = liveDests()
  // The pin first: a resumed tree row keeps its destination even when its share record is no
  // longer readable, and only a fresh resolve needs the share's name.
  const finalPath = pinnedDest(pending?.finalPath, destRoot, reserved) ?? resolveDest(destRoot, destRel(share, relPath, kept), reserved)
  return downloadJob({
    spaceId, share, relPath, pendingKey, keyHex: cat.keyHex, encrypted: cat.encrypted, epoch: cat.epoch, entry,
    finalPath, destRoot, layout: kept, prevFinalPath: pending?.finalPath, prevBytes: pending?.bytesTransferred,
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
  // The row's own layout: a row that carries none was written flat.
  const job = await jobFor({ spaceId, share: found.share, relPath: row.relPath, pendingKey: row.filePath, cat, entry: state, pending: row, layout: LAYOUT.FLAT })
  return { removed: false, seq: state.seq, job }
}

export const downloadChannel = createOverlayChannel({ emit: (name, payload) => ipcRef?.emit(name, payload), resolvePendingRow })

// A loose click the catalog cannot answer yet (owner offline, a read budget spent under reconnect
// churn) is kept as a durable intent row, so the reconnect reconcile owns the retry; with no row
// nothing would retry and the click is lost; recordPendingIntent states which existing row it keeps.
// The share-wait re-drives the row, so it is armed only once the row landed, and a click whose row
// failed is not reported as queued.
async function recordLooseIntent({ spaceId, share, relPath, entry, destDir }) {
  try {
    // PERSISTED: the intent row's fields are what the channel's loose ownsRow and the resolve read.
    const intent = { inPlace: true, shareId: LOOSE_SHARE_ID, relPath, ownerKey: share.owner, total: 0, destDir: destDir || getDownloadDir(spaceId) }
    await recordPendingIntent(spaceId, looseDrivePath(relPath), intent, { folderAsked: !!destDir })
  } catch (err) {
    log.warn('loose download click dropped, its intent row failed:', relPath, err.message)
    return { queued: false }
  }
  if (entry) memberWaits.wait(share.owner, transferIdFor(spaceId, LOOSE_SHARE_ID, relPath), SHARE_WAIT_SOURCE.ROW)
  downloadChannel.emitUpdated(spaceId, LOOSE_SHARE_ID)
  return { queued: true }
}

async function openCatalog(spaceId, share) {
  const cat = await resolvePeerCatalog(spaceId, share)
  if (cat.readable) ensureCatalogWatch(spaceId, share, cat)
  return cat
}

// The answer for one file of a click or a batch, whose pause marker the caller has already
// retired. `express` is a click's lane; a
// batch takes the bulk lane so the concurrency limit holds and the rest read Waiting. Only a
// tombstone means the owner removed the file: a null entry may be an offline owner or replication
// lag, so a loose click still records its intent row for it. A batch hands over the entry it
// already read; a click reads it here.
async function downloadOne(spaceId, share, cat, relPath, { express, destDir, entry = undefined }) {
  const transferId = transferIdFor(spaceId, share.id, relPath)
  if (entry === undefined) entry = cat.readable ? await getPeerEntryState(cat.keyHex, share.id, relPath, { sck: cat.sck }) : null
  if (entry?.removed) return { queued: false }
  if (entry?.contentHash) {
    const layout = express ? clickLayout(share, relPath) : layoutFor(share)
    const job = await jobFor({ spaceId, share, relPath, pendingKey: pendingKeyFor(share, relPath), cat, entry, layout, destDir })
    return engine().start({ ...job, express })
  }
  if (isLoose(share)) return await recordLooseIntent({ spaceId, share, relPath, entry, destDir })
  if (entry) memberWaits.wait(share.owner, transferId, SHARE_WAIT_SOURCE.CLICK)
  return { queued: true }
}

/**
 * The user's download click, and its manual resume. A mirrored share syncs itself, paused or not,
 * so it is refused before the engine is touched: a second copy in the downloads folder would also
 * overwrite the mirror's verified record for the path. A file the owner removed queues nothing.
 * `destDir` is the folder the click names, already validated; absent, see landingRoot.
 * @param {string} spaceId
 * @param {import('./download-job.js').DownloadShare} share
 * @param {string} relPath
 * @param {{ destDir?: string }} [opts]
 * @returns {Promise<import('../../contract/responses.js').ShareDownloadResult>}
 */
export async function requestShareDownload(spaceId, share, relPath, { destDir } = {}) {
  if (!isLoose(share) && await getForeignMount(spaceId, share.id)) return { ok: true, mirrored: true }
  // Retired before any guard or read can fail: a marker left set suppresses every later auto-resume.
  engine().clearPauseMarker(transferIdFor(spaceId, share.id, relPath))
  if (!getOverlay() || !readCatalogKey(share).keyHex) return { queued: true }
  const cat = await openCatalog(spaceId, share)
  return await downloadOne(spaceId, share, cat, relPath, { express: true, destDir })
}

// A batch asks for all its bytes at once, through the same preflight each file runs: each file's
// own preflight sees only itself, so N files that each fit can still fill the disk together, and
// the batch is refused before its first file. The root probe holds no partial, so nothing is
// credited here; what a resumed row's partial already holds was subtracted from `needBytes`. A
// resumed row keeps its own folder, which may be on another volume than `root`: the batch can then
// be refused when it would fit, never the reverse.
function assertBatchFits(root, needBytes) {
  const dest = engine().destProbe(root)
  const code = preflightFault(needBytes, dest)
  if (code) throw new AppError(code, 'batch refused: ' + code, { needBytes, freeBytes: dest.freeBytes(), root })
}

// A start that was refused by its own preflight, or that could not be built at all, is a failure
// the user can act on from the row; a queued one waits on its owner.
function tally(counts, res) {
  if ('transferId' in res) counts.started += 1
  else if ('failed' in res || res.refused) counts.failed += 1
  else if (res.queued) counts.waitingOnOwner += 1
  else counts.removed += 1
}

// One file of a batch. A throw here is that file's failure, never the batch's: the files ahead of
// it have started and the ones behind it still can.
async function downloadBatchFile(spaceId, share, cat, relPath, entry, destDir) {
  try {
    return await downloadOne(spaceId, share, cat, relPath, { express: false, destDir, entry })
  } catch (err) {
    log.warn('batch file could not start:', relPath, '-', err.message)
    return { failed: true }
  }
}

// The files a batch still has to fetch, with the bytes they need. A file is already here when a
// copy of ITS content is on the device: the claim is keyed by name, so the hash is what tells one
// owner's file from another's under the same name, and the check prunes nothing. A row that
// resumes a partial needs only what its partial does not already hold.
async function batchWanted(spaceId, share, cat, relPaths, counts) {
  const wanted = []
  let needBytes = 0
  for (const relPath of relPaths) {
    const pendingKey = pendingKeyFor(share, relPath)
    const entry = cat.readable ? await getPeerEntryState(cat.keyHex, share.id, relPath, { sck: cat.sck }) : null
    if (entry?.contentHash && await hasDownloadedCopy(spaceId, pendingKey, entry.contentHash)) {
      counts.alreadyHere += 1
      continue
    }
    wanted.push({ relPath, entry })
    const pending = await getPendingFor(spaceId, pendingKey)
    const allocated = pending?.finalPath ? partialAllocatedBytes(pending.finalPath) : 0
    needBytes += Math.max(0, (entry?.size || 0) - allocated)
  }
  return { wanted, needBytes }
}

/**
 * A batch download: every file the user selected, in one request. Paths that escape are refused
 * as a whole (a peer's catalog never names one). Files already here are skipped; the rest start on
 * the bulk lane. Free space is checked for the whole batch before the first file starts.
 * @param {string} spaceId
 * @param {import('./download-job.js').DownloadShare} share
 * @param {readonly string[]} relPaths
 * @param {{ destDir?: string }} [opts]
 * @returns {Promise<import('../../contract/responses.js').BatchDownloadResult>}
 */
export async function requestShareDownloads(spaceId, share, relPaths, { destDir } = {}) {
  if (!isLoose(share) && await getForeignMount(spaceId, share.id)) return { mirrored: true }
  if (relPaths.some(relKeyEscapes)) throw new AppError(CODES.EPATH, 'batch download: unsafe path')
  if (!isLoose(share)) assertTreeName(share)
  const counts = { started: 0, alreadyHere: 0, waitingOnOwner: 0, removed: 0, failed: 0 }
  const unique = [...new Set(relPaths)]
  // Every marker first: a batch refused or failed below must not leave a row suppressed.
  for (const relPath of unique) engine().clearPauseMarker(transferIdFor(spaceId, share.id, relPath))
  if (!getOverlay() || !readCatalogKey(share).keyHex) {
    counts.waitingOnOwner = unique.length
    if (isLoose(share)) for (const relPath of unique) await recordLooseIntent({ spaceId, share, relPath, entry: null, destDir })
    return counts
  }
  const cat = await openCatalog(spaceId, share)
  const { wanted, needBytes } = await batchWanted(spaceId, share, cat, unique, counts)
  if (cat.readable) assertBatchFits(destDir || getDownloadDir(spaceId), needBytes)
  for (const { relPath, entry } of wanted) tally(counts, await downloadBatchFile(spaceId, share, cat, relPath, entry, destDir))
  return counts
}

export const pauseShareDownload = (transferId) => engine().pause(transferId)
export const cancelShareDownload = (transferId) => engine().cancel(transferId)
/** @returns {'waiting' | 'active' | null} */
export const shareDownloadPhase = (transferId) => engine().phase(transferId)
export async function cancelSpaceDownloads(spaceId) {
  await cancelSpaceOn(engine(), spaceId, log)
}
