// Bare worker entrypoint — Mirall's data-layer process (see .claude/solution-architecture.md
// for the process model and glossary). This file runs once, top to bottom, and the boot order is
// load-bearing: crash backstop + pipe-close shutdown hooks → bootstrap config → identity
// unlock (master secret M, via the KEK from Electron main) → Corestore + bees → one-time
// migrations → swarm + subsystem wiring (every connection hook attaches before the swarm
// accepts sockets) → resume of owned/foreign folder mounts → registration of the
// renderer-facing IPC command handlers (named `domain:verb`, grouped by the `// === … ===`
// section markers below) → ipc.start(), which replays frames queued during boot, then ready.
import os from 'bare-os'
import fs from 'bare-fs'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { createIPC, getBootstrapPromise } from '../shared/core/ipc.js'
import { setRuntimeConfig, getRuntimeConfig, setDownloadFolder, setBandwidthLimits, getDeepReconcileEvery, isHandshakeIdentityBindingEnabled, isOverlayEnabled, isInPlaceFilesEnabled, isSharePrepareProgressEnabled, isSeparateContentPlaneEnabled, getListFilesCap, isRelayEnabled, getRelayConfig, setRelayConfig } from '../shared/core/runtime-config.js'
import { hydrateDownloadRoots, setSpaceDownloadRoot, forgetSpaceDownloadRoot, listDownloadRoots } from '../shared/core/paths.js'
import { createLogger } from '../shared/core/logger.js'
import { installCrashBackstop } from '../shared/core/crash-backstop.js'
import { initStore, getStore, setMasterSecret } from '../shared/core/store.js'
import { migrateLocalBeesToEncrypted } from '../shared/storage/metadata-migration.js'
import { resolveMasterSecret } from '../shared/core/identity-resolve.js'
import { osKeychainProvider } from '../shared/core/unlock-providers.js'
import { getContentBackend, UNSUPPORTED, initBackends, teardownBackends, fanoutAttach, sweepBackends } from '../shared/transfer/content-backends.js'
import {
  initProfile, getProfile, setProfile,
  ensureMembershipManifestCap,
  markOwnMembership, clearOwnMembership, getLocalPublicKeyHex,
  readProfileRecord, markRequest, markRequestDenied,
  captureJoinerMembership, getIdentitySigner,
  markInvite, sweepExpiredInvites,
} from '../shared/spaces/profile.js'
import {
  initSpaces, createSpace, joinSpace, listSpaces,
  getSpace, loadDrives, purgeSpace, purgeSpaceDrive, forgetSpaceRecord, updateSpace,
  markSpaceLeavingDurable, resumeInterruptedLeave,
  toggleFavorite, upsertMember,
  getSpaceContentKey, recordJoinRequest, listJoinRequests, listPendingRequests, clearJoinRequest,
  recordApproval, materializeOwnDrive,
  backfillSelfCreatedCreatorKey, pinCreatorKey, markCreatorDivergence, clearCreatorDivergence, flagUnverifiedJoinedCreators,
  persistPendingLeave, clearPendingLeave, listPendingLeaves,
} from '../shared/spaces/space.js'
import { initSpaceKeys } from '../shared/spaces/space-keys.js'
import { classifyInvite } from '../shared/spaces/invite-policy.js'
import { encodeInvite, decodeInvite } from '../shared/invite-envelope.js'
import { initSwarm, joinSpaceTopic, leaveSpaceTopic, cleanupSpaceDrives, compactStore, destroySwarm, broadcastDeparture, getConnectedPeers, isOwnerOnline, broadcastProfileUpdate, sendLeaveFrameToConnectedPeers, awaitLeaveAcks, getSwarmStatus, setRelayThrough, testRelayReachable, reconnectAll, setMembershipControlHandler, setConnectionAttachHook, getSwarmDht, setOverlayReconnectHook, setRevokeServesForSpaceHook, setStalledOwnersHook, rescueStalledTransfers, sendMembershipGrant, sendMembershipDeny, broadcastMembershipCancel, reconcilePendingRequester, isApprovedMember, resolveInvite, markSpaceLeaving, unmarkSpaceLeaving, isSpaceLeaving, getBoundSignerKey, broadcastSharePrepareProgress, configurePendingLeaves, registerPendingLeave, unregisterPendingLeave, joinPendingLeaveTopic, leavePendingLeaveTopic, hasPendingLeave, takeLeaveAckedKeys, configurePendingCancels, registerPendingCancel, joinPendingCancelTopic, leavePendingCancelTopic, hasPendingCancel, sendPendingCancelToConnected } from '../shared/transfer/swarm.js'
import { initContentSwarm, destroyContentSwarm, setContentAttachHook, setContentResumeHook } from '../shared/transfer/content-swarm.js'
import { clampDisplayName, checkGrantAssertion } from '../shared/transfer/handshake-guard.js'
import { openSealedSck } from '../shared/transfer/sck-seal.js'
import { reconcileAssertedRoot } from '../shared/spaces/creator-root.js'
import { getConnectedMemberMeta, readmitConnectedMembers } from '../shared/transfer/swarm.js'
import {
  configureMemberRegistry, openMemberView, closeMemberView, openMemberViewsForKnownSpaces, closeAllMemberViews, dropTombstone, isLeft,
  isApprovedJoiner, isDeniedJoiner, setMembershipRevokedHook,
} from '../shared/spaces/member-registry.js'
import { reconnectGrantAllowed } from '../shared/spaces/member-set.js'
import { ownCatalogPublish, purgeOwnCatalog, catalogKeyField } from '../shared/shares/share-catalog.js'
import { initDownloads, listFiles, removeFile, revealFile, cleanupDownloadHistory, addFile, isDownloadedFile, getDownloadedPath, revealLocalPath, getVerifiedHash, isVerifiedDownload, claimedPathFor } from '../shared/transfer/files.js'
import { initLooseOverlay, looseDownload, loosePause, looseCancel, looseCancelSpace, looseCancelTransfer, looseCancelPublish, resumeLooseForOwner, handleLooseFsEvent, rehydrateLooseFiles, sweepLoosePresence } from '../shared/transfer/loose-overlay.js'
import { overlayPause, overlayCancel, overlayCancelByKey, overlayCancelSpace, resumeOverlayForOwner, overlayHasTransfer, setSharePrepareBroadcast, subscribeServeDetail, unsubscribeServeDetail, listServeSummaries, abortInFlightPublishes } from '../shared/transfer/backends/overlay/overlay-backend.js'
import { getJournalDir, revokeServesForSpace, bumpServeEpoch } from '../shared/transfer/backends/overlay/overlay-instance.js'
import { cleanupOrphanedJournals } from '../shared/transfer/backends/overlay/vendor/transfer.js'
import { cleanupOrphanedPartials } from '../shared/transfer/partial-sweep.js'
import { pausedStatusFor, unhashedStatusFor } from '../shared/transfer/transfer-status.js'
import { transferIdFor, isLooseTransferId } from '../shared/transfer/transfer-id.js'
import { makeKeyedCoalescer } from '../shared/state/coalesce.js'
import { initPendingTransfers, clearPendingForSpace, listPendingForSpace, listPendingOwnerKeys } from '../shared/transfer/pending-transfers.js'
import { getStorageInfo, cleanupOrphanedData, getSpaceCacheBytes, freeSpace } from '../shared/storage/storage.js'
import { spaceStorageSummary } from '../shared/storage/space-storage.js'
import { reclaimLegacyPeerCaches } from '../shared/storage/legacy-peer-cache.js'
import { classifyLeftovers, forgetUnreferencedPeerCores } from '../shared/storage/leftover.js'
import { sendFeedback } from '../shared/telemetry/feedback.js'
import { getInstallId } from '../shared/telemetry/install-id.js'
import {
  initAuditLog, record, setAuditIdentity, queryAudit, auditSpaces, auditActors, auditStats,
  getAuditConfig, setAuditConfig, pruneAudit, purgeAudit, exportAudit,
} from '../shared/audit/audit-log.js'
import { publishShare, tombstoneShare, readOwnShares, isValidShareName, generateShareId, ensureSharesCap } from '../shared/shares/shares.js'
import { migrateLegacyOwnedSharesToOverlay } from '../shared/shares/migrate-content-mode.js'
import { migrateCatalogsToEncrypted } from '../shared/shares/migrate-catalog-encrypt.js'
import { migrateOverlayIndexToEncrypted } from '../shared/transfer/backends/overlay/migrate-overlay-index-encrypt.js'
import { listSharesForSpace } from '../shared/shares/share-registry.js'
import { ensureFolderMirrorsCap, publishMirror, ensureMirror } from '../shared/folders/mirror-records.js'
import { listMirrorsForShare, listMirrorsForSpace } from '../shared/folders/mirror-registry.js'
import { AppError, ErrorCodes } from '../shared/core/errors.js'
import { initMounts, saveOwnedMount, getOwnedMount, deleteOwnedMount, listOwnedMounts, listAllMounts, setOwnedMountStatus } from '../shared/folders/mount-store.js'
import { validateMountPath, validateDownloadFolderAgainstMounts } from '../shared/folders/mount-validate.js'
import { relKeyEscapes } from '../shared/folders/path-keys.js'
import {
  initOwnedFolders, handleFsEventFromMain, onFsEvent, initialPublishScan,
  previewInitialPublishScan, periodicReconcile, stopOwnedFolder, DEFAULT_IGNORE,
  mountRootAvailable, countFolderFiles,
} from '../shared/folders/owned-folders.js'
import { exceedsShareFileLimit, shareFileLimitMessage, listingTruncated } from '../shared/folders/share-limits.js'
import {
  initForeignFolders, initialMaterializeScan, previewMaterializeScan,
  startForeignLoop, stopForeignLoop, setForeignEnabled, unmountForeignFolder,
  foreignFetchActive, resumeAutoPausedForeignMount, autoPauseForeignMountGone,
} from '../shared/folders/foreign-folders.js'
import { saveForeignMount as persistForeignMount, getForeignMount, listForeignMounts } from '../shared/folders/mount-store.js'

const ipc = createIPC(Bare.IPC)
const log = createLogger('worklet')

// Main authorizes "reveal in folder" against these, and cannot read the space records
// that hold the per-space overrides, so the set is pushed to it on every change.
function publishDownloadRoots() {
  ipc.emit('main-request', { command: 'downloads:roots', args: { roots: listDownloadRoots() } })
}

// Dropping a root is a NARROWING of that allowlist, so it has to be published like any other
// change: main's copy is push-only, and a forget that never republishes leaves it authorizing
// reveals under a departed space's folder for the rest of the process lifetime.
function dropSpaceDownloadRoot(spaceId) {
  forgetSpaceDownloadRoot(spaceId)
  publishDownloadRoots()
}

// === Crash safety & shutdown ===

// Install the crash backstop FIRST — before any core-opening init below — so that NO
// boot-time data-layer error can abort the worker and take the whole data layer down with it
// (the user-visible symptom would be "the app won't start"). The hazard it guards against is a
// fire-and-forget rejection from a background core open — e.g. corestore opening a
// derived/announced core by discovery key that isn't stored locally → STORAGE_EMPTY — which
// Bare's default unhandled-rejection handler would turn into a worker abort. With the backstop
// up front it is logged and boot continues. (A genuinely fatal *awaited* init can still leave
// boot incomplete, but the worker stays alive and logs loudly instead of vanishing — strictly
// better than a silent abort.)
installCrashBackstop(log)

let shuttingDown = false
async function safeShutdown(reason) {
  if (shuttingDown) return
  shuttingDown = true
  log.warn('shutdown:', reason)
  // Hard deadline: a hung swarm/store teardown must never keep the worker alive.
  // (This covers the "stuck on an await" case; if the event loop is starved by a
  // busy loop the timer can't fire either — the parent's SIGKILL backstop is what
  // reaps that case.)
  const deadline = setTimeout(() => { try { Bare.exit(0) } catch {} }, 4000)
  deadline.unref?.()
  // Announce departure to connected peers FIRST (best-effort) and abort in-flight hashing so a
  // quit-mid-index worker unwinds and teardown wins the parent's SIGTERM/SIGKILL race; then a
  // short flush window so the departure datagram leaves UDX before destroySwarm drops the socket.
  try { broadcastDeparture() } catch {}
  try { abortInFlightPublishes() } catch {}
  try { await new Promise((resolve) => { const to = setTimeout(resolve, 150); to.unref?.() }) } catch {}
  try { closeAllMemberViews() } catch {}
  try { await teardownBackends() } catch {}
  try { await destroyContentSwarm() } catch {}
  try { await destroySwarm() } catch {}
  log.info('shutdown complete')
  Bare.exit(0)
}

// Register the pipe-close teardown BEFORE the bootstrap await. If the parent dies
// during startup (before sending the bootstrap line), the IPC pipe closes while
// we're parked on getBootstrapPromise; without these handlers in place the
// worker would sit at that await forever as an idle orphan. safeShutdown's
// teardown steps all no-op safely when called before init.
Bare.IPC.on('end', () => { safeShutdown('ipc-end') })
Bare.IPC.on('close', () => { safeShutdown('ipc-close') })
Bare.IPC.on('error', (err) => { safeShutdown('ipc-error: ' + (err && err.message ? err.message : err)) })

// === Boot: config, identity unlock, store, migrations ===

const bootstrap = await getBootstrapPromise()
setRuntimeConfig(bootstrap)

log.info('starting...')

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
// Before loadDrives and the swarm, so the log is writable before anything worth recording can
// happen. A failure here must not abort boot — an unavailable audit log degrades to no rows.
try {
  await initAuditLog({ installId: await getInstallId(bootstrap.storage) })
} catch (err) {
  log.warn('audit log unavailable — events will not be recorded:', err.message)
}

// Audit rows must render with zero joins: a space record is deleted on leave and a peer's name
// needs that peer reachable, so both are snapshotted into the row at write time. These helpers
// are the single place that resolution happens.
function refreshAuditSelfName(displayName) {
  setAuditIdentity({ key: getLocalPublicKeyHex(), name: displayName })
}

function selfActor() {
  return { type: 'self', key: null, name: null }
}

function peerActor(space, publicKey) {
  const live = space ? getConnectedMemberMeta(space.spaceId, publicKey) : null
  const persisted = (space?.members || []).find((m) => m.publicKey === publicKey)
  return { type: 'peer', key: publicKey, name: live?.displayName || persisted?.displayName || null }
}

function spaceRef(space) {
  return space ? { id: space.spaceId, name: space.name } : null
}

function fileNameOf(path) {
  if (typeof path !== 'string') return null
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i >= 0 ? path.slice(i + 1) : path
}

// A peer handed us the space content key — the moment read access was actually granted, and the
// counterpart to the approver's own `membership.approved` row. Extracted so onGrant, already at
// the complexity ceiling, gains no branches.
async function recordGrantReceived(spaceId, space, granterKey) {
  const name = getConnectedMemberMeta(spaceId, granterKey)?.displayName || null
  record('membership.granted', {
    actor: { type: 'peer', key: granterKey || null, name },
    space: spaceRef(await getSpace(spaceId)),
    target: { kind: 'space', id: spaceId, name: space?.name ?? null },
  })
}

async function shareNameOrNull(spaceId, ownerKey, shareId) {
  try {
    const all = await listSharesForSpace(spaceId)
    return all.find((s) => s.id === shareId && s.owner === ownerKey)?.name ?? null
  } catch {
    return null
  }
}

const driveLoad = await loadDrives()
if (driveLoad.hadFailure) {
  try { await cleanupOrphanedData() } catch (err) {
    log.warn('orphan cleanup after drive-load failure failed:', err.message)
  }
}

await ensureMembershipManifestCap()
await ensureSharesCap()
await ensureFolderMirrorsCap()
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
await initMounts()
// settleScanStatus (hoisted, defined with the reconcile scheduling below) also settles the
// trailing catch-up reconcile a watcher event schedules, so a source that disappears or returns
// between probe ticks still updates the durable status and notifies the UI. Forward-referencing it
// here is safe: the hook can only fire off a watcher event, and no frame is dispatched until
// ipc.start() at the end of this module — well after the state it touches is initialised.
initOwnedFolders(ipc, { settleScan: settleScanStatus })
initForeignFolders(ipc)
const knownSpaces = await listSpaces()
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
const activeSpaces = knownSpaces.filter((s) => !s.leaving)
// Hydrated here, from the spaces that SURVIVED the interrupted-leave pass above, and off the
// scan that pass already did. A space being left keeps no download root: hydrating it would
// leak a dead space's folder into main's reveal allowlist and into mount validation for the
// whole session (the resume path purges the record without going through space:leave's forget).
// Safe this late — nothing between store init and here reads a download root, and ipc.start()
// (which admits the first frame that could) is the last statement in this module.
hydrateDownloadRoots(activeSpaces)
publishDownloadRoots()
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

// wire backends + every connection handler/hook BEFORE the swarm starts
// accepting connections, so no inbound connection lands without the overlay
// channel attached, the content/membership handlers set, or the overlay instance
// created (a connection in that window would silently never get an overlay channel).
await initBackends(ipc) // overlay instance + IPC ref when the flag is on
initLooseOverlay(ipc)
if (isInPlaceFilesEnabled()) rehydrateLooseFiles().catch((err) => log.debug('loose rehydrate failed:', err.message))
const useContentPlane = isOverlayEnabled() && isSeparateContentPlaneEnabled()
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
setMembershipControlHandler(handleMembershipControl)
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
initSwarm(ipc)
if (useContentPlane) initContentSwarm(getSwarmDht())
// After BOTH constructors: getContentSwarm() is null until the line above runs, and a
// relay installed on the control swarm alone leaves every file byte unrelayed.
applyRelayConfig()

function applyRelayConfig() {
  const { mode, relays } = getRelayConfig()
  const res = setRelayThrough(relays, mode)
  if (res.applied > 0) log.info('relay configured:', res.applied, 'key(s), mode', mode)
  return res
}

// Deferred past the core-opening init above so the one-time compaction (which
// scrubs the migrated plaintext from old SSTs) doesn't contend with boot I/O.
if (didMigrateMetadata || didMigrateOverlayIndex) {
  compactStore().catch((err) => log.warn('post-migration compaction failed:', err.message))
}

// === Membership control ===

// One poke per followed member per share-record append — K raw frames while K records
// replicate, each driving a 3-IPC useShares refresh incl. per-member network head-pulls.
// Coalesce per space at the source; files-updated is additionally coalesced downstream
// into event:reconcile by the hint bus.
const sharesPoke = makeKeyedCoalescer((spaceId) => {
  ipc.emit('event:shares-updated', { spaceId })
  ipc.emit('event:files-updated', { spaceId })
}, { intervalMs: 250 })

// Durable (Tier-1) membership: derive each space's member set from replicated records and
// write it into space.members. Swarm metadata + the IPC emitter are injected so the registry
// needs no swarm import. (Runs alongside the handshake/gossip path under a conservative
// contract: it only ever agrees-or-adds, and removes a member only once the replicated
// evidence and the live connection state agree — a live handshake always outranks stale
// records.)
configureMemberRegistry({
  metaFor: (spaceId, key) => getConnectedMemberMeta(spaceId, key),
  isConnected: (spaceId, key) => !!getConnectedMemberMeta(spaceId, key),
  profileFor: (spaceId, key) => readProfileRecord(key, spaceId),
  readmitConnected: (spaceId, keys) => readmitConnectedMembers(spaceId, keys),
  // A change in the derived member set changes whose files + shares we surface (both lists
  // read peer content keyed on space.members), so refresh all three renderer views — not
  // just the member list. On a removal these events are the only signal that drops the gone
  // member's content from the file/share views.
  emitMembersUpdated: (spaceId) => {
    ipc.emit('event:members-updated', { spaceId })
    ipc.emit('event:shares-updated', { spaceId })
    ipc.emit('event:files-updated', { spaceId })
  },
  emitJoinRequest: (spaceId, req) => {
    ipc.emit('event:member-join-request', { spaceId, ...req })
    auditJoinRequest(spaceId, req.publicKey, req.displayName)
  },
  emitJoinRequestsUpdated: (spaceId) => ipc.emit('event:join-requests-updated', { spaceId }),
  // A followed member added/removed a share/<space>/* record (shares live in the profile bee, which
  // doesn't move the member set). Poke the share + file lists so a derived-only member's share
  // surfaces without waiting for an unrelated member-set change.
  emitSharesUpdated: (spaceId) => sharesPoke.poke(spaceId),
})

async function handleMembershipControl(msg, ctx) {
  try {
    if (msg.type === 'membership:request') return await onJoinRequest(msg)
    if (msg.type === 'membership:grant') return await onGrant(msg, ctx)
    if (msg.type === 'membership:deny') return onDeny(msg)
    if (msg.type === 'membership:cancel') return await onCancel(msg, ctx)
  } catch (err) {
    log.warn('membership control failed:', msg?.type, '-', err.message)
  }
}

async function onJoinRequest(msg) {
  const spaceId = (msg.spaceTopic || '').slice(0, 16)
  const space = spaceId ? await getSpace(spaceId) : null
  if (!space || space.schemaVersion !== 2) return
  // We are still pending ourselves: we hold no content key, so we can neither grant
  // nor meaningfully approve — ignore other peers' requests entirely.
  if (space.status === 'pending') return
  // Capture the leave-tombstone (the kept "this peer left" marker) BEFORE clearing it: a peer
  // mid-leave can still be transiently in
  // space.members (handleLeaveFrame's removeMember hasn't committed), so a peer we've observed
  // leaving must go through fresh approval, never the reconnect re-grant shortcut below.
  const hadLeft = isLeft(spaceId, msg.profileKey)
  // A fresh request means they want back in — lift any leave-tombstone (in-memory + durable) so the
  // gate and the fold treat them as a normal (re)joiner again.
  await dropTombstone(spaceId, msg.profileKey)
  const grant = () => {
    // Honor the same pause resolveJoinRequest enforces: while the creator-root conflict is
    // unresolved, hand out no content key. Harmless for a reconnecting member (it already holds
    // the SCK); load-bearing for the approved-but-keyless branch below, whose grant would be the
    // joiner's FIRST SCK delivery under the disputed trust anchor.
    if (space.creatorDivergence) { log.warn('re-grant blocked — creator root divergence unresolved:', spaceId); return }
    const sck = getSpaceContentKey(spaceId, space)
    if (sck) sendMembershipGrant(msg.profileKey, space.topic, b4a.toString(sck, 'hex'), space.creatorKey, boundSignerPk(msg.profileKey))
  }
  // Reconnect (still a member, no leave observed) → re-grant idempotently. A just-left peer falls
  // through to a fresh join request + approval banner instead.
  if (reconnectGrantAllowed((space.members || []).some((m) => m.publicKey === msg.profileKey), hadLeft)) return grant()
  // Approved but never confirmed: the durable approved/<S>/<joiner> receipt exists while the
  // joiner's own member/<S> record hasn't converged — the state a joiner approved while OFFLINE
  // re-knocks from (its grant frame was undeliverable, so it is still 'pending' and re-requests
  // on every reconnect). Re-issue the grant BEFORE the invite classification: the original invite
  // may be spent or expired by now and must not re-deny an already-approved joiner. Idempotent,
  // and self-terminating once the joiner publishes its member record and the fold promotes it;
  // hadLeft still forces a departed peer through fresh approval.
  if (!hadLeft && isApprovedJoiner(spaceId, msg.profileKey)) return grant()
  // Per-link policy. The record is replicated across the member set, so any member resolves it the
  // same: expired → refuse (the replicated record is authoritative, so stripping or forging the
  // envelope's expiry hint cannot bypass it); auto → grant; review/absent → fall through to the
  // manual approval banner. A resolved record (inviteRec) marks a deliberate, still-valid link.
  let inviteRec = null
  if (msg.inviteId) {
    inviteRec = await resolveInvite(space, msg.inviteId)
    const verdict = classifyInvite(inviteRec)
    if (verdict === 'expired') {
      if (space.topic) sendMembershipDeny(msg.profileKey, space.topic)
      return
    }
    if (verdict === 'auto') {
      await resolveJoinRequest(space, msg.profileKey, 'approve')
      return
    }
  }
  // Denied while offline: the durable denied/<S>/<joiner> tombstone converged among members, but
  // the joiner never received the live deny frame — its space is stuck 'pending' and re-knocks on
  // every reconnect. Re-send the deny so a STUCK joiner (a bare reconnect replay: no currently-valid
  // reviewable invite backs this knock) can discard the space; no fresh banner. But a valid review
  // invite means the owner re-opened the door — fall through to the banner so they can approve or
  // revoke, instead of silently re-denying a genuine re-invitation.
  if (!hadLeft && !inviteRec && isDeniedJoiner(spaceId, msg.profileKey)) {
    if (space.topic) sendMembershipDeny(msg.profileKey, space.topic)
    return
  }
  const displayName = clampDisplayName(msg.displayName)
  const changed = recordJoinRequest(spaceId, msg.profileKey, displayName, msg.avatar)
  // The durable receipt runs on EVERY knock — markRequest short-circuits on an existing one,
  // so a re-announced (heartbeat) request is nearly free while a first write that failed
  // self-heals. A departed peer (hadLeft) that re-requests must write a FRESH receipt ts, so
  // co-members reading it via replication surface the rejoin instead of suppressing it
  // against our leave stamp. Only the renderer emit is deduped: an unchanged heartbeat
  // keeps the banner quiet, and this sits strictly AFTER the replay branches above, so a
  // re-knock still replays a lost grant/deny.
  await markRequest(spaceId, msg.profileKey, { displayName, avatar: msg.avatar || null, refresh: hadLeft })
  if (changed || hadLeft) {
    ipc.emit('event:member-join-request', { spaceId, publicKey: msg.profileKey, displayName, avatar: msg.avatar || null })
    auditJoinRequest(spaceId, msg.profileKey, displayName)
  }
}

// The bound ed25519 signer key of a currently-connected peer, as a buffer, to seal its SCK grant.
// A grant only reaches a connected peer, so this is the single reliable source (boundSignerKeys is
// populated from every verified identity frame); no need to thread it through the request record.
// A knock reaches us two ways — the live membership:request frame, and the replicated fold when a
// co-member heard it first — and either can arrive first. Both record through here so the row
// appears regardless of path, and appears once. Cleared when the request resolves, so a later
// re-knock after a denial is recorded again.
const recordedJoinRequests = new Set()
const joinRequestKey = (spaceId, publicKey) => spaceId + '|' + publicKey

function auditJoinRequest(spaceId, publicKey, displayName) {
  const key = joinRequestKey(spaceId, publicKey)
  if (recordedJoinRequests.has(key)) return
  recordedJoinRequests.add(key)
  getSpace(spaceId).then((space) => {
    record('membership.requested', {
      actor: { type: 'peer', key: publicKey, name: displayName || null },
      space: spaceRef(space),
      target: { kind: 'member', id: publicKey, name: displayName || null },
    })
  }).catch(() => {})
}

function forgetJoinRequestRecord(spaceId, publicKey) {
  recordedJoinRequests.delete(joinRequestKey(spaceId, publicKey))
}

function boundSignerPk(profileKeyHex) {
  const hex = getBoundSignerKey(profileKeyHex)
  return hex ? b4a.from(hex, 'hex') : null
}

// Reconcile the granter's authenticated root assertion against our pin. noop with an
// assertion = an authenticated granter re-confirmed the pinned root, so a flagged divergence
// is no longer live (noop without one clears nothing); refuse = a confirmed conflict, the
// grant must stop. Returns { blocked, decision }.
async function reconcileGrantCreator(spaceId, space, asserted) {
  const pinnedIsAuthenticated = !!space.creatorKey && !space.creatorUnverified
  const decision = reconcileAssertedRoot({ pinned: space.creatorKey || null, pinnedIsAuthenticated, asserted })
  if (decision === 'noop' && asserted && space.creatorDivergence) {
    await clearCreatorDivergence(spaceId)
    ipc.emit('event:membership-creator-divergence', { spaceId })
  }
  if (decision === 'refuse') {
    record('security.creator_divergence', {
      actor: { type: 'system', key: null, name: null },
      space: spaceRef(space),
      target: { kind: 'space', id: spaceId, name: space?.name ?? null },
      subject: { pinned: space.creatorKey ?? null, asserted: asserted ?? null },
      outcome: 'denied',
    })
    log.warn('membership:grant creator divergence — confirmed', space.creatorKey?.slice(0, 12) + '...', 'vs granter', asserted?.slice(0, 12) + '...')
    await markCreatorDivergence(spaceId)
    ipc.emit('event:membership-creator-divergence', { spaceId })
    return { blocked: true, decision }
  }
  return { blocked: false, decision }
}

async function onGrant(msg, ctx = {}) {
  const spaceId = (msg.spaceTopic || '').slice(0, 16)
  const space = spaceId ? await getSpace(spaceId) : null
  if (!space || space.status !== 'pending') return

  // Authenticate the member-set root assertion before trusting it. The granter is, by the read
  // gate, an authorized member; verifying its identity binding (the signature tying its profile
  // key to this socket's Noise key) proves it really is the peer it claims to be. We pin
  // creatorKey from THIS authenticated assertion, not from the bearer invite.
  const enforce = isHandshakeIdentityBindingEnabled()
  const verdict = checkGrantAssertion(ctx.peerInfo, msg, { enforceBinding: enforce })
  if (!verdict.ok) {
    log.warn('rejected membership:grant —', verdict.reason)
    return
  }
  // While binding enforcement is off the assertion is unverified, so we leave the provisional
  // invite pin untouched; an assertion is adopted or refused only once it is authenticated
  // (enforcement on).
  const asserted = enforce ? verdict.creator : null
  const { blocked, decision } = await reconcileGrantCreator(spaceId, space, asserted)
  if (blocked) return

  // The SCK arrives sealed to our bound signer key; a plaintext sck field is refused as a
  // downgrade. A sealed 32-byte SCK is exactly 80 bytes (32 + crypto_box_SEALBYTES) = 160 hex
  // chars; bound the length so a peer can't trigger a large allocation with a multi-megabyte
  // sckSealed.
  const signer = getIdentitySigner()
  if (typeof msg.sckSealed !== 'string' || !/^[0-9a-f]{160}$/i.test(msg.sckSealed) || !signer) return
  const sckBuf = openSealedSck(b4a.from(msg.sckSealed, 'hex'), signer)
  if (!sckBuf || sckBuf.length !== 32) return

  await materializeOwnDrive(spaceId, sckBuf)
  if (asserted && (decision === 'adopt' || decision === 'confirm')) await pinCreatorKey(spaceId, asserted)
  await broadcastProfileUpdate()
  await openMemberView(spaceId)   // space is now approved → derive its membership
  await recordGrantReceived(spaceId, space, msg.profileKey)
  ipc.emit('event:membership-granted', { spaceId })
}

// A pending joiner withdrew their request (an ephemeral Tier-3 lifecycle signal) — drop our banner. Only the
// members actually showing it author a durable tombstone (the cancel is broadcast to every
// socket; don't pollute uninvolved members' bees) so the withdrawal converges + survives restart.
async function onCancel(msg, ctx = {}) {
  const spaceId = (msg.spaceTopic || '').slice(0, 16)
  if (!spaceId || typeof msg.joinerKey !== 'string') return
  const showing = listJoinRequests(spaceId).some((r) => r.publicKey === msg.joinerKey)
  const had = clearJoinRequest(spaceId, msg.joinerKey)
  if (showing) await markRequestDenied(spaceId, msg.joinerKey)
  // Ack so the joiner stops replaying. applied:true whenever the withdrawal is DURABLY applied here
  // (we just wrote the tombstone, or already hold one from a prior replay) — re-attesting on every
  // replay so a single lost ack can't leave the joiner replaying forever. isDeniedJoiner reflects
  // the tombstone that replicates the withdrawal to co-members.
  const applied = showing || isDeniedJoiner(spaceId, msg.joinerKey)
  ctx.reply?.({ type: 'membership:cancel-ack', spaceTopic: msg.spaceTopic, joinerKey: msg.joinerKey, applied })
  if (had || showing) ipc.emit('event:join-requests-updated', { spaceId })
}

async function onDeny(msg) {
  const spaceId = (msg.spaceTopic || '').slice(0, 16)
  if (!spaceId) return
  // The request was rejected — the joiner never became a member, so drop the
  // pending space entirely instead of leaving it stranded in their list.
  const space = await getSpace(spaceId)
  if (space?.status === 'pending') await discardPendingSpace(spaceId)
  ipc.emit('event:membership-denied', { spaceId })
}

// Single chokepoint for a member resolving a pending join request (an ephemeral Tier-3
// request becoming durable Tier-1 membership). On
// approve it authors the approval record (recordApproval) and hands the joiner the SCK
// grant directly; co-members converge on the new member by replicating that record (the
// fold re-derives) — no approval gossip. On deny it signals the joiner and tells
// co-members to drop the banner. Routing all decision sites (manual approve, auto-admit,
// deny) through here means none can omit a step. outcome: 'approve' | 'deny'.
async function resolveJoinRequest(space, joinerKey, outcome) {
  // The knock is settled; forget it so a genuine later re-knock (e.g. after a denial) records
  // again rather than being swallowed by the first one's dedupe.
  forgetJoinRequestRecord(space.spaceId, joinerKey)
  const spaceId = space.spaceId
  if (outcome === 'approve') {
    // A confirmed creator-root conflict disputes the roster's trust anchor — handing out the
    // SCK now would admit members under an unresolved identity split. This check is what makes
    // the divergence banner's "approvals are paused" claim true.
    if (space.creatorDivergence) {
      log.warn('approval blocked — creator root divergence unresolved:', spaceId)
      throw new AppError(ErrorCodes.CREATOR_DIVERGENCE_UNRESOLVED, 'approvals are paused while the creator root conflict is unresolved')
    }
    const sck = getSpaceContentKey(spaceId, space)
    if (!sck) return false
    await recordApproval(spaceId, joinerKey)
    // The read-model is already correct here (member approved, request cleared), so clear the
    // approver's banner now instead of gating it on the grant/capture below — matches the deny path.
    ipc.emit('event:join-requests-updated', { spaceId })
    // Grant FIRST so the joiner flips to approved promptly — delaying it widens a race where a
    // co-member's (no-op) deny reaches a still-pending joiner and makes it discard the space.
    let delivered = false
    if (space.topic) {
      // The grant is sealed to the joiner's bound signer key, read from its live connection
      // (the joiner must be connected to be granted). Surface a failure loudly rather than leaving
      // the joiner silently stuck on "waiting for approval".
      const signerPk = boundSignerPk(joinerKey)
      delivered = sendMembershipGrant(joinerKey, space.topic, b4a.toString(sck, 'hex'), space.creatorKey, signerPk)
      if (!delivered) log.warn('approval grant not delivered —', joinerKey.slice(0, 8), '— signer key', signerPk ? 'present' : 'missing')
    }
    // THEN durably capture the joiner's OWN profile core while it is still connected (it stays
    // connected through this awaited handler). Without this, a joiner that disconnects right after
    // approval leaves NO peer holding its record, so the OR-Set fold can never converge it on
    // anyone — the owner included. We serve it onward via our member-view follow. The capture is
    // best-effort and time-bounded so slow replication can't stall the approval; the joiner
    // usually hasn't authored/replicated its member record yet at this instant, so a miss here is
    // normal and the fold converges it later anyway — keep it at debug.
    const captured = await captureJoinerMembership(joinerKey, spaceId)
    if (!captured) log.debug('approval: joiner membership record not captured —', joinerKey.slice(0, 8))
    return { granted: true, delivered }
  }
  clearJoinRequest(spaceId, joinerKey)
  await markRequestDenied(spaceId, joinerKey)   // durable, replicated dismissal (+ drops our receipt)
  if (space.topic) {
    sendMembershipDeny(joinerKey, space.topic)
    broadcastMembershipCancel(spaceId, space.topic, joinerKey)   // co-members drop the banner
  }
  ipc.emit('event:join-requests-updated', { spaceId })
  return true
}

// Tear down a space we only ever sat pending in: no own drive, owned/foreign
// mounts, or authored membership records exist, so the heavyweight leave path
// (which purges a drive that was never materialized) does not apply and crashes
// on the closing cores. This is the cancel path for both a deny and a manual
// "stop waiting". Every step is best-effort so a single failure can't reject the
// caller and surface as an Uncaught in the renderer.
async function discardPendingSpace(spaceId) {
  markSpaceLeaving(spaceId)
  closeMemberView(spaceId)
  try {
    const space = await getSpace(spaceId)
    const peerMembers = (space?.members || []).filter((m) => !!m.driveKey)
    try { await leaveSpaceTopic(spaceId) } catch (err) { log.warn('discard pending: leave topic failed:', err.message) }
    try { await cleanupSpaceDrives(spaceId, peerMembers) } catch (err) { log.warn('discard pending: peer-drive cleanup failed:', err.message) }
    try { await purgeSpace(spaceId) } catch (err) { log.warn('discard pending: remove failed:', err.message) }
    dropSpaceDownloadRoot(spaceId)
    try { await forgetUnreferencedPeerCores(space?.members || []) } catch (err) { log.warn('discard pending: peer-core gc failed:', err.message) }
  } finally {
    unmarkSpaceLeaving(spaceId)
  }
}

// === Startup resume: sweeps, folder mounts, periodic timers ===

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

// Open derived member views (which seed the durable leave-tombstones into memory) BEFORE joining
// topics, so an inbound membership:request from a departed peer that reconnects can't be handled
// with an unseeded tombstone set — which would misread `hadLeft`, take the reconnect re-grant
// shortcut, and clear the durable tombstone before it was ever loaded. The fold self-heals as more
// peer bees replicate after the topics join below.
await openMemberViewsForKnownSpaces()

for (const space of activeSpaces) {
  await joinSpaceTopic(space.spaceId)
}

// Replay leaves that never reached a member (leave-while-alone): re-join each marker's
// topic and let the swarm re-announce the leave frame on every new connection; the first
// co-member ack clears the marker and drops the topic again.
configurePendingLeaves(async (spaceId) => {
  await clearPendingLeave(spaceId)
  await leavePendingLeaveTopic(spaceId)
})
configurePendingCancels((spaceId) => leavePendingCancelTopic(spaceId))
try {
  for (const pl of await listPendingLeaves()) {
    // The marker is persisted mid-teardown, BEFORE the space record is purged. If the worker
    // died in that window the record survives (the leave was interrupted, the user still has the
    // space) — drop the stale marker rather than replaying a leave for a live space, which would
    // otherwise swarm.leave() its topic on the first ack and strand it deaf until restart.
    if (!pl.topic || await getSpace(pl.spaceId)) { await clearPendingLeave(pl.spaceId); continue }
    registerPendingLeave(pl.spaceId, pl.topic, pl.ts || Date.now())
    joinPendingLeaveTopic(pl.spaceId, pl.topic)
    log.info('replaying pending leave for space', pl.spaceId)
  }
} catch (err) {
  log.warn('pending-leave replay setup failed:', err.message)
}

const periodicTimers = new Map()
const reconcileCounters = new Map()
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000

// role:shareId → last-known existence of the mount path. Read during the startup
// watcher restart (below) and maintained by the mount-point probe loop.
const lastMountPointStatus = new Map()

// Persist + announce an owned mount's status in one step. The durable field is what a
// boot or refresh re-derives the badge from — a transient-only event vanishes on reload —
// and the event stays as the live decoration.
async function setOwnedStatus(spaceId, shareId, status, error) {
  try { await setOwnedMountStatus(spaceId, shareId, status, error ?? null) } catch (err) {
    log.debug('owned mount status persist failed:', shareId, '-', err.message)
  }
  ipc.emit('event:owned-folder-mount-status', { spaceId, shareId, status, ...(error ? { error } : {}) })
}

// Everything that must happen once an owned source folder is known to be missing, from whichever
// signal noticed first: the mount-point probe, or a scan/reconcile that bailed on the absent root.
// Recording the absence in `lastMountPointStatus` is what lets the probe read the RETURN as a
// gone→present edge. Without it, a folder that vanished and came back inside a single 60s probe
// window produced no transition at all — so no status event, and every derived-from-event UI
// (the FolderView banner, the share card badge) stayed latched on "source missing" indefinitely.
async function handleOwnedMountGone(spaceId, shareId) {
  lastMountPointStatus.set('owned-folder:' + shareId, false)
  // Stop pointing a watcher at a dead path and stop reconciling. The published snapshot and the
  // mount config are left untouched — a missing root is ambiguous, never a delete.
  ipc.emit('main-request', { command: 'owned-folder:stop-watcher', args: { shareId } })
  cancelPeriodicReconcile(spaceId, shareId)
  await setOwnedStatus(spaceId, shareId, 'mount-point-gone')
}

// Map a reconcile/scan outcome to the durable owned-mount status. A scan RESOLVES (not rejects)
// with { skipped } when it couldn't run — a missing root or a content mode this build can't serve
// — so treating any resolution as 'active' would durably record a healthy scan that never ran.
// Returns the settled result (null on failure) so callers can gate their scan-completed emit.
async function settleScanStatus(promise, spaceId, shareId) {
  try {
    const result = await promise
    if (result?.skipped === 'mount-point-gone') await handleOwnedMountGone(spaceId, shareId)
    else if (result?.skipped) await setOwnedStatus(spaceId, shareId, 'paused-error', result.skipped)
    else await setOwnedStatus(spaceId, shareId, 'active')
    return result
  } catch (err) {
    log.warn('owned reconcile failed for', shareId, '-', err.message)
    await setOwnedStatus(spaceId, shareId, 'paused-error', err.message)
    return null
  }
}

function schedulePeriodicReconcile(spaceId, shareId, mountPath, ignore) {
  const key = spaceId + ':' + shareId
  const existing = periodicTimers.get(key)
  if (existing) clearInterval(existing)
  const timer = setInterval(() => {
    // Every Nth periodic pass runs deep (content-hash) to catch an in-place rewrite
    // that kept identical size+mtime; the rest are the fast stat-only diff.
    const n = (reconcileCounters.get(key) || 0) + 1
    reconcileCounters.set(key, n)
    const every = getDeepReconcileEvery()
    const deep = every > 0 && n % every === 0
    settleScanStatus(periodicReconcile(spaceId, shareId, mountPath, ignore, { deep }), spaceId, shareId)
  }, RECONCILE_INTERVAL_MS)
  timer.unref?.()
  periodicTimers.set(key, timer)
}

function cancelPeriodicReconcile(spaceId, shareId) {
  const key = spaceId + ':' + shareId
  const timer = periodicTimers.get(key)
  if (timer) {
    clearInterval(timer)
    periodicTimers.delete(key)
  }
}

try {
  const mounts = await listOwnedMounts()
  for (const mount of mounts) {
    // Don't point a watcher at a path that isn't there. The mount-point probe
    // loop restarts the watcher + reconcile once the path comes back.
    if (!mountRootAvailable(mount.mountPath)) {
      log.warn('owned mount path missing at startup:', mount.mountPath)
      lastMountPointStatus.set('owned-folder:' + mount.shareId, false)
      await setOwnedStatus(mount.spaceId, mount.shareId, 'mount-point-gone')
      continue
    }
    lastMountPointStatus.set('owned-folder:' + mount.shareId, true)
    ipc.emit('main-request', {
      command: 'owned-folder:start-watcher',
      args: { shareId: mount.shareId, mountPath: mount.mountPath, ignore: mount.ignore },
    })
    settleScanStatus(periodicReconcile(mount.spaceId, mount.shareId, mount.mountPath, mount.ignore), mount.spaceId, mount.shareId)
    schedulePeriodicReconcile(mount.spaceId, mount.shareId, mount.mountPath, mount.ignore)
  }
} catch (err) {
  log.warn('owned-folder watcher restart failed:', err.message)
}

try {
  const mounts = await listForeignMounts()
  for (const mount of mounts) {
    // Seed the probe baseline (parity with owned mounts above) so a later mount-point return
    // registers as a gone→present transition and the probe can auto-resume mid-session.
    lastMountPointStatus.set('foreign-folder:' + mount.shareId, mountRootAvailable(mount.mountPath))
    // Backfill a participation record for a mount that predates this feature (or whose mount-time
    // publish failed): only the fresh-mount handler publishes, and setMirrorState can't create one,
    // so without this a restored mirror stays invisible to owners forever.
    await ensureMirror(mount.spaceId, mount.shareId, { state: mount.enabled === false ? 'paused' : 'syncing' })
      .catch((err) => log.debug('mirror record ensure at boot failed for', mount.shareId, '-', err.message))
    if (!mount.enabled) {
      // Auto-paused mirrors (mount-point-gone / enospc / perm) recover at boot if the
      // local target is back and the fault cleared; a user pause ('paused') stays paused.
      await resumeAutoPausedForeignMount(mount.spaceId, mount.shareId).catch((err) =>
        log.debug('foreign auto-resume at boot deferred for', mount.shareId, '-', err.message))
      continue
    }
    // Enabled but its local target is missing at boot — durably pause it now. The probe only
    // pauses on a mid-session gone TRANSITION, so without this a gone-at-boot mirror would keep
    // a stale durable 'active' all session (its poll loop even mkdir -p's the missing root).
    if (!mountRootAvailable(mount.mountPath)) {
      await autoPauseForeignMountGone(mount.spaceId, mount.shareId).catch((err) =>
        log.debug('foreign gone-at-boot pause failed for', mount.shareId, '-', err.message))
      continue
    }
    // Owner drive may not be replicated at boot — the polling loop tolerates this
    // and retries every 30 s. We start the loop unconditionally and best-effort the
    // initial scan; if it fails because the peer isn't online yet, the next tick
    // picks up once the owner connects.
    startForeignLoop(mount)
    initialMaterializeScan(mount).catch((err) => {
      log.debug('foreign mirror initial scan deferred for', mount.shareId, '-', err.message)
    })
  }
} catch (err) {
  log.warn('foreign-folder restart failed:', err.message)
}

const MOUNT_PROBE_INTERVAL_MS = 60_000

async function probeMountPoints() {
  const fsMod = await import('bare-fs')
  const all = await listAllMounts()
  for (const mount of all) {
    const key = mount.role + ':' + mount.shareId
    let exists = true
    try { fsMod.default.statSync(mount.mountPath) } catch { exists = false }
    const prev = lastMountPointStatus.get(key)
    if (prev === exists) continue
    const wasGone = prev === false
    lastMountPointStatus.set(key, exists)

    if (mount.role === 'owned-folder') {
      if (!exists) {
        // Source folder just disappeared — same teardown the watcher-driven path runs.
        await handleOwnedMountGone(mount.spaceId, mount.shareId)
      } else if (wasGone) {
        // Source folder came back (USB replugged, network mount up, moved back). Resume: restart
        // the watcher, run one catch-up reconcile whose OUTCOME sets the durable status (so a
        // failing re-scan records paused-error, not a fabricated 'active'), and re-arm the timer.
        ipc.emit('main-request', {
          command: 'owned-folder:start-watcher',
          args: { shareId: mount.shareId, mountPath: mount.mountPath, ignore: mount.ignore },
        })
        settleScanStatus(periodicReconcile(mount.spaceId, mount.shareId, mount.mountPath, mount.ignore), mount.spaceId, mount.shareId)
        schedulePeriodicReconcile(mount.spaceId, mount.shareId, mount.mountPath, mount.ignore)
      }
      // A plain present tick (neither branch — e.g. the first probe of a freshly-added mount) must
      // NOT assert durable 'active': status is owned by scan outcomes, and blanket-writing 'active'
      // here would clobber a real paused-error the mount scan just recorded.
    } else {
      if (!exists) {
        // The poll loop may be idle (no writes → no I/O error to classify), leaving a
        // stale durable 'active' that a refresh/boot would resurrect — persist the pause.
        await autoPauseForeignMountGone(mount.spaceId, mount.shareId).catch((err) =>
          log.debug('foreign auto-pause on gone path failed for', mount.shareId, '-', err.message))
      }
      if (exists && wasGone) {
        // Local target returned mid-session — resume an auto-paused mirror (owned-branch
        // parity). No-ops for a user pause or a still-faulted mount.
        await resumeAutoPausedForeignMount(mount.spaceId, mount.shareId).catch((err) =>
          log.warn('foreign auto-resume after mount return failed for', mount.shareId, '-', err.message))
      }
      // Report the mount's real status (a user pause / still-faulted mount stays paused),
      // not a fabricated 'active' derived from mere path presence.
      const current = exists ? await getForeignMount(mount.spaceId, mount.shareId) : null
      ipc.emit('event:foreign-folder-mount-status', {
        spaceId: mount.spaceId,
        shareId: mount.shareId,
        status: current ? (current.status || 'active') : 'mount-point-gone',
      })
    }
  }
}

// === Download-root availability ===
//
// The mount probe above covers owned/mirrored folders; download roots had no equivalent, which
// is why a deleted or ejected download folder only ever surfaced as a failing transfer. Every
// root counts, not just the global one — a per-space override can vanish on its own.
//
// Level-triggered probe, edge-triggered emit: re-broadcasting an unchanged set every minute
// would churn the renderer for nothing, so the event fires only when the set actually changes.
// The renderer gets its INITIAL state from downloads:roots-status instead of waiting up to a
// full interval for the first transition.
let unavailableRoots = []

// The download-root twin of owned-folders' mountRootAvailable, deliberately kept separate: a
// download root is not a mount, and borrowing the mount-named helper would imply it is.
function rootAvailable(root) {
  try { return fs.statSync(root).isDirectory() } catch { return false }
}

function readUnavailableRoots() {
  return listDownloadRoots().filter((root) => !rootAvailable(root))
}

function sameRootSet(a, b) {
  return a.length === b.length && a.every((root, i) => root === b[i])
}

function probeDownloadRoots() {
  const next = readUnavailableRoots()
  if (sameRootSet(next, unavailableRoots)) return
  unavailableRoots = next
  if (next.length > 0) log.warn('download folder unavailable:', next.join(', '))
  else log.info('all download folders are available again')
  ipc.emit('event:download-roots-status', { unavailable: next })
}

// The renderer asks on mount and again whenever a transfer reports the folder gone, so the
// banner can appear at once rather than on the next tick. Re-probing (rather than returning the
// cached set) is what makes that second call worth making.
ipc.handle('downloads:roots-status', async () => {
  probeDownloadRoots()
  return { unavailable: unavailableRoots }
})

const mountProbeTimer = setInterval(() => {
  probeMountPoints().catch((err) => log.debug('mount probe failed:', err.message))
  try { probeDownloadRoots() } catch (err) { log.debug('download-root probe failed:', err.message) }
}, MOUNT_PROBE_INTERVAL_MS)
mountProbeTimer.unref?.()

// Backstop for catalog-backed shares: tombstone catalog entries whose source
// vanished (chokidar unlinks cover the live case; this catches missed events).
const PRESENCE_SWEEP_INTERVAL_MS = 60_000
const presenceSweepTimer = setInterval(() => {
  // overlay shares get a missed-unlink backstop via the backend fan-out
  // (no-ops when overlay is off / there are no overlay shares).
  sweepBackends().catch((err) => log.debug('overlay presence sweep failed:', err.message))
  if (isInPlaceFilesEnabled()) sweepLoosePresence().catch((err) => log.debug('loose presence sweep failed:', err.message))
}, PRESENCE_SWEEP_INTERVAL_MS)
presenceSweepTimer.unref?.()

// Prune our own expired invite links (reusable-until-expiry records are never consumed). Best-effort:
// enforcement is by timestamp regardless, so a missed run only defers cleanup.
const INVITE_SWEEP_INTERVAL_MS = 60 * 60 * 1000
async function sweepAllExpiredInvites() {
  for (const s of await listSpaces()) {
    if (s.schemaVersion === 2) await sweepExpiredInvites(s.spaceId)
  }
}
const inviteSweepTimer = setInterval(() => {
  sweepAllExpiredInvites().catch((err) => log.debug('invite sweep failed:', err.message))
}, INVITE_SWEEP_INTERVAL_MS)
inviteSweepTimer.unref?.()
sweepAllExpiredInvites().catch((err) => log.debug('invite sweep failed:', err.message))

ipc.handle('shutdown', () => { safeShutdown('renderer-shutdown') })

// === IPC: folder-share handlers (shares, owned & foreign mounts) ===

ipc.handle('share:list', async (msg) => {
  return await listSharesForSpace(msg.spaceId)
})

ipc.handle('share:create', async (msg) => {
  const space = await getSpace(msg.spaceId)
  if (!space) throw new AppError(ErrorCodes.NOT_FOUND, 'Space not found')
  const name = (msg.name || '').trim()
  if (!isValidShareName(name)) throw new AppError(ErrorCodes.SHARE_NAME_INVALID, 'Invalid share name')

  const existingOwn = await readOwnShares(msg.spaceId)
  if (existingOwn.some((s) => s.name === name)) {
    throw new AppError(ErrorCodes.SHARE_NAME_COLLISION, 'A folder with this name already exists in this space')
  }

  const share = {
    id: generateShareId(),
    type: 'owned-folder',
    name,
    owner: getLocalPublicKeyHex(),
    spaceId: msg.spaceId,
    createdAt: Date.now(),
  }
  // Overlay is the only content backend: serve straight from the source file (no
  // second copy), advertising into a replicated catalog peers list/fetch from.
  // Stamped at creation (replicates). A build without overlay can't create shares.
  if (!isOverlayEnabled()) throw new AppError(ErrorCodes.OVERLAY_REQUIRED, 'Folder sharing requires the overlay backend')
  // A v2 space's catalog is SCK-encrypted; without the SCK (a pending, not-yet-approved
  // member) we can't open our own catalog to advertise into. Refuse cleanly rather than let
  // ownCatalog throw a raw Error out of the IPC handler.
  if (space.schemaVersion === 2 && !getSpaceContentKey(msg.spaceId, space)) {
    throw new AppError(ErrorCodes.EOWNERSHIP, 'Cannot share into a space you have not been approved for yet')
  }
  share.contentMode = 'overlay'
  const { keyHex, encrypted } = await ownCatalogPublish(msg.spaceId)
  Object.assign(share, catalogKeyField(keyHex, encrypted))
  await publishShare(msg.spaceId, share)
  record('share.created', {
    actor: selfActor(),
    space: spaceRef(space),
    target: { kind: 'share', id: share.id, name: share.name },
  })
  ipc.emit('event:shares-updated', { spaceId: msg.spaceId })
  return share
})

ipc.handle('share:delete', async (msg) => {
  const space = await getSpace(msg.spaceId)
  const share = (await readOwnShares(msg.spaceId)).find((s) => s.id === msg.shareId)
  await tombstoneShare(msg.spaceId, msg.shareId)
  record('share.deleted', {
    actor: selfActor(),
    space: spaceRef(space),
    target: { kind: 'share', id: msg.shareId, name: share?.name ?? null },
  })
  ipc.emit('event:shares-updated', { spaceId: msg.spaceId })
  return { ok: true }
})

async function loadShareDescriptor(spaceId, ownerKey, shareId) {
  const all = await listSharesForSpace(spaceId)
  const share = all.find((s) => s.id === shareId && s.owner === ownerKey)
  if (!share) throw new AppError(ErrorCodes.NOT_FOUND, 'Share not found')
  return share
}

ipc.handle('share:list-files', async (msg) => {
  const share = await loadShareDescriptor(msg.spaceId, msg.ownerKey, msg.shareId)
  // Overlay is the only content backend; an unsupported mode renders as unavailable.
  const backend = getContentBackend(share)
  if (backend === UNSUPPORTED) return { entries: [], complete: true, total: 0, totalBytes: 0 }
  return await listOverlayShareFiles(msg.spaceId, share, backend)
})

// Contain a renderer-supplied (share:reveal-file) or catalog relPath inside the mount, so
// neither a compromised renderer nor a malicious owner catalog can reveal/open a file
// outside the share folder. Same guard as the data layer (path-keys.relKeyEscapes); reject
// before building the path.
function pathFromMount(mountPath, relPath) {
  if (relKeyEscapes(relPath)) {
    throw new AppError(ErrorCodes.EPATH, `file path rejected — unsafe segment escapes the share folder: ${relPath}`)
  }
  const sep = mountPath.includes('\\') ? '\\' : '/'
  const root = mountPath.replace(/[/\\]+$/, '')
  const abs = root + sep + relPath.split('/').join(sep)
  if (!(abs === root || abs.startsWith(root + sep))) {
    throw new AppError(ErrorCodes.EPATH, `file path rejected — resolves outside the share folder: ${relPath}`)
  }
  return abs
}

function statSizeOrNull(absPath) {
  try { return fs.statSync(absPath).size } catch { return null }
}

// Consumer-side status for a catalog-backed overlay share row. A null contentHash means
// the owner is still hashing → `preparing` while the owner is online, else `unavailable`
// (entries are advertised before hashing completes). Downloads land in the downloads folder and are recorded in the downloaded
// registry (markDownloaded), so `downloaded` is detected via isDownloadedFile — a file
// counts as downloaded iff the registry lists it.
async function overlayConsumerRow(spaceId, share, entry, { ownerOnline, foreignMount, pending }) {
  if (foreignMount && foreignMount.enabled) {
    const abs = pathFromMount(foreignMount.mountPath, entry.relPath)
    if (statSizeOrNull(abs) === entry.size) {
      const verified = !!entry.contentHash && (await getVerifiedHash(spaceId, share.id + '|' + entry.relPath)) === entry.contentHash
      return { status: 'synced', localPath: abs, verified }
    }
    // The mirror loop is pulling this row right now — 'downloading' so FolderView's
    // bar/speed/verify lane (all gated on the status) render during materialization.
    if (foreignFetchActive(spaceId, share.id, entry.relPath)) {
      return { status: 'downloading', localPath: null, pendingBytes: 0 }
    }
    if (!entry.contentHash) return { status: unhashedStatusFor(ownerOnline), localPath: null }
    return { status: ownerOnline ? 'remote' : 'unavailable', localPath: null }
  }
  const drivePath = '/' + share.name + '/' + entry.relPath
  if (await isDownloadedFile(spaceId, drivePath, entry.contentHash)) {
    const verified = await isVerifiedDownload(spaceId, share.id + '|' + entry.relPath, entry.contentHash)
    return { status: 'downloaded', localPath: (await getDownloadedPath(spaceId, drivePath)) || claimedPathFor(drivePath, null), verified }
  }
  // A failed (non-active) download surfaces as 'error' with the code, so the row
  // offers Retry/Dismiss + the message — parity with the loose path, instead of a
  // misleading 'paused-interrupted' that re-fetches the same bad bytes on Resume.
  const transferId = transferIdFor(spaceId, share.id, entry.relPath)
  const isActive = overlayHasTransfer(transferId)
  const pendingRow = pending?.get(drivePath)
  // An in-flight fetch is 'downloading' — derived here, not overlaid by the renderer.
  if (isActive) return { status: 'downloading', localPath: null, pendingBytes: pendingRow?.bytesTransferred || 0 }
  if (pendingRow?.errorCode) return { status: 'error', localPath: null, errorCode: pendingRow.errorCode }
  // A pending row with no live transfer is an interrupted/paused download →
  // paused-interrupted/paused-offline; overlayHasTransfer gates it so a refresh
  // mid-download doesn't flip the row.
  const paused = pausedStatusFor({ pendingRow, isActive, ownerOnline })
  if (paused) return { status: paused.status, localPath: null, pendingBytes: paused.pendingBytes }
  if (!entry.contentHash) return { status: unhashedStatusFor(ownerOnline), localPath: null }
  return { status: ownerOnline ? 'remote' : 'unavailable', localPath: null }
}

async function listOverlayShareFiles(spaceId, share, backend) {
  const isOwn = share.owner === getLocalPublicKeyHex()
  // One bounded pass returns the first `cap` catalog entries AND the true {total, totalBytes}
  // for the whole share, so a huge folder never materialises a 150k-row array and the count is
  // always consistent with the rows (total >= entries.length). The rich display rows below are
  // built only for the capped entries.
  const cap = getListFilesCap()
  const { entries, total, totalBytes, complete = true } = isOwn
    ? await backend.listOwn(spaceId, share.id, cap)
    : await backend.listPeerWithMeta(spaceId, share, cap)
  const ownerOnline = isOwn ? true : isOwnerOnline(share.owner)
  const ownedMount = isOwn ? await getOwnedMount(spaceId, share.id) : null
  const foreignMount = isOwn ? null : await getForeignMount(spaceId, share.id)
  const pending = isOwn ? null : new Map((await listPendingForSpace(spaceId)).map((p) => [p.filePath, p]))
  const out = []
  for (const entry of entries) {
    let row
    try {
      // pathFromMount throws on an unsafe peer-supplied relPath — skip that one
      // entry rather than aborting the whole listing (a malicious owner catalog
      // must not make the share un-browsable).
      if (isOwn) {
        row = { status: entry.contentHash ? 'synced' : 'preparing', localPath: ownedMount ? pathFromMount(ownedMount.mountPath, entry.relPath) : null }
      } else {
        row = await overlayConsumerRow(spaceId, share, entry, { ownerOnline, foreignMount, pending })
      }
    } catch (err) {
      log.warn('skipping overlay file row with an unsafe path:', entry.relPath, '-', err.message)
      continue
    }
    out.push({ relPath: entry.relPath, size: entry.size, hash: entry.contentHash || '', mtime: entry.mtime, status: row.status, localPath: row.localPath, verified: row.verified || false, pendingBytes: row.pendingBytes, errorCode: row.errorCode, transferId: isOwn ? undefined : transferIdFor(spaceId, share.id, entry.relPath) })
  }
  // Truncation is a FACT the worker reports, never something the renderer infers from
  // (total > rows): on an incomplete read `total` is itself partial, so that inference collapses
  // to false exactly when the rows were capped — and the truncation goes silent.
  const truncated = listingTruncated({ rowCount: entries.length, total, cap, complete })
  if (truncated) log.debug(`share:list-files showing ${out.length} of ${total} rows for share ${share.id} (capped at ${cap})`)
  return { entries: out, complete, total, totalBytes, truncated, fileLimit: truncated ? cap : null }
}

ipc.handle('share:reveal-folder', async (msg) => {
  const share = await loadShareDescriptor(msg.spaceId, msg.ownerKey, msg.shareId)
  const isOwn = share.owner === getLocalPublicKeyHex()
  let target
  if (isOwn) {
    const ownedMount = await getOwnedMount(msg.spaceId, msg.shareId)
    if (!ownedMount) throw new AppError(ErrorCodes.NOT_FOUND, 'Folder is not mounted on this device')
    target = ownedMount.mountPath
  } else {
    const foreignMount = await getForeignMount(msg.spaceId, msg.shareId)
    if (!foreignMount) throw new AppError(ErrorCodes.NOT_FOUND, 'Mirror not mounted')
    target = foreignMount.mountPath
  }
  return revealLocalPath(target)
})

ipc.handle('share:reveal-file', async (msg) => {
  const share = await loadShareDescriptor(msg.spaceId, msg.ownerKey, msg.shareId)
  const isOwn = share.owner === getLocalPublicKeyHex()
  let target
  if (isOwn) {
    const ownedMount = await getOwnedMount(msg.spaceId, msg.shareId)
    if (!ownedMount) throw new AppError(ErrorCodes.NOT_FOUND, 'Folder is not mounted on this device')
    target = pathFromMount(ownedMount.mountPath, msg.relPath)
  } else {
    const foreignMount = await getForeignMount(msg.spaceId, msg.shareId)
    if (foreignMount && foreignMount.enabled) {
      target = pathFromMount(foreignMount.mountPath, msg.relPath)
    } else {
      const drivePath = '/' + share.name + '/' + msg.relPath
      target = (await getDownloadedPath(msg.spaceId, drivePath)) || claimedPathFor(drivePath, null)
    }
  }
  return revealLocalPath(target)
})

ipc.handle('share:folder-info', async (msg) => {
  const share = await loadShareDescriptor(msg.spaceId, msg.ownerKey, msg.shareId)
  const backend = getContentBackend(share)
  if (backend === UNSUPPORTED) return { fileCount: 0, totalBytes: 0, blobsLength: null }
  // overlay: counts come from the catalog (no drive blobs)
  const isOwn = share.owner === getLocalPublicKeyHex()
  // limit=0 → count + sum the catalog in one pass WITHOUT retaining any rows, so a 150k-file
  // folder (e.g. opened in MirrorFolderModal) can't rebuild the full array here and OOM.
  const { total, totalBytes } = isOwn
    ? await backend.listOwn(msg.spaceId, share.id, 0)
    : await backend.listPeerWithMeta(msg.spaceId, share, 0)
  return { fileCount: total, totalBytes, blobsLength: null }
})

// Space-wide storage for the space view's storage widget: one aggregate across
// every folder share plus the loose files (src/shared/storage/space-storage.js).
ipc.handle('space:storage-summary', async (msg) => {
  if (isSpaceLeaving(msg.spaceId)) return { totalBytes: 0, onDeviceBytes: 0 } // teardown is closing cores — don't race it
  return await spaceStorageSummary(msg.spaceId)
})

ipc.handle('share:read-file', async (msg) => {
  const share = await loadShareDescriptor(msg.spaceId, msg.ownerKey, msg.shareId)
  const isOwn = share.owner === getLocalPublicKeyHex()
  const backend = getContentBackend(share)
  if (backend === UNSUPPORTED) throw new AppError(ErrorCodes.NOT_FOUND, 'Share uses an unsupported content mode')
  // overlay: request the file via the backend (catalog/overlay), not a drive
  if (isOwn) return { ok: true, alreadyOwned: true }
  return await backend.requestDownload(msg.spaceId, share, msg.relPath)
})

ipc.handle('share:discard-partial', async (msg) => {
  const share = await loadShareDescriptor(msg.spaceId, msg.ownerKey, msg.shareId)
  const drivePath = '/' + share.name + '/' + msg.relPath
  // Overlay folder downloads run on the shared engine; it clears the partial +
  // pending row and emits the share refresh itself.
  await overlayCancelByKey(msg.spaceId, drivePath, transferIdFor(msg.spaceId, msg.shareId, msg.relPath))
  return { ok: true }
})

ipc.handle('event:owned-folder-fs-event', async (msg) => {
  try {
    await handleFsEventFromMain(msg)
  } catch (err) {
    log.warn('owned-folder fs event failed:', err.message)
  }
})

ipc.handle('event:loose-file-fs-event', async (msg) => {
  try {
    await handleLooseFsEvent(msg)
  } catch (err) {
    log.warn('loose-file fs event failed:', err.message)
  }
})

const previewAborts = new Map()

ipc.handle('owned-folder:preview', async (msg) => {
  const ignore = msg.ignore || DEFAULT_IGNORE
  const shareId = msg.shareId && msg.shareId !== 'preview' ? msg.shareId : null
  const previewId = msg.previewId || null
  const signal = previewId ? { aborted: false } : null
  if (previewId) previewAborts.set(previewId, signal)
  try {
    return await previewInitialPublishScan(msg.spaceId, shareId, msg.mountPath, ignore, {
      signal,
      onProgress: previewId
        ? (p) => ipc.emit('event:owned-folder-preview-progress', { previewId, ...p })
        : null,
    })
  } finally {
    if (previewId) previewAborts.delete(previewId)
  }
})

ipc.handle('owned-folder:cancel-preview', async (msg) => {
  const sig = previewAborts.get(msg.previewId)
  if (sig) sig.aborted = true
  return { ok: true }
})

ipc.handle('owned-folder:validate', async (msg) => {
  return await validateMountPath(msg.mountPath, 'owned-folder', { shareId: msg.shareId })
})

ipc.handle('owned-folder:mount', async (msg) => {
  const own = await readOwnShares(msg.spaceId)
  const share = own.find((s) => s.id === msg.shareId)
  if (!share) throw new AppError(ErrorCodes.NOT_FOUND, 'Share not found')

  const { mountPath, advisories } = await validateMountPath(msg.mountPath, 'owned-folder', { shareId: msg.shareId })
  const ignore = msg.ignore && msg.ignore.length > 0 ? msg.ignore : DEFAULT_IGNORE

  // The admission gate. This is the CREATE path (the renderer's add-folder wizard is its only
  // caller) — relocate, the periodic reconcile and the watcher's publishAdd are deliberately NOT
  // gated, so a share that grows past the limit keeps publishing instead of breaking on restart.
  // The modal blocks first; this is the authoritative check.
  const fileCount = await countFolderFiles(mountPath, ignore)
  if (exceedsShareFileLimit(fileCount)) {
    throw new AppError(ErrorCodes.SHARE_FILE_LIMIT, shareFileLimitMessage(fileCount))
  }

  const mount = {
    spaceId: msg.spaceId,
    shareId: msg.shareId,
    mountPath,
    ignore,
    createdAt: Date.now(),
  }
  await saveOwnedMount(mount)
  // Seed the probe baseline so the first mount-point tick doesn't read this brand-new mount as a
  // gone→present transition (which would otherwise run against an unseeded key).
  lastMountPointStatus.set('owned-folder:' + msg.shareId, mountRootAvailable(mountPath))
  await setOwnedStatus(msg.spaceId, msg.shareId, 'scanning')

  ipc.emit('main-request', {
    command: 'owned-folder:start-watcher',
    args: { shareId: msg.shareId, mountPath, ignore },
  })

  settleScanStatus(initialPublishScan(msg.spaceId, msg.shareId, mountPath, ignore), msg.spaceId, msg.shareId)
    .then(async (result) => {
      if (result && !result.skipped) ipc.emit('event:owned-folder-scan-completed', { spaceId: msg.spaceId, shareId: msg.shareId, ...result })
      // One row for the deliberate act, carrying the totals from the initial scan. The recurring
      // reconcile deliberately records nothing — it is machine churn, not a user action.
      record('share.mounted', {
        actor: selfActor(),
        space: spaceRef(await getSpace(msg.spaceId)),
        target: { kind: 'share', id: msg.shareId, name: share?.name ?? null },
        subject: { fileCount: result?.totalOnDisk ?? null, uploaded: result?.uploaded ?? null, mountPath },
      })
      schedulePeriodicReconcile(msg.spaceId, msg.shareId, mountPath, ignore)
    })

  return { mount, advisories }
})

ipc.handle('owned-folder:get', async (msg) => {
  return await getOwnedMount(msg.spaceId, msg.shareId)
})

// Re-point an owned folder at a new on-disk location after the original source
// was moved, renamed, or disconnected. The hash-based reconcile recognizes
// unchanged content at the new path and uploads nothing, so mirror peers see
// no churn — this is why relocate beats delete-and-re-add for recovery.
ipc.handle('owned-folder:relocate', async (msg) => {
  const mount = await getOwnedMount(msg.spaceId, msg.shareId)
  if (!mount) throw new AppError(ErrorCodes.NOT_FOUND, 'Mount not found')

  const { mountPath, advisories } = await validateMountPath(msg.mountPath, 'owned-folder', { shareId: msg.shareId })

  // Tear down anything still bound to the old (likely missing) path first.
  cancelPeriodicReconcile(msg.spaceId, msg.shareId)
  ipc.emit('main-request', { command: 'owned-folder:stop-watcher', args: { shareId: msg.shareId } })

  const previousMountPath = mount.mountPath
  mount.mountPath = mountPath
  await saveOwnedMount(mount)
  lastMountPointStatus.set('owned-folder:' + msg.shareId, true)

  await setOwnedStatus(msg.spaceId, msg.shareId, 'scanning')
  ipc.emit('main-request', {
    command: 'owned-folder:start-watcher',
    args: { shareId: msg.shareId, mountPath, ignore: mount.ignore },
  })

  // Relocate diffs by content hash (deep): the new path is typically a moved/copied
  // tree whose mtimes differ, but identical content must upload nothing so mirror
  // peers see no churn. The fast size+mtime diff would re-upload on the new mtimes.
  settleScanStatus(initialPublishScan(msg.spaceId, msg.shareId, mountPath, mount.ignore, { deep: true }), msg.spaceId, msg.shareId)
    .then((result) => {
      if (result && !result.skipped) ipc.emit('event:owned-folder-scan-completed', { spaceId: msg.spaceId, shareId: msg.shareId, ...result })
      schedulePeriodicReconcile(msg.spaceId, msg.shareId, mountPath, mount.ignore)
    })

  record('share.relocated', {
    actor: selfActor(),
    space: spaceRef(await getSpace(msg.spaceId)),
    target: { kind: 'share', id: msg.shareId, name: null },
    subject: { from: previousMountPath, to: mountPath },
  })
  return { mount, advisories }
})

ipc.handle('owned-folder:delete', async (msg) => {
  const own = await readOwnShares(msg.spaceId)
  const share = own.find((s) => s.id === msg.shareId)
  if (!share) {
    log.warn('delete requested for unknown share:', msg.shareId)
  }

  cancelPeriodicReconcile(msg.spaceId, msg.shareId)
  stopOwnedFolder(msg.spaceId, msg.shareId)
  ipc.emit('main-request', { command: 'owned-folder:stop-watcher', args: { shareId: msg.shareId } })

  // Overlay keeps no per-share drive blobs to tombstone — the share record
  // tombstone below retires the catalog from every consumer's view.
  await deleteOwnedMount(msg.spaceId, msg.shareId)
  await tombstoneShare(msg.spaceId, msg.shareId)
  record('share.deleted', {
    actor: selfActor(),
    space: spaceRef(await getSpace(msg.spaceId)),
    target: { kind: 'share', id: msg.shareId, name: share?.name ?? null },
  })
  ipc.emit('event:shares-updated', { spaceId: msg.spaceId })
  ipc.emit('event:share-files-updated', { spaceId: msg.spaceId, shareId: msg.shareId })
  return { ok: true }
})

ipc.handle('owned-folder:list-all', async () => {
  const mounts = await listOwnedMounts()
  return mounts.map((m) => ({ ...m, mountPointMissing: !mountRootAvailable(m.mountPath) }))
})

ipc.handle('mounts:list-all', async () => {
  return await listAllMounts()
})

ipc.handle('foreign-folder:validate', async (msg) => {
  return await validateMountPath(msg.mountPath, 'foreign-folder', { shareId: msg.shareId })
})

ipc.handle('foreign-folder:preview', async (msg) => {
  const previewId = msg.previewId || null
  const signal = previewId ? { aborted: false } : null
  if (previewId) previewAborts.set(previewId, signal)
  try {
    return await previewMaterializeScan(msg.spaceId, msg.ownerKey, msg.shareId, msg.mountPath, {
      signal,
      onProgress: previewId
        ? (p) => ipc.emit('event:foreign-folder-preview-progress', { previewId, ...p })
        : null,
    })
  } finally {
    if (previewId) previewAborts.delete(previewId)
  }
})

ipc.handle('foreign-folder:cancel-preview', async (msg) => {
  const sig = previewAborts.get(msg.previewId)
  if (sig) sig.aborted = true
  return { ok: true }
})

ipc.handle('foreign-folder:mount', async (msg) => {
  const { mountPath, advisories } = await validateMountPath(msg.mountPath, 'foreign-folder', { shareId: msg.shareId })
  const mount = {
    spaceId: msg.spaceId,
    shareId: msg.shareId,
    ownerKey: msg.ownerKey,
    mountPath,
    enabled: true,
    attachedAt: Date.now(),
    status: 'scanning',
  }
  await persistForeignMount(mount)
  ipc.emit('event:foreign-folder-mount-status', { spaceId: msg.spaceId, shareId: msg.shareId, status: 'scanning' })
  try { await publishMirror(msg.spaceId, msg.shareId, { state: 'syncing' }) }
  catch (err) { log.warn('mirror record publish failed:', msg.shareId, '-', err.message) }
  ipc.emit('event:mirrors-updated', { spaceId: msg.spaceId, shareId: msg.shareId })

  // Start the poll loop regardless of the initial scan's outcome: a scan that rejects must still
  // leave a running loop so the record re-derives from 'syncing' instead of stranding there.
  initialMaterializeScan(mount)
    .catch((err) => {
      log.warn('mirror initial scan failed:', err.message)
      ipc.emit('event:foreign-folder-mount-status', { spaceId: msg.spaceId, shareId: msg.shareId, status: 'paused-error', error: err.message })
    })
    .finally(() => { startForeignLoop(mount) })

  record('mirror.created', {
    actor: selfActor(),
    space: spaceRef(await getSpace(msg.spaceId)),
    target: { kind: 'share', id: msg.shareId, name: await shareNameOrNull(msg.spaceId, msg.ownerKey, msg.shareId) },
    subject: { mountPath: mount.mountPath, ownerKey: msg.ownerKey },
  })
  return { mount, advisories }
})

ipc.handle('foreign-folder:get', async (msg) => {
  return await getForeignMount(msg.spaceId, msg.shareId)
})

ipc.handle('foreign-folder:set-enabled', async (msg) => {
  return await setForeignEnabled(msg.spaceId, msg.shareId, !!msg.enabled)
})

ipc.handle('foreign-folder:unmount', async (msg) => {
  const mount = await getForeignMount(msg.spaceId, msg.shareId)
  await unmountForeignFolder(msg.spaceId, msg.shareId)
  record('mirror.removed', {
    actor: selfActor(),
    space: spaceRef(await getSpace(msg.spaceId)),
    target: { kind: 'share', id: msg.shareId, name: await shareNameOrNull(msg.spaceId, mount?.ownerKey, msg.shareId) },
    subject: { mountPath: mount?.mountPath ?? null },
  })
  return { ok: true }
})

ipc.handle('foreign-folder:list-all', async () => {
  return await listForeignMounts()
})

// === IPC: profile & space handlers ===

ipc.handle('profile:get', async () => await getProfile())
ipc.handle('profile:set', async (msg) => {
  await setProfile({ displayName: msg.displayName, avatar: msg.avatar })
  refreshAuditSelfName(msg.displayName)
  broadcastProfileUpdate().catch(err => log.warn('profile broadcast failed:', err.message))
  return await getProfile()
})

// The self-first roster (avatars included) for ONE space. Rosters ship slim in spaces:list —
// avatars are base64 data-URLs up to the sanitizeAvatar cap, far too heavy for an
// every-refetch payload — so per-space consumers read this on demand.
function fullRoster(space, profile) {
  const others = (space.members || []).filter((m) => !profile || m.publicKey !== profile.publicKey)
  if (!profile) return others
  const self = {
    publicKey: profile.publicKey,
    driveKey: null,
    displayName: profile.displayName,
    avatar: profile.avatar,
  }
  return [self, ...others]
}

// The catalog-key fields are worker-internal (handshake fallbacks) — no roster payload
// ships them to the renderer.
function stripCatalogKeys({ looseCatalogKey, looseCatalogKeyEnc, ...m }) {
  return m
}

function slimMember(m) {
  const { avatar, ...slim } = stripCatalogKeys(m)
  return slim
}

// The one projection for every Space[] the worker ships (spaces:list AND the boot
// event:state) — slim self-first rosters plus memberCount/pendingCount. A second
// unprojected emit path would leak raw rosters and desync the renderer's Space type.
async function slimSpaces(profile) {
  // A space mid-leave (or one whose interrupted-leave completion failed at boot) must not
  // surface as a normal space: it has no drive, no swarm, and is about to be forgotten.
  const allSpaces = (await listSpaces()).filter((s) => !s.leaving)
  return allSpaces.map(s => {
    const memberKeys = new Set((s.members || []).map(m => m.publicKey))
    if (profile) memberKeys.add(profile.publicKey)
    const members = fullRoster(s, profile).map(slimMember)
    return {
      ...s,
      members,
      memberCount: members.length,
      pendingCount: listPendingRequests(s.spaceId, memberKeys).length,
    }
  })
}

ipc.handle('spaces:list', async () => slimSpaces(await getProfile()))

ipc.handle('space:members', async (msg) => {
  const space = await getSpace(msg.spaceId)
  if (!space || space.leaving) return []
  return fullRoster(space, await getProfile()).map(stripCatalogKeys)
})
ipc.handle('space:mirrors', async (msg) => {
  const mirrors = msg.shareId
    ? await listMirrorsForShare(msg.spaceId, msg.shareId)
    : await listMirrorsForSpace(msg.spaceId)
  return mirrors.map((m) => ({ mirrorer: m.mirrorer, shareId: m.shareId, state: m.state, mountedAt: m.mountedAt }))
})
ipc.handle('space:create', async (msg) => {
  log.info('creating space:', msg.name)
  const space = await createSpace(msg.name, msg.icon)
  await markOwnMembership(space.spaceId, { refresh: true })
  await joinSpaceTopic(space.spaceId)
  await openMemberView(space.spaceId)   // the creator's own space derives its membership too
  log.info('space created:', space.spaceId)
  record('space.created', { actor: selfActor(), space: spaceRef(space), target: { kind: 'space', id: space.spaceId, name: space.name } })
  return space
})
// Block a rejoin until a concurrent leave of the same space has fully torn down (the leaving flag
// clears only after the catalog record + drive are purged), so the rejoin sees no stale record and
// mints a fresh driveSuffix instead of resurrecting the just-purged deterministic drive key.
async function awaitSpaceLeaveSettled(spaceId, capMs = 15000) {
  if (!isSpaceLeaving(spaceId)) return true
  log.info('join: waiting for in-progress leave to settle:', spaceId)
  const start = Date.now()
  while (isSpaceLeaving(spaceId) && Date.now() - start < capMs) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !isSpaceLeaving(spaceId)
}
ipc.handle('space:join', async (msg) => {
  const decoded = decodeInvite(msg.inviteCode)
  if (!decoded) {
    const err = new Error('Invalid invite code')
    err.code = 'INVITE_INVALID'
    throw err
  }
  // Soft pre-check for instant feedback. `x` is a strippable hint, so allow 60s for clock skew;
  // the minting member's record is the authority on the handshake.
  if (decoded.expiresAt && decoded.expiresAt + 60_000 < Date.now()) {
    const err = new Error('This invite link has expired')
    err.code = 'INVITE_EXPIRED'
    throw err
  }
  const name = (typeof msg.name === 'string' && msg.name.trim()) || decoded.name || 'Shared Space'
  // Rejoining a space we just left: wait for the leave teardown to settle. While it runs the
  // catalog record still holds the old driveSuffix, and joinSpace would reuse it — resurrecting
  // the deterministic drive key and forking replication against the blocks co-members still hold
  // (the INVALID_OPERATION "Nodes is out of bounds" reconnect loop). Once leaving clears, the
  // record is gone, so the rejoin mints a fresh suffix → a genuinely new, fork-free drive. If the
  // teardown is still running past the cap, refuse the join rather than fork — the user retries.
  if (!(await awaitSpaceLeaveSettled(decoded.topic.slice(0, 16)))) {
    const err = new Error('A leave of this space is still finishing — try joining again in a moment')
    err.code = 'LEAVE_IN_PROGRESS'
    throw err
  }
  const rejoinSpaceId = decoded.topic.slice(0, 16)
  log.info('joining space', decoded.v === 1 ? '(envelope)' : '(legacy)')
  const space = await joinSpace(decoded.topic, name, msg.icon, { schemaVersion: decoded.schemaVersion, inviteId: decoded.inviteId, creator: decoded.creator })
  await markOwnMembership(space.spaceId, { refresh: true })
  // A genuine rejoin supersedes any pending outbound leave: the fresh member/<S> record (strictly
  // newer ts) outranks the old tombstone on co-members, so retire the marker + its replay topic.
  // Guard on an ACTIVE marker (never touch the shared topic maps otherwise — re-pasting an invite
  // for a space we already belong to reaches here with no marker, and an unguarded
  // leavePendingLeaveTopic would tear down that LIVE space's topic), and only after the rejoin is
  // durable so a joinSpace failure can't drop a still-needed replay. joinSpaceTopic below re-joins.
  if (hasPendingLeave(rejoinSpaceId)) {
    unregisterPendingLeave(rejoinSpaceId)
    await clearPendingLeave(rejoinSpaceId)
    await leavePendingLeaveTopic(rejoinSpaceId)
  }
  // Pre-seed the inviter as an offline shell member (when the envelope carries
  // their identity) so the space isn't empty until their handshake lands. Keyed
  // by their real public key, so the handshake's upsertMember merges into this
  // entry — filling driveKey/avatar and flipping them online — rather than adding
  // a duplicate. Skipped if the invite predates this field or names ourselves.
  if (decoded.owner && decoded.owner !== getLocalPublicKeyHex()) {
    await upsertMember(space.spaceId, {
      publicKey: decoded.owner,
      displayName: decoded.ownerName || 'Unknown',
    })
  }
  await joinSpaceTopic(space.spaceId)
  await openMemberView(space.spaceId)   // no-op while pending; opens on re-join of an approved space
  log.info('space joined:', space.spaceId)
  record('space.joined', {
    actor: selfActor(),
    space: spaceRef(space),
    target: { kind: 'space', id: space.spaceId, name: space.name },
    subject: { inviteId: decoded.inviteId || null, autoAdmit: !!decoded.autoAdmit },
  })
  return space
})
ipc.handle('space:invite', async (msg) => {
  const space = await getSpace(msg.spaceId)
  if (!space?.topic) return null
  // Hard block: a member-only capability. While pending we hold no content key, so
  // any invite we minted could never confer read access (the redeemer would stall
  // pending exactly as we do) — but it WOULD leak the space topic to outsiders. Refuse
  // at the data layer, not just in the UI, so membership is enforced where it's authored.
  if (space.status === 'pending') {
    const err = new Error('Cannot invite to a space you have not joined')
    err.code = 'NOT_A_MEMBER'
    throw err
  }
  // Embed our identity so the joiner can show us as an offline member before we
  // first connect. Display name is a snapshot at invite time; the handshake later
  // corrects it if we've since renamed.
  const profile = await getProfile()
  // Mint a replicated per-link record (v2 only) when the caller asks for auto-approve OR an expiry —
  // the new UI always sends an expiry. A bare programmatic call (no opts) stays record-less = a
  // plain manual, never-expiring invite.
  let inviteId, expiresAt
  if (space.schemaVersion === 2 && (msg.autoAdmit || Number.isInteger(msg.expiresInMs))) {
    inviteId = b4a.toString(crypto.randomBytes(16), 'hex')
    expiresAt = Number.isInteger(msg.expiresInMs) ? Date.now() + msg.expiresInMs : null
    await markInvite(space.spaceId, inviteId, { autoApprove: !!msg.autoAdmit, expiresAt })
    record('invite.minted', {
      actor: selfActor(),
      space: spaceRef(space),
      target: { kind: 'invite', id: inviteId, name: null },
      subject: { autoAdmit: !!msg.autoAdmit, expiresAt },
    })
  }
  return encodeInvite({
    topic: space.topic,
    name: space.name,
    owner: profile?.publicKey,
    ownerName: profile?.displayName,
    // The OR-Set root (whoever created the space), so every joiner — and every member
    // who re-shares this invite — seeds its membership fold from the same peer. Distinct
    // from `owner` above, which is us (the inviter). Absent on pre-creatorKey joined
    // spaces; the fold's transition fallback covers those.
    creator: space.creatorKey,
    schemaVersion: space.schemaVersion,
    autoAdmit: !!(inviteId && msg.autoAdmit),
    inviteId,
    expiresAt,
  })
})
ipc.handle('space:approve-member', async (msg) => {
  const space = await getSpace(msg.spaceId)
  // The real gate: approval IS handing out the content key, so a peer who holds no key
  // (pending, or otherwise unauthorized) physically cannot approve anyone — enforced by
  // the sck check inside resolveJoinRequest.
  if (!space || space.schemaVersion !== 2 || space.status === 'pending') return false
  const approved = await resolveJoinRequest(space, msg.publicKey, 'approve')
  if (approved) {
    record('membership.approved', {
      actor: selfActor(),
      space: spaceRef(space),
      target: { kind: 'member', id: msg.publicKey, name: peerActor(space, msg.publicKey).name },
    })
  }
  return approved
})
ipc.handle('space:deny-member', async (msg) => {
  const space = await getSpace(msg.spaceId)
  if (!space || space.status === 'pending') return false
  // Approval is monotonic: if another member already let them in (they hold the SCK),
  // a deny can't revoke without key rotation — clear our stale banner and no-op.
  if (await isApprovedMember(msg.spaceId, msg.publicKey)) {
    if (clearJoinRequest(msg.spaceId, msg.publicKey)) ipc.emit('event:join-requests-updated', { spaceId: msg.spaceId })
    return false
  }
  const denied = await resolveJoinRequest(space, msg.publicKey, 'deny')
  if (denied) {
    record('membership.denied', {
      actor: selfActor(),
      space: spaceRef(space),
      target: { kind: 'member', id: msg.publicKey, name: peerActor(space, msg.publicKey).name },
      outcome: 'denied',
    })
  }
  return denied
})
ipc.handle('space:pending-requests', async (msg) => {
  const space = await getSpace(msg.spaceId)
  const memberKeys = new Set((space?.members || []).map(m => m.publicKey))
  return listPendingRequests(msg.spaceId, memberKeys)
})
ipc.handle('space:update', async (msg) => {
  const space = await getSpace(msg.spaceId)
  if (space?.status === 'pending') return null
  log.info('updating space:', msg.spaceId)
  // Tri-state: absent leaves the override alone, null clears it, a string is validated.
  let downloadFolder
  if (msg.downloadFolder !== undefined) {
    downloadFolder = msg.downloadFolder === null
      ? null
      : await validateDownloadFolderAgainstMounts(msg.downloadFolder)
  }
  const updated = await updateSpace(msg.spaceId, msg.name, msg.icon, { downloadFolder })
  if (updated) {
    if (downloadFolder !== undefined) {
      setSpaceDownloadRoot(msg.spaceId, downloadFolder)
      publishDownloadRoots()
      // Every row's downloaded status derives from the root, so re-derive the file views.
      ipc.emit('event:files-updated', { spaceId: msg.spaceId })
    }
    record('space.updated', {
      actor: selfActor(),
      space: spaceRef(updated),
      target: { kind: 'space', id: msg.spaceId, name: updated.name },
      subject: { previousName: space?.name ?? null },
    })
  }
  return updated
})
ipc.handle('space:toggle-favorite', async (msg) => {
  return await toggleFavorite(msg.spaceId)
})
// Persist a pending-leave marker BEFORE the record purge erases the topic, so the swarm can
// re-announce the leave to members who were offline at leave time (and boot re-joins the topic)
// until they provably apply it — without this they keep us as a ghost member forever. Arm iff
// some OTHER member did NOT ack: this excludes a solo space (no members → nobody to tell → no
// immortal marker) and covers a member that dropped mid-leave (never acked → still owed the
// replay), which the raw awaitLeaveAcks boolean conflated with "nobody was connected". ts is the
// leave stamp: a genuine later rejoin writes a strictly newer member/<S> ts and outranks the replay.
async function armPendingLeaveIfUnwitnessed(spaceId, space) {
  if (!space?.topic) return false
  const others = (space.members || []).map((m) => m.publicKey)
  if (others.length === 0) return false
  const acked = takeLeaveAckedKeys(spaceId)
  if (others.every((k) => acked.has(k))) return false
  try {
    const leaveTs = Date.now()
    await persistPendingLeave(spaceId, space.topic, leaveTs)
    registerPendingLeave(spaceId, space.topic, leaveTs)
    log.info('leave unwitnessed — pending-leave marker armed:', spaceId)
    return true
  } catch (err) {
    log.warn('pending-leave persist failed:', err.message)
    return false
  }
}

// The teardown's leaveSpaceTopic dropped the topic — re-join it for the replay so a co-member
// returning THIS session still receives the leave (boot covers restarts). Re-check the live
// marker rather than a stale armed-flag: an ack that landed mid-teardown already cleared the
// marker and left the topic, and re-joining here would strand a zombie topic nothing can leave.
function rejoinPendingLeaveTopicAfterTeardown(spaceId, space) {
  if (!hasPendingLeave(spaceId) || !space?.topic) return
  try { joinPendingLeaveTopic(spaceId, space.topic) } catch (err) {
    log.warn('pending-leave topic rejoin failed:', err.message)
  }
}

ipc.handle('space:leave', async (msg) => {
  // A teardown is already in flight (it can outlive the IPC response) — a re-click must be a no-op,
  // not a second run that clobbers the in-flight leave-ack tracking and re-purges half-torn state.
  // Claim the flag SYNCHRONOUSLY before any await, so two near-simultaneous leaves can't both pass
  // the guard during the getSpace round-trip below.
  if (isSpaceLeaving(msg.spaceId)) return { ok: true }
  markSpaceLeaving(msg.spaceId)
  // A pending space was never joined — take the lightweight cancel path instead of
  // the drive-purge teardown, which assumes a materialized drive and crashes without one.
  const pending = await getSpace(msg.spaceId)
  // Recorded up front, while the space record still exists: the teardown deletes it, and the row
  // must carry the name snapshot or it renders as raw hex forever afterwards.
  if (pending) {
    record('space.left', {
      actor: selfActor(),
      space: spaceRef(pending),
      target: { kind: 'space', id: pending.spaceId, name: pending.name },
      subject: { wasPending: pending.status === 'pending' },
    })
  }
  if (pending?.status === 'pending') {
    unmarkSpaceLeaving(msg.spaceId)   // a pending cancel is not a drive teardown
    log.info('cancel pending join:', msg.spaceId)
    // Tell members who saw our request to drop it. A lost frame self-heals: register a pending
    // cancel replayed on every connection until a member acks it applied, and re-join the topic
    // (discard purges it) so a member offline now can still be reached. The initial send goes
    // through sendPendingCancelToConnected so the ack from a currently-connected member is honored.
    if (pending.topic) {
      registerPendingCancel(msg.spaceId, pending.topic, getLocalPublicKeyHex())
      sendPendingCancelToConnected()
    }
    await discardPendingSpace(msg.spaceId)
    // Re-join for replay ONLY if a member hasn't already acked during the teardown above (which
    // clears the pending cancel) — otherwise we'd re-join a purged topic nothing ever leaves.
    if (pending.topic && hasPendingCancel(msg.spaceId)) joinPendingCancelTopic(msg.spaceId, pending.topic)
    return { ok: true }
  }

  closeMemberView(msg.spaceId)
  log.info('leave starting:', msg.spaceId)
  // markSpaceLeaving already set above (before the getSpace await) so files:list reads short-circuit.

  // Run the full teardown as a background task tracking its current phase. The
  // load-bearing signals (leave frame, clearOwnMembership) and the durable catalog-record
  // delete all happen before the heavyweight, occasionally-slow steps (swarm leave, peer
  // core close/compaction, purge) — so if one of those stalls we can answer the renderer
  // and let the rest finish in the background, instead of hanging the UI for the full IPC
  // timeout. `phase` names where it is so a stall is diagnosable from the logs.
  const tracker = { phase: 'start' }
  let space = null
  const teardown = (async () => {
    try {
      // Durable leaving marker BEFORE the member del: a quit anywhere in this teardown is now
      // completed at the next boot (resumeInterruptedLeave) instead of being reverted by the
      // markOwnMembership backfill. Best-effort — without it a crash reverts as before.
      tracker.phase = 'mark-leaving'
      try { await markSpaceLeavingDurable(msg.spaceId) } catch (err) {
        log.warn('durable leaving mark failed:', err.message)
      }
      // Author the durable departure (member/<S> del) BEFORE broadcasting the frame, so it is
      // written + announced when co-members apply the leave — their member-view live-follow can then
      // re-host it and serve it to members who were offline at leave time.
      tracker.phase = 'clearOwnMembership'
      try { await clearOwnMembership(msg.spaceId) } catch (err) {
        log.warn('clearOwnMembership failed:', err.message)
      }
      tracker.phase = 'leave-frame'
      try { sendLeaveFrameToConnectedPeers(msg.spaceId) } catch (err) {
        log.warn('leave-frame broadcast failed:', err.message)
      }

      // Tear down this space's folder machinery BEFORE purging its drive: a still-live
      // chokidar watcher, foreign mirror loop, periodic reconcile, or cached share view
      // would otherwise keep writing to the closed-and-purged drive and recreate state
      // mid-purge (write-after-purge).
      tracker.phase = 'folder-teardown'
      try {
        for (const m of (await listOwnedMounts()).filter((x) => x.spaceId === msg.spaceId)) {
          cancelPeriodicReconcile(msg.spaceId, m.shareId)
          stopOwnedFolder(msg.spaceId, m.shareId)
          ipc.emit('main-request', { command: 'owned-folder:stop-watcher', args: { shareId: m.shareId } })
          await deleteOwnedMount(msg.spaceId, m.shareId)
        }
        // Retire our share advertisements (deletedAt), like the unshare path. Without this our
        // profile bee keeps advertising share/<S>/<id>, so on a rejoin a co-member reads it back
        // and a folder they mirrored re-surfaces before any re-approval. The per-space drive is
        // purged below, so only the profile-bee record needs tombstoning here.
        for (const s of await readOwnShares(msg.spaceId)) {
          await tombstoneShare(msg.spaceId, s.id)
        }
        for (const m of (await listForeignMounts()).filter((x) => x.spaceId === msg.spaceId)) {
          await unmountForeignFolder(msg.spaceId, m.shareId)
        }
      } catch (err) {
        log.warn('leave: folder teardown failed:', err.message)
      }
      log.info('leave: own state cleared, waiting flush...')

      // Wait (bounded) for connected members to confirm they applied our leave — an observed signal
      // that their durable revokeApproval ran — instead of a blind fixed sleep. Resolves early on
      // full ack coverage; falls back to the cap for pre-upgrade peers that never ack.
      tracker.phase = 'flush'
      await awaitLeaveAcks(msg.spaceId, { capMs: 2000, floorMs: 500 })
      log.info('leave: flush done, gathering members...')

      space = await getSpace(msg.spaceId)
      const members = space?.members || []
      const peerDrivenMembers = members.filter(m => !!m.driveKey)
      const peerDriveCount = peerDrivenMembers.length

      await armPendingLeaveIfUnwitnessed(msg.spaceId, space)

      // Drop the catalog record up front so the leave is durable: if any purge step
      // below fails (or the worker dies mid-teardown), the space is already gone from
      // the list and won't reappear — leftover cores are reclaimable, a stuck space is
      // not. The drive stays in the in-memory map for purgeSpaceDrive.
      tracker.phase = 'forgetSpaceRecord'
      try { await forgetSpaceRecord(msg.spaceId) } catch (err) {
        log.warn('leave: catalog record delete failed:', err.message)
      }
      dropSpaceDownloadRoot(msg.spaceId)

      // Cache-size precompute is best-effort; cap at 2s so a stuck drive read
      // can't block the rest of the leave teardown.
      tracker.phase = 'cache-bytes'
      let totalBytes = 0
      try {
        totalBytes = await Promise.race([
          getSpaceCacheBytes(msg.spaceId),
          new Promise((resolve) => setTimeout(() => resolve(0), 2000)),
        ])
      } catch (err) {
        log.warn('cannot precompute space cache size:', err.message)
      }
      log.info('leave: cache bytes computed:', totalBytes)

      // Must match the number of progress calls below: 1 disconnecting + N
      // cleaningPeer + (N>0 ? compactingPeerCache : 0) + 4 local phases.
      const totalSteps = 5 + peerDriveCount + (peerDriveCount > 0 ? 1 : 0)
      let step = 0

      const progress = (phase, data) => {
        step++
        const payload = { spaceId: msg.spaceId, step, totalSteps, phase }
        if (data) payload.data = data
        if (step === 1) payload.totalBytes = totalBytes
        ipc.emit('event:leave-progress', payload)
      }

      // Cancel + discard any in-flight downloads for this space before the purges, so the
      // overlay/loose engine stops fetching (no orphaned partial) and can't re-write the
      // download-history rows cleanupDownloadHistory/clearPendingForSpace purge below.
      await overlayCancelSpace(msg.spaceId)
      await looseCancelSpace(msg.spaceId)
      // ...and stop SERVING this space to everyone else. The cancels above only walk OUR OWN
      // fetch slots — as the owner we have none, so without this a leave stops nothing on the
      // serving side and the content plane keeps streaming the space's bytes. Runs BEFORE the
      // purges: it needs serveIndex to still resolve hash → space.
      revokeServesForSpace(msg.spaceId)
      bumpServeEpoch()

      tracker.phase = 'leaveSpaceTopic'
      progress('disconnecting')
      await leaveSpaceTopic(msg.spaceId)
      log.info('leave: topic left, cleaning peer drives...')
      // Defer the disk-reclaim compaction (compact: false): purging tombstones the cores (the
      // leave is effective immediately), but a forced full-range compaction scans the WHOLE store
      // and is expensive on a large one — one pass per drive (peer caches here, local cache below)
      // would serially block the leave for tens of seconds. Run a SINGLE coalesced pass in the
      // background after the purges instead.
      tracker.phase = 'cleanupSpaceDrives'
      await cleanupSpaceDrives(msg.spaceId, peerDrivenMembers, (phase, data) => {
        progress(phase, data)
      }, { compact: false })
      log.info('leave: peer drives cleaned, purging local...')

      tracker.phase = 'purge-local'
      await cleanupDownloadHistory(msg.spaceId)
      await clearPendingForSpace(msg.spaceId)
      await purgeSpaceDrive(msg.spaceId, (phase) => {
        progress(phase)
      }, { compact: false })
      try { await purgeOwnCatalog(msg.spaceId, space) } catch (err) {
        log.warn('leave: own catalog purge failed:', err.message)
      }
      await purgeSpace(msg.spaceId)
      tracker.phase = 'forgetUnreferencedPeerCores'
      try { await forgetUnreferencedPeerCores(members) } catch (err) {
        log.warn('leave: peer-core gc failed:', err.message)
      }
      // One background compaction pass for everything purged above — never awaited, so the
      // leave completes as soon as the cores are tombstoned; the bytes come back shortly after.
      compactStore()
        .catch((err) => log.warn('leave: background reclaim compaction failed:', err.message))
      tracker.phase = 'complete'
      log.info('leave: complete (reclaim compaction running in background):', msg.spaceId)
    } finally {
      unmarkSpaceLeaving(msg.spaceId)
      rejoinPendingLeaveTopicAfterTeardown(msg.spaceId, space)
    }
  })()

  // Never hold the renderer past this deadline: the leave is already durable (catalog record
  // dropped) and propagated (leave frame sent) well before the slow steps, so answer now and let
  // any straggling teardown finish in the background. The warn names the stalled phase so a real
  // hang is pinpointable from the console instead of surfacing only as a 30s IPC timeout.
  const LEAVE_RESPOND_DEADLINE_MS = 12000
  const stalled = await Promise.race([
    teardown.then(() => false, () => false),
    new Promise((resolve) => setTimeout(() => resolve(true), LEAVE_RESPOND_DEADLINE_MS)),
  ])
  if (stalled) {
    log.warn('leave: teardown exceeded', LEAVE_RESPOND_DEADLINE_MS, 'ms — stalled at phase:', tracker.phase, '— space', msg.spaceId, '— finishing in background')
    teardown.catch((err) => log.warn('leave: background teardown failed:', err.message))
  }
  return { ok: true }
})

// === IPC: presence, file & transfer handlers ===

ipc.handle('members:online', async (msg) => {
  // Include self: the local peer never leases itself in presence, and every consumer
  // wants "who is reachable INCLUDING me".
  return [getLocalPublicKeyHex(), ...getConnectedPeers(msg.spaceId)]
})

// Sender-side download indicator: open/close a per-file detail subscription so the
// worker only streams per-peer progress for a file whose row is expanded. Subscribe
// returns the current snapshot so the dropdown renders immediately; the ledger sweep
// pushes the authoritative snapshot while subscribed (no renderer poll).
ipc.handle('serving:summary-list', async (msg) => listServeSummaries(msg.spaceId))
ipc.handle('serving:detail-subscribe', async (msg) => subscribeServeDetail(msg.spaceId, msg.path))
ipc.handle('serving:detail-unsubscribe', async (msg) => unsubscribeServeDetail(msg.spaceId, msg.path))

ipc.handle('files:list', async (msg) => {
  if (isSpaceLeaving(msg.spaceId)) return [] // teardown is closing the drive — don't race it
  const space = await getSpace(msg.spaceId)
  return await listFiles(msg.spaceId, space?.members || [])
})
ipc.handle('files:remove', async (msg) => {
  await removeFile(msg.spaceId, msg.path)
  record('file.unshared', {
    actor: selfActor(),
    space: spaceRef(await getSpace(msg.spaceId)),
    target: { kind: 'file', id: msg.path, name: fileNameOf(msg.path) },
  })
  ipc.emit('event:files-updated', { spaceId: msg.spaceId })
  return { ok: true }
})
ipc.handle('files:discard-partial', async (msg) => {
  // Loose downloads run on the overlay engine; it clears the partial + pending row
  // and emits files-updated + the decoration done frame itself.
  await looseCancel(msg.spaceId, msg.path)
  return { ok: true }
})
ipc.handle('files:reveal', async (msg) => {
  await revealFile(msg.spaceId, msg.path)
  return { ok: true }
})
ipc.handle('files:add', async (msg) => {
  log.info('adding file:', msg.fileName, 'from', msg.filePath)
  await addFile(msg.spaceId, msg.filePath, msg.fileName)
  record('file.shared', {
    actor: selfActor(),
    space: spaceRef(await getSpace(msg.spaceId)),
    target: { kind: 'file', id: msg.fileName, name: msg.fileName },
    subject: { size: msg.fileSize ?? null },
  })
  ipc.emit('event:files-updated', { spaceId: msg.spaceId })
  return { ok: true }
})
ipc.handle('files:download', async (msg) => {
  const space = await getSpace(msg.spaceId)
  const member = (space?.members || []).find((m) => m.publicKey === msg.ownerKey)
  const res = await looseDownload(msg.spaceId, member, msg.path)
  // Couldn't start: the owner may simply be unreachable on the bulk plane. Don't make the user
  // wait for the next tick to find that out — the rescue throttles itself, so clicks stay cheap.
  if (res?.queued) rescueStalledTransfers().catch((err) => log.debug('stalled-transfer rescue failed:', err.message))
  return res
})
ipc.handle('files:cancel-download', async (msg) => {
  const id = msg.transferId
  // Route on the id's shape, not on a live transfer — the same defect the pause handler below was
  // fixed for. A dropped connection settles the fetch a beat before the click lands, and gating on
  // has() routed a settled row to NEITHER engine: the partial and the pending row survived a
  // discard that reported ok, and the row auto-resumed on the next reconnect.
  if (isLooseTransferId(id)) await looseCancelTransfer(id)
  else await overlayCancel(id)
  return { ok: true }
})
ipc.handle('files:pause-download', async (msg) => {
  const id = msg.transferId
  // Route on the id's shape, not on a live transfer: a dropped connection can settle the fetch a
  // moment before the click lands, and gating on has() would silently pause nothing — leaving the
  // row to auto-resume on the next reconnect against the user's intent.
  if (isLooseTransferId(id)) loosePause(id)
  else overlayPause(id)
  return { ok: true }
})
ipc.handle('files:cancel-publish', async (msg) => {
  await looseCancelPublish(msg.spaceId, msg.path)
  return { ok: true }
})

// === IPC: feedback, storage & settings handlers ===

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatTimestamp (d) {
  const pad = (n) => String(n).padStart(2, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const absMin = Math.abs(offsetMin)
  const offH = Math.floor(absMin / 60)
  const offM = absMin % 60
  const offset = offM === 0 ? `UTC${sign}${offH}` : `UTC${sign}${offH}:${pad(offM)}`
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} at ${pad(d.getHours())}:${pad(d.getMinutes())} (${offset})`
}

ipc.handle('feedback:send', async (msg) => {
  const profile = await getProfile()
  const displayName = profile?.displayName || 'Unknown User'
  const email = typeof msg.email === 'string' && msg.email.trim() ? msg.email.trim() : null
  const timestamp = formatTimestamp(new Date())
  const cfg = getRuntimeConfig()
  const appVersion = cfg.appVersion || (cfg.dev ? 'dev' : 'unknown')
  const comment = msg.comment || '(no comment)'

  const headerLines = [`Feedback from ${displayName}`]
  if (email) headerLines.push(email)
  headerLines.push(`v${appVersion} · ${os.platform()} ${os.release()} (${os.arch()})`)
  headerLines.push(timestamp)
  const header = headerLines.join('\n') + '\n\n'

  const captionLimit = msg.screenshot ? 1024 : 4096
  const room = captionLimit - header.length
  const finalComment = comment.length > room ? comment.slice(0, room - 3) + '...' : comment
  const caption = header + finalComment

  const screenshotBuffer = msg.screenshot
    ? Buffer.from(msg.screenshot, 'base64')
    : null

  await sendFeedback(caption, screenshotBuffer)
  return { ok: true }
})

ipc.handle('storage:info', async () => await getStorageInfo())
ipc.handle('storage:cleanup', async () => await cleanupOrphanedData())

ipc.handle('storage:leftover-scan', async () => await classifyLeftovers())

ipc.handle('storage:free-space', async () => {
  const res = await freeSpace()
  // Reclaim spans every space; emit per-space so each open file view re-derives (a spaceId-less
  // poke matches no scoped consumer under the reconcile model).
  for (const s of await listSpaces()) ipc.emit('event:files-updated', { spaceId: s.spaceId })
  return res
})

ipc.handle('settings:set-download-folder', async (msg) => {
  // Same mount-overlap rejection as a per-space folder: the global root is the effective root
  // of every space that never overrode it, so pointing it into a folder the user shares or
  // mirrors publishes their downloads to peers just as surely.
  const folder = await validateDownloadFolderAgainstMounts(msg?.folder)
  setDownloadFolder(folder)
  publishDownloadRoots()
  return { ok: true }
})

// The limiters read their rate per call, so this reaches in-flight transfers with no
// further plumbing.
ipc.handle('settings:set-bandwidth', async (msg) => {
  setBandwidthLimits({ downloadKBps: msg?.downloadKBps, uploadKBps: msg?.uploadKBps })
  return { ok: true }
})


ipc.handle('network:status:get', async () => getSwarmStatus())
ipc.handle('network:reconnect', async () => await reconnectAll())

ipc.handle('network:set-relays', async (msg) => {
  if (!isRelayEnabled()) return { ok: false, reason: 'disabled' }
  setRelayConfig(msg?.relayMode, msg?.relays)
  return { ok: true, ...applyRelayConfig() }
})

ipc.handle('network:test-relay', async (msg) => await testRelayReachable(msg?.publicKey))

ipc.handle('features:get', async () => ({ overlay: isOverlayEnabled(), inPlaceFiles: isInPlaceFilesEnabled() }))

// Live verbose-logging toggle, driven from the renderer dev console
// (window.mirall.verbose). The logger reads getRuntimeConfig().verbose on every
// call, so flipping it here takes effect immediately with no relaunch. The
// spread preserves every other runtime-config field (buildConfig round-trips
// them losslessly).
ipc.handle('setVerbose', async (msg) => {
  setRuntimeConfig({ ...getRuntimeConfig(), verbose: !!msg.verbose })
  return { verbose: !!msg.verbose }
})

ipc.handle('ping', async () => ({ pong: true, timestamp: Date.now() }))

// === IPC: audit log ===

ipc.handle('audit:list', async (msg) => await queryAudit(msg))
ipc.handle('audit:spaces', async () => await auditSpaces())
ipc.handle('audit:actors', async () => await auditActors())
ipc.handle('audit:stats', async () => await auditStats())
ipc.handle('audit:get-config', async () => getAuditConfig())
ipc.handle('audit:configure', async (msg) => {
  const next = await setAuditConfig(msg)
  ipc.emit('event:audit-updated', {})
  return next
})
ipc.handle('audit:purge', async () => {
  const result = await purgeAudit()
  ipc.emit('event:audit-updated', {})
  return result
})
ipc.handle('audit:export', async (msg) => ({
  version: 1,
  exportedAt: Date.now(),
  entries: await exportAudit(msg || {}),
}))

const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000
pruneAudit().catch((err) => log.warn('audit prune failed:', err.message))
setInterval(() => { pruneAudit().catch((err) => log.debug('audit prune failed:', err.message)) }, AUDIT_PRUNE_INTERVAL_MS)

// === Go live: flush queued frames, announce ready ===

ipc.start()

ipc.emit('event:worker-ready')

log.info('ready')

const profile = await getProfile()
refreshAuditSelfName(profile?.displayName)
if (!profile) {
  ipc.emit('event:profile-needed')
} else {
  ipc.emit('event:state', { profile, spaces: await slimSpaces(profile) })
}
