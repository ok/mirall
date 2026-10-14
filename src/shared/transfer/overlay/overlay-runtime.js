// The overlay as one lifetime: the instance, the serve index, and the download engine,
// constructed in _open rather than at module level so nothing here runs during import.
//
// Nothing in the package imports this file — only the boot root does — so wiring the modules
// together here adds no edge to the import graph test/integration/import-time guards.
import { Subsystem } from '../../core/subsystem.js'
import { createOverlayDownloadEngine } from './overlay-download.js'
import { drainFetchSlots, registerFetchOwner, resetFetchClaims, resetFetchSlots } from './fetch-gate.js'
import { initOverlay, teardownOverlay, attachOverlay, revokeServesForSpace, bumpServeEpoch } from './overlay-instance.js'
import { serveIndex } from './overlay-serve-index.js'
import { rehydrateOwnedContent, resetOverlayMaintenance } from './overlay-maintenance.js'
import { resetOverlayPublish } from './overlay-publish.js'
import { initPublishProgress, resetPublishProgress } from './publish-progress.js'
import { initFolderPublish, resetFolderPublish } from './folder-publish.js'
import { initLoosePublish, resetLoosePublish } from './loose-publish.js'
import { downloadChannel, initShareDownloads, resetShareDownloads, setDownloadEngine } from './share-downloads.js'
import { listSpaces } from '../../spaces/space.js'
import { listPendingOwnerKeys, listPendingOwnerSpaces } from '../pending-transfers.js'

const CONTENT_RESUME_COALESCE_MS = 250

export class OverlayBackend extends Subsystem {
  constructor(name, deps) {
    super(name, deps)
    this.require('ipc', 'broadcastSharePrepare')
    this.resumePending = new Map()
    this.overlay = null
    this.engine = null
  }

  async _open() {
    const { ipc } = this.deps
    initPublishProgress({ emit: (name, payload) => ipc.emit(name, payload), broadcast: this.deps.broadcastSharePrepare })
    initFolderPublish({ ipc })
    initLoosePublish({ ipc })
    initShareDownloads({ ipc })
    // The instance comes first: the rehydrate below reaches makeServable and the loose re-publish,
    // and both fall through on a null getOverlay() — so a rehydrate that runs ahead of it silently
    // leaves a crash-interrupted entry unhashed and stuck on "Adding".
    this.overlay = await initOverlay()
    // The gate is a module singleton, so unlike the engine it does not die with the previous
    // lifetime: a slot whose release was lost would shrink the cap for every later open.
    resetFetchSlots()
    this.engine = createOverlayDownloadEngine(downloadChannel)
    setDownloadEngine(this.engine)
    // Registered as a probe, not copied: the engine's registry already has exactly the lifetime of
    // its fetch. This is what lets the mirror ask "is ANYONE fetching this".
    resetFetchClaims()
    registerFetchOwner('download', (transferId) => this.engine.has(transferId))
    // Backgrounded: re-registering every owned file walks and chunk-maps each one.
    rehydrateOwnedContent().catch((err) => this.log.debug('rehydrate failed:', err.message))
  }

  // Destroys the protocol — and only the protocol — while the sockets its frames travel on are
  // still up, so the peer teardown fires its serve-end callbacks and an interrupted transfer is
  // still recorded. The index, the engine and the instance stay alive for the subsystems that
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
    setDownloadEngine(null)
    // Before the engine is dropped: the probe closes over it.
    resetFetchClaims()
    this.engine = null
    serveIndex.reset()
    resetFolderPublish()
    resetOverlayPublish()
    resetOverlayMaintenance()
    resetPublishProgress()
    resetLoosePublish()
    resetShareDownloads()
  }

  attach(mux, socket) {
    attachOverlay(mux, socket)
  }

  revokeServesForSpace(spaceId, profileKey) {
    revokeServesForSpace(spaceId, profileKey)
    bumpServeEpoch()
  }

  // One pass re-drives that owner's rows of every share, loose and folder.
  resumeForOwner(ownerKey, spaceId) {
    this.engine?.resumeForOwner(ownerKey, spaceId).catch((err) => this.log.debug('download auto-resume failed:', err.message))
  }

  // The owners the convergence tick's stalled-owner rescue reaches for: one scan of the pending
  // rows, each judged by the engine.
  awaitedOwnerKeys() {
    const engine = this.engine
    return listPendingOwnerKeys({ keep: (row) => !!engine?.awaitsOwner(row) })
  }

  // The rows the user unblocked since the last tick — a download folder that takes writes again —
  // re-driven through the reconcile a reconnect runs, once per (owner, space). The engine hands a
  // row out once per clear and only while its owner is present. `beat` is the tick's liveness.
  async redriveUnblocked({ beat = () => {} } = {}) {
    if (this.stopping) return
    const engine = this.engine
    const keep = (row) => { beat(); return !!engine?.takeUnblocked(row) }
    for (const { ownerKey, spaceId } of await listPendingOwnerSpaces({ keep })) {
      this.log.info('download folder writable again — re-driving downloads in', spaceId, 'from', ownerKey.slice(0, 8))
      this.resumeForOwner(ownerKey, spaceId)
    }
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
