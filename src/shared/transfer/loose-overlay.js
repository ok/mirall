// In-place loose files: the loose-file primitive served through the overlay
// instance instead of copied into the per-space drive. A reserved share id groups
// loose entries in the per-(owner,space) catalog; the bytes stay at the user's
// original file on disk, resolved per file via the source map (not a mount root).
// The publish/fetch cores live in overlay-backend.js and are shared with folder
// shares — this module is the loose-specific glue (source map, watch, cap, naming).
import path from 'bare-path'
import { getOverlay } from './backends/overlay/overlay-instance.js'
import { publishContent, broadcastSharePrepare, evictIfUnreferenced, makeServable } from './backends/overlay/overlay-backend.js'
import {
  tombstone as catalogTombstone, getOwnEntry, listOwnShare, listOwnShareForDisplay, collectPeerShare, getPeerEntry, getPeerEntryState, watchPeerCatalog, resolvePeerCatalog,
} from '../shares/share-catalog.js'
import { markListIncomplete } from './list-deficits.js'
import { markOwnedSource, getOwnedSourcePath, clearOwnedSource } from './files.js'
import { getPendingFor, recordPending } from './pending-transfers.js'
import { reuseDest } from './download-dest.js'
import { observePeerCatalog } from '../audit/peer-watch.js'
import { getDownloadDir } from '../core/paths.js'
import { listSpaces, getSpace } from '../spaces/space.js'
import { makeProgressTicker } from './progress-ticker.js'
import { nextFreeName } from '../folders/path-keys.js'
import { AppError, ErrorCodes } from '../core/errors.js'
import { createKeyedLock } from '../core/keyed-lock.js'
import { getPublishScheduler, registerPublishChannel } from '../folders/publish-service.js'
import { OP, PRIORITY } from '../folders/work-item.js'
import { fileStatPresent, statFacts } from '../folders/disk-presence.js'
import { createLogger } from '../core/logger.js'
import { supersedeDecision, republishDecision } from './supersede-decision.js'
import { LOOSE_SHARE_ID, looseTransferIdFor } from './transfer-id.js'

const log = createLogger('loose-overlay')

export { LOOSE_SHARE_ID }
export const MAX_LOOSE_FILES_PER_SPACE = 100

// abs source path -> (spaceId -> relPath). The same file can be shared in several
// spaces, so a watcher event must fan out to every space that holds it.
export const looseSources = new Map()

function trackSource (abs, spaceId, relPath) {
  let m = looseSources.get(abs)
  if (!m) looseSources.set(abs, (m = new Map()))
  m.set(spaceId, relPath)
}
function untrackSource (abs, spaceId) {
  const m = looseSources.get(abs)
  if (!m) return
  m.delete(spaceId)
  if (m.size === 0) looseSources.delete(abs)
}
export function looseSourceFor (abs, spaceId) {
  return looseSources.get(abs)?.get(spaceId) || null
}

let ipcRef = null
export function initLooseOverlay (ipc) { ipcRef = ipc }

const rel = (drivePath) => drivePath.replace(/^\//, '')
const drivePathOf = (relPath) => '/' + relPath

function armWatch (spaceId, absPath) {
  ipcRef?.emit('main-request', { command: 'loose-file:watch', args: { spaceId, absPath } })
}
function disarmWatch (spaceId, absPath) {
  ipcRef?.emit('main-request', { command: 'loose-file:unwatch', args: { spaceId, absPath } })
}

// Serializes everything that changes what a loose path MEANS — its name, its source link, its
// tracking, whether its entry exists — per space. The hash itself runs on the publish service's
// lane, never under this lock: one bounded lane and one ordering policy for every file the user
// shares, loose or folder. The executor only reads, and takes the lock only for its own writes.
const withSpaceLock = createKeyedLock()

// Pick the relPath for a new/changed share under the lock: an already-tracked source keeps its
// name with NO catalog scan (the hot change-event path); a new source does ONE catalog pass
// yielding the taken names (suffix-on-collision) and the count for the cap — including names
// queued but not yet advertised, or two quick adds could both pass the cap.
async function resolveLooseName (spaceId, absPath, fileName) {
  const tracked = looseSourceFor(absPath, spaceId)
  if (tracked) return tracked

  const base = fileName || path.basename(absPath)
  const takenNames = new Set(getPublishScheduler().pendingRelPaths(spaceId, LOOSE_SHARE_ID))
  for await (const e of listOwnShare(spaceId, LOOSE_SHARE_ID)) takenNames.add(e.relPath)

  let relPath = base
  let isNew = true
  if (takenNames.has(base)) {
    const existingSrc = await getOwnedSourcePath(spaceId, drivePathOf(base))
    if (existingSrc === absPath) isNew = false // same source, untracked (e.g. pre-rehydrate) → reuse name
    else relPath = nextFreeName(base, (c) => takenNames.has(c))
  }
  // Cap applies only to genuinely new entries; an update at the cap is allowed.
  if (isNew && takenNames.size >= MAX_LOOSE_FILES_PER_SPACE) {
    throw new AppError(ErrorCodes.LOOSE_FILE_LIMIT, `Limit of ${MAX_LOOSE_FILES_PER_SPACE} shared files per space reached`)
  }
  return relPath
}

// Resolves once the file is published (or its publish was cancelled), like the inline hash it
// replaces, so files:add still returns when the file is really shared.
export async function looseShareFile (spaceId, absPath, fileName) {
  const { relPath, ticket } = await withSpaceLock(spaceId, async () => {
    const relPath = await resolveLooseName(spaceId, absPath, fileName)
    return { relPath, ticket: await admitLoosePublish(spaceId, relPath, absPath, PRIORITY.INTERACTIVE) }
  })
  return await settledWithTail(spaceId, relPath, ticket, absPath)
}

// Under the caller's lock: records the source link (durable BEFORE the hash, so a quit mid-hash
// resumes at boot instead of stranding an "Adding" — and it is what the executor resolves the
// path from), tracks the path, and enqueues, so the next admission already sees the name
// pending. A re-publish re-records the link from the path in hand, healing one lost earlier.
async function admitLoosePublish (spaceId, relPath, absPath, priority) {
  await markOwnedSource(spaceId, drivePathOf(relPath), absPath)
  trackSource(absPath, spaceId, relPath)
  const { size, mtime } = statFacts(absPath)
  return getPublishScheduler().enqueue({ spaceId, shareId: LOOSE_SHARE_ID, relPath, op: OP.PUBLISH, size, mtime, priority })
}

async function enqueueLoosePublish (spaceId, relPath, absPath, priority) {
  const ticket = await withSpaceLock(spaceId, () => admitLoosePublish(spaceId, relPath, absPath, priority))
  return await settledWithTail(spaceId, relPath, ticket, absPath)
}

async function enqueueLooseRetire (spaceId, relPath, priority) {
  const ticket = getPublishScheduler().enqueue({ spaceId, shareId: LOOSE_SHARE_ID, relPath, op: OP.RETIRE, priority })
  return await settledWithTail(spaceId, relPath, ticket, null)
}

// A cancel releases the caller at once while the executor still has to honour the abort and
// revert; the caller resolves only once that tail has exited, as the inline publish it replaces
// did. A cancel is not a failure (the user stopped it); a real error propagates — and so does a
// publish that found no source link, because the file was NOT shared.
async function settledWithTail (spaceId, relPath, ticket, absPath) {
  const outcome = await ticket.settled
  if (outcome.outcome === 'cancelled') {
    await ticket.exited
    await withSpaceLock(spaceId, () => clearOwnedSourceIfUnshared(spaceId, relPath, absPath, { unless: getPublishScheduler().isPending(spaceId, LOOSE_SHARE_ID, relPath) }))
  }
  if (outcome.outcome === 'failed' && outcome.error) throw outcome.error
  if (outcome.result?.outcome === 'unlinked') {
    if (absPath && looseSourceFor(absPath, spaceId) === relPath) untrackSource(absPath, spaceId)
    throw new AppError(ErrorCodes.NOT_FOUND, 'Shared file has no source link')
  }
  return outcome
}

export async function looseCancelPublish (spaceId, drivePath) {
  const relPath = rel(drivePath)
  const { cancelled, exited } = getPublishScheduler().cancelPath(spaceId, LOOSE_SHARE_ID, relPath)
  if (cancelled) await exited
  // Whatever the cancel caught — a running hash that has now reverted, an item that was still
  // queued (no executor, so no revert), or nothing (a half-publish orphaned by a restart) — a
  // null-hash placeholder left behind is reverted here, so the cancel control always means
  // something. Re-read UNDER the lock and bail if the entry is no longer a placeholder: a resume
  // that completed meanwhile must not have its finished, replicated share torn down.
  // Best-effort: a cancel issued as the worker (or a test's store) is closing must not surface its
  // tail as an unhandled rejection — the boot rehydrate reverts a leftover placeholder anyway.
  // Announced only when this revert changed something: a live cancel's revert is announced by the
  // executor's own hook, and a no-op must stay silent (a listener may cancel on every refresh).
  let reverted = false
  try {
    await withSpaceLock(spaceId, async () => {
      const entry = await getOwnEntry(spaceId, LOOSE_SHARE_ID, relPath)
      if (!entry || entry.contentHash) return
      const src = await getOwnedSourcePath(spaceId, drivePath)
      await unshareEntry(spaceId, relPath, null, src)
      reverted = true
    })
  } catch (err) {
    log.debug('loose cancel cleanup skipped:', relPath, '-', err.message)
  }
  if (reverted) ipcRef?.emit('event:files-updated', { spaceId })
}

registerPublishChannel('loose', {
  direct: true,
  // Identity is the recorded absolute path, judged the way the file is opened: a case-only
  // rename on a folding volume or a symlinked source keeps a loose share readable, so it stays.
  present: fileStatPresent,
  async resolve (item) {
    const absPath = await getOwnedSourcePath(item.spaceId, drivePathOf(item.relPath))
    if (!absPath && item.op === OP.PUBLISH) return { skip: 'unlinked' }
    return { absPath }
  },
  async publish (item, { absPath }, { signal }) {
    const { spaceId, relPath } = item
    let ticker = null
    try {
      const { changed, contentHash } = await publishContent(spaceId, LOOSE_SHARE_ID, relPath, absPath, {
        signal,
        onAdvertised: async (size) => {
          ticker = makeProgressTicker(size, ({ bytes, total, speed, eta }) => {
            deco(spaceId, drivePathOf(relPath), { phase: 'publishing', bytes, total, speed, eta })
            broadcastSharePrepare(spaceId, { shareId: LOOSE_SHARE_ID, relPath, bytes, total, eta })
          })
          ipcRef?.emit('event:files-updated', { spaceId })
        },
        onProgress: (len) => ticker?.push(len),
      })
      return { changed, contentHash }
    } finally {
      // Only clear a bar we actually raised: a fast-pathed healthy entry never created a ticker.
      if (ticker) {
        deco(spaceId, drivePathOf(relPath), { done: true })
        broadcastSharePrepare(spaceId, { shareId: LOOSE_SHARE_ID, relPath, done: true })
      }
    }
  },
  async afterPublish (item, { absPath }, { changed, contentHash }) {
    const { spaceId, relPath } = item
    if (!contentHash) {
      // The source vanished mid-publish. publishContent already reverted its half-advertised
      // entry, so this is a benign abort — the file is simply not shared.
      await withSpaceLock(spaceId, () => clearOwnedSourceIfUnshared(spaceId, relPath, absPath, { unless: item.dirty }))
      log.debug('loose publish aborted — source vanished mid-hash:', absPath)
      ipcRef?.emit('event:files-updated', { spaceId })
      return
    }
    armWatch(spaceId, absPath)
    // An unchanged healthy entry re-registered at boot advertised nothing new.
    if (changed) ipcRef?.emit('event:files-updated', { spaceId })
  },
  // publishContent undoes its own half-advertised placeholder on any failure or cancel — and
  // leaves a successfully-published prior version alone — so only a now-dangling source link
  // is dropped here.
  async onPublishFailed (item, { absPath }) {
    await withSpaceLock(item.spaceId, () => clearOwnedSourceIfUnshared(item.spaceId, item.relPath, absPath, { unless: item.dirty }))
    ipcRef?.emit('event:files-updated', { spaceId: item.spaceId })
  },
  async retire (item, { absPath }) {
    await withSpaceLock(item.spaceId, async () => {
      const prev = await getOwnEntry(item.spaceId, LOOSE_SHARE_ID, item.relPath)
      await unshareEntry(item.spaceId, item.relPath, prev?.contentHash || null, absPath)
    })
    ipcRef?.emit('event:files-updated', { spaceId: item.spaceId })
  },
})

// After a failed, aborted or never-started publish: drop the source link and tracking ONLY if
// nothing advertises the path and no newer admission owns it (`unless`: from the executor's own
// hooks that is a rerun queued behind it, from a caller it is any pending item) — a re-add
// admitted meanwhile has written its own link, and a reverted re-publish keeps its prior
// version's. Called under the lock.
async function clearOwnedSourceIfUnshared (spaceId, relPath, absPath = null, { unless = false } = {}) {
  try {
    if (unless) return
    if (await getOwnEntry(spaceId, LOOSE_SHARE_ID, relPath)) return
    const linked = await getOwnedSourcePath(spaceId, drivePathOf(relPath))
    if (linked && (!absPath || linked === absPath)) await clearOwnedSource(spaceId, drivePathOf(relPath))
    if (absPath && looseSourceFor(absPath, spaceId) === relPath) untrackSource(absPath, spaceId)
  } catch (err) {
    log.debug('post-failure source cleanup skipped:', err.message)
  }
}

async function unshareEntry (spaceId, relPath, contentHash, src) {
  await catalogTombstone(spaceId, LOOSE_SHARE_ID, relPath)
  await evictIfUnreferenced(contentHash, spaceId, LOOSE_SHARE_ID, relPath)
  await clearOwnedSource(spaceId, drivePathOf(relPath))
  if (src) { untrackSource(src, spaceId); disarmWatch(spaceId, src) }
}

// A user action with a synchronous contract: when this resolves the entry is gone. Untracked
// first (a watcher event for the path is ignored from here on), then any item for the path is
// cancelled and its executor waited out, so no tail can advertise after the tombstone. A newer
// admission that lands in that wait is a later intent and wins: the unshare then does nothing.
export async function looseUnshareFile (spaceId, drivePath) {
  const relPath = rel(drivePath)
  const src = await withSpaceLock(spaceId, async () => {
    const src = await getOwnedSourcePath(spaceId, drivePath)
    if (src) { untrackSource(src, spaceId); disarmWatch(spaceId, src) }
    return src
  })
  const { cancelled, exited } = getPublishScheduler().cancelPath(spaceId, LOOSE_SHARE_ID, relPath)
  if (cancelled) await exited
  await withSpaceLock(spaceId, async () => {
    if (getPublishScheduler().isPending(spaceId, LOOSE_SHARE_ID, relPath)) return
    const prev = await getOwnEntry(spaceId, LOOSE_SHARE_ID, relPath)
    await unshareEntry(spaceId, relPath, prev?.contentHash || null, src)
  })
  ipcRef?.emit('event:files-updated', { spaceId })
}

export async function looseListOwn (spaceId) {
  // Display path: tolerate a corrupt catalog core as a partial listing (resolveLooseName
  // / sweeps keep listOwnShare and fail loud — they must not act on partial data).
  return await listOwnShareForDisplay(spaceId, LOOSE_SHARE_ID)
}

export async function looseHasOwn (spaceId, drivePath) {
  return !!(await getOwnEntry(spaceId, LOOSE_SHARE_ID, rel(drivePath)))
}

// Watcher dispatch (one event per (space, path) the file is shared in). Resolves the file's
// assigned name from the reverse map so a change re-publishes under the same name and an unlink
// retires the right entry; an untracked path is ignored. The retire executor re-confirms the
// file is really gone before tombstoning (an atomic save fires an unlink for a path that is
// immediately back).
export async function handleLooseFsEvent ({ spaceId, absPath, action }) {
  const relPath = looseSourceFor(absPath, spaceId)
  if (!relPath) return
  if (action === 'unlink') return await enqueueLooseRetire(spaceId, relPath, PRIORITY.INTERACTIVE)
  return await enqueueLoosePublish(spaceId, relPath, absPath, PRIORITY.INTERACTIVE)
}

export async function looseListPeer (spaceId, member, timeoutMs, space) {
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
function ensureLooseCatalogWatch (spaceId, member, keyHex, sck) {
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
async function reconcileActiveLooseTransfers (spaceId, member) {
  const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, member)
  if (!readable) return
  for (const [transferId, slot] of engine().activeSlots()) {
    if (slot.spaceId !== spaceId || slot.ownerPublicKey !== member.publicKey) continue
    const drivePath = slot.pendingKey
    const inflightHash = slot.contentHash
    const state = await getPeerEntryState(keyHex, LOOSE_SHARE_ID, rel(drivePath), { sck })
    const decision = republishDecision(inflightHash, state, slot.sourceSeq)
    // Tombstoned, or re-added with identical content → terminate; don't silently continue the
    // old partial. A genuine content change falls through to the supersede below.
    if (decision === 'drop') { await engine().dropRemoved(spaceId, drivePath, transferId).catch((err) => log.debug('loose active drop-removed failed:', err.message)); continue }
    // Mid-rehash: a new version is advertised, its hash not materialized yet. Park the transfer as
    // 'preparing' (abort the doomed old-hash fetch, keep the row) — the setMaterializedHash append
    // restarts it on the new content via runReconcile.
    if (decision === 'pending') { engine().releaseForRepublish(transferId); continue }
    if (decision !== 'restart' && supersedeDecision(inflightHash, state?.contentHash) !== 'restart') continue
    const newJob = await buildLooseJob(spaceId, member, drivePath)
    if (newJob) engine().supersede(transferId, { ...newJob, prevBytes: 0 }, inflightHash)
  }
}

// Loose downloads run on the shared overlay consumer engine (single-flight, real
// pause/resume, stop/cancel, auto-resume). This module supplies the loose "channel":
// the space-root event names + the catalog/ownerKey/pending-key specifics.
async function buildLooseJob (spaceId, member, drivePath, prevPending, entry) {
  const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, member)
  if (!readable) return null
  ensureLooseCatalogWatch(spaceId, member, keyHex, sck) // guarantee change-detection even for an auto-resumed transfer
  const relPath = rel(drivePath)
  entry = entry || await getPeerEntry(keyHex, LOOSE_SHARE_ID, relPath, { sck })
  if (!entry?.contentHash) return null
  const pending = prevPending || await getPendingFor(spaceId, drivePath)
  // Re-anchored when the recorded destination no longer sits in the space's download folder
  // (the user re-pointed the space while this row was paused) — see reuseDest.
  const finalPath = reuseDest(pending?.finalPath, getDownloadDir(spaceId), path.basename(relPath))
  return {
    spaceId, pendingKey: drivePath, path: drivePath, relPath,
    transferId: looseTransferIdFor(spaceId, relPath),
    contentHash: entry.contentHash, size: entry.size || 0, sourceSeq: entry.seq,
    ownerPublicKey: member.publicKey, verifyKey: LOOSE_SHARE_ID + '|' + relPath,
    finalPath, prevBytes: finalPath === pending?.finalPath ? pending.bytesTransferred : 0,
  }
}

// Decoration frames carry spaceId: job.path is the bare drive path ('/'+relPath), unique per
// space only — without the field two spaces downloading the same-named loose file would mix
// bytes in the renderer's per-key decoration map.
const deco = (spaceId, key, p) => ipcRef?.emit('event:decoration', { channel: 'transfer', spaceId, key, ...p })

let looseEngine = null

export function setLooseEngine(next) { looseEngine = next }

function engine() {
  if (!looseEngine) throw new Error('loose overlay: not started')
  return looseEngine
}

export const looseChannel = {
  diagLabel: 'loose download',
  inPlace: true,
  ownsPendingRow: (row) => row.inPlace === true && row.shareId === LOOSE_SHARE_ID,
  pendingExtra: (job) => ({ shareId: LOOSE_SHARE_ID, relPath: job.relPath }),
  // Progress is DECORATION (never status). Lifecycle events (complete/error/paused/superseded)
  // remain as signals for notifications; the row's status is re-derived from files:list.
  emitProgress: (job, p) => deco(job.spaceId, job.path, { bytes: p.bytes, total: p.total, speed: p.speed, eta: p.eta }),
  emitVerifying: (job, fraction) => deco(job.spaceId, job.path, { phase: 'verifying', verifyFraction: fraction, bytes: job.prevBytes || 0, total: job.size }),
  emitError: (job, errorCode) => { ipcRef?.emit('event:transfer-error', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, errorCode }); deco(job.spaceId, job.path, { done: true }) },
  emitComplete: (job, localPath) => { ipcRef?.emit('event:transfer-complete', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, localPath }); deco(job.spaceId, job.path, { done: true }) },
  emitCancelled: (spaceId, transferId, pendingKey) => deco(spaceId, pendingKey, { done: true }),
  emitSuperseded: (job) => { ipcRef?.emit('event:transfer-superseded', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, fileName: path.basename(job.relPath) }); deco(job.spaceId, job.path, { bytes: 0, total: job.size, speed: 0, eta: null }) },
  // [mirall] FIX-BW9 — `retrying` means the engine has an automatic retry armed for this row.
  // The decoration still terminates (a stranded entry samples speed across the whole backoff),
  // but the notification is withheld: 'event:transfer-paused' raises an OS notification, and one
  // per attempt would turn a slow transfer into a stream of them.
  emitPaused: (job, reason, opts) => { if (!opts?.retrying) ipcRef?.emit('event:transfer-paused', { transferId: job.transferId, spaceId: job.spaceId, path: job.path, reason }); deco(job.spaceId, job.path, { done: true }) },
  emitDecorationDone: (job) => deco(job.spaceId, job.path, { done: true }),
  emitUpdated: (spaceId) => ipcRef?.emit('event:files-updated', { spaceId }),
  transferIdForRow: (spaceId, row) => looseTransferIdFor(spaceId, row.relPath),
  resolvePendingRow: async (spaceId, row) => {
    const space = await getSpace(spaceId)
    const member = (space?.members || []).find((m) => m.publicKey === row.ownerKey)
    if (!member) return { removed: false, seq: undefined, job: null }
    const { keyHex, sck, readable } = await resolvePeerCatalog(spaceId, member, { space })
    if (!readable) return { removed: false, seq: undefined, job: null }
    const state = await getPeerEntryState(keyHex, LOOSE_SHARE_ID, row.relPath, { sck })
    if (state?.removed) return { removed: true, seq: undefined, job: null }
    const job = state?.contentHash ? await buildLooseJob(spaceId, member, drivePathOf(row.relPath), row, state) : null
    return { removed: false, seq: state?.seq, job }
  },
  emitRemovedByOwner: (spaceId, pendingKey, row, transferId) =>
    ipcRef?.emit('event:transfer-removed', { spaceId, transferId, path: pendingKey, fileName: path.basename(row?.relPath || rel(pendingKey)) }),
}

export function looseHasTransfer (transferId) { return engine().has(transferId) }
export function looseTransferActive (spaceId, relPath) { return engine().has(looseTransferIdFor(spaceId, relPath)) }

export async function looseDownload (spaceId, member, drivePath) {
  const relPath = rel(drivePath)
  // This is the manual resume path too, so retire any pause marker up front — start() clears it
  // as well, but the guards below can return before we ever reach start().
  engine().clearPauseMarker(looseTransferIdFor(spaceId, relPath))
  if (!getOverlay() || !(member?.looseCatalogKey || member?.looseCatalogKeyEnc)) return { queued: true }
  const job = await buildLooseJob(spaceId, member, drivePath)
  if (!job) {
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

export function loosePause (transferId) { return engine().pause(transferId) }
export function looseCancelTransfer (transferId) { return engine().cancel(transferId) }
export function looseCancel (spaceId, drivePath) {
  return engine().cancelByKey(spaceId, drivePath, looseTransferIdFor(spaceId, rel(drivePath)))
}
// Cancel + discard every in-flight loose download for a space (leave teardown): the
// engine keeps fetching a started transfer even after its pending row is cleared, so
// without this the partial is orphaned and a late completion re-writes purged meta rows.
export async function looseCancelSpace (spaceId) {
  const ids = []
  for (const [transferId, slot] of engine().activeSlots()) {
    if (slot.spaceId === spaceId) ids.push(transferId)
  }
  // Per-id best-effort: cancel now throws when the row cannot be cleared, and the leave's own
  // clearPendingForSpace purges the rows a beat later — one failed discard must not abort the leave.
  await Promise.all(ids.map((id) => engine().cancel(id).catch((err) => log.warn('cancel on leave failed:', id, '-', err.message))))
}
export function resumeLooseForOwner (ownerKey, spaceId) { return engine().resumeForOwner(ownerKey, spaceId) }

// Boot: in-memory serve maps + reverse map are not persisted. Re-register every
// own loose file whose source still exists (re-hashing if it changed while
// offline) and re-arm its watch.
export async function rehydrateLooseFiles () {
  const pending = []
  for (const space of await listSpaces()) {
    try {
      for await (const e of listOwnShare(space.spaceId, LOOSE_SHARE_ID)) pending.push(rehydrateLooseEntry(space.spaceId, e))
    } catch (err) {
      log.debug('skip loose rehydrate for space', space.spaceId, '-', err.message)
    }
  }
  await Promise.allSettled(pending)
}

// Per-file isolation (parity with the folder boot pass): one entry whose resume fails must not
// abort the later loose files. A never-hashed entry with no recorded source is an unrecoverable
// half-publish (an install predating the advertise-time link, or a crash inside the
// advertise-then-link window): revert it so it stops showing "Adding" forever. A finished entry
// that merely lost its source is left as-is — it still displays as an owned file. A healthy entry
// whose source is unchanged is re-registered with the serve gate directly, like the folder boot
// path, so it is servable and watched the moment the worker is up rather than after a lane slot
// frees behind a folder backfill. Only an entry that needs the hash — null hash, or a source that
// changed while offline — goes on the lane.
async function rehydrateLooseEntry (spaceId, e) {
  try {
    const src = await getOwnedSourcePath(spaceId, drivePathOf(e.relPath))
    if (!src) {
      if (!e.contentHash) {
        await withSpaceLock(spaceId, () => unshareEntry(spaceId, e.relPath, null, null))
        ipcRef?.emit('event:files-updated', { spaceId })
      }
      return
    }
    if (e.contentHash && !fileStatPresent(src)) return
    const { size, mtime } = statFacts(src)
    if (e.contentHash && e.size === size && e.mtime === mtime) {
      await makeServable(spaceId, LOOSE_SHARE_ID, e.relPath, src, e.contentHash, size)
      trackSource(src, spaceId, e.relPath)
      armWatch(spaceId, src)
      return
    }
    await enqueueLoosePublish(spaceId, e.relPath, src, PRIORITY.BULK)
  } catch (err) {
    log.warn('skip loose file during rehydrate:', e.relPath, '-', err.message)
  }
}

// Backstop: retire loose entries whose source vanished without a watcher unlink. Proposes on two
// consecutive misses (an atomic-save window must not transiently unshare a still-present file)
// and the retire executor confirms the same way, on the shared lane. Never touches an entry
// whose publish is queued or running: disk presence decides only for settled entries. Each
// space's failures stay its own; one failing retire never skips the spaces after it.
const sweepGone = new Set()
const goneKey = (spaceId, relPath) => spaceId + '\0' + relPath

export async function sweepLoosePresence () {
  const retires = []
  for (const space of await listSpaces()) {
    try {
      for await (const e of listOwnShare(space.spaceId, LOOSE_SHARE_ID)) {
        const key = goneKey(space.spaceId, e.relPath)
        if (getPublishScheduler().isPending(space.spaceId, LOOSE_SHARE_ID, e.relPath)) { sweepGone.delete(key); continue }
        // No recorded source → a crash inside the tiny advertise→link window or a stranded entry
        // from an older install (reverted by the boot rehydrate, not the sweep). The sweep only
        // reclaims a RECORDED source that disappeared from disk.
        const src = await getOwnedSourcePath(space.spaceId, drivePathOf(e.relPath))
        if (!src) { sweepGone.delete(key); continue }
        if (fileStatPresent(src)) { sweepGone.delete(key); continue }
        if (!sweepGone.has(key)) { sweepGone.add(key); continue }
        sweepGone.delete(key)
        retires.push(enqueueLooseRetire(space.spaceId, e.relPath, PRIORITY.BULK)
          .catch((err) => log.debug('loose retire failed:', e.relPath, '-', err.message)))
      }
    } catch (err) {
      log.debug('skip loose presence sweep for space', space.spaceId, '-', err.message)
    }
  }
  await Promise.all(retires)
}

export function resetLooseState () {
  ipcRef = null
  looseSources.clear()
  sweepGone.clear()
}
