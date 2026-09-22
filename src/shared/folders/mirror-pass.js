// The materialize pass: one walk of a mirrored share's catalog, deciding for every entry whether
// it is already right, must be fetched, or must be withheld.
//
// The pass is restartable and the fetch is not, which is the whole reason they are two modules:
// everything here is derived fresh from the catalog each tick, while mirror-fetch.js holds the
// in-flight download, the attempt budget and the integrity ledger across passes.

import fs from 'bare-fs'
import { createLogger } from '../core/logger.js'

import { MOUNT_STATUS } from '../contract/statuses.js'
import { isMountFault } from '../contract/mount-fault.js'
import { getForeignFullWalkEvery, getMirrorDeletionGuard } from '../core/runtime-config.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { getContentBackend, hasContentBackend } from '../transfer/content-backends.js'
import { isOwnerOnline } from '../network/presence-leases.js'
import { createMountProbe, materializeOverlayFile } from './mirror-fetch.js'
import { mirrorMayFetch, mirrorKey, shouldWalk } from './mirror-policy.js'
import { localRelOf } from './mirror-state.js'
import { getForeignMount } from './mount-store.js'
import { dropUnsafeEntries, relKeyEscapes, shouldHonorDeletions } from './path-keys.js'
import { emitMirrorEvent, emitStatus, settleMirrorSyncState } from './mirror-signals.js'
import { pathFromMount } from './path-guard.js'
import { loadShareForForeignMount } from './foreign-shares.js'

const log = createLogger('mirror-pass')

// Injected by foreign-folders.js — the loop generation, the pass writers, the per-mount sync state
// and the orphan check, which reaches the unmount verb and so cannot be imported here without
// closing a cycle.
let state = null
let loops = null
let passWriter = null
let maybeUnmountIfOwnerGone = async () => false

export function initMirrorPass(d) {
  state = d.state
  loops = d.loops
  passWriter = d.passWriter
  maybeUnmountIfOwnerGone = d.maybeUnmountIfOwnerGone
}

const mirrorGen = (key) => loops.generationOf(key)
const mirrorStopped = (key, gen) => loops.stopped(key, gen)

// Presence is a module-private lease map in swarm.js, so an unreachable owner cannot otherwise be
// staged below the flow layer: a fabricated remote key makes the share unreadable and the pass exits
// before any gate, while a self-mirror is reachable by rule. Overriding the VERDICT rather than
// isOwnerOnline is what lets a readable mount stand in for an absent owner; the rule itself is
// unit-tested in mirror-reach.test.js. The engine carries the same seam as `channel.isOwnerOnline`.
let reachabilityOverride = null
/** @internal */
export function setMirrorReachability(fn) { reachabilityOverride = fn }

// A leaked override disables fetching for every mount in the process, not just a test's own.
export function resetMirrorPass() { reachabilityOverride = null }

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
  return await loops.tick(mirrorKey(spaceId, shareId), { spaceId, shareId })
}

export async function materializeOnce(spaceId, shareId) {
  const gen = mirrorGen(mirrorKey(spaceId, shareId))
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
  const writer = passWriter(current, gen)
  if (hasContentBackend(share)) return await materializeOnceCatalog(current, share, { gen, writer })
  // No usable content backend (unsupported / unreadable mode) — don't mirror, but settle the
  // record so it doesn't advertise 'syncing' forever.
  log.debug('skipping mirror tick — no usable content backend:', share.contentMode, shareId)
  await settleMirrorSyncState(writer, current, true)
}

// Route one catalog entry to the read-to-mount: overlay fetches straight from a
// holder by content hash (no peer drive to stream from).
/** @internal */
export async function materializeCatalogFile(mount, share, entry, opts = {}) {
  return await materializeOverlayFile(mount, share, entry, opts)
}

// The half both passes share: materialize every catalog entry and report what the walk learned.
// `stopped` is a cancelled pass, which its caller must return from without writing anything;
// `noPeers` is a pass that gave up early because there was nothing to fetch from, which leaves its
// view of the catalog a prefix — the same partial view a truncated listing gives. `faulted` is a walk
// in which some entry threw rather than reporting an outcome.
async function materializeEntries(mount, share, entries, { key, gen, synced, fresh, label }) {
  let allPresent = true
  let faulted = false
  const probe = createMountProbe(mount)
  // Asked once, not per entry: a walk that cannot fetch can still ADOPT — reporting what is already
  // on disk needs no holder, and it is the difference between a fully-mirrored folder converging
  // across an outage and reporting "syncing" until the owner returns. A drop mid-pass is caught by
  // the fetch itself returning no-peers.
  const canFetch = mayFetch(mount)
  if (!canFetch) log.debug('mirror pass will adopt only — owner offline:', mount.shareId)
  for (const entry of entries) {
    if (mirrorStopped(key, gen)) return { allPresent, noPeers: false, stopped: true, faulted }
    // A walk over files already on disk fetches nothing, so the entry itself is the heartbeat.
    loops.noteProgress(key)
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
        return { allPresent, noPeers: true, stopped: false, faulted }
      }
    } catch (err) {
      allPresent = false
      faulted = true
      log.debug(label, entry.relPath, '-', err.message)
    }
  }
  // An adopt-only walk read the whole catalog and every file on disk, so its view is COMPLETE — it
  // simply could not fetch what was missing. Calling it a prefix would stop the scan ever settling.
  return { allPresent, noPeers: false, stopped: false, faulted }
}

// The initial scan is launched unawaited at boot and on a fresh mount, and it walks the whole
// catalog — so it is exactly the kind of in-flight pass stopAllForeignLoops has to wait for. It
// honours the generation internally (bails between files, re-checks before the trailing persist),
// but the bulk stop can only WAIT for what it sees, hence the same in-flight map the poll tick uses.
//
// The generation is taken when the scan is asked for, before any await, so a pause, unmount or
// relocate that lands while the share is still being read stops it.
/** @internal */
export function mirrorIdleForTests(spaceId, shareId) {
  return loops.idle(mirrorKey(spaceId, shareId))
}

export async function initialMaterializeScan(mount) {
  const key = mirrorKey(mount.spaceId, mount.shareId)
  const gen = mirrorGen(key)
  state.forgetConverged(key)
  return await loops.adopt(key, () => runInitialMaterializeScan(mount, gen), { spaceId: mount.spaceId, shareId: mount.shareId })
}

async function runInitialMaterializeScan(mount, gen) {
  const key = mirrorKey(mount.spaceId, mount.shareId)
  const share = await loadShareForForeignMount(mount)
  if (mirrorStopped(key, gen)) return { stopped: true }
  if (share && hasContentBackend(share)) return await initialMaterializeScanCatalog(mount, share, gen)
  // A share that could not be read says nothing about the folder: the poll tick settles it once it
  // reads, or unmounts it if the owner is gone.
  if (!share) {
    log.warn('skipping mirror scan — share not readable yet:', mount.shareId)
    return { skipped: 'share-unreadable' }
  }
  // No usable content backend — skip the mirror rather than materialize from a path this build
  // can't serve. Still settle the record so it doesn't advertise 'syncing' forever for a mount that
  // can never fetch.
  log.warn('skipping mirror — no usable content backend:', share.contentMode, mount.shareId)
  await settleMirrorSyncState(passWriter(mount, gen), mount, true)
  return { skipped: 'no-content-backend' }
}

// The containment-guarded delete primitive, used by the catalog deletion reconcile. pathFromMount
// rejects any owner-controlled relPath that escapes the mount BEFORE the unlink — the
// path-traversal guard the security suite exercises (foreign-path-containment). Puts never come
// here: they are fetched by materializeOverlayFile.
/** @internal */
export async function applyChange(mount, change) {
  const abs = pathFromMount(mount.mountPath, change.localRelPath || change.relPath)
  if (change.action === 'del') {
    try { await fs.promises.unlink(abs) } catch (err) {
      if (err && err.code !== 'ENOENT') throw err
    }
    emitMirrorEvent('event:share-files-updated', { spaceId: mount.spaceId, shareId: mount.shareId })
  }
}

async function initialMaterializeScanCatalog(mount, share, gen) {
  const key = mirrorKey(mount.spaceId, mount.shareId)
  // Resolved before the first await: a pass cancelled by an unmount must never recreate a
  // re-mounted key's Set or collision map from its stale mount object.
  const synced = state.syncedSetFor(mount)
  state.renamedFor(mount)
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
  // What a cancelled scan owns on disk stays dirty in the mirror state, where the pause's write and
  // the resume tick's persist both read it.
  const writer = passWriter(mount, gen)
  const written = await writer.mutate((m) => ({
    ...m,
    ...state.syncFields(mount),
    status: MOUNT_STATUS.ACTIVE,
    // A pass that got through clears the reason with the status: a stale one would name the next
    // fault that records none.
    lastError: null,
    ...(listingComplete ? { initialScanCompletedAt: mount.initialScanCompletedAt } : {}),
  }))
  if (!written) return { stopped: true }
  state.markClean(key)
  emitStatus(mount.spaceId, mount.shareId, MOUNT_STATUS.ACTIVE)
  // Skip the terminal state on an empty or partial listing: at mount the owner's catalog may not
  // have replicated yet, and publishing 'synced' with zero (or truncated) entries would falsely
  // show a fully-merged mirror. A genuinely-empty share settles to 'synced' on a later tick.
  if (entries.length > 0 && listingComplete) await settleMirrorSyncState(writer, mount, allPresent)
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

// Resolves false when the pass was cancelled part way: it stops deleting at once, because the
// verb that cancelled it may have moved or paused the folder these paths are resolved against.
async function applyDeletions(mount, pendingDeletions, { key, gen, synced }) {
  for (const ownerKey of pendingDeletions) {
    if (mirrorStopped(key, gen)) return false
    if (relKeyEscapes(ownerKey)) {
      log.warn('refusing to honor a stored sync path that escapes the mount folder — skipping deletion:', ownerKey)
      state.forgetSynced(key, synced, ownerKey)
      continue
    }
    await applyChange(mount, { action: 'del', relPath: ownerKey, localRelPath: localRelOf(mount, ownerKey) })
    state.forgetSynced(key, synced, ownerKey)
  }
  return true
}

async function materializeOnceCatalog(mount, share, { gen, writer }) {
  const key = mirrorKey(mount.spaceId, mount.shareId)

  // Nothing this pass is allowed to do: an offline owner cannot append, so the catalog cannot have
  // moved, and shouldHonorDeletions already refuses to act on deletions while they are away — every
  // fetch would just burn the overlay's peer wait to learn there is no holder. Returning HERE,
  // above the version read and above forgetConverged, is what lets a converged mirror skip every
  // tick of an outage. onOwnerOnline re-drives a walk on their handshake, so being wrong costs
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
    fullWalkEvery: getForeignFullWalkEvery(),
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
  //
  // Bound only by a live pass, with no await before the binding: a pass cancelled by an unmount or a
  // relocate must never recreate the key's state from its stale record, nor consume a walk request.
  if (mirrorStopped(key, gen)) return
  state.forgetConverged(key)
  state.beginWalk(key)
  const synced = state.syncedSetFor(mount)
  state.renamedFor(mount)
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
  const guard = getMirrorDeletionGuard()
  const honorDeletions = shouldHonorDeletions({
    // mayFetch, not raw isOwnerOnline: presence never leases our own key, so a self-mirror read as
    // offline here would refuse the owner's deletions forever. Same rule as the fetch gate.
    ownerOnline: mayFetch(mount),
    driveCount: onDrive.size,
    listingComplete,
    syncedCount: synced.size,
    deletionCount: pendingDeletions.length,
    minDeletions: guard.minMirrorDeletions,
    maxDeletionRatio: guard.maxMirrorDeletionRatio,
  })
  if (!honorDeletions) logWithheldDeletions(key, pendingDeletions.length, synced.size, guard.minMirrorDeletions)
  if (honorDeletions) {
    if (!(await applyDeletions(mount, pendingDeletions, { key, gen, synced }))) return
    state.pruneRenamedPaths(mount, onDrive)
  }
  // Once per pass, only when dirty.
  await state.persist(writer, mount, key)
  if (!walk.faulted) await closeScanStatus(writer, mount)
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
  if (converged && version !== null && !state.walkRequested(key) && !mirrorStopped(key, gen)) state.setWatermark(key, version)
  await settleMirrorSyncState(writer, mount, allPresent)
}

// Only the initial scan writes `active`, so a scan that faulted or could not read the share leaves
// the status open; the first tick that walks the catalog without a fault closes it. Otherwise a
// tick never writes status.
async function closeScanStatus(writer, mount) {
  const open = (m) => m.enabled && (m.status === MOUNT_STATUS.SCANNING || isMountFault(m.status))
  if (!open(mount)) return
  const written = await writer.mutate((m) => (open(m) ? { ...m, status: MOUNT_STATUS.ACTIVE, lastError: null } : null))
  if (written) emitStatus(mount.spaceId, mount.shareId, MOUNT_STATUS.ACTIVE)
}
