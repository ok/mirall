// The mirror engine for foreign folders: another member's share materialized read-only
// to a local mount path. A per-mount loop lists the owner's catalog (the replicated
// file listing) and materializes the diff — files are fetched by content hash through
// the overlay backend and land as partials that rename into place; deletions are
// honored only for files the mirror itself wrote (syncedPaths) and only while the
// owner is provably online, so a lagged replica or a user's own files are never wiped.
import fs from 'bare-fs'
import path from 'bare-path'
import { shouldHonorDeletions, relKeyEscapes, dropUnsafeEntries, conflictCopyName, driveKeyToSegments } from './path-keys.js'
import { isOwnerOnline } from '../transfer/swarm.js'
import { record } from '../audit/audit-log.js'
import { createIntegritySeen } from './integrity-seen.js'
import { getSpace } from '../spaces/space.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { getResourceCaps } from '../core/runtime-config.js'
import {
  getForeignMount, saveForeignMount, deleteForeignMount, patchForeignMount, findForeignMountByShareId,
} from './mount-store.js'
import { setMirrorState, tombstoneMirror } from './mirror-records.js'
import { mountRootAvailable } from './owned-folders.js'
import { AppError, ErrorCodes, classifyLocalIoFault } from '../core/errors.js'
import { pathFromMount } from '../transfer/path-guard.js'
import { PARTIAL_SUFFIX } from '../transfer/partial-suffix.js'
import { faultFromError, statusForFaultCode, isAutoPauseStatus, STATUS_MOUNT_GONE } from './mount-fault.js'
import { getContentBackend, hasContentBackend } from '../transfer/content-backends.js'
import { getOverlay } from '../transfer/backends/overlay/overlay-instance.js'
import { overlayHashFile, setOverlayCatalogChangeHook } from '../transfer/backends/overlay/overlay-backend.js'
import { runOverlayFetch } from '../transfer/backends/overlay/fetch-run.js'
import { acquireFetchSlot, drainFetchSlots, FETCH_OWNER_MIRROR } from '../transfer/backends/overlay/fetch-slots.js'
import { claimFetch, dropFetchClaim, fetchClaimedBy } from '../transfer/backends/overlay/fetch-claims.js'
import { createPausedHolders } from '../transfer/backends/overlay/paused-holders.js'
import { shareDecoKey } from '../transfer/decoration-key.js'
import { transferIdFor } from '../transfer/transfer-id.js'
import { markVerified, isVerifiedUnchanged, getVerifiedHash } from '../transfer/files.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { mirrorVerdict } from './mirror-health.js'
import { createMirrorLoops } from './mirror-loop.js'
import { createMirrorState, localRelOf } from './mirror-state.js'
import { classifyLocalCopy, mayOverwriteInPlace } from './mirror-ownership.js'
import { shouldWalk } from './mirror-walk.js'

const log = createLogger('foreign-folders')

// The loop engine. Everything mount-specific stays here; the interval, the one-pass-at-a-time
// serialisation, the cancellation generation and the liveness heartbeat live in mirror-loop.js.
const loops = createMirrorLoops({
  intervalMs: () => getResourceCaps().foreignPollIntervalMs,
  runPass: ({ spaceId, shareId }) => materializeOnce(spaceId, shareId),
  onStop: (key, { discardPartial = false } = {}) => {
    cancelInflightFetch(key, discardPartial)
    state.forgetConverged(key)
  },
  onError: (err) => log.debug('materialize tick failed:', err.message),
})
const state = createMirrorState({ keyOf: loopKey, isStopped: (key, gen) => loops.stopped(key, gen) })

let ipcRef = null

export function initForeignFolders(_ipc) {
  ipcRef = _ipc
  // Materialize promptly when an owner's catalog appends, instead of waiting for
  // the mirror's poll tick.
  setOverlayCatalogChangeHook(onPeerDriveChanged)
}

function loopKey(spaceId, shareId) {
  return spaceId + ':' + shareId
}

const APPEND_TICK_DEBOUNCE_MS = 250

// The owner's content changed. Run a materialize tick now (debounced) for each
// active mirror in that space instead of waiting for the 30s poll, so owner-side
// edits/deletes reflect on the mirror's disk as promptly as they do in the folder
// view.
export function onPeerDriveChanged(spaceId) {
  for (const loop of loops.entries()) {
    if (loop.spaceId !== spaceId) continue
    loops.debounce(loop.key, { spaceId: loop.spaceId, shareId: loop.shareId }, APPEND_TICK_DEBOUNCE_MS)
  }
}

async function loadShareForForeignMount(mount) {
  const { readPeerShares } = await import('../shares/shares.js')
  const shares = await readPeerShares(mount.ownerKey, mount.spaceId)
  if (!shares) return null
  const found = shares.find((s) => s.id === mount.shareId)
  if (!found) return null
  return { ...found, spaceId: mount.spaceId, owner: mount.ownerKey }
}

function emitStatus(spaceId, shareId, status, extra) {
  ipcRef?.emit('event:foreign-folder-mount-status', { spaceId, shareId, status, ...(extra || {}) })
}

// Keep the replicated mirror-participation record in step with a mount lifecycle change, then poke
// the local mirror views. A record-write failure must not break the mount operation itself.
async function syncMirrorRecord(spaceId, shareId, op) {
  let changed = false
  try { changed = await op() } catch (err) { log.warn('mirror record update failed:', shareId, '-', err.message) }
  if (changed) ipcRef?.emit('event:mirrors-updated', { spaceId, shareId })
}

// The one place a materialize pass reports its terminal sync state: 'synced' once every catalog
// entry is present locally, else 'syncing'. Callers gen-guard this so a stopped/paused mount's
// trailing tick can't overwrite the pause.
function settleMirrorSyncState(mount, allPresent) {
  return syncMirrorRecord(mount.spaceId, mount.shareId, () => setMirrorState(mount.spaceId, mount.shareId, allPresent ? 'synced' : 'syncing'))
}

async function pauseMount(mount, status, reason) {
  mount.enabled = false
  mount.status = status
  // Durable, like the status itself: the reason is what the folder screen names the fault by, and
  // an event-only reason left the strip generic after every reload.
  mount.lastError = reason ?? null
  // Carry the Set: a pause cancels the pass, so this write is what persists whatever it landed.
  await saveForeignMount({ ...mount, ...state.syncFields(mount) })
  // Symmetry with the user-pause path (setForeignEnabled(false)): stop the poll loop so an
  // auto-paused mount doesn't keep a live interval, its in-flight fetch is cancelled, and its
  // generation is bumped — the last point lets an in-progress scan bail before it would
  // otherwise overwrite this pause with a trailing status:'active'.
  stopForeignLoop(mount.spaceId, mount.shareId)
  await syncMirrorRecord(mount.spaceId, mount.shareId, () => setMirrorState(mount.spaceId, mount.shareId, 'paused'))
  emitStatus(mount.spaceId, mount.shareId, status, reason ? { error: reason } : null)
}

// Pause the mount for a local I/O failure (overlay materializeOverlayFile write path). Returns
// true if it paused — the caller then stops; false leaves the error for generic handling. The
// fault→status decision is shared with the owner side; stopping the loop is ours, because a
// mirror's pause really does stop it.
async function pauseMountForIoError(mount, err) {
  const fault = faultFromError(err)
  if (fault) { await pauseMount(mount, fault.status, fault.code); return true }
  if (err?.code === 'ENOENT' && !fs.existsSync(mount.mountPath)) { await pauseMount(mount, STATUS_MOUNT_GONE); return true }
  return false
}

// A mirror's INITIAL scan failing is not a pause: the poll loop still starts, and the next
// successful tick clears this. So it records the fault without touching `enabled` — which is what
// keeps it out of the auto-pause resume gate.
export async function recordMirrorScanFault(spaceId, shareId, err) {
  const code = classifyLocalIoFault(err)
  const status = statusForFaultCode(code)
  await patchForeignMount(spaceId, shareId, { status, lastError: code })
  emitStatus(spaceId, shareId, status, { error: code })
  return status
}

export function isAutoPaused(mount) {
  return !!mount && mount.enabled === false && isAutoPauseStatus(mount.status)
}

// Probe-driven twin of pauseMountForIoError for a mount whose local path vanished while the
// poll loop was idle: nothing touched the destination, so no I/O error ever classified the
// fault and the durable status stayed a stale 'active' that a refresh/boot would resurrect.
// No-ops for a user pause, an already-applied auto-pause, or a path that is actually present.
export async function autoPauseForeignMountGone(spaceId, shareId) {
  const mount = await getForeignMount(spaceId, shareId)
  if (!mount || mount.enabled === false) return false
  if (mountRootAvailable(mount.mountPath)) return false
  await pauseMount(mount, STATUS_MOUNT_GONE)
  return true
}

// Level-triggered recovery for an auto-paused mirror: the local target returned, the disk
// was freed, or a permission was fixed. Re-enables via the canonical enable path, which drives an
// immediate materialize through the serialized tick (not a bare initial scan) so it can't race the
// poll loop and can't leave a trailing status:'active'; if the fault still holds, that tick's
// write re-pauses it. A user pause and a still-missing path are left untouched.
export async function resumeAutoPausedForeignMount(spaceId, shareId) {
  const mount = await getForeignMount(spaceId, shareId)
  if (!isAutoPaused(mount)) return false
  if (!mountRootAvailable(mount.mountPath)) return false
  await setForeignEnabled(spaceId, shareId, true)
  return true
}

// The containment-guarded materialize primitive. pathFromMount rejects any
// owner-controlled relPath that escapes the mount BEFORE any local write/unlink —
// the path-traversal guard the security suite exercises (foreign-path-containment).
// Puts are fetched by the overlay path (materializeOverlayFile); this remains the
// delete primitive used by the catalog deletion reconcile.
export async function applyChange(mount, change) {
  const abs = pathFromMount(mount.mountPath, change.localRelPath || change.relPath)
  if (change.action === 'del') {
    try { await fs.promises.unlink(abs) } catch (err) {
      if (err && err.code !== 'ENOENT') throw err
    }
    ipcRef?.emit('event:share-files-updated', { spaceId: mount.spaceId, shareId: mount.shareId })
  }
}

// The initial scan is launched unawaited at boot and on a fresh mount, and it walks the whole
// catalog — so it is exactly the kind of in-flight pass stopAllForeignLoops has to wait for. It
// honours the generation internally (bails between files, re-checks before the trailing persist),
// but the bulk stop can only WAIT for what it sees, hence the same in-flight map the poll tick uses.
export async function initialMaterializeScan(mount) {
  const key = loopKey(mount.spaceId, mount.shareId)
  state.forgetConverged(key)
  return await loops.adopt(key, runInitialMaterializeScan(mount))
}

async function runInitialMaterializeScan(mount) {
  const share = await loadShareForForeignMount(mount)
  if (share && hasContentBackend(share)) return await initialMaterializeScanCatalog(mount, share)
  // No usable content backend (unsupported / unreadable share) — skip the mirror
  // rather than materialize from a path this build can't serve. Still settle the record
  // so it doesn't advertise 'syncing' forever for a mount that can never fetch.
  log.warn('skipping mirror — no usable content backend:', share?.contentMode, mount.shareId)
  await settleMirrorSyncState(mount, true)
  return { skipped: 'no-content-backend' }
}

export async function startForeignLoop(mount) {
  loops.start(loopKey(mount.spaceId, mount.shareId), { spaceId: mount.spaceId, shareId: mount.shareId })
}

// The file the mirror is fetching right now (one per loopKey — the catalog materialize is
// strictly sequential): contentHash so stopForeignLoop can abort the in-flight overlay
// download, relPath so foreignFetchActive can identify the row.
const activeOverlayFetches = new Map()
// The paused-stop markers this mount left with holders, so a later unmount can still tell them we
// stopped rather than leaving their "who is downloading" row paused until the 5-min sweep.
const pausedHolders = createPausedHolders({ notifyStopped: (hash) => getOverlay()?.notifyTransferStopped(hash) })
// One in-memory Set of synced owner keys per mount — the authoritative copy while the process
// lives. mount.syncedPaths (the persisted array) is its boot-time seed and durable snapshot,
// written back only when the Set changed. Membership is asked once per catalog entry per tick,
// so it must be O(1): the array scan it replaces made a fully-synced tick quadratic. The Set
// outlives pause/resume (a stopped pass has already written files it must keep owning) and is
// dropped only on unmount, with the record.
// Is the mirror loop actively fetching THIS row? Consulted by the worker's share:list-files
// derivation so a materializing mirror row reports 'downloading'.
export function foreignFetchActive(spaceId, shareId, relPath) {
  return activeOverlayFetches.get(loopKey(spaceId, shareId))?.relPath === relPath
}
const mirrorGen = (key) => loops.generationOf(key)
const mirrorStopped = (key, gen) => loops.stopped(key, gen)

export async function runMaterializeTick(spaceId, shareId) {
  return await loops.tick(loopKey(spaceId, shareId), { spaceId, shareId })
}

async function materializeOnce(spaceId, shareId) {
  const current = await getForeignMount(spaceId, shareId)
  if (!current || !current.enabled) return
  // The owner's share metadata can be momentarily unreadable (profile bee not
  // replicated this instant) or gone (owner deleted the share). A periodic /
  // append-driven tick must skip quietly in that case — not throw on every
  // fire, which floods the log once the append trigger runs ticks frequently.
  const share = await loadShareForForeignMount(current)
  if (!share) {
    await maybeUnmountIfOwnerGone(current)
    return
  }
  if (hasContentBackend(share)) return await materializeOnceCatalog(current, share)
  // No usable content backend (unsupported / unreadable mode) — don't mirror, but settle the
  // record so it doesn't advertise 'syncing' forever.
  log.debug('skipping mirror tick — no usable content backend:', share.contentMode, shareId)
  await settleMirrorSyncState(current, true)
}

// Route one catalog entry to the read-to-mount: overlay fetches straight from a
// holder by content hash (no peer drive to stream from).
export async function materializeCatalogFile(mount, share, entry, opts = {}) {
  return await materializeOverlayFile(mount, share, entry, opts)
}

// Classify an overlay-mirror fetch that produced no file (fetchFile → null).
// fetchFile returns null for TWO reasons: no holder was ever reachable (no chunk
// scheduler ran), or a holder WAS asked but the transfer stalled / all peers
// vanished mid-stream (its internal catch swallows that into null). Only the
// latter is a genuine give-up worth a WARN; the former is a benign "retry next
// tick" (debug). `attempted` is true once a scheduler ran — i.e. the fetch's
// onEnd fired. Exported for unit coverage of the give-up/no-holder split.
export function classifyMirrorMiss(attempted) {
  return attempted ? 'failed' : 'no-holder'
}

const integritySeen = createIntegritySeen({
  onCap: (mountKey, limit) => log.warn('mirror integrity rows capped at', limit, 'for', mountKey,
    '— further hash mismatches on this mount are logged but not audited until it is remounted'),
})

// The ONE thing a mirror audits. contract/audit-kinds.js deliberately records no per-file folder
// sync, and this is not sync bookkeeping: it is a claim about what a member of this space served.
function recordMirrorIntegrityFailure(mount, share, entry) {
  if (!integritySeen.admit(loopKey(mount.spaceId, mount.shareId), entry.relPath, entry.contentHash)) return
  getSpace(mount.spaceId).then((space) => {
    record('security.integrity_failure', {
      actor: { type: 'self' },
      space: { id: mount.spaceId, name: space?.name ?? null },
      target: { kind: 'file', id: entry.relPath ?? null, name: path.basename(entry.relPath || '') || null },
      subject: {
        bytes: entry.size ?? null,
        ownerKey: mount.ownerKey ?? null,
        folder: share?.displayName || share?.name || null,
        shareId: mount.shareId ?? null,
      },
      outcome: 'error',
      code: 'TRANSFER_CHECKSUM',
    })
  }).catch((err) => log.debug('mirror integrity audit failed:', err.message))
}

// A mirror is owner-authoritative: the owner's bytes belong at the natural name, and that is what
// test/flow/mirror-local-edit.test.js pins. What was never intended is the other half of the old
// behaviour — that the user's bytes were DESTROYED to get there, with no copy, no warning and no
// audit row.
//
// So before the fetch renames over the local file, prove the file is one we delivered. The verified
// record is that ancestor and `diskHash` is already computed, so the check costs one bee read on a
// file that was going to be overwritten anyway. Anything we cannot vouch for is moved aside first;
// the owner's version then lands at the canonical path exactly as before.
async function preserveLocalEdit (mount, entry, verifyKey, diskHash, abs) {
  const ancestorHash = await getVerifiedHash(mount.spaceId, verifyKey).catch(() => null)
  if (mayOverwriteInPlace(classifyLocalCopy({ diskHash, ownerHash: entry.contentHash, ancestorHash }))) return

  const segs = driveKeyToSegments(entry.relPath)
  const leaf = segs.pop()
  const dir = segs.join('/')
  const isTaken = (name) => {
    const candidate = pathFromMount(mount.mountPath, dir ? dir + '/' + name : name)
    return fs.existsSync(candidate) || fs.existsSync(candidate + PARTIAL_SUFFIX)
  }
  const conflictRel = (dir ? dir + '/' : '') + conflictCopyName(leaf, isTaken)
  try {
    await fs.promises.rename(abs, pathFromMount(mount.mountPath, conflictRel))
    log.warn('mirror conflict on', entry.relPath, '- the local copy was not the one we delivered; kept it as', conflictRel)
  } catch (err) {
    // Could not move it aside, so do not overwrite it either: leaving the mirror one file stale is
    // recoverable on the next tick, and destroying the edit is not.
    log.error('could not preserve a locally-edited mirror file — leaving it untouched:', entry.relPath, '-', err.message)
    throw new AppError(ErrorCodes.TRANSFER_PERMISSION, 'could not preserve a local edit')
  }
}

// Overlay share: the bytes never enter a drive, so the mirror fetches the file by
// its content hash straight to the mount path (hash-verified by the overlay). No
// ensureRemote/release handshake — the holder serves on demand, gated by the
// serve ACL. A null contentHash means the owner is still hashing; retry next tick.
// A local I/O failure pauses the mount via the shared pauseMountForIoError
// classification (full disk / permission / vanished mount); anything else is a
// logged fetch miss.
async function handleOverlayMirrorFetchError(mount, share, entry, err, diag) {
  // Order matters: a local I/O fault pauses the mount and is NOT a peer act. Auditing it would
  // blame a holder for our own full disk.
  if (await pauseMountForIoError(mount, err)) return
  diag.finish('failed')
  if (err?.code === 'EHASHMISMATCH') {
    log.warn('overlay mirror integrity failure — holder served bytes not matching the content hash:', entry.relPath)
    recordMirrorIntegrityFailure(mount, share, entry)
  } else log.debug('overlay mirror fetch failed:', entry.relPath, '-', err.message)
}

async function materializeOverlayFile(mount, share, entry, opts = {}) {
  const hashOf = opts.hashOf || overlayHashFile
  const verifyKey = mount.shareId + '|' + entry.relPath
  // Overlay content hashes are leaf/size-prefixed, NOT plain blake2b — compare
  // the on-disk copy with the overlay hasher, or the skip/adopt checks never
  // match and the mirror re-fetches every file every tick.
  const localRelPath = await state.resolveLocalRelPath(mount, entry.relPath, entry.contentHash, hashOf, opts.synced || state.syncedSetFor(mount), opts.fresh)
  const abs = pathFromMount(mount.mountPath, localRelPath)
  let onDisk = null
  try { onDisk = await fs.promises.stat(abs) } catch {}
  // Retained past the checks below: it is the evidence the ancestor comparison needs, and hashing
  // a multi-GB file twice in one pass to re-derive it would undo FIX-MIRROR-REHASH.
  let diskHash = null
  if (onDisk?.isFile() && entry.contentHash) {
    // Already-mirrored file: the verified record skips the full re-hash the poll
    // would otherwise run over every file each tick; only hash on a cache miss.
    if (await isVerifiedUnchanged(mount.spaceId, verifyKey, entry.contentHash, entry.size, onDisk)) return 'present'
    try {
      diskHash = await hashOf(abs)
      if (diskHash === entry.contentHash) {
        await markVerified(mount.spaceId, verifyKey, entry.contentHash)
        return 'present'
      }
    } catch (err) { log.debug('overlay hash skipped on disk:', err.message) }
  }
  if (!entry.contentHash) return 'missing'
  // A manual download of the same file may already be in flight (mounted mid-download): fetching it
  // here too would interleave two producers on one decoration key and duplicate the bytes. A cheap
  // early-out so we do not queue for a slot to do it; the claim taken past the gate decides. Another
  // OWNER only — our own overlapping pass (a tick racing an adopted initial scan) is serialised by
  // activeOverlayFetches, and refusing it here would change what FIX-R09-2 pins.
  const claimedBy = fetchClaimedBy(transferIdFor(mount.spaceId, mount.shareId, entry.relPath))
  if (claimedBy && claimedBy !== FETCH_OWNER_MIRROR) return 'missing'
  const streamKey = loopKey(mount.spaceId, mount.shareId)
  const releaseSlot = await acquireMirrorSlot(streamKey)
  try {
    // Fall back to the LIVE generation rather than undefined: loops.stopped compares against it,
    // so an absent gen would read as 'stopped' and refuse every fetch. A caller without one still
    // gets the check it needs — a stop landing during the wait above.
    return await fetchOverlayEntry(mount, share, entry, { abs, verifyKey, streamKey, gen: opts.gen ?? mirrorGen(streamKey), diskHash, localExists: !!onDisk?.isFile() })
  } finally {
    releaseSlot()
  }
}

// A parked pass is in flight as far as pass-liveness is concerned, so mirrorVerdict would condemn
// it after pollInterval x STALL_FACTOR (10 minutes) and the Supervisor would restart it — churn
// whose cause is a queue, not a wedge. Stamping progress either side of the wait is not enough:
// the wait is unbounded and can outlast the window on its own. Heartbeat through it instead, so
// the verdict measures the fetch rather than the queue. Before this gate the mirror never waited.
//
// Never express: a background materialize must not outrank a click. Taken BEFORE the in-flight
// record, because cancelInflightFetch reads that record — a stop landing while this is parked
// would ask the vendor layer to cancel a fetch that never started, and would tell the holder we
// paused a transfer we never began.
async function acquireMirrorSlot(streamKey) {
  loops.noteProgress(streamKey)
  const beat = setInterval(() => loops.noteProgress(streamKey), getResourceCaps().foreignPollIntervalMs)
  beat.unref?.()
  try {
    return await acquireFetchSlot({ express: false, owner: FETCH_OWNER_MIRROR })
  } finally {
    clearInterval(beat)
    loops.noteProgress(streamKey)
  }
}

// The gated half of a materialize: everything past the slot owns a chunk scheduler, a watchdog,
// an fd and a ticker.
async function fetchOverlayEntry(mount, share, entry, { abs, verifyKey, streamKey, gen, diskHash = null, localExists = false }) {
  // The wait for a slot is unbounded, so re-check the stop the catalog walk tests at every entry.
  if (mirrorStopped(streamKey, gen)) return 'missing'
  // Read AFTER the wait, not before it: the overlay can be torn down while a pass is parked.
  const overlay = getOverlay()
  if (!overlay) return 'missing'
  await fs.promises.mkdir(path.dirname(abs), { recursive: true })
  // Mirror download bar with speed/ETA. The overlay scheduler reports CUMULATIVE
  // bytes; ticker.pushTo diffs them.
  const total = entry.size || 0
  const decoKey = shareDecoKey(mount.shareId, entry.relPath)
  // Taken past the gate, not before it: holding it while queued would make the engine attach to a
  // fetch that has not started. Whoever holds it owns the decoration key until they release.
  const transferId = transferIdFor(mount.spaceId, mount.shareId, entry.relPath)
  const releaseClaim = claimFetch(transferId, FETCH_OWNER_MIRROR)
  if (!releaseClaim) return 'missing'
  let res
  let attempted = false
  let diag = null
  // Everything from here is inside the try, so no throw between the claim and the fetch can leak it.
  try {
    // Move a local edit aside before the fetch renames over it — here, past the gate, rather than
    // in the caller: every early-out above (a claim the engine holds, a stop landing during the
    // unbounded slot wait, the overlay torn down) would otherwise have moved the user's file and
    // then not replaced it, leaving the canonical path empty until a later tick.
    if (localExists) {
      try { await preserveLocalEdit(mount, entry, verifyKey, diskHash, abs) } catch { return 'missing' }
    }
    activeOverlayFetches.set(streamKey, { contentHash: entry.contentHash, relPath: entry.relPath, transferId })
    pausedHolders.supersede(streamKey)
    // The row just flipped to 'downloading' (foreignFetchActive) — poke the list re-derive.
    ipcRef?.emit('event:share-files-updated', { spaceId: mount.spaceId, shareId: mount.shareId })
    // The overlay scheduler reports CUMULATIVE bytes; the ticker diffs them into speed/ETA.
    ;({ res, attempted, diag } = await runOverlayFetch(overlay, entry.contentHash, {
      label: 'overlay mirror',
      relPath: entry.relPath,
      size: total,
      destPath: abs,
      onProgress: ({ bytes, speed, eta }) => ipcRef?.emit('event:decoration', {
        channel: 'transfer', spaceId: mount.spaceId, key: decoKey, bytes, total, speed, eta,
      }),
      onVerify: (fraction) => ipcRef?.emit('event:decoration', {
        channel: 'transfer', spaceId: mount.spaceId, key: decoKey, phase: 'verifying', verifyFraction: fraction, bytes: 0, total,
      }),
      onTick: () => loops.noteProgress(streamKey),
    }))
  } catch (err) {
    // ECANCELLED is a deliberate pause/unmount abort (stopForeignLoop), not a
    // give-up: log it as a stop and keep whatever partial cancelFetch chose to keep.
    if (err?.code === 'ECANCELLED') { err.diag.finish('paused'); return 'missing' }
    await handleOverlayMirrorFetchError(mount, share, entry, err, err.diag)
    return 'missing'
  } finally {
    activeOverlayFetches.delete(streamKey)
    releaseClaim()
    // Every settle (done/miss/error/pause) re-derives the row off the now-cleared fetch slot and
    // terminally clears the row's decoration. No probe: the claim above means no other producer
    // could have taken the key while we held it, so the decoration is ours to clear.
    ipcRef?.emit('event:share-files-updated', { spaceId: mount.spaceId, shareId: mount.shareId })
    ipcRef?.emit('event:decoration', { channel: 'transfer', spaceId: mount.spaceId, key: decoKey, done: true })
  }
  // null = nothing fetched: a stall after a holder was asked is a give-up (WARN);
  // never reaching a holder is a benign retry-next-tick (debug).
  if (!res) { diag.finish(classifyMirrorMiss(attempted)); return 'missing' }
  diag.finish('done')
  // a local hit returns the source path without writing abs — copy the bytes by
  // path (never buffering a possibly multi-GB file in memory).
  if (res.local && res.destPath !== abs) {
    try { fs.copyFileSync(res.destPath, abs) } catch (err) { log.debug('overlay mirror local-copy failed:', entry.relPath, '-', err.message); return 'missing' }
  }
  // The transfer verified the content hash on landing — record it so the row can
  // surface a "verified" indicator without re-hashing.
  await markVerified(mount.spaceId, verifyKey, entry.contentHash)
  return 'present'
}

async function initialMaterializeScanCatalog(mount, share) {
  const key = loopKey(mount.spaceId, mount.shareId)
  const gen = mirrorGen(key)
  // Resolved before the first await: a pass cancelled by an unmount must never recreate a
  // re-mounted key's Set from its stale mount object.
  const synced = state.syncedSetFor(mount)
  const fresh = new Set()
  const { entries: raw, complete } = await getContentBackend(share).listPeerWithMeta(mount.spaceId, share)
  const entries = dropUnsafeEntries(raw, (rel) => log.warn('refusing a peer file path that escapes the mount folder — skipping this entry (the owner drive may be malicious or corrupted):', rel, '(source: catalog-initial)'))
  let allPresent = true
  for (const entry of entries) {
    if (mirrorStopped(key, gen)) return { stopped: true }
    // Own the path BEFORE the write lands: a pass cancelled mid-file must still own what it
    // wrote, or the owner's later delete of that file is never applied.
    state.recordSynced(key, synced, entry.relPath, fresh)
    try {
      if (await materializeCatalogFile(mount, share, entry, { synced, fresh, gen }) === 'missing') allPresent = false
    } catch (err) {
      allPresent = false
      log.debug('catalog initial materialize failed:', entry.relPath, '-', err.message)
    }
  }
  if (mirrorStopped(key, gen)) return { stopped: true }
  // An incomplete drain is a partial view of the owner's catalog, so it may not SHRINK the synced
  // record — union instead, or a mirror that already holds 12 files forgets 8 of them on a
  // truncated re-scan (and with it the evidence a later deletion would be judged against). Only a
  // complete read is authoritative enough to replace the record, or to stamp the scan done.
  if (complete) {
    const listed = new Set(entries.map((e) => e.relPath))
    for (const ownerKey of [...synced]) if (!listed.has(ownerKey)) state.forgetSynced(key, synced, ownerKey)
    mount.initialScanCompletedAt = Date.now()
  }
  mount.status = 'active'
  await patchForeignMount(mount.spaceId, mount.shareId, {
    ...state.syncFields(mount),
    status: 'active',
    // A pass that got through clears the reason with the status: a stale one would name the next
    // fault that records none.
    lastError: null,
    ...(complete ? { initialScanCompletedAt: mount.initialScanCompletedAt } : {}),
  })
  state.markClean(key)
  emitStatus(mount.spaceId, mount.shareId, 'active')
  // Skip the terminal state on an empty or partial listing: at mount the owner's catalog may not
  // have replicated yet, and publishing 'synced' with zero (or truncated) entries would falsely
  // show a fully-merged mirror. A genuinely-empty share settles to 'synced' on a later tick. The
  // gen recheck (adjacent to the enqueue, no await between) stops a concurrent pause from being
  // overwritten.
  if (!mirrorStopped(key, gen) && entries.length > 0 && complete) await settleMirrorSyncState(mount, allPresent)
  return {}
}

async function materializeOnceCatalog(mount, share) {
  const key = loopKey(mount.spaceId, mount.shareId)
  const gen = mirrorGen(key)

  // Read BEFORE the listing: an append landing mid-walk leaves the head past the version this pass
  // records, so the next tick walks. A pass only ever converges against the snapshot it walked.
  const version = await getContentBackend(share).catalogVersion?.(mount.spaceId, share) ?? null
  const skipped = state.skipped(key)
  const decision = shouldWalk({
    // Only a non-null version is ever stored, so a miss and an unknown both read as null.
    watermark: state.watermark(key),
    version,
    skipped,
    fullWalkEvery: getResourceCaps().foreignFullWalkEvery,
  })
  if (!decision.walk) {
    state.noteSkipped(key, skipped + 1)
    // No settle: the pass that converged already wrote the terminal state, and by definition
    // nothing has happened since.
    return
  }
  if (skipped > 0) log.debug('mirror walking after', skipped, 'skipped tick(s):', decision.reason, mount.shareId)
  // A walk invalidates the watermark up front. Only a pass that reaches the convergence test below
  // may re-establish one, so a pass that throws midway — an unlink the OS refuses, a bee put that
  // fails — cannot leave a stale watermark standing over a zeroed skip counter, which would retry
  // the failed work at the backstop's cadence instead of the poll's.
  state.forgetConverged(key)

  const synced = state.syncedSetFor(mount)
  const fresh = new Set()
  const { entries: raw, complete } = await getContentBackend(share).listPeerWithMeta(mount.spaceId, share)
  const entries = dropUnsafeEntries(raw, (rel) => log.warn('refusing a peer file path that escapes the mount folder — skipping this entry (the owner drive may be malicious or corrupted):', rel, '(source: catalog-tick)'))
  const onDrive = new Map(entries.map((e) => [e.relPath, e]))
  let allPresent = true
  for (const [, entry] of onDrive) {
    if (mirrorStopped(key, gen)) return
    state.recordSynced(key, synced, entry.relPath, fresh)
    try {
      if (await materializeCatalogFile(mount, share, entry, { synced, fresh, gen }) === 'missing') allPresent = false
    } catch (err) {
      allPresent = false
      log.debug('catalog materialize failed:', entry.relPath, '-', err.message)
    }
  }

  if (mirrorStopped(key, gen)) return

  const honorDeletions = shouldHonorDeletions({
    ownerOnline: isOwnerOnline(mount.ownerKey),
    driveCount: onDrive.size,
    listingComplete: complete,
  })
  if (honorDeletions) {
    for (const ownerKey of [...synced]) {
      if (onDrive.has(ownerKey)) continue
      if (relKeyEscapes(ownerKey)) {
        log.warn('refusing to honor a stored sync path that escapes the mount folder — skipping deletion:', ownerKey)
        state.forgetSynced(key, synced, ownerKey)
        continue
      }
      await applyChange(mount, { action: 'del', relPath: ownerKey, localRelPath: localRelOf(mount, ownerKey) })
      state.forgetSynced(key, synced, ownerKey)
    }
    state.pruneRenamedPaths(mount, onDrive)
  }
  // Once per pass and only when something changed — the old code wrote the whole record on every
  // tick of an owner-online mirror, whether or not anything moved.
  await state.persist(mount, key, gen)
  // Nothing left to do: every file present, the listing a full read, and no path still owned that the
  // catalog no longer lists. Every entry in the listing was recorded into `synced` above, so the
  // listing is a subset of the Set and equal sizes prove the two agree — an O(1) test for
  // "no deletions pending".
  //
  // Deliberately NOT gated on `honorDeletions`: that gate says whether this pass was ALLOWED to act
  // on deletions, not whether any exist. An offline owner cannot append, so it is exactly when
  // skipping is safest — and if deletions really are outstanding the size check catches them and the
  // mirror keeps walking. A cancelled pass proves nothing, and a version we could not read cannot
  // authorise a later skip.
  const converged = allPresent && complete && synced.size === onDrive.size
  if (converged && version !== null && !mirrorStopped(key, gen)) state.setWatermark(key, version)
  // Re-check the generation adjacent to the enqueue (no await between) so a pause/unmount that
  // landed during the deletion-reconcile await above can't be overwritten by this terminal write.
  if (!mirrorStopped(key, gen)) await settleMirrorSyncState(mount, allPresent)
}

// A mount whose share is no longer in the owner's live list is usually just a transient
// replication gap — but the orphaned mirror must be torn down (stop the loop, drop the mount;
// materialized files stay on disk, matching owner-delete behaviour) once the owner is gone for good,
// in either of two ways: the owner LEFT the space (no longer in space.members — robust even when its
// tombstone never replicates, e.g. an offline leaver), or the owner DELETED the share (profile-bee
// tombstone). A genuinely-unreadable share whose owner is still a member is left alone to retry.
async function maybeUnmountIfOwnerGone(mount) {
  if (await ownerLeftSpace(mount.spaceId, mount.ownerKey)) {
    log.info('owner left space — unmounting orphaned mirror', mount.shareId, '(files kept on disk)')
    await unmountForeignFolder(mount.spaceId, mount.shareId)
    return
  }
  const { readPeerShareEntry } = await import('../shares/shares.js')
  const raw = await readPeerShareEntry(mount.ownerKey, mount.spaceId, mount.shareId)
  if (raw && raw.deletedAt) {
    log.info('owner removed share', mount.shareId, '— unmounting orphaned mirror (files kept on disk)')
    await unmountForeignFolder(mount.spaceId, mount.shareId)
  }
}

// Positive evidence only: true when we hold the space's member list and the owner is absent from it
// (left, or fold-dropped). Unknown/not-yet-loaded membership returns false so a boot/transient gap
// never triggers a spurious unmount.
async function ownerLeftSpace(spaceId, ownerKey) {
  // Our own share (self-mirror) — we never "leave" our own space; space.members lists OTHERS only.
  if (ownerKey === getLocalPublicKeyHex()) return false
  const space = await getSpace(spaceId)
  if (!space || !Array.isArray(space.members)) return false
  return !space.members.some((m) => m.publicKey === ownerKey)
}

// One verdict per mount that has a live loop. A mount with no loop is not reported: it is paused,
// unmounted or gone, none of which this can or should recover.
export function mirrorHealth({ now = Date.now() } = {}) {
  const pollIntervalMs = getResourceCaps().foreignPollIntervalMs
  return loops.entries().map((loop) => ({
    ...loop,
    ...mirrorVerdict(loops.liveness(loop.key), { now, pollIntervalMs }),
  }))
}

// Un-wedge one mirror: the stop generation-invalidates a hung pass so it bails at its next
// checkpoint without writing, and the restart drops the dead in-flight promise the stop leaves
// behind — without that the fresh interval coalesces straight back onto it.
export async function restartForeignLoop(spaceId, shareId) {
  loops.restart(loopKey(spaceId, shareId), { spaceId, shareId })
    .catch((err) => log.debug('materialize tick after restart failed:', err.message))
}

// Abort the file this mount is fetching right now. discardPartial:false (pause) keeps the partial
// + journal so the next tick resumes; true (unmount) unlinks it. cancelFetch also tells the holder
// we paused/stopped, so its "who is downloading" indicator clears now rather than on the idle
// sweep. A pause releases the fetch slot while the holder still shows us paused, so the hash is
// remembered and a later unmount with no live fetch tells the holder we stopped.
function cancelInflightFetch(key, discardPartial) {
  const inflight = activeOverlayFetches.get(key)
  if (inflight) {
    try { getOverlay()?.cancelFetch(inflight.contentHash, { discardPartial }) } catch {}
    activeOverlayFetches.delete(key)
    // A cancelled pass may never settle at all — a wedged fetch is exactly what restartForeignLoop
    // exists to recover — so the claim cannot wait for its finally, or the restart is refused by
    // the dead claim of the pass it just gave up on.
    dropFetchClaim(inflight.transferId)
    if (discardPartial) pausedHolders.supersede(key)
    else pausedHolders.remember(key, inflight.contentHash)
  } else if (discardPartial) {
    pausedHolders.stop(key)
  }
}

export function stopForeignLoop(spaceId, shareId, { discardPartial = false } = {}) {
  loops.stop(loopKey(spaceId, shareId), { discardPartial })
}

// discardPartial stays false — a shutdown is a pause, not an unmount: the partial and its journal
// are what let the next boot resume instead of refetching.
function stopAllForeignLoops({ settleMs = 5000 } = {}) {
  return loops.stopAll({ settleMs })
}

// Owns the mirror loops as a set: _open is the module's wiring, _close is the bulk stop the
// per-mount stopForeignLoop never had a caller for.
export class ForeignMirrors extends Subsystem {
  constructor(name, deps) { super(name, deps); this.require('ipc'); this.units = new Map() }
  async _open() { initForeignFolders(this.deps.ipc) }
  // stopAllForeignLoops pauses rather than unmounts, so it is the one path that FILLS
  // pausedHolders. Without the clear the hashes outlive the subsystem that recorded them, and a
  // later open inherits markers for fetches belonging to a previous lifetime.
  // The scoped drain comes first: a pass parked on the shared fetch gate cannot observe the
  // generation bump stopAllForeignLoops relies on, and would hold the 1500 ms tier budget open
  // until the 5000 ms settle timeout. Scoped to FETCH_OWNER_MIRROR because OverlayBackend closes
  // AFTER us — an unscoped drain would release the two engines' backlog into an overlay that is
  // still live, and those tasks pass their own hasOverlay() guard.
  async _close() {
    drainFetchSlots(FETCH_OWNER_MIRROR)
    await stopAllForeignLoops()
    pausedHolders.clear()
    integritySeen.clear()
  }

  // Counts, not identifiers: diagnostics:export is user-shareable and redacts peer keys and
  // topics, so space and share ids must not ride along. The probe names the mount in the worker
  // log instead.
  health() {
    const open = !this.closed && !this.stopping
    const mirrors = open ? mirrorHealth() : []
    const wedged = mirrors.filter((mirror) => !mirror.ok)
    return {
      ok: open && wedged.length === 0,
      detail: wedged.length ? wedged.map((mirror) => mirror.detail).join('; ') : null,
      mirrors: { total: mirrors.length, wedged: wedged.length },
    }
  }

  // One unit per mount with a live loop. A mount without one is not reported: it is paused,
  // unmounted or gone, none of which a recovery can or should address. The ids are remembered so
  // recover() needs no key parsing — a share id is opaque and splitting it would be a guess.
  supervise({ now = Date.now() } = {}) {
    if (this.closed || this.stopping) return []
    const rows = mirrorHealth({ now })
    this.units = new Map(rows.map((row) => [row.key, { spaceId: row.spaceId, shareId: row.shareId }]))
    return rows.map((row) => ({ key: row.key, ok: row.ok, detail: row.detail, label: row.shareId }))
  }

  async recover(key) {
    if (this.stopping) return
    const unit = this.units.get(key)
    if (!unit) return
    await restartForeignLoop(unit.spaceId, unit.shareId)
  }
}

// Every cache here is keyed by mount PATH in effect, not by path itself: the synced Set records
// which entries this mount already owns on disk. Both unmount and relocate must drop them — an
// inherited Set would claim files exist at a path the mount no longer uses.
function resetForeignSyncState(spaceId, shareId) {
  const key = loopKey(spaceId, shareId)
  state.reset(key)
  loops.forgetLiveness(key)
}

export async function unmountForeignFolder(spaceId, shareId) {
  stopForeignLoop(spaceId, shareId, { discardPartial: true })
  // Only here, not in stopForeignLoop: that runs on pause and on a health restart too, and
  // re-arming there would re-record the same mismatch on every resume.
  integritySeen.forget(loopKey(spaceId, shareId))
  // Overlay copies no bytes into a drive (it serves straight from the owner's
  // source), so there is no per-share blob cache to reclaim on unmount — the
  // materialized files stay on disk, matching owner-delete behaviour.
  await deleteForeignMount(spaceId, shareId)
  // The Set's lifetime is the record's: drop it with the record so a re-mount starts from the
  // persisted array again rather than inheriting this mount's ownership.
  resetForeignSyncState(spaceId, shareId)
  await syncMirrorRecord(spaceId, shareId, () => tombstoneMirror(spaceId, shareId))
  emitStatus(spaceId, shareId, 'idle')
  ipcRef?.emit('event:share-files-updated', { spaceId, shareId })
}

// Move the mount, not the bytes. `discardPartial` is deliberately NOT passed to the stop: a
// half-written file at the old path is the user's to keep or delete, and deleting it here would
// destroy data the relocate never promised to touch.
//
// Everything that can fail happens BEFORE anything is torn down — same rule as pauseMount and
// resumeIndex — so a failed write leaves a mount that is still running against its old path rather
// than one with no loop, no caches and a record that disagrees with both.
export async function relocateForeignFolder(spaceId, shareId, mountPath) {
  const mount = await getForeignMount(spaceId, shareId)
  if (!mount) throw new AppError(ErrorCodes.MOUNT_NOT_ON_DEVICE, 'Mount not found')

  const enabled = mount.enabled !== false
  // A disabled mount keeps the status it was disabled WITH. Collapsing an auto-pause
  // ('mount-point-gone', 'paused-enospc') into a plain user 'paused' would take it out of the
  // auto-pause set and permanently disable the auto-resume that exists to rescue exactly the
  // mirrors this verb is used on.
  const status = enabled ? 'scanning' : (mount.status ?? 'paused')
  // A read-merge, never a whole-object write-back: the snapshot above predates this await, so
  // putting it back would resurrect an `enabled`/`status` a concurrent pause had already written.
  const patched = await patchForeignMount(spaceId, shareId, { mountPath, status, syncedPaths: [], renamedPaths: {} })
  if (!patched) throw new AppError(ErrorCodes.MOUNT_NOT_ON_DEVICE, 'Mount not found')

  stopForeignLoop(spaceId, shareId)
  resetForeignSyncState(spaceId, shareId)
  // stopForeignLoop deliberately leaves the in-flight pass alone; without this a pass still
  // running against the OLD path makes every later tick coalesce onto that dead promise, and
  // because a coalesced call never marks a pass started, the liveness probe reports it healthy.
  loops.dropInFlight(loopKey(spaceId, shareId))
  emitStatus(spaceId, shareId, status)

  const next = await getForeignMount(spaceId, shareId)
  if (enabled && next) {
    await syncMirrorRecord(spaceId, shareId, () => setMirrorState(spaceId, shareId, 'syncing'))
    await startForeignLoop(next)
    runMaterializeTick(spaceId, shareId).catch((err) => log.debug('relocate tick failed:', shareId, '-', err.message))
  }
  ipcRef?.emit('event:share-files-updated', { spaceId, shareId })
  return next
}

export async function setForeignEnabled(spaceId, shareId, enabled) {
  const mount = await getForeignMount(spaceId, shareId)
  if (!mount) throw new AppError(ErrorCodes.MOUNT_NOT_ON_DEVICE, 'Mount not found')
  const wasEnabled = mount.enabled !== false
  mount.enabled = enabled
  mount.status = enabled ? 'active' : 'paused'
  if (enabled) mount.lastError = null
  await saveForeignMount({ ...mount, ...state.syncFields(mount) })
  if (enabled) {
    await startForeignLoop(mount)
    // Only a genuine resume (was paused) touches the record and re-evaluates now: set 'syncing',
    // then kick an immediate tick so a mirror with nothing left to fetch settles straight back to
    // 'synced' instead of blinking for a whole poll interval. A redundant enable of an already-
    // active mount must not blink 'synced'->'syncing'.
    if (!wasEnabled) {
      await syncMirrorRecord(spaceId, shareId, () => setMirrorState(spaceId, shareId, 'syncing'))
      runMaterializeTick(spaceId, shareId).catch((err) => log.debug('foreign resume tick failed:', shareId, '-', err.message))
    }
  } else {
    stopForeignLoop(spaceId, shareId)
    await syncMirrorRecord(spaceId, shareId, () => setMirrorState(spaceId, shareId, 'paused'))
  }
  emitStatus(spaceId, shareId, mount.status)
  return mount
}

export async function findForeignMount(shareId) {
  return await findForeignMountByShareId(shareId)
}
