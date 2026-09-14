// The mirror engine for foreign folders: another member's share materialized read-only
// to a local mount path. A per-mount loop lists the owner's catalog (the replicated
// file listing) and materializes the diff — files are fetched by content hash through
// the overlay backend and land as partials that rename into place; deletions are
// honored only for files the mirror itself wrote (syncedPaths) and only while the
// owner is provably online, so a lagged replica or a user's own files are never wiped.

import { MOUNT_STATUS, MIRROR_STATE } from '../contract/statuses.js'
import fs from 'bare-fs'
import { shouldHonorDeletions, relKeyEscapes, dropUnsafeEntries } from './path-keys.js'
import { isOwnerOnline, onPeerOnline } from '../transfer/swarm.js'

import { getSpace } from '../spaces/space.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { getResourceCaps } from '../core/runtime-config.js'
import { getForeignMount, mutateForeignMount, deleteForeignMount, patchForeignMount } from './mount-store.js'
import { setMirrorState, tombstoneMirror } from './mirror-records.js'

import { AppError } from '../core/errors.js'
import { CODES } from '../contract/errors.js'
import { pathFromMount } from '../transfer/path-guard.js'

import { getContentBackend, hasContentBackend } from '../transfer/content-backends.js'

import { setOverlayCatalogChangeHook } from '../transfer/backends/overlay/overlay-backend.js'

import { drainFetchSlots, FETCH_OWNER_MIRROR } from '../transfer/backends/overlay/fetch-slots.js'

import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { mirrorVerdict } from './mirror-health.js'
import { createMirrorLoops } from './mirror-loop.js'
import { createMirrorState, localRelOf } from './mirror-state.js'

import { shouldWalk } from './mirror-walk.js'
import { mirrorMayFetch } from './mirror-reach.js'

import { initMirrorFetch, foreignFetchActive, materializeOverlayFile, createMountProbe, cancelInflightFetch, resetMirrorFetch, forgetMirrorFetch } from './mirror-fetch.js'
import { initForeignPause, recordMirrorScanFault, isAutoPaused, autoPauseForeignMountGone, resumeAutoPausedForeignMount } from './foreign-pause.js'

// The pause ladder keeps its address here: mounts-runtime and the IPC layer reach the mirror
// through this module, and a mount's fault is one of its verbs.
export { recordMirrorScanFault, isAutoPaused, autoPauseForeignMountGone, resumeAutoPausedForeignMount }
export { foreignFetchActive }

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

const mirrorGen = (key) => loops.generationOf(key)
const mirrorStopped = (key, gen) => loops.stopped(key, gen)

// Presence is a module-private lease map in swarm.js, so an unreachable owner cannot otherwise be
// staged below the flow layer: a fabricated remote key makes the share unreadable and the pass exits
// before any gate, while a self-mirror is reachable by rule. Overriding the VERDICT rather than
// isOwnerOnline is what lets a readable mount stand in for an absent owner; the rule itself is
// unit-tested in mirror-reach.test.js. The engine carries the same seam as `channel.isOwnerOnline`.
let reachabilityOverride = null
// test seam
export function setMirrorReachability(fn) { reachabilityOverride = fn }

// Read live rather than snapshotted: a pass that starts online and finishes offline re-asks at the
// per-entry gate.
function mayFetch(mount) {
  if (reachabilityOverride) return reachabilityOverride(mount)
  return mirrorMayFetch({
    ownerKey: mount.ownerKey,
    localKey: getLocalPublicKeyHex(),
    ownerOnline: isOwnerOnline(mount.ownerKey),
  })
}

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
// test seam
export async function materializeCatalogFile(mount, share, entry, opts = {}) {
  return await materializeOverlayFile(mount, share, entry, opts)
}

// The half both passes share: materialize every catalog entry and report what the walk learned.
// `stopped` is a cancelled pass, which its caller must return from without writing anything;
// `noPeers` is a pass that gave up early because there was nothing to fetch from, which leaves its
// view of the catalog a prefix — the same partial view a truncated listing gives.
async function materializeEntries(mount, share, entries, { key, gen, synced, fresh, label }) {
  let allPresent = true
  const probe = createMountProbe(mount)
  // Asked once, not per entry: a walk that cannot fetch can still ADOPT — reporting what is already
  // on disk needs no holder, and it is the difference between a fully-mirrored folder converging
  // across an outage and reporting "syncing" until the owner returns. A drop mid-pass is caught by
  // the fetch itself returning no-peers.
  const canFetch = mayFetch(mount)
  if (!canFetch) log.debug('mirror pass will adopt only — owner offline:', mount.shareId)
  for (const entry of entries) {
    if (mirrorStopped(key, gen)) return { allPresent, noPeers: false, stopped: true }
    // Own the path BEFORE the write lands: a pass cancelled mid-file must still own what it
    // wrote, or the owner's later delete of that file is never applied.
    state.recordSynced(key, synced, entry.relPath, fresh)
    try {
      const outcome = await materializeCatalogFile(mount, share, entry, { synced, fresh, gen, probe, noFetch: !canFetch })
      // A NOT-present test rather than a list of miss values: a future outcome must never read as
      // done and let a file that was never fetched count toward convergence.
      if (outcome !== 'present') allPresent = false
      if (outcome === 'no-peers') {
        log.debug('mirror pass stopped early — nothing to fetch from:', mount.shareId)
        return { allPresent, noPeers: true, stopped: false }
      }
    } catch (err) {
      allPresent = false
      log.debug(label, entry.relPath, '-', err.message)
    }
  }
  // An adopt-only walk read the whole catalog and every file on disk, so its view is COMPLETE — it
  // simply could not fetch what was missing. Calling it a prefix would stop the scan ever settling.
  return { allPresent, noPeers: false, stopped: false }
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
  const walk = await materializeEntries(mount, share, entries, {
    key, gen, synced, fresh, label: 'catalog initial materialize failed:',
  })
  if (walk.stopped || mirrorStopped(key, gen)) return { stopped: true }
  const allPresent = walk.allPresent
  // A pass that stopped early walked a PREFIX of the catalog, which is the same thing a truncated
  // listing is — so it may not replace the synced record or stamp the scan done either.
  const listingComplete = complete && !walk.noPeers
  // An incomplete drain is a partial view of the owner's catalog, so it may not SHRINK the synced
  // record — union instead, or a mirror that already holds 12 files forgets 8 of them on a
  // truncated re-scan (and with it the evidence a later deletion would be judged against). Only a
  // complete read is authoritative enough to replace the record, or to stamp the scan done.
  if (listingComplete) {
    const listed = new Set(entries.map((e) => e.relPath))
    for (const ownerKey of [...synced]) if (!listed.has(ownerKey)) state.forgetSynced(key, synced, ownerKey)
    mount.initialScanCompletedAt = Date.now()
  }
  mount.status = MOUNT_STATUS.ACTIVE
  await patchForeignMount(mount.spaceId, mount.shareId, {
    ...state.syncFields(mount),
    status: MOUNT_STATUS.ACTIVE,
    // A pass that got through clears the reason with the status: a stale one would name the next
    // fault that records none.
    lastError: null,
    ...(listingComplete ? { initialScanCompletedAt: mount.initialScanCompletedAt } : {}),
  })
  state.markClean(key)
  emitStatus(mount.spaceId, mount.shareId, MOUNT_STATUS.ACTIVE)
  // Skip the terminal state on an empty or partial listing: at mount the owner's catalog may not
  // have replicated yet, and publishing 'synced' with zero (or truncated) entries would falsely
  // show a fully-merged mirror. A genuinely-empty share settles to 'synced' on a later tick. The
  // gen recheck (adjacent to the enqueue, no await between) stops a concurrent pause from being
  // overwritten.
  if (!mirrorStopped(key, gen) && entries.length > 0 && listingComplete) await settleMirrorSyncState(mount, allPresent)
  return {}
}

// error, not warn: this is the mirror declining to delete the user's files on an implausible
// listing, and it is the one line that explains a mirror that has stopped tracking deletions.
// Nothing is forgotten from the synced set, so a later pass re-evaluates rather than losing the
// fact. Quiet below the floor, where a withheld pass just means the owner was offline.
function logWithheldDeletions(key, pending, syncedSize, minDeletions) {
  if (pending <= minDeletions) return
  log.error('withholding', pending, 'mirror deletions of', syncedSize,
    'synced paths — the owner catalog shrank implausibly; keeping the local files:', key)
}

async function materializeOnceCatalog(mount, share) {
  const key = loopKey(mount.spaceId, mount.shareId)
  const gen = mirrorGen(key)

  // Nothing this pass is allowed to do: an offline owner cannot append, so the catalog cannot have
  // moved, and shouldHonorDeletions already refuses to act on deletions while they are away — every
  // fetch would just burn the overlay's peer wait to learn there is no holder. Returning HERE,
  // above the version read and above forgetConverged, is what lets a converged mirror keep its
  // watermark across an outage. onOwnerOnline re-drives on their handshake, so being wrong costs
  // latency, never a stuck mirror.
  if (!mayFetch(mount)) {
    log.debug('mirror tick skipped — owner offline:', mount.shareId)
    return
  }

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
  const walk = await materializeEntries(mount, share, onDrive.values(), {
    key, gen, synced, fresh, label: 'catalog materialize failed:',
  })
  if (walk.stopped || mirrorStopped(key, gen)) return
  const allPresent = walk.allPresent
  // A pass that stopped early walked a PREFIX of the catalog — the same partial view a truncated
  // listing gives, and the two things that must not act on one are the same: the deletion reconcile
  // and the convergence test.
  const listingComplete = complete && !walk.noPeers

  // Resolved BEFORE the gate rather than inside the loop: the gate now weighs how MANY files a
  // pass would remove, which cannot be known one key at a time.
  const pendingDeletions = [...synced].filter((ownerKey) => !onDrive.has(ownerKey))
  const caps = getResourceCaps()
  const honorDeletions = shouldHonorDeletions({
    // mayFetch, not raw isOwnerOnline: presence never leases our own key, so a self-mirror read as
    // offline here would refuse the owner's deletions forever. Same rule as the fetch gate.
    ownerOnline: mayFetch(mount),
    driveCount: onDrive.size,
    listingComplete,
    syncedCount: synced.size,
    deletionCount: pendingDeletions.length,
    minDeletions: caps.minMirrorDeletions,
    maxDeletionRatio: caps.maxMirrorDeletionRatio,
  })
  if (!honorDeletions) logWithheldDeletions(key, pendingDeletions.length, synced.size, caps.minMirrorDeletions)
  if (honorDeletions) {
    for (const ownerKey of pendingDeletions) {
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
  // Once per pass, only when dirty.
  await state.persist(mount, key, gen)
  // Converged = every file present, the listing a full read, and no owned path the catalog no longer
  // lists. Every listed entry was recorded into `synced` above, so the listing is a subset of the Set
  // and equal sizes prove "no deletions pending" in O(1).
  //
  // Deliberately NOT gated on `honorDeletions`: that gate says whether this pass was ALLOWED to act
  // on deletions, not whether any exist. An offline owner cannot append, so it is exactly when
  // skipping is safest; if deletions really are outstanding the size check catches them and the
  // mirror keeps walking. A cancelled pass proves nothing, and a version we could not read cannot
  // authorise a later skip.
  const converged = allPresent && listingComplete && synced.size === onDrive.size
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
    // A leaked override disables fetching for every mount in the process, not just a test's own.
    reachabilityOverride = null
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
