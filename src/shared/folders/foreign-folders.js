// The mirror engine for foreign folders: another member's share materialized read-only
// to a local mount path. A per-mount loop lists the owner's catalog (the replicated
// file listing) and materializes the diff — files are fetched by content hash through
// the overlay backend and land as partials that rename into place; deletions are
// honored only for files the mirror itself wrote (syncedPaths) and only while the
// owner is provably online, so a lagged replica or a user's own files are never wiped.

import { MOUNT_STATUS, MIRROR_STATE } from '../contract/statuses.js'
import fs from 'bare-fs'

import { onPeerOnline } from '../network/swarm.js'

import { getSpace } from '../spaces/space.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { getResourceCaps } from '../core/runtime-config.js'
import { getForeignMount, mutateForeignMount, deleteForeignMount, patchForeignMount } from './mount-store.js'
import { setMirrorState, tombstoneMirror } from './mirror-records.js'

import { AppError } from '../core/errors.js'
import { CODES } from '../contract/errors.js'
import { pathFromMount } from './path-guard.js'

import { hasContentBackend } from '../transfer/content-backends.js'

import { setOverlayCatalogChangeHook } from '../transfer/backends/overlay/overlay-backend.js'

import { drainFetchSlots, FETCH_OWNER_MIRROR } from '../transfer/backends/overlay/fetch-gate.js'

import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { mirrorVerdict } from './mirror-policy.js'
import { createMirrorLoops } from './mirror-loop.js'
import { createMirrorState } from './mirror-state.js'

import { initMirrorFetch, foreignFetchActive, cancelInflightFetch, resetMirrorFetch, forgetMirrorFetch } from './mirror-fetch.js'
import {
  initMirrorPass,
  setMirrorReachability,
  runMaterializeTick,
  materializeCatalogFile,
  initialMaterializeScanCatalog,
  materializeOnce,
  resetMirrorPass,
} from './mirror-pass.js'
import { initForeignPause, recordMirrorScanFault, isAutoPaused, autoPauseForeignMountGone, resumeAutoPausedForeignMount } from './foreign-pause.js'

// The pause ladder keeps its address here: mounts-runtime and the IPC layer reach the mirror
// through this module, and a mount's fault is one of its verbs.
export { recordMirrorScanFault, isAutoPaused, autoPauseForeignMountGone, resumeAutoPausedForeignMount }
export { foreignFetchActive }

export { setMirrorReachability, runMaterializeTick, materializeCatalogFile }

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
let unsubscribePeerOnline = null

// test seam — production starts the mirror through this file's own _open()
export function initForeignFolders(_ipc) {
  ipcRef = _ipc
  initForeignPause({ state, stopForeignLoop, syncMirrorRecord, emitStatus, setForeignEnabled })
  initMirrorFetch({ state, loops, getIpc: () => ipcRef })
  initMirrorPass({
    state,
    loops,
    applyChange,
    emitStatus,
    loadShareForForeignMount,
    settleMirrorSyncState,
    maybeUnmountIfOwnerGone,
  })
  // Materialize promptly when an owner's catalog appends, instead of waiting for
  // the mirror's poll tick.
  setOverlayCatalogChangeHook(onPeerDriveChanged)
  // The other level trigger: a pass gated on an offline owner did nothing at all, so without this
  // an offline->online flip waits out a whole poll interval before the first byte moves.
  unsubscribePeerOnline?.()
  unsubscribePeerOnline = onPeerOnline(onOwnerOnline)
}

function loopKey(spaceId, shareId) {
  return spaceId + ':' + shareId
}

const APPEND_TICK_DEBOUNCE_MS = 250

// Both level triggers poke the same way — every mirror in the space, debounced. A loop record
// carries no ownerKey, and a mirror whose owner is uninvolved re-derives and settles for the price
// of a map lookup, so filtering by owner would buy nothing and cost a mount read per event.
function pokeSpaceMirrors(spaceId) {
  for (const loop of loops.entries()) {
    if (loop.spaceId !== spaceId) continue
    loops.debounce(loop.key, { spaceId: loop.spaceId, shareId: loop.shareId }, APPEND_TICK_DEBOUNCE_MS)
  }
}

// The owner's content changed. Run a materialize tick now (debounced) for each
// active mirror in that space instead of waiting for the 30s poll, so owner-side
// edits/deletes reflect on the mirror's disk as promptly as they do in the folder
// view.
// test seam
export function onPeerDriveChanged(spaceId) {
  pokeSpaceMirrors(spaceId)
}

// A member handshaked into this space. Any mirror of theirs has been skipping its passes on the
// reachability gate, so re-drive now rather than at the next tick.
function onOwnerOnline(_ownerKey, spaceId) {
  pokeSpaceMirrors(spaceId)
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

// The containment-guarded delete primitive, used by the catalog deletion reconcile. pathFromMount
// rejects any owner-controlled relPath that escapes the mount BEFORE the unlink — the
// path-traversal guard the security suite exercises (foreign-path-containment). Puts never come
// here: they are fetched by materializeOverlayFile.
// test seam
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
  return await loops.adopt(key, runInitialMaterializeScan(mount), { spaceId: mount.spaceId, shareId: mount.shareId })
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

// One verdict per mount with a live loop (loops.entries() says why the others are not reported).
// test seam
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
// test seam
export async function restartForeignLoop(spaceId, shareId) {
  loops.restart(loopKey(spaceId, shareId), { spaceId, shareId })
    .catch((err) => log.debug('materialize tick after restart failed:', err.message))
}

// test seam
export function stopForeignLoop(spaceId, shareId, { discardPartial = false } = {}) {
  loops.stop(loopKey(spaceId, shareId), { discardPartial })
}

// discardPartial stays false — a shutdown is a pause, not an unmount: the partial and its journal
// are what let the next boot resume instead of refetching.
function stopAllForeignLoops({ settleMs = 5000 } = {}) {
  return loops.stopAll({ settleMs })
}

// Owns the mirror loops as a set: _open is the module's wiring, _close is the bulk stop.
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
    unsubscribePeerOnline?.()
    unsubscribePeerOnline = null
    resetMirrorPass()
    drainFetchSlots(FETCH_OWNER_MIRROR)
    await stopAllForeignLoops()
    resetMirrorFetch()
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

  // One unit per mount with a live loop. The ids are remembered so recover() needs no key parsing —
  // a share id is opaque and splitting it would be a guess.
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

// Unmount and relocate both come through here: the caches are keyed by the mount path in effect
// (state.reset says why).
function resetForeignSyncState(spaceId, shareId) {
  const key = loopKey(spaceId, shareId)
  state.reset(key)
  loops.forgetLiveness(key)
}

export async function unmountForeignFolder(spaceId, shareId) {
  stopForeignLoop(spaceId, shareId, { discardPartial: true })
  // Only here, not in stopForeignLoop: that runs on pause and on a health restart too, and
  // re-arming there would re-record the same mismatch on every resume.
  forgetMirrorFetch(loopKey(spaceId, shareId))
  // Overlay copies no bytes into a drive (it serves straight from the owner's
  // source), so there is no per-share blob cache to reclaim on unmount — the
  // materialized files stay on disk, matching owner-delete behaviour.
  await deleteForeignMount(spaceId, shareId)
  resetForeignSyncState(spaceId, shareId)
  await syncMirrorRecord(spaceId, shareId, () => tombstoneMirror(spaceId, shareId))
  emitStatus(spaceId, shareId, MOUNT_STATUS.IDLE)
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
  if (!mount) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Mount not found')

  const enabled = mount.enabled !== false
  // A disabled mount keeps the status it was disabled WITH. Collapsing an auto-pause
  // ('mount-point-gone', 'paused-enospc') into a plain user 'paused' would take it out of the
  // auto-pause set and permanently disable the auto-resume that exists to rescue exactly the
  // mirrors this verb is used on.
  const status = enabled ? MOUNT_STATUS.SCANNING : (mount.status ?? MOUNT_STATUS.PAUSED)
  // A read-merge, never a whole-object write-back: the snapshot above predates this await, so
  // putting it back would resurrect an `enabled`/`status` a concurrent pause had already written.
  const patched = await patchForeignMount(spaceId, shareId, { mountPath, status, syncedPaths: [], renamedPaths: {} })
  if (!patched) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Mount not found')

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
  if (!mount) throw new AppError(CODES.MOUNT_NOT_ON_DEVICE, 'Mount not found')
  const wasEnabled = mount.enabled !== false
  mount.enabled = enabled
  mount.status = enabled ? MOUNT_STATUS.ACTIVE : MOUNT_STATUS.PAUSED
  if (enabled) mount.lastError = null
  await mutateForeignMount(spaceId, shareId, (m) => ({
    ...m,
    enabled,
    status: enabled ? MOUNT_STATUS.ACTIVE : MOUNT_STATUS.PAUSED,
    ...(enabled ? { lastError: null } : {}),
    ...state.syncFields(m),
  }))
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
    await syncMirrorRecord(spaceId, shareId, () => setMirrorState(spaceId, shareId, MIRROR_STATE.PAUSED))
  }
  emitStatus(spaceId, shareId, mount.status)
  return mount
}
