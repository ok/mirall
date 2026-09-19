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

import { createIPC } from '../shared/core/ipc.js'
import { createHealthMonitor } from '../shared/core/health.js'
import { registerSpaceLeave } from './ipc/space-leave.js'
import { registerAudit } from './ipc/audit.js'
import { registerNetwork } from './ipc/network.js'
import { registerSettings } from './ipc/settings.js'
import { registerProfile } from './ipc/profile.js'
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
import { createOwnedMounter } from './owned-mount.js'
import {
  setRuntimeConfig,
} from '../shared/core/runtime-config.js'
import { forgetSpaceDownloadRoot, listDownloadRoots } from '../shared/core/paths.js'
import { createLogger } from '../shared/core/logger.js'
import { installCrashBackstop } from '../shared/core/crash-backstop.js'
import { WORKER_EXIT_UNSTABLE, WORKER_EXIT_PROTOCOL_MISMATCH } from '../shared/contract/exit-codes.js'
import { MAIN_REQUEST_FRAME, MAIN_REQUEST } from '../shared/contract/main-requests.js'
import {
  getProfile,
} from '../shared/spaces/profile.js'
import { boot } from './boot.js'
import { refreshAuditSelfName } from './audit-refs.js'

const ipc = createIPC(Bare.IPC)
const log = createLogger('worklet')

// Started next to ipc.start() rather than here: before the router goes live the loop is busy with
// boot I/O by design, and sampling that would report a wedge that is really just a large library
// being opened.
// The worker's one periodic loop, so it carries the router's deadline sweep too — a second timer
// for that would be the parallel mechanism the supervisor already argues against.
const health = createHealthMonitor({ onTick: () => ipc.sweepDeadlines() })

// Main authorizes "reveal in folder" against these, and cannot read the space records
// that hold the per-space overrides, so the set is pushed to it on every change.
function publishDownloadRoots() {
  ipc.emit(MAIN_REQUEST_FRAME, { command: MAIN_REQUEST.DOWNLOADS_ROOTS, args: { roots: listDownloadRoots() } })
}

// Dropping a root is a NARROWING of that allowlist, so it has to be published like any other
// change: main's copy is push-only, and a forget that never republishes leaves it authorizing
// reveals under a departed space's folder for the rest of the process lifetime.
function dropSpaceDownloadRoot(spaceId) {
  forgetSpaceDownloadRoot(spaceId)
  publishDownloadRoots()
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
let bootComplete = false
let shuttingDown = false
// How the renderer tells one death from another: an unstable exit and a refused protocol want
// different respawn budgets, and nothing else about the exits differs. Module-scoped rather than
// a parameter because the code is read at exit time, not at call time — see below.
let exitCode = 0
async function safeShutdown(reason, code = 0) {
  // A specific code beats the default. Two shutdowns can race — a pipe that closed as the worker
  // was already going down for a reason of its own — and the first to arrive owns the sequence.
  // Without this the generic one silences the specific one, and the renderer reads a refused
  // protocol as an ordinary exit and spends the whole respawn budget rediscovering it.
  if (code !== 0) exitCode = code
  if (shuttingDown) return
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
  log.info('shutdown complete')
  Bare.exit(exitCode)
}

// Register the pipe-close teardown BEFORE the bootstrap await. If the parent dies
// during startup (before sending the bootstrap line), the IPC pipe closes while
// we're parked on ipc.bootstrapPromise; without these handlers in place the
// worker would sit at that await forever as an idle orphan. safeShutdown's
// teardown steps all no-op safely when called before init.
Bare.IPC.on('end', () => { safeShutdown('ipc-end') })
Bare.IPC.on('close', () => { safeShutdown('ipc-close') })
Bare.IPC.on('error', (err) => { safeShutdown('ipc-error: ' + (err && err.message ? err.message : err)) })

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
setRuntimeConfig(bootstrap)

// === Boot: the composition root constructs and starts the data layer ===
//
// Everything from the Corestore to the swarm lives in src/worker/boot.js, which starts each
// subsystem in a declared order and closes them in reverse. What stays here is what only an
// entry can own: the pipe, the handlers, the deadline and Bare.exit.

// Membership owns both halves of a knock — the live frame and the replicated fold — so it is
// built before the root and hands back the two collaborators the root folds with.
const { memberRegistry, handleMembershipControl, discardPendingSpace } =
  createMembership(ipc, { log, dropSpaceDownloadRoot })

// The root constructs everything it needs; the membership collaborators and publishDownloadRoots
// are passed in because they close over state that belongs here.
root = await boot(bootstrap, {
  ipc,
  log,
  membershipControl: handleMembershipControl,
  publishDownloadRoots,
  memberRegistry,
  // Publishes a closable handle before the root finishes starting, so a pipe close or a quit
  // during boot still announces departure and drops what came up. The full root replaces it on
  // the line below; both carry the same close().
  onPartialRoot: (partial) => { root = partial },
})
const { mounts, intents, applyRelayConfig } = root
const mountOwnedShare = createOwnedMounter({ ipc, mounts })

ipc.handle('shutdown', () => { safeShutdown('renderer-shutdown') })

// === IPC: folder-share handlers (shares, owned & foreign mounts) ===

registerShares(ipc, { log, intents, mountOwnedShare })

registerFolderPreview(ipc)

registerOwnedFolders(ipc, { log, mounts, intents, mountOwnedShare })

registerForeignFolders(ipc, { log, intents })

// === IPC: profile & space handlers ===

registerProfile(ipc, { log })

registerSpaces(ipc, { log, publishDownloadRoots })

registerSpaceLeave(ipc, { log, mounts, discardPendingSpace, dropSpaceDownloadRoot })

// === IPC: presence, file & transfer handlers ===

registerFiles(ipc, { log })

// === IPC: feedback, storage & settings handlers ===

registerSettings(ipc, { mounts, publishDownloadRoots })
registerFeedback(ipc)
registerNetwork(ipc, { applyRelayConfig })
registerDiagnostics(ipc, { health, getRoot: () => root })

ipc.handle('ping', async () => ({ pong: true, timestamp: Date.now() }))

// === IPC: audit log ===

registerAudit(ipc)

// === Go live: flush queued frames, announce ready ===

// What every client is told on arrival, recomputed per client rather than replayed from boot. The
// three frames below used to fire exactly once, so a client that attached afterwards — or the same
// renderer after a reload, which is indistinguishable — never received them at all.
ipc.onClientAttach(async (client) => {
  ipc.emit('event:worker-ready', {}, { to: client })
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
