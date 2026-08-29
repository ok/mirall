// The worker's composition root.
//
// Everything the data layer needs is constructed here, with its collaborators passed in, and
// started in a declared order; `root.close()` closes what started, in reverse. Before this file
// existed the same sequence was ~250 top-level statements in `worker/main.js`, and the boot order
// was carried entirely by comments — 25 things were started, 6 were ever stopped, and adding a
// subsystem meant remembering to edit two distant places or silently leaking it.
//
// `worker/main.js` keeps what only an entry point can own: the crash backstop, the IPC pipe, the
// renderer-facing handlers, the shutdown deadline and `Bare.exit`. boot() and close() never exit
// the process, which is exactly what lets a test call them twice.
import { createLifecycle } from '../shared/core/subsystem.js'
import { getPeerPresenceDwellMs, isOverlayEnabled, isInPlaceFilesEnabled, isSeparateContentPlaneEnabled, isSharePrepareProgressEnabled, getRelayConfig } from '../shared/core/runtime-config.js'
import { hydrateDownloadRoots, listDownloadRoots } from '../shared/core/paths.js'
import { initStore, getStore, setMasterSecret } from '../shared/core/store.js'
import { resolveMasterSecret } from '../shared/core/identity-resolve.js'
import { osKeychainProvider } from '../shared/core/unlock-providers.js'
import { migrateLocalBeesToEncrypted } from '../shared/storage/metadata-migration.js'
import { initSpaceKeys } from '../shared/spaces/space-keys.js'
import { initProfile, markOwnMembership, ensureMembershipManifestCap } from '../shared/spaces/profile.js'
import {
  initSpaces, listSpaces, getSpace, loadDrives,
  resumeInterruptedLeave, backfillSelfCreatedCreatorKey, flagUnverifiedJoinedCreators,
  persistPendingLeave, clearPendingLeave, listPendingLeaves,
} from '../shared/spaces/space.js'
import { openMemberViewsForKnownSpaces, closeAllMemberViews } from '../shared/spaces/member-registry.js'
import { initDownloads, cleanupDownloadHistory } from '../shared/transfer/files.js'
import { initPendingTransfers, clearPendingForSpace, listPendingOwnerKeys } from '../shared/transfer/pending-transfers.js'
import { initBackends, teardownBackends, fanoutAttach } from '../shared/transfer/content-backends.js'
import { initLooseOverlay, rehydrateLooseFiles, resumeLooseForOwner } from '../shared/transfer/loose-overlay.js'
import { resumeOverlayForOwner, setSharePrepareBroadcast, abortInFlightPublishes, clearPublishAbort } from '../shared/transfer/backends/overlay/overlay-backend.js'
import { initServeLedger } from '../shared/transfer/serve-ledger.js'
import { getJournalDir, revokeServesForSpace, bumpServeEpoch } from '../shared/transfer/backends/overlay/overlay-instance.js'
import { cleanupOrphanedJournals } from '../shared/transfer/backends/overlay/vendor/transfer.js'
import { cleanupOrphanedPartials } from '../shared/transfer/partial-sweep.js'
import {
  initSwarm, destroySwarm, joinSpaceTopic, compactStore, broadcastDeparture, broadcastSharePrepareProgress,
  setMembershipControlHandler, setConnectionAttachHook, setOverlayReconnectHook,
  setRevokeServesForSpaceHook, setStalledOwnersHook, getSwarmDht, setRelayThrough,
  configurePendingLeaves, registerPendingLeave, joinPendingLeaveTopic, leavePendingLeaveTopic,
  configurePendingCancels, leavePendingCancelTopic,
} from '../shared/transfer/swarm.js'
import { initContentSwarm, destroyContentSwarm, setContentAttachHook, setContentResumeHook } from '../shared/transfer/content-swarm.js'
import { setMembershipRevokedHook } from '../shared/spaces/member-registry.js'
import { ensureSharesCap } from '../shared/shares/shares.js'
import { ensureFolderMirrorsCap } from '../shared/folders/mirror-records.js'
import { migrateLegacyOwnedSharesToOverlay } from '../shared/shares/migrate-content-mode.js'
import { migrateCatalogsToEncrypted } from '../shared/shares/migrate-catalog-encrypt.js'
import { migrateOverlayIndexToEncrypted } from '../shared/transfer/backends/overlay/migrate-overlay-index-encrypt.js'
import { initMounts, listForeignMounts } from '../shared/folders/mount-store.js'
import { OwnedFolders } from '../shared/folders/owned-folders.js'
import { stopAllPublishing, armPublishService } from '../shared/folders/publish-service.js'
import { ForeignMirrors } from '../shared/folders/foreign-folders.js'
import { EchoGuardPurge } from '../shared/folders/echo-guard.js'
import { cleanupOrphanedData } from '../shared/storage/storage.js'
import { reclaimLegacyPeerCaches } from '../shared/storage/legacy-peer-cache.js'
import { AuditLog } from '../shared/audit/audit-runtime.js'
import { PeerWatch } from '../shared/audit/peer-watch.js'
import { getInstallId } from '../shared/telemetry/install-id.js'
import { MountsRuntime } from './mounts-runtime.js'
import { Sweeps } from './sweeps.js'

// Apply the configured relay set to BOTH swarms. Exported through the root because the
// settings handler re-applies it at runtime.
function applyRelayConfig(log) {
  const { mode, relays } = getRelayConfig()
  const res = setRelayThrough(relays, mode)
  if (res.applied > 0) log.info('relay configured:', res.applied, 'key(s), mode', mode)
  return res
}

/**
 * Construct and start the worker's data layer.
 *
 * @param bootstrap        the config frame from Electron main (storage path, flags, KEK).
 * @param deps.ipc         the IPC channel; every subsystem emits through it.
 * @param deps.log         the entry's logger, used for the boot narration.
 * @param deps.membershipControl   the entry's membership-control handler (it needs the handler
 *                                 closure's state, so it is passed in rather than moved here).
 * @param deps.publishDownloadRoots  pushes the reveal allowlist to Electron main.
 * @param deps.swarm       false skips the swarm, the content swarm and topic joins — how the
 *                         single-peer test suite boots the data layer with no network.
 * @param deps.onPartialRoot  called with `{ close }` before anything starts, so a shutdown that
 *                         arrives mid-boot can still stop what has started.
 * @returns the root: the handles the entry's handlers need, plus close().
 */
export async function boot(bootstrap, { ipc, log, membershipControl = null, publishDownloadRoots = () => {}, swarm = true, onPartialRoot = null } = {}) {
  const life = createLifecycle({ log })

  // The reverse of boot, defined BEFORE anything starts and handed to the caller at once. A
  // shutdown can arrive at any point during boot — the pipe closes when Electron main dies, and
  // the passes after the swarm comes up run for seconds on a large library — and the entry has to
  // be able to stop whatever has started so far. Until this is published, `root` is null and a
  // quit would exit without announcing departure or dropping the swarm.
  //
  // The first three steps are deliberately NOT in reverse order and are kept verbatim from the
  // entry's old safeShutdown: announce departure and abort hashing FIRST, then a short flush
  // window, so the departure datagram leaves UDX before any socket drops.
  //
  // `budgetMs` bounds the subsystem drains alone. Several of them wait (bounded) for an in-flight
  // pass to bail — 5 s for the mirror loops, 5 s for the publish executors, 3 s for the peer-watch
  // sweeps — and those ceilings sum well past the entry's 4 s hard deadline. Without a budget a
  // single slow drain means the swarms and the store are never closed at all, which is strictly
  // worse than abandoning that drain.
  async function close({ budgetMs = 1500 } = {}) {
    if (swarm) { try { broadcastDeparture() } catch {} }
    try { abortInFlightPublishes() } catch {}
    try { stopAllPublishing() } catch {}
    try { await new Promise((resolve) => { const to = setTimeout(resolve, 150); to.unref?.() }) } catch {}

    // sweeps → mounts → peer-watch → echo-guard → foreign-mirrors → owned-folders → audit
    await life.close({ deadlineAt: Date.now() + budgetMs })

    // Not yet resources: the member views, the content backends and both swarms keep the order
    // the entry gave them, and each no-ops when its init never ran. Phase 2 and 3 fold them into
    // the lifecycle above.
    try { closeAllMemberViews() } catch {}
    try { await teardownBackends() } catch {}
    if (swarm) {
      try { await destroyContentSwarm() } catch {}
      try { await destroySwarm() } catch {}
    }
    // Pulled forward from Phase 2: an in-process reboot needs the store released, and every core
    // above is closed by now.
    try { await getStore()?.close() } catch (err) { log.warn('store close failed:', err.message) }
  }
  onPartialRoot?.({ close })

  try {
    return await start()
  } catch (err) {
    // A throw here leaves boot() rejecting with `root` never assigned in the entry, so nothing
    // downstream would ever close what already came up — the "25 started, 6 stopped" asymmetry
    // this root exists to end, reintroduced on the error path. Close it, then rethrow.
    log.error('boot failed:', err.message)
    await close().catch((closeErr) => log.warn('cleanup after failed boot failed:', closeErr.message))
    throw err
  }

  async function start() {

    log.info('starting...')

    const didMigrateMetadata = await openIdentityAndBees(bootstrap)
    // Before loadDrives and the swarm, so the log is writable before anything worth recording can
    // happen. NOTHING about the audit log may abort boot — an unavailable log degrades to no rows,
    // and boot() rejecting here would leave every handler unregistered and the worker alive but
    // deaf. That covers the id read too: getInstallId rethrows any error but ENOENT, so a damaged
    // or unreadable install-id would otherwise take the whole worker down. A failed _open is closed
    // by ReadyResource in the background, so the lifecycle never lists it and close() skips it.
    const installId = await getInstallId(bootstrap.storage).catch((err) => {
      log.warn('install id unavailable:', err.message)
      return null
    })
    const auditLog = new AuditLog('audit', { ipc, installId, peerDwellMs: getPeerPresenceDwellMs() })
    try { await life.start(auditLog) } catch (err) {
      log.warn('audit log unavailable — events will not be recorded:', err.message)
    }

    await loadDrivesAndCaps(log)
    const didMigrateOverlayIndex = await runContentMigrations(log)

    await initMounts()
    // The mount runtime is CONSTRUCTED here and STARTED further down, where its resume loops used to
    // run. That split is what retires the entry's forward reference to a hoisted settleScanStatus:
    // the owned-folder subsystem needs the settle callback at wiring time, and the runtime that owns
    // it needs the mounts bee — construction is free of side effects, so both can be satisfied.
    const mounts = new MountsRuntime('mounts', { ipc })
    // Two latches a previous root's close() set and nothing clears: the module-level publish
    // scheduler stays stopped for good, and the publish-abort flag stays raised. Left alone, this
    // boot's publishes would queue and never pump, or run and abort. Cleared before the lane's
    // owner starts.
    armPublishService()
    clearPublishAbort()
    const ownedFolders = await life.start(new OwnedFolders('owned-folders', {
      ipc,
      settleScan: (promise, spaceId, shareId) => mounts.settleScanStatus(promise, spaceId, shareId),
    }))
    await life.start(new ForeignMirrors('foreign-mirrors', { ipc }))
    await life.start(new EchoGuardPurge('echo-guard'))
    await life.start(new PeerWatch('peer-watch'))
    const knownSpaces = await listSpaces()
    await resumeInterruptedLeaves(knownSpaces, log)
    const activeSpaces = knownSpaces.filter((s) => !s.leaving)
    // Hydrated here, from the spaces that SURVIVED the interrupted-leave pass above, and off the
    // scan that pass already did. A space being left keeps no download root: hydrating it would
    // leak a dead space's folder into main's reveal allowlist and into mount validation for the
    // whole session (the resume path purges the record without going through space:leave's forget).
    // Safe this late — nothing between store init and here reads a download root, and ipc.start()
    // (which admits the first frame that could) is the last statement in this module.
    hydrateDownloadRoots(activeSpaces)
    publishDownloadRoots()
    await backfillMembership(activeSpaces, log)

    const useContentPlane = isOverlayEnabled() && isSeparateContentPlaneEnabled()
    await wireSubsystemHooks({ ipc, log, membershipControl, useContentPlane })
    // `swarm: false` is how the single-peer test suite boots the data layer without a network: it
    // has never started a swarm, and skipping it here is what lets those tests boot through the root.
    if (swarm) {
      initSwarm(ipc)
      if (useContentPlane) initContentSwarm(getSwarmDht())
      // After BOTH constructors: getContentSwarm() is null until the line above runs, and a
      // relay installed on the control swarm alone leaves every file byte unrelayed.
      applyRelayConfig(log)
    }

    // Deferred past the core-opening init above so the one-time compaction (which
    // scrubs the migrated plaintext from old SSTs) doesn't contend with boot I/O.
    if (didMigrateMetadata || didMigrateOverlayIndex) {
      compactStore().catch((err) => log.warn('post-migration compaction failed:', err.message))
    }

    await sweepOrphans(log)

    // Open derived member views (which seed the durable leave-tombstones into memory) BEFORE joining
    // topics, so an inbound membership:request from a departed peer that reconnects can't be handled
    // with an unseeded tombstone set — which would misread `hadLeft`, take the reconnect re-grant
    // shortcut, and clear the durable tombstone before it was ever loaded. The fold self-heals as more
    // peer bees replicate after the topics join below.
    await openMemberViewsForKnownSpaces()

    if (swarm) {
      for (const space of activeSpaces) {
        await joinSpaceTopic(space.spaceId)
    }
    }
    await replayPendingLeaves(swarm, log)

    // The three periodic backstops start last, so nothing they sweep is still opening.
    await life.start(mounts)
    await life.start(new Sweeps('sweeps', { ipc, auditLog }))

    return { close, mounts, auditLog, ownedFolders, activeSpaces, applyRelayConfig: () => applyRelayConfig(log) }
  }
}



// Store, identity unlock and the local bees. Order is load-bearing: setMasterSecret must
// land before the first createLocalBee, and the metadata migration before initSpaceKeys.
// Returns whether it rewrote anything, which decides the post-boot compaction.
async function openIdentityAndBees(bootstrap) {
  initStore(bootstrap.storage)
  // Unlock identity: resolve the master secret M from identity.enc — Electron main supplies
  // only the KEK (key-encryption key), never M itself — and open identity cores from keypairs
  // derived from M. Without a KEK (MIRALL_INSECURE_IDENTITY / headless tests) the worker
  // falls back to plaintext seed derivation.
  if (bootstrap.identityKEK) {
    const provider = osKeychainProvider(bootstrap.identityKEK)
    setMasterSecret(await resolveMasterSecret({ store: getStore(), storagePath: bootstrap.storage, provider }))
  }
  const didMigrateMetadata = await migrateLocalBeesToEncrypted()
  await initSpaceKeys()
  await initProfile()
  await initSpaces()
  await initDownloads()
  await initPendingTransfers()
  return didMigrateMetadata
}

// Space drives, then the three manifest caps every writer checks.
async function loadDrivesAndCaps(log) {
  const driveLoad = await loadDrives()
  if (driveLoad.hadFailure) {
    try { await cleanupOrphanedData() } catch (err) {
      log.warn('orphan cleanup after drive-load failure failed:', err.message)
  }
  }

  await ensureMembershipManifestCap()
  await ensureSharesCap()
  await ensureFolderMirrorsCap()
}

// The one-time content migrations, all of which must land BEFORE the initial publish scans
// and before initBackends opens the overlay index. Returns whether the overlay index moved.
async function runContentMigrations(log) {
  // One-time migration: move owned folder shares recorded with a retired contentMode
  // (undefined / 'eager' / 'deferred') to overlay BEFORE the initial publish scans below, so
  // such a share re-advertises into the catalog instead of resolving to UNSUPPORTED (empty
  // listing, publishing stops).
  try { await migrateLegacyOwnedSharesToOverlay() } catch (err) {
    log.warn('legacy content-mode migration failed:', err.message)
  }
  // One-time migration: encrypt existing plaintext v2 catalogs with the SCK (space content key —
  // holding it is what grants read access to a space) BEFORE the initial publish scans below, so
  // the re-advertise repopulates the new encrypted core and the old plaintext core is purged first.
  try { await migrateCatalogsToEncrypted() } catch (err) {
    log.warn('catalog SCK-encrypt migration failed:', err.message)
  }
  // One-time migration: copy the overlay's plaintext local index into an M-encrypted core
  // generation and purge the plaintext one, BEFORE initBackends opens the overlay so it opens
  // the encrypted generation directly.
  let didMigrateOverlayIndex = false
  try { didMigrateOverlayIndex = (await migrateOverlayIndexToEncrypted())?.migrated === true } catch (err) {
    log.warn('overlay-index at-rest migration failed:', err.message)
  }
  return didMigrateOverlayIndex
}

async function resumeInterruptedLeaves(knownSpaces, log) {
  // Finish any leave a prior process interrupted (durable `leaving` marker still present) BEFORE
  // the membership backfill — otherwise markOwnMembership below re-asserts active:true and silently
  // resurrects the space, undoing the user's leave (and diverging from co-members who already
  // revoked). Runs pre-swarm: the completion is purely durable-local; co-members converge on the
  // member del via replication, like any offline leave.
  for (const space of knownSpaces) {
    if (!space.leaving) continue
    // The interrupted teardown may have died BEFORE its leave frame reached anyone — arm the
    // pending-leave replay (the live teardown's own machinery) so the departure still gets
    // announced once a co-member connects. Armed before the resume deletes the record: the
    // replay setup below skips markers whose record still exists, so a failed resume merely
    // retires this marker until the next boot re-arms it. Solo spaces skip (nobody to tell).
    if (space.topic && (space.members || []).length) {
      try { await persistPendingLeave(space.spaceId, space.topic, Date.now()) } catch (err) {
        log.warn('interrupted-leave replay arm failed:', space.spaceId, '-', err.message)
      }
  }
    try {
      await resumeInterruptedLeave(space.spaceId)
      // The live teardown also purges these spaceId-keyed rows; nothing else ever reclaims them
      // (the sweeps cover cores, not bee rows). Best-effort — the leave itself is already durable.
      try {
        await cleanupDownloadHistory(space.spaceId)
        await clearPendingForSpace(space.spaceId)
      } catch (err) {
        log.warn('interrupted-leave transfer-row cleanup failed:', space.spaceId, '-', err.message)
      }
      log.info('completed interrupted leave at boot:', space.spaceId)
    } catch (err) {
      log.warn('resume interrupted leave failed:', space.spaceId, '-', err.message)
  }
  }
}

// Membership manifest backfill plus the two one-time creator-key passes.
async function backfillMembership(activeSpaces, log) {
  for (const space of activeSpaces) {
    try { await markOwnMembership(space.spaceId) } catch (err) {
      log.warn('manifest backfill failed for space', space.spaceId, '-', err.message)
  }
  }
  // One-time, idempotent backfill: stamp the member-set root (creatorKey) on self-created
  // spaces whose records predate the field. The OR-Set membership fold (conflict-free
  // add/remove roster) seeds its root of trust from it.
  try { await backfillSelfCreatedCreatorKey() } catch (err) {
    log.warn('creatorKey backfill failed:', err.message)
  }
  // One-time migration: flag joined spaces whose creatorKey was TOFU-pinned (trust on first
  // use) from a bearer invite as unverified, so the handshake cross-check re-authenticates
  // the member-set root on the next connection.
  try { await flagUnverifiedJoinedCreators() } catch (err) {
    log.warn('creatorKey migration failed:', err.message)
  }
}

async function wireSubsystemHooks({ ipc, log, membershipControl, useContentPlane }) {
  // wire backends + every connection handler/hook BEFORE the swarm starts
  // accepting connections, so no inbound connection lands without the overlay
  // channel attached, the content/membership handlers set, or the overlay instance
  // created (a connection in that window would silently never get an overlay channel).
  initServeLedger(ipc)
  await initBackends(ipc) // overlay instance + IPC ref when the flag is on
  initLooseOverlay(ipc)
  if (isInPlaceFilesEnabled()) rehydrateLooseFiles().catch((err) => log.debug('loose rehydrate failed:', err.message))
  if (isOverlayEnabled()) {
    // Auto-resume overlay downloads (loose + folder) when their owner (re)connects.
    const autoResume = (ownerKey, spaceId) => {
      if (isInPlaceFilesEnabled()) resumeLooseForOwner(ownerKey, spaceId).catch((err) => log.debug('loose auto-resume failed:', err.message))
      resumeOverlayForOwner(ownerKey, spaceId).catch((err) => log.debug('overlay folder auto-resume failed:', err.message))
  }
    // BOTH planes drive the resume. The control handshake marks the owner's presence lease
    // synchronously before firing this hook, so a resume it triggers can never observe the stale
    // "owner offline" that start()'s gate reads — whereas a content-plane hello routinely lands
    // while the control socket is still re-handshaking, and its resume is dropped. With only the
    // content hook installed, out-of-phase flapping starves the download of every trigger it has.
    setOverlayReconnectHook(autoResume)
    if (useContentPlane) {
      // The content plane authenticates per owner with no space, so fan the resume across our
      // spaces — coalesced per owner so reconnect churn doesn't re-run listSpaces() each time.
      // Still needed alongside the control hook: a content-only flap re-runs no handshake.
      const resumePending = new Map()
      setContentResumeHook((ownerKey) => {
        if (resumePending.has(ownerKey)) return
        const timer = setTimeout(() => {
          resumePending.delete(ownerKey)
          listSpaces()
            .then((spaces) => { for (const s of spaces) if (!s.leaving) autoResume(ownerKey, s.spaceId) })
            .catch((err) => log.debug('content-hello resume fan-out failed:', err.message))
        }, 250)
        timer.unref?.()
        resumePending.set(ownerKey, timer)
      })
  }
  }
  setMembershipControlHandler(membershipControl)
  if (useContentPlane) setContentAttachHook(fanoutAttach) // overlay binds its channel on content connections
  else setConnectionAttachHook(fanoutAttach) // lets overlay bind its channel per connection
  // Lets the convergence tick see a download whose owner has dropped off either plane.
  setStalledOwnersHook(listPendingOwnerKeys)
  setSharePrepareBroadcast((spaceId, p) => { if (isSharePrepareProgressEnabled()) broadcastSharePrepareProgress(spaceId, p) })
  // A peer left a space we are still in: stop serving THAT PEER the space's bytes. Scoped to the
  // leaver — a space-wide revoke here would also cut off every other member still legitimately
  // downloading from us. The epoch bump then re-checks the rest against the live membership gate.
  setRevokeServesForSpaceHook((spaceId, profileKey) => { revokeServesForSpace(spaceId, profileKey); bumpServeEpoch() })
  // The same revocation, learned through replication (the observed-leave fold) instead of a direct
  // frame. An epoch bump alone is inert here (the fold does not remove the member from the roster,
  // so the serve gate would re-approve), so ACTIVELY drop the leaver's grants for the space.
  setMembershipRevokedHook((spaceId, profileKey) => { revokeServesForSpace(spaceId, profileKey); bumpServeEpoch() })
}

// Crash leftovers: partials, retired peer-cache cores, orphaned receive journals. All
// best-effort — a failure here defers reclamation, it never blocks boot.
async function sweepOrphans(log) {
  try {
    // Sweep Downloads (loose/folder downloads) + every foreign mount dir (mirror fetches
    // write partials at the file's nested location), reclaiming crash-orphaned partials
    // while keeping any a paused/in-flight transfer can still resume from.
    const foreignDirs = (await listForeignMounts()).map((m) => m.mountPath)
    const sweep = await cleanupOrphanedPartials(listDownloadRoots(), foreignDirs)
    if (sweep.swept || sweep.failed) {
      log.info('partial sweep:', sweep.swept, 'reclaimed across', sweep.rootsScanned, 'roots,', sweep.failed, 'unreadable')
    }
  } catch (err) {
    log.warn('partial sweep failed:', err.message)
  }

  // One-shot: reclaim peer-download cache cores left behind by the retired eager content
  // backend (the overlay backend keeps no such cache, and storage:info does not surface them).
  // Fire-and-forget + flag-guarded so the compaction never blocks boot.
  reclaimLegacyPeerCaches().catch((err) => log.warn('legacy peer-cache reclaim failed:', err.message))

  try {
    cleanupOrphanedJournals(getJournalDir())
  } catch (err) {
    log.warn('journal sweep failed:', err.message)
  }
}

async function replayPendingLeaves(swarm, log) {
  // Replay leaves that never reached a member (leave-while-alone): re-join each marker's
  // topic and let the swarm re-announce the leave frame on every new connection; the first
  // co-member ack clears the marker and drops the topic again.
  if (swarm) configurePendingLeaves(async (spaceId) => {
    await clearPendingLeave(spaceId)
    await leavePendingLeaveTopic(spaceId)
  })
  if (swarm) configurePendingCancels((spaceId) => leavePendingCancelTopic(spaceId))
  try {
    for (const pl of await listPendingLeaves()) {
      // The marker is persisted mid-teardown, BEFORE the space record is purged. If the worker
      // died in that window the record survives (the leave was interrupted, the user still has the
      // space) — drop the stale marker rather than replaying a leave for a live space, which would
      // otherwise swarm.leave() its topic on the first ack and strand it deaf until restart.
      if (!pl.topic || await getSpace(pl.spaceId)) { await clearPendingLeave(pl.spaceId); continue }
      registerPendingLeave(pl.spaceId, pl.topic, pl.ts || Date.now())
      if (swarm) joinPendingLeaveTopic(pl.spaceId, pl.topic)
      log.info('replaying pending leave for space', pl.spaceId)
  }
  } catch (err) {
    log.warn('pending-leave replay setup failed:', err.message)
  }
}