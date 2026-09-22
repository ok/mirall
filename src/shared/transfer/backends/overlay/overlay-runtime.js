// The overlay as one lifetime: the instance, the serve index, and the two download engines,
// constructed in _open rather than at module level so nothing here runs during import.
//
// Nothing in the package imports this file — only the boot root does — so wiring the modules
// together here adds no edge to the import graph test/integration/import-time guards.
import { Subsystem } from '../../../core/subsystem.js'
import { isOverlayEnabled, isInPlaceFilesEnabled } from '../../../core/runtime-config.js'
import { createOverlayDownloadEngine } from './overlay-download.js'
import { resetFetchSlots, drainFetchSlots } from './fetch-gate.js'
import { registerFetchOwner, resetFetchClaims } from './fetch-gate.js'
import { initOverlay, teardownOverlay, attachOverlay, revokeServesForSpace, bumpServeEpoch } from './overlay-instance.js'
import { serveIndex } from './overlay-serve-index.js'
import { rehydrateOwnedFiles, resetOverlayMaintenance } from './overlay-maintenance.js'
import { resetOverlayPublish } from './overlay-publish.js'
import { initPublishProgress, resetPublishProgress } from './publish-progress.js'
import { initFolderPublish, resetFolderPublish } from './folder-publish.js'
import {
  initFolderDownloads, resetFolderDownloads, folderChannel, setFolderEngine, resumeFolderForOwner,
} from './folder-downloads.js'
import { initLoosePublish, resetLoosePublish } from './loose-publish.js'
import {
  initLooseDownloads, resetLooseDownloads, looseChannel, setLooseEngine, resumeLooseForOwner,
} from './loose-downloads.js'
import { rehydrateLooseFiles, resetLooseMaintenance } from './loose-maintenance.js'
import { listSpaces } from '../../../spaces/space.js'
import { listPendingOwnerKeys } from '../../pending-transfers.js'

const CONTENT_RESUME_COALESCE_MS = 250

export class OverlayBackend extends Subsystem {
  constructor(name, deps) {
    super(name, deps)
    this.require('ipc', 'broadcastSharePrepare')
    this.resumePending = new Map()
    this.overlay = null
    this.folderEngine = null
    this.looseEngine = null
  }

  async _open() {
    const { ipc } = this.deps
    initPublishProgress({ emit: (name, payload) => ipc.emit(name, payload), broadcast: this.deps.broadcastSharePrepare })
    // The instance comes first: the rehydrate below reaches makeServable and enqueueLoosePublish,
    // and both fall through on a null getOverlay() — so a rehydrate that runs ahead of it silently
    // leaves a crash-interrupted entry unhashed and stuck on "Adding".
    if (isOverlayEnabled()) {
      initFolderPublish({ ipc })
      initFolderDownloads({ ipc })
      this.overlay = await initOverlay()
    }
    // The engines are built whatever the overlay flag says. They are inert without an instance
    // (every entry point checks getOverlay()), and on the kill-switch build the alternative is an
    // engine() that throws out of files:list, space:leave and the transfer handlers.
    initLoosePublish({ ipc })
    initLooseDownloads({ ipc })
    // The gate is a module singleton, so unlike the engines it does not die with the previous
    // lifetime: a slot whose release was lost would shrink the cap for every later open.
    resetFetchSlots()
    this.folderEngine = createOverlayDownloadEngine(folderChannel)
    this.looseEngine = createOverlayDownloadEngine(looseChannel)
    setFolderEngine(this.folderEngine)
    setLooseEngine(this.looseEngine)
    // Registered as probes, not copied: each engine's registry already has exactly the lifetime of
    // its fetch. This is what lets the mirror ask "is ANYONE fetching this" instead of asking the
    // folder engine alone, which is the wrong question for a loose row.
    resetFetchClaims()
    registerFetchOwner('folder', (transferId) => this.folderEngine.has(transferId))
    registerFetchOwner('loose', (transferId) => this.looseEngine.has(transferId))
    if (isInPlaceFilesEnabled()) {
      rehydrateLooseFiles().catch((err) => this.log.debug('loose rehydrate failed:', err.message))
    }
    if (!isOverlayEnabled()) return
    // Backgrounded: re-registering every owned file walks and chunk-maps each one.
    rehydrateOwnedFiles().catch((err) => this.log.debug('overlay rehydrate failed:', err.message))
  }

  // Destroys the protocol — and only the protocol — while the sockets its frames travel on are
  // still up, so the peer teardown fires its serve-end callbacks and an interrupted transfer is
  // still recorded. The index, the engines and the instance stay alive for the subsystems that
  // close after the swarms: a publish still settling in PublishService._close needs them.
  // Idempotent, and called by whichever swarm closes first.
  detach() {
    this.overlay?.closeProtocol()
  }

  async _close() {
    for (const timer of this.resumePending.values()) this.timers.clear(timer)
    this.resumePending.clear()
    // Before the teardown: a download parked on the fetch gate would otherwise hold its task past
    // the stop deadline waiting for a slot nobody will release. Unscoped — every producer is done
    // by now, ForeignMirrors having already released its own waiters when it closed ahead of us.
    drainFetchSlots()
    await teardownOverlay()
    this.overlay = null
    setFolderEngine(null)
    setLooseEngine(null)
    // Before the engines are dropped: the probes close over them.
    resetFetchClaims()
    this.folderEngine = null
    this.looseEngine = null
    serveIndex.reset()
    resetFolderPublish()
    resetFolderDownloads()
    resetOverlayPublish()
    resetOverlayMaintenance()
    resetPublishProgress()
    resetLoosePublish()
    resetLooseDownloads()
    resetLooseMaintenance()
  }

  attach(mux, socket) {
    if (!isOverlayEnabled()) return
    attachOverlay(mux, socket)
  }

  revokeServesForSpace(spaceId, profileKey) {
    revokeServesForSpace(spaceId, profileKey)
    bumpServeEpoch()
  }

  resumeForOwner(ownerKey, spaceId) {
    if (!isOverlayEnabled()) return
    if (isInPlaceFilesEnabled()) {
      resumeLooseForOwner(ownerKey, spaceId).catch((err) => this.log.debug('loose auto-resume failed:', err.message))
    }
    resumeFolderForOwner(ownerKey, spaceId).catch((err) => this.log.debug('overlay folder auto-resume failed:', err.message))
  }

  // The owners the convergence tick's stalled-owner rescue reaches for: one scan of the pending
  // rows, each judged by the engine that owns it.
  awaitedOwnerKeys() {
    const engines = [this.folderEngine, this.looseEngine].filter(Boolean)
    return listPendingOwnerKeys({ keep: (row) => engines.some((engine) => engine.awaitsOwner(row)) })
  }

  // The content plane authenticates per owner with no space, so the resume fans out across our
  // spaces — coalesced per owner so reconnect churn does not re-run listSpaces() each time.
  resumeForOwnerAllSpaces(ownerKey) {
    if (this.stopping || this.resumePending.has(ownerKey)) return
    const timer = this.timers.setTimeout(() => {
      this.resumePending.delete(ownerKey)
      listSpaces()
        .then((spaces) => { for (const s of spaces) if (!s.leaving) this.resumeForOwner(ownerKey, s.spaceId) })
        .catch((err) => this.log.debug('content-hello resume fan-out failed:', err.message))
    }, CONTENT_RESUME_COALESCE_MS)
    this.resumePending.set(ownerKey, timer)
  }
}
