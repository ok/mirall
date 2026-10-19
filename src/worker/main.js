// Bare worker ENTRY — Mirall's data-layer process (see .claude/solution-architecture.md for the
// process model and glossary). This file runs once, top to bottom, and owns what only an entry
// can: the crash backstop and the pipe-close shutdown hooks (both installed before the first
// await), the bootstrap frame, the membership-control block, every renderer-facing IPC command
// handler (named `domain:verb`, grouped by the `// === … ===` section markers below), the
// shutdown deadline and Bare.exit.
//
// The data layer itself — Corestore, bees, migrations, folder subsystems, both swarms, the
// resume passes and the periodic backstops — is constructed and started by the composition root
// in ./boot.js, whose returned `root.close()` is the whole stop sequence. ipc.start() runs after
// every handler is registered, so no frame is dispatched before its handler exists.

import path from 'bare-path'
import { createIPC } from '../shared/core/ipc.js'
import { createHealthMonitor } from '../shared/core/health.js'
import { registerSpaceLeave } from './ipc/space-leave.js'
import { registerWorkerProcess } from './ipc/worker-process.js'
import { registerAudit } from './ipc/audit.js'
import { registerNetwork } from './ipc/network.js'
import { registerSettings } from './ipc/settings.js'
import { registerStorage } from './ipc/storage.js'
import { registerProfile } from './ipc/profile.js'
import { registerIdentity } from './ipc/identity.js'
import { registerBackup } from './ipc/backup.js'
import { registerBackupRestore } from './ipc/backup-restore.js'
import { registerManaged } from './ipc/managed.js'
import { createPassphraseThrottle } from '../shared/core/identity-recovery.js'
import { applyPendingIdentityChange } from '../shared/core/identity-adopt.js'
import { registerFeedback } from './ipc/feedback.js'
import { registerDiagnostics } from './ipc/diagnostics.js'
import { registerFiles } from './ipc/files.js'
import { registerFolderPreview } from './ipc/folder-preview.js'
import { registerForeignFolders } from './ipc/foreign-folders.js'
import { registerOwnedFolders } from './ipc/owned-folders.js'
import { registerShares } from './ipc/shares.js'
import { registerSpaces } from './ipc/spaces.js'
import { createMembership } from './ipc/membership.js'
import { slimSpaces } from './space-projection.js'
import { createFolderChooser } from './download-folder-push.js'
import { createOwnedMounter } from './owned-mount.js'
import {
  setRuntimeConfig, getIpcKeepaliveMs, getIpcKeepaliveGraceMs,
} from '../shared/core/runtime-config.js'
import { forgetSpaceDownloadRoot, listDownloadRoots, setDownloadRootsListener } from '../shared/core/paths.js'
import { listRevealRoots } from '../shared/folders/reveal-roots.js'
import { setMountRootsListener } from '../shared/folders/mount-store.js'
import { loadSettings, getSettings } from '../shared/core/settings-store.js'
import { loadFeatureFlags } from '../shared/core/feature-flags.js'
import { assembleRuntimeConfig } from '../shared/core/runtime-config-sources.js'
import { daemonPaths } from '../shared/contract/paths.js'
import { createLogger } from '../shared/core/logger.js'
import { installCrashBackstop } from '../shared/core/crash-backstop.js'
import {
  WORKER_EXIT_UNSTABLE, WORKER_EXIT_PROTOCOL_MISMATCH, WORKER_EXIT_ORPHANED, WORKER_EXIT_ALREADY_RUNNING,
  WORKER_EXIT_LISTEN_FAILED,
} from '../shared/contract/exit-codes.js'
import { IDENTITY_LOCK_CODES } from '../shared/contract/errors.js'
import { bindConnectionLifecycle } from './connection-lifecycle.js'
import { startListener } from './listener.js'
import { MAIN_REQUEST_FRAME, MAIN_REQUEST } from '../shared/contract/main-requests.js'
import {
  getProfile,
} from '../shared/spaces/profile.js'
import { installDataDirTripwire, armDataDirTripwire } from './dir-tripwire.js'
import { boot } from './boot.js'
import { refreshAuditSelfName } from './audit-refs.js'

// DIAGNOSTIC — wrap bare-fs before the composition root can capture a reference to it. The rule
// stays inert until armDataDirTripwire runs with the bootstrap's storage path, below.
installDataDirTripwire()

const ipc = createIPC(Bare.IPC)
const log = createLogger('worklet')

// Started next to ipc.start() rather than here: before the router goes live the loop is busy with
// boot I/O by design, and sampling that would report a wedge that is really just a large library
// being opened.
// The worker's one periodic loop, so it carries the router's deadline and liveness sweeps too — a
// second timer for those would be the parallel mechanism the supervisor already argues against.
const health = createHealthMonitor({
  onTick: () => {
    ipc.sweepDeadlines()
    ipc.sweepLiveness({ keepaliveMs: getIpcKeepaliveMs(), graceMs: getIpcKeepaliveGraceMs() })
  },
})

// Main authorizes "reveal in folder" against these — download roots and mount paths — and cannot
// read the space or mount records that hold them, so the set is pushed to it on every change.
// Main's copy is last-frame-wins, so one listing is in flight at a time and a change that lands
// during it runs one more afterwards: a burst of mount deletes costs one scan, and no frame can
// overtake a newer one. A listing that fails still publishes the download roots, so a narrowing is
// never lost. Callers hand this on as a `() => void`.
let revealRootsListing = null
let revealRootsDirty = false
function publishRevealRoots() {
  if (revealRootsListing) { revealRootsDirty = true; return }
  revealRootsListing = listRevealRoots()
    .catch((err) => { log.warn('reveal roots listing failed, publishing download roots only:', err.message); return listDownloadRoots() })
    .then((roots) => {
      ipc.emit(MAIN_REQUEST_FRAME, { command: MAIN_REQUEST.REVEAL_ROOTS, args: daemonPaths({ roots }) })
      revealRootsListing = null
      if (revealRootsDirty) { revealRootsDirty = false; publishRevealRoots() }
    })
}
setMountRootsListener(publishRevealRoots)
setDownloadRootsListener(publishRevealRoots)
const chooseFolder = createFolderChooser({ ipc, publishRevealRoots })

// Dropping a root is a NARROWING of that allowlist, so it has to be published like any other
// change: main's copy is push-only, and a forget that never republishes leaves it authorizing
// reveals under a departed space's folder for the rest of the process lifetime.
function dropSpaceDownloadRoot(spaceId) {
  forgetSpaceDownloadRoot(spaceId)
  publishRevealRoots()
}

// === Crash safety & shutdown ===

// Installed FIRST — before any await — so a fire-and-forget rejection during boot (a background
// core open by discovery key hitting STORAGE_EMPTY, say) is logged instead of aborting the worker.
// Armed only once the worker is LIVE (`isArmed`): escalating during boot would recreate the abort
// this guard exists to prevent. `bootComplete` flips next to the ready broadcast, so the worker
// and the renderer's respawn policy agree on what "this generation booted" means.
installCrashBackstop(log, {
  isArmed: () => bootComplete && !shuttingDown,
  onUnstable: () => { safeShutdown('unstable', WORKER_EXIT_UNSTABLE) },
})

let root = null
let listener = null
let bootComplete = false
let shuttingDown = false
// How the renderer tells one death from another: an unstable exit and a refused protocol want
// different respawn budgets, and nothing else about the exits differs. Module-scoped rather than
// a parameter because the code is read at exit time, not at call time — see below.
let exitCode = 0
async function safeShutdown(reason, code = 0) {
  // The FIRST reason owns the exit code, and a later one cannot relabel it. Shutdowns routinely
  // arrive in pairs: the host asks us to stop, our teardown runs for seconds, and main's escalation
  // closes the pipe underneath it. That second event is a CONSEQUENCE of the first, so letting it
  // set the code would report a clean quit as an orphaned worker on every slow teardown.
  if (shuttingDown) return
  exitCode = code
  shuttingDown = true
  log.warn('shutdown:', reason)
  // Hard deadline: a hung swarm/store teardown must never keep the worker alive.
  // (This covers the "stuck on an await" case; if the event loop is starved by a
  // busy loop the timer can't fire either — the parent's SIGKILL backstop is what
  // reaps that case.)
  const deadline = setTimeout(() => { try { Bare.exit(exitCode) } catch {} }, 4000)
  deadline.unref?.()
  health.stop()
  // Before the data layer closes under them: a handler parked on a bee read that is about to be
  // closed throws a "session closed" error into the crash backstop's fault window, which exits the
  // worker once it fills. Aborted first, the same handler leaves through the ECANCELLED path the
  // router already treats as expected.
  ipc.abortAll('worker is shutting down')
  // The whole stop sequence — the departure announce, the flush window, then every subsystem in
  // the reverse of its start order — lives in the composition root. `root` is null until boot()
  // returns, which is what lets the pipe-close hooks below fire at any point during startup.
  try { await root?.close() } catch (err) { log.warn('shutdown: close failed:', err.message) }
  // Last, so a window learns the worker is gone together with the code it exits with.
  try { await listener?.close() } catch (err) { log.warn('shutdown: listener close failed:', err.message) }
  log.info('shutdown complete')
  Bare.exit(exitCode)
}

// Registered BEFORE the bootstrap await. If the parent dies during startup, the pipe closes while
// we are parked on ipc.bootstrapPromise; without this the worker would sit at that await forever as
// an idle orphan. safeShutdown's teardown steps all no-op safely when called before init.
//
// A closed pipe disconnects a CLIENT and then asks separately whether to stay up. The answer is
// "stop" — see connection-lifecycle.js for why it has to be while the worker lives with its host.
bindConnectionLifecycle({
  pipe: Bare.IPC,
  ipc,
  client: ipc.primary,
  isBootComplete: () => bootComplete,
  stop: (reason) => { safeShutdown(reason, WORKER_EXIT_ORPHANED) },
})

// === Bootstrap frame ===

// Not left to the crash backstop: it is not armed until bootComplete, so an escaping rejection
// here would abort the worker with no code and no line. safeShutdown runs the real teardown (root
// is still null, so every step no-ops) and exits with the code the renderer branches on.
//
// It is awaited and then parked, never re-thrown: a throw here is a top-level-await rejection,
// which is the outcome this branch exists to avoid. The park covers the one case where
// safeShutdown returns instead of exiting — a teardown that got there first and owns the exit.
let bootstrap
try {
  bootstrap = await ipc.bootstrapPromise
} catch (err) {
  await safeShutdown('protocol-mismatch: ' + err.message, WORKER_EXIT_PROTOCOL_MISMATCH)
  await new Promise(() => {})
}
// The package root is two levels up from this entry — the repo in dev, app.asar.unpacked when
// packaged — and feature-flags.json sits there. The settings file is the worker's own and is read
// before anything else needs a preference; a first boot imports it from main's config.json.
const flags = loadFeatureFlags(path.resolve(path.dirname(Bare.argv[1]), '..', '..'), { override: bootstrap.featureFlags, log })
const settingsLoad = await loadSettings(bootstrap.storage)
if (settingsLoad.imported) log.info('settings: imported from config.json')
if (!settingsLoad.persisted) log.warn('settings: running on defaults, settings.json could not be', settingsLoad.broken ? 'read: ' + settingsLoad.broken : 'written')
setRuntimeConfig(assembleRuntimeConfig({ bootstrap, settings: getSettings(), flags }))

// DIAGNOSTIC — the bootstrap frame carries the storage path, which is the first moment the worker
// knows which directory to protect. Armed here, before boot() opens the Corestore, so every
// migration and purge the data layer runs is already covered. See src/worker/dir-tripwire.js.
armDataDirTripwire(bootstrap.storage)

// Before anything touches the store: the profile lock taken here is what keeps a second worker away
// from it, and a locked-identity worker serves its recovery screen over this socket too.
{
  const listened = await startListener({ ipc, storage: bootstrap.storage, log })
  if (listened.verdict !== 'listening') {
    await safeShutdown('listener ' + listened.verdict + ': ' + listened.reason,
      listened.verdict === 'already-running' ? WORKER_EXIT_ALREADY_RUNNING : WORKER_EXIT_LISTEN_FAILED)
    await new Promise(() => {})
  }
  listener = listened
}

// === Boot: the composition root constructs and starts the data layer ===
//
// Everything from the Corestore to the swarm lives in src/worker/boot.js, which starts each
// subsystem in a declared order and closes them in reverse. What stays here is what only an
// entry can own: the pipe, the handlers, the deadline and Bare.exit.

// Membership owns both halves of a knock — the live frame and the replicated fold — so it is
// built before the root and hands back the two collaborators the root folds with.
// One throttle for every request that opens a recovery file, locked worker or not.
const openRecovery = createPassphraseThrottle()

const { memberRegistry, handleMembershipControl, discardPendingSpace } =
  createMembership(ipc, { log, dropSpaceDownloadRoot })

// A key that cannot open this identity locks the worker instead of crashing it: the renderer shows
// the recovery screen, and the router serves only the process and identity handlers. boot() has
// already closed what it started, so the store is free for a recovery key to be checked against.
// The top level parks there; the next generation, after an import or a set-aside, boots normally.
async function serveLockedIdentity(code) {
  log.warn('identity locked, serving recovery only:', code)
  registerWorkerProcess(ipc, { stop: () => { safeShutdown('shutdown-request') } })
  registerIdentity(ipc, { storagePath: bootstrap.storage, identityKEK: bootstrap.identityKEK, log, lockedBy: code, openRecovery })
  registerBackupRestore(ipc, { storagePath: bootstrap.storage, identityKEK: bootstrap.identityKEK, log, lockedBy: code, openRecovery })
  ipc.onClientAttach((client) => {
    ipc.emit('event:worker-ready', { epoch: ipc.epoch, head: ipc.head() }, { to: client })
  })
  health.start()
  ipc.start()
  await new Promise(() => {})
}

// The root constructs everything it needs; the membership collaborators and publishRevealRoots
// are passed in because they close over state that belongs here.
let lockedBy = null
try {
  await applyPendingIdentityChange(bootstrap.storage)
  root = await boot(bootstrap, {
    ipc,
    log,
    membershipControl: handleMembershipControl,
    publishRevealRoots,
    memberRegistry,
    // Publishes a closable handle before the root finishes starting, so a pipe close or a quit
    // during boot still announces departure and drops what came up. The full root replaces it on
    // the line below; both carry the same close().
    onPartialRoot: (partial) => { root = partial },
  })
} catch (err) {
  if (!IDENTITY_LOCK_CODES.includes(err?.code)) throw err
  root = null
  lockedBy = err.code
}
if (lockedBy) await serveLockedIdentity(lockedBy)
const { mounts, intents, applyRelayConfig, overlayBackend } = root
const mountOwnedShare = createOwnedMounter({ ipc, mounts })

registerWorkerProcess(ipc, { stop: () => { safeShutdown('shutdown-request') } })

// === IPC: folder-share handlers (shares, owned & foreign mounts) ===

registerShares(ipc, { log, intents, mountOwnedShare, chooseFolder })

registerFolderPreview(ipc)

registerOwnedFolders(ipc, { log, mounts, intents, mountOwnedShare })

registerForeignFolders(ipc, { log, intents })

// === IPC: profile & space handlers ===

registerProfile(ipc, { log })
registerIdentity(ipc, {
  storagePath: bootstrap.storage, identityKEK: bootstrap.identityKEK, log, lockedBy: null, openRecovery,
  restoreStatus: () => root?.restoreCatchUp?.status() ?? null,
})

registerSpaces(ipc, { log, chooseFolder })

registerBackup(ipc, { backup: root.backup, paused: root.backupPaused, openRecovery })
registerBackupRestore(ipc, { storagePath: bootstrap.storage, identityKEK: bootstrap.identityKEK, log, lockedBy: null, openRecovery })

registerSpaceLeave(ipc, { log, mounts, overlayBackend, discardPendingSpace, dropSpaceDownloadRoot })

// === IPC: presence, file & transfer handlers ===

registerFiles(ipc, { log, chooseFolder })

// === IPC: feedback, storage & settings handlers ===

registerSettings(ipc, { mounts, publishRevealRoots })
registerStorage(ipc)
registerFeedback(ipc)
registerNetwork(ipc, { applyRelayConfig })
registerDiagnostics(ipc, { health, getRoot: () => root })

// === IPC: audit log ===

registerAudit(ipc)

// === IPC: organization configuration ===

registerManaged(ipc, { service: root.managed })

// === Go live: flush queued frames, announce ready ===

// What every client is told on arrival, recomputed per client rather than replayed from boot. The
// three frames below used to fire exactly once, so a client that attached afterwards — or the same
// renderer after a reload, which is indistinguishable — never received them at all.
ipc.onClientAttach(async (client) => {
  // The coordinates ride the greeting, so a client learns where the stream is without asking: the
  // epoch tells it whether this is the worker it was talking to, and head where the numbering is.
  ipc.emit('event:worker-ready', { epoch: ipc.epoch, head: ipc.head() }, { to: client })
  const profile = await getProfile()
  refreshAuditSelfName(profile?.displayName)
  if (!profile) ipc.emit('event:profile-needed', {}, { to: client })
  else ipc.emit('event:state', { profile, spaces: await slimSpaces(profile) }, { to: client })
})

health.start()
ipc.start()

log.info('ready')
// From here a fault storm is the worker's own failure, not a boot that has not finished, so the
// backstop may escalate. Set after the router goes live so the renderer has already recorded this
// generation as booted before any escalation can end it.
bootComplete = true
