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
import { getPeerPresenceDwellMs, isSharePrepareProgressEnabled, getRelayConfig } from '../shared/core/runtime-config.js'
import { hydrateDownloadRoots, listDownloadRoots } from '../shared/core/paths.js'
import { IntentsBee, getIntentsBee } from '../shared/core/intent-store.js'
import { createIntentLog } from '../shared/core/intents.js'
import { deleteOwnedMount } from '../shared/folders/mount-store.js'
import { tombstoneShare } from '../shared/shares/shares.js'
import { unmountForeignFolder } from '../shared/folders/foreign-folders.js'
import { Store, getStore, setMasterSecret } from '../shared/core/store.js'
import { resolveMasterSecret } from '../shared/core/identity-resolve.js'
import { osKeychainProvider } from '../shared/core/unlock-providers.js'
import { migrateLocalBeesToEncrypted } from '../shared/storage/metadata-migration.js'
import { SpaceKeysVault } from '../shared/spaces/space-keys.js'
import { ProfileBee, markOwnMembership, ensureMembershipManifestCap } from '../shared/spaces/profile.js'
import {
  SpacesBee, SpaceDrives, listSpaces, getSpace,
  resumeInterruptedLeave, backfillSelfCreatedCreatorKey, flagUnverifiedJoinedCreators,
  persistPendingLeave, clearPendingLeave, listPendingLeaves,
} from '../shared/spaces/space.js'
import { MemberViews } from '../shared/spaces/member-registry.js'
import { DownloadsBee, cleanupDownloadHistory } from '../shared/transfer/files.js'
import { PendingTransfersBee, clearPendingForSpace, listPendingOwnerKeys } from '../shared/transfer/pending-transfers.js'
import { abortInFlightPublishes } from '../shared/transfer/backends/overlay/overlay-backend.js'
import { ServeLedger } from '../shared/transfer/serve-ledger.js'
import { getJournalDir } from '../shared/transfer/backends/overlay/overlay-instance.js'
import { cleanupOrphanedJournals } from '../shared/transfer/backends/overlay/vendor/transfer.js'
import { cleanupOrphanedPartials } from '../shared/transfer/partial-sweep.js'
import {
  Swarm, joinSpaceTopic, compactStore, broadcastDeparture, broadcastSharePrepareProgress, setRelayThrough,
  configurePendingLeaves, registerPendingLeave, joinPendingLeaveTopic, leavePendingLeaveTopic,
  configurePendingCancels, leavePendingCancelTopic,
} from '../shared/transfer/swarm.js'
import { ContentSwarm } from '../shared/transfer/content-swarm.js'
import { ensureSharesCap } from '../shared/shares/shares.js'
import { ensureFolderMirrorsCap } from '../shared/folders/mirror-records.js'
import { migrateLegacyOwnedSharesToOverlay } from '../shared/shares/migrate-content-mode.js'
import { migrateCatalogsToEncrypted } from '../shared/shares/migrate-catalog-encrypt.js'
import { migrateOverlayIndexToEncrypted } from '../shared/transfer/backends/overlay/migrate-overlay-index-encrypt.js'
import { MountsBee, listForeignMounts } from '../shared/folders/mount-store.js'
import { OwnedFolders } from '../shared/folders/owned-folders.js'
import { PublishService } from '../shared/folders/publish-service.js'
import { ForeignMirrors } from '../shared/folders/foreign-folders.js'
import { EchoGuardPurge } from '../shared/folders/echo-guard.js'
import { cleanupOrphanedData } from '../shared/storage/storage.js'
import { reclaimLegacyPeerCaches } from '../shared/storage/legacy-peer-cache.js'
import { AuditLog } from '../shared/audit/audit-runtime.js'
import { Catalogs } from '../shared/shares/share-catalog.js'
import { PeerWatch } from '../shared/audit/peer-watch.js'
import { OverlayBackend } from '../shared/transfer/backends/overlay/overlay-runtime.js'
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

// The tier that must outlive the network teardown: everything holding a Corestore session (closing
// the store closes them all, so they have to be gone first) plus the recorder that tail writes
// through. Exported so a test whose subject is what boot() does NEXT — a content migration, the
// manifest caps — can start exactly this much and no more. It stays in this file because the
// crash-backstop test pins the core-opening call sites to boot.js by source text.
export async function bootDurable(bootstrap, { ipc, log, masterSecret = undefined, onTier = null } = {}) {
  const durable = createLifecycle({ log })
  // Handed over before anything can throw: a failure part-way through this tier must still leave
  // the caller something to close, or the store and every resource started so far leak.
  onTier?.(durable)
  const store = await durable.start(new Store('store', { path: bootstrap.storage }))
  if (masterSecret !== undefined) setMasterSecret(masterSecret)
  else if (bootstrap.identityKEK) {
    const provider = osKeychainProvider(bootstrap.identityKEK)
    setMasterSecret(await resolveMasterSecret({ store: getStore(), storagePath: bootstrap.storage, provider }))
  }
  const didMigrateMetadata = await migrateLocalBeesToEncrypted()
  await durable.start(new SpaceKeysVault('space-keys'))
  await durable.start(new ProfileBee('profile'))
  await durable.start(new SpacesBee('spaces'))
  await durable.start(new DownloadsBee('downloads'))
  await durable.start(new PendingTransfersBee('pending-transfers'))
  await durable.start(new MountsBee('mounts-meta'))
  await durable.start(new IntentsBee('intents'))
  const installId = await getInstallId(bootstrap.storage).catch((err) => {
    log.warn('install id unavailable:', err.message)
    return null
  })
  const auditLog = new AuditLog('audit', { ipc, installId, peerDwellMs: getPeerPresenceDwellMs() })
  try { await durable.start(auditLog) } catch (err) {
    log.warn('audit log unavailable — events will not be recorded:', err.message)
  }
  // After the audit log, so on the way out it flushes before that bee closes; before the drives,
  // so the spaces bee its flush reads is still open too.
  await durable.start(new ServeLedger('serve-ledger', { ipc }))
  await durable.start(new Catalogs('catalogs'))
  const drives = await durable.start(new SpaceDrives('drives'))
  return { durable, store, auditLog, drives, didMigrateMetadata, close: (opts) => durable.close(opts) }
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
 * @param deps.masterSecret  overrides the identity unlock; undefined resolves M from
 *                         bootstrap.identityKEK as production does.
 * @returns the root: the handles the entry's handlers need, plus close().
 */
export async function boot(bootstrap, {
  ipc, log, membershipControl = null, publishDownloadRoots = () => {}, memberRegistry = {},
  swarm = true, onPartialRoot = null, masterSecret = undefined,
} = {}) {
  const life = createLifecycle({ log })
  let durable = null
  let publishService = null
  let overlayBackend = null

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
  // The budgets bound the subsystem drains. Several wait (bounded) for an in-flight pass to bail —
  // 5 s for the mirror loops, 5 s for the publish executors, 3 s for the peer-watch sweeps — and
  // those ceilings sum well past the entry's 4 s hard deadline. Without a budget a single slow
  // drain means the swarms and the store are never closed at all, which is strictly worse than
  // abandoning that drain.
  // Each tier gets its own budget. One shared deadline let a busy runtime tier spend all of it and
  // skip the durable tier outright — including the store's own close, which on the way out is what
  // releases the RocksDB lock, and the ledger flush that records the shutdown's own audit rows.
  async function close({ budgetMs = 1500, durableBudgetMs = 1500 } = {}) {
    if (swarm) { try { broadcastDeparture() } catch {} }
    try { abortInFlightPublishes() } catch {}
    try { publishService?.halt() } catch {}
    // Ref'd: this is the only await on the close path with no work behind it, and an unref'd
    // timer here empties the loop for any in-process caller that holds no other handle.
    try { await new Promise((resolve) => setTimeout(resolve, 150)) } catch {}

    await life.close({ deadlineAt: Date.now() + budgetMs })
    // Last: the runtime tier's overlay teardown is what emits the serve-completed rows this tier
    // records, and closing the store closes every session anything still holds.
    await durable?.close({ deadlineAt: Date.now() + durableBudgetMs })
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

    const tier = await bootDurable(bootstrap, { ipc, log, masterSecret, onTier: (d) => { durable = d } })
    const { store, auditLog, drives, didMigrateMetadata } = tier
    if (drives.load.hadFailure) {
      try { await cleanupOrphanedData() } catch (err) {
        log.warn('orphan cleanup after drive-load failure failed:', err.message)
      }
    }
    await ensureMembershipManifestCap()
    await ensureSharesCap()
    await ensureFolderMirrorsCap()
    const didMigrateOverlayIndex = await runContentMigrations(log)

    // The mount runtime is CONSTRUCTED here and STARTED further down, where its resume loops used to
    // run. That split is what retires the entry's forward reference to a hoisted settleScanStatus:
    // the owned-folder subsystem needs the settle callback at wiring time, and the runtime that owns
    // it needs the mounts bee — construction is free of side effects, so both can be satisfied.
    const mounts = new MountsRuntime('mounts', { ipc })
    // Before every hook consumer and before the swarm: an inbound connection that landed without
    // the overlay channel attached would silently never get one.
    overlayBackend = await life.start(new OverlayBackend('overlay', {
      ipc,
      broadcastSharePrepare: (spaceId, p) => {
        if (isSharePrepareProgressEnabled()) broadcastSharePrepareProgress(spaceId, p)
      },
    }))
    publishService = await life.start(new PublishService('publish'))
    const ownedFolders = await life.start(new OwnedFolders('owned-folders', {
      ipc,
      publishService,
      settleScan: (promise, spaceId, shareId) => mounts.settleScanStatus(promise, spaceId, shareId),
    }))
    await life.start(new ForeignMirrors('foreign-mirrors', { ipc }))
    await life.start(new EchoGuardPurge('echo-guard'))
    await life.start(new PeerWatch('peer-watch'))
    // Reconcilers register with the flows they complete, then one pass finishes everything a prior
    // process left half-done. Before the swarm and the topic joins: recovery re-asserts durable
    // departures and drops mount records, and a join racing that would re-arm a watcher or a
    // mirror against a space this pass is about to forget.
    const intents = createIntentLog({ bee: getIntentsBee, log })
    intents.register('owned-delete', async ({ spaceId, shareId }) => {
      await deleteOwnedMount(spaceId, shareId)
      await tombstoneShare(spaceId, shareId)
    })
    intents.register('foreign-unmount', async ({ spaceId, shareId }) => {
      await unmountForeignFolder(spaceId, shareId)
    })

    const knownSpaces = await listSpaces()
    await resumeInterruptedLeaves(knownSpaces, log)
    await intents.recover()
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

    // Before the swarm: starting it wires the registry's collaborators, and a handshake that
    // landed while they were still the no-op defaults would read every peer as disconnected.
    // Also before the topic joins, so an inbound membership:request from a departed peer that
    // reconnects can't be handled with an unseeded tombstone set — which would misread `hadLeft`,
    // take the reconnect re-grant shortcut, and clear the durable tombstone before it was loaded.
    await life.start(new MemberViews('member-views', { overlayBackend, ...memberRegistry }))

    // `swarm: false` is how the single-peer test suite boots the data layer without a network.
    if (swarm) {
      const swarmSubsystem = await life.start(new Swarm('swarm', {
        ipc,
        membershipControl,
        overlayBackend,
        stalledOwners: listPendingOwnerKeys,
      }))
      await life.start(new ContentSwarm('content-swarm', { swarm: swarmSubsystem, overlayBackend }))
      // After BOTH: getContentSwarm() is null until the content swarm starts, and a relay
      // installed on the control swarm alone leaves every file byte unrelayed.
      applyRelayConfig(log)
    }

    // Deferred past the core-opening init above so the one-time compaction (which
    // scrubs the migrated plaintext from old SSTs) doesn't contend with boot I/O.
    if (didMigrateMetadata || didMigrateOverlayIndex) {
      compactStore().catch((err) => log.warn('post-migration compaction failed:', err.message))
    }

    await sweepOrphans(log)


    if (swarm) {
      for (const space of activeSpaces) {
        await joinSpaceTopic(space.spaceId)
    }
    }
    await replayPendingLeaves(swarm, log)

    // The three periodic backstops start last, so nothing they sweep is still opening.
    await life.start(mounts)
    await life.start(new Sweeps('sweeps', { ipc, auditLog }))

    return { close, store, mounts, intents, auditLog, ownedFolders, publishService, overlayBackend, activeSpaces, applyRelayConfig: () => applyRelayConfig(log) }
  }
}



// The one-time content migrations, all of which must land BEFORE the initial publish scans
// and before the overlay backend opens the index. Returns whether the overlay index moved.
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
  // generation and purge the plaintext one, BEFORE the overlay backend opens the index so it
  // opens the encrypted generation directly.
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