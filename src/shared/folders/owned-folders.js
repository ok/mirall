// Owner side of folder sharing: keeps a mounted disk folder (an "owned folder") published into its
// share's catalog. Every producer — mount, relocate, boot, the watcher, the catch-up and the
// periodic reconcile — computes a diff and enqueues work items on the shared publish service; the
// folder channel resolves, publishes and retires them. A missing mount root always pauses
// publishing instead of tombstoning the catalog.
//
// This module is the composition root: it owns the subsystem's lifetime and hands the leaves below
// their collaborators. The leaves never import it back.
import { clearShareGuards } from './echo-guard.js'
import { getOwnedMount } from './mount-store.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { setFolderPublishLane } from '../transfer/backends/overlay/overlay-maintenance.js'
import { countDiskFiles } from './walk-disk.js'
import { DEFAULT_IGNORE } from './path-keys.js'
import { OP, PRIORITY } from './work-item.js'
import { settleCatalog } from './publish-service.js'
import { getReconcileStallWindowMs } from '../core/runtime-config.js'
import { ownedKey } from './owned-policy.js'
import { createOwnedState } from './owned-state.js'
import { createOwnedProgress, INDEX_ANNOUNCE_MS } from './owned-progress.js'
import { passLiveness, initOwnedPass, runPublishPass, abortScan, cancelPass, abortAllPasses, resetPasses } from './owned-pass.js'
import { initOwnedWatcher, stopWatcher, forgetCatchup, drainCatchups } from './owned-watcher.js'
// Imported for its registration side effect: the publish service dispatches on a channel that has
// to exist before the first item is enqueued.
import { initOwnedChannel } from './owned-channel.js'

const log = createLogger('owned-folders')

const state = createOwnedState()

// Set by OwnedFolders._open, so the leaves can arm through the running instance's timer set and
// reach its scheduler. `timers` doubles as the open flag: a leaf with no live set has no subsystem
// to belong to.
let timers = null
let scheduler = null
let progress = null

function sched() {
  if (!scheduler) throw new Error('owned-folders: not started')
  return scheduler
}

// test seam — production starts owned folders through this file's own _open()
export function initOwnedFolders(ipc, { settleScan = null, broadcastIndex = null, indexAnnounceMs = INDEX_ANNOUNCE_MS } = {}) {
  const emit = (event, payload) => ipc?.emit(event, payload)

  progress?.reset()
  progress = createOwnedProgress({
    timers: () => timers,
    emit,
    broadcast: (spaceId, payload) => broadcastIndex?.(spaceId, payload),
    statusFor: (spaceId, shareId) => scheduler?.statusFor(spaceId, shareId),
    announceMs: indexAnnounceMs,
  })

  initOwnedPass({ state, scheduler: sched, emit })
  initOwnedWatcher({
    timers: () => timers,
    scheduler: sched,
    runPassFor: reconcileOwnedShare,
    settleScan,
    emit,
  })
  initOwnedChannel({
    state,
    emit,
    onProgress: (spaceId, shareId) => progress?.poke(spaceId, shareId),
    onFlush: (spaceId, shareId) => progress?.flush(spaceId, shareId),
  })

  // The backend's presence sweep proposes reclaims onto this lane rather than writing tombstones
  // itself. Installed here rather than by the service, which must not import the backend.
  setFolderPublishLane({
    isPending: (spaceId, shareId, relPath) => scheduler?.isPending(spaceId, shareId, relPath) ?? false,
    enqueueRetire: (spaceId, shareId, relPath) => sched().enqueue({ spaceId, shareId, relPath, op: OP.RETIRE, priority: PRIORITY.BULK }).settled,
    // A bulk retire writes through the space's catalog batch, so the item settles before the
    // tombstone is durable. An awaited sweep has to outlast the flush, not the enqueue.
    settle: (spaceId) => settleCatalog(spaceId),
  })
}

// test seam
export function stopIndexAnnounce() {
  progress?.stopAnnounce()
}

// The same pass, given the mount record the caller already holds. The ignore fallback lives here so
// three callers stop each remembering it.
export function reconcileOwnedShare(mount, opts = {}) {
  return runPublishPass(mount.spaceId, mount.shareId, mount.mountPath, mount.ignore || DEFAULT_IGNORE, opts)
}

// The count the worker's admission gate reads. It counts what is on disk under the same key rule
// the publish scan walks by, INCLUDING files the scan will set aside as unreadable — so the gate
// can only ever be stricter than the scan, never looser, and can never admit a folder the scan
// would then find too large.
export async function countFolderFiles(mountPath, ignore) {
  return await countDiskFiles(mountPath, ignore)
}

export function getIndexStatus(spaceId, shareId) {
  return sched().statusFor(spaceId, shareId)
}

export function cancelIndex(spaceId, shareId) {
  abortScan(spaceId, shareId)
  return sched().cancelShare(spaceId, shareId)
}

export function stopOwnedFolder(spaceId, shareId) {
  const key = ownedKey(spaceId, shareId)
  forgetCatchup(key)
  // An unmounted share is not an unhealthy one: the row has to go, or the supervisor reports a
  // folder that is no longer there for the life of the process.
  state.forget(key)
  clearShareGuards(shareId)
  // Tolerant on purpose: this is a cleanup path (leave, unmount, a test teardown) and can legally
  // run after the lane has stopped. The enqueue paths above still fail loudly.
  scheduler?.cancelShare(spaceId, shareId)
}

// Owns the owned-folder side as a set: the catch-up timers, the publish scheduler's in-flight
// work and the caches. stopOwnedFolder stays the per-share stop; this is the bulk one shutdown
// needs, and it waits for the publish executors rather than just cancelling them.
export class OwnedFolders extends Subsystem {
  constructor(name, deps) { super(name, deps); this.require('ipc', 'publishService') }

  async _open() {
    timers = this.timers
    scheduler = this.deps.publishService.scheduler
    initOwnedFolders(this.deps.ipc, {
      settleScan: this.deps.settleScan ?? null,
      broadcastIndex: this.deps.broadcastIndex ?? null,
    })
  }

  async _close() {
    progress?.stopAnnounce()
    stopWatcher()
    setFolderPublishLane(null)
    abortAllPasses()
    await drainCatchups()
    // The scheduler reference is left in place: PublishService closes after this subsystem and
    // drains its executors, whose settling items still poke the channel's callbacks. `progress`
    // going first is what makes those pokes silent.
    progress?.reset()
    progress = null
    resetPasses()
    state.reset()
    timers = null
  }

  // One unit per reconcile pass in flight, keyed by space and share. The label is the same string:
  // the worker log names a unit, and the redacted health() below — which reaches the shareable
  // diagnostics bundle — counts them instead.
  supervise({ now = Date.now() } = {}) {
    if (this.closed || this.stopping) return []
    const rows = passLiveness.verdicts({ now, windowMs: getReconcileStallWindowMs() })
      .map((row) => ({ ...row, label: row.key }))
    const live = new Set(rows.map((row) => row.key))
    // A share we abandoned and have not scanned since, reported until one does. Not recoverable:
    // there is no pass left to abandon, and the next scan is the cadence's job. Reporting it is
    // the point — it is what carries the strike counter across the gap between passes, so a mount
    // that wedges every pass is eventually given up on by name instead of retried forever.
    for (const key of state.abandonedKeys()) {
      if (live.has(key)) continue
      rows.push({ key, label: key, ok: false, recoverable: false, detail: 'scan abandoned, not yet re-run' })
    }
    return rows
  }

  // Abandon the wedged diff. Three steps, none optional: the abort signal stops the walk at its next
  // checkpoint, the runner drops the key so the next request does not coalesce onto a promise that
  // may never settle, and forgetting the heartbeat stops the abandoned pass being reported forever.
  async recover(key) {
    if (this.stopping) return
    const unit = state.unit(key)
    if (!unit) return
    abortScan(unit.spaceId, unit.shareId)
    cancelPass(key)
    passLiveness.forget(key)
    state.abandon(key)
    // Re-armed here, not left to the cadence: the periodic reconcile is six hours out and the watcher
    // fires only on a filesystem event. Safe because the abort signal spans the whole pass.
    const mount = await getOwnedMount(unit.spaceId, unit.shareId)
    // Nothing to scan and nothing to report: the share is no longer mounted here.
    if (!mount) { state.unabandon(key); return }
    // NOT awaited: a fresh pass over a large share outlives the supervisor's recovery budget, and
    // holding that budget open on the mount that just wedged is the one thing a recovery must not
    // do. If this pass wedges too, the strike counter — kept alive by the abandoned row — reaches the
    // give-up limit.
    reconcileOwnedShare(mount)
      .catch((err) => log.debug('reconcile after recovery failed:', unit.shareId, '-', err.message))
  }

  health() {
    const open = !this.closed && !this.stopping
    if (!open) return { ok: false, detail: null }
    const wedged = passLiveness.stalled({ windowMs: getReconcileStallWindowMs() })
    return {
      ok: wedged.length === 0,
      detail: wedged.length ? `${wedged.length} folder scan(s) not advancing` : null,
      scans: { wedged: wedged.length },
    }
  }
}
