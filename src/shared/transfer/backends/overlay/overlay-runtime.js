// The overlay as one lifetime: the instance, the serve index, and the two download engines that
// were previously constructed at module level inside this package's import cycle.
//
// It lives outside that cycle — nothing in it imports this file, only the boot root does — so
// wiring the four modules together here adds no edge to the cycle test/integration/import-time
// guards.
import { Subsystem } from '../../../core/subsystem.js'
import { isOverlayEnabled, isInPlaceFilesEnabled } from '../../../core/runtime-config.js'
import { createOverlayDownloadEngine } from './overlay-download.js'
import { drainTransferAudit } from '../../transfer-audit.js'
import { initOverlay, teardownOverlay, attachOverlay, revokeServesForSpace, bumpServeEpoch } from './overlay-instance.js'
import { serveIndex } from './overlay-serve-index.js'
import {
  initContentBackendOverlay, resetContentBackendState, folderChannel, setFolderEngine,
  rehydrateOwnedFiles, resumeOverlayForOwner, setSharePrepareBroadcast,
} from './overlay-backend.js'
import {
  initLooseOverlay, resetLooseState, looseChannel, setLooseEngine,
  rehydrateLooseFiles, resumeLooseForOwner,
} from '../../loose-overlay.js'
import { listSpaces } from '../../../spaces/space.js'

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
    // The instance comes first: the rehydrate below reaches makeServable and enqueueLoosePublish,
    // and both fall through on a null getOverlay() — so a rehydrate that runs ahead of it silently
    // leaves a crash-interrupted entry unhashed and stuck on "Adding".
    if (isOverlayEnabled()) {
      initContentBackendOverlay(this.deps.ipc)
      this.overlay = await initOverlay()
      setSharePrepareBroadcast(this.deps.broadcastSharePrepare)
    }
    // The engines are built whatever the overlay flag says. They are inert without an instance
    // (every entry point checks getOverlay()), and on the kill-switch build the alternative is an
    // engine() that throws out of files:list, space:leave and the transfer handlers.
    initLooseOverlay(this.deps.ipc)
    this.folderEngine = createOverlayDownloadEngine(folderChannel)
    this.looseEngine = createOverlayDownloadEngine(looseChannel)
    setFolderEngine(this.folderEngine)
    setLooseEngine(this.looseEngine)
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
    // Before the teardown: a download parked on the admission gate would otherwise hold its
    // task past the stop deadline waiting for a slot nobody will release.
    this.folderEngine?.drainAdmission()
    this.looseEngine?.drainAdmission()
    await teardownOverlay()
    // After the teardown, which settles the in-flight fetches that produce these rows, and before
    // the durable tier closes the audit bee: boot.js starts the audit log in `durable` and this
    // subsystem in `life`, so `life` is always torn down first.
    await drainTransferAudit()
    this.overlay = null
    setFolderEngine(null)
    setLooseEngine(null)
    this.folderEngine = null
    this.looseEngine = null
    serveIndex.reset()
    resetContentBackendState()
    resetLooseState()
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
    resumeOverlayForOwner(ownerKey, spaceId).catch((err) => this.log.debug('overlay folder auto-resume failed:', err.message))
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
