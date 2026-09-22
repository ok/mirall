// The Bare worker host: spawning one, framing what goes down its pipe, and reaping it.
//
// Exactly one function writes to a worker pipe. A lost watcher event is survivable; a lost
// bootstrap is not, so the spawn path treats a failed bootstrap write as a failed spawn rather
// than caching a worker nothing can talk to.

const { ipcMain } = require('electron')
const { StringDecoder } = require('string_decoder')
const { logRing } = require('./log-ring.js')
const { isDebug } = require('./debug-gate.js')
const { isQuitting } = require('./quit-state.js')
const { sendToAll } = require('./logging.js')
const { createMainRequestRouter } = require('./main-requests.js')
const { createFailureGate } = require('./worker-bus-failure.js')
const { createWorkerRestart } = require('./lifecycle.js')
const { entrypointFor } = require('./worker-entrypoints.js')
const { createWorkerFrameReader } = require('./ipc-frame.js')
const { envJson } = require('./env-json.js')
const { readFeatureFlags } = require('./feature-flags.js')
const { isVerbose } = require('./debug-gate.js')
const relaySecret = require('./relay-secret.js')
const { readDownloadFolder, readBandwidth } = require('./settings-ipc.js')
const { MAIN_REQUEST_FRAME } = require('../shared/contract/main-requests.js')
const { IPC_PROTOCOL_VERSION, IPC_PROTOCOL_MIN_SUPPORTED } = require('../shared/contract/ipc-frames.js')

const pkg = require('../../package.json')
const version = pkg.version
const upgrade = pkg.upgrade

const workers = new Map()

// Bound by the entry. identityKEK is a getter, not a value: it is resolved inside whenReady, after
// this module is required but before the first spawn, and the bootstrap frame reads it then.
let config = null
let getPear = null
let isDev = false
let identityKEK = () => null

function initWorkerHost(d) {
  config = d.config
  getPear = d.getPear
  isDev = d.isDev
  identityKEK = d.identityKEK
}

function downloadRoots() { return workerDownloadRoots }

// The watchers live in main because Bare has no recursive watch, and they feed the worker through
// this module — so the quit sequence reaches them here. They stay two steps: the sequence records
// each by name, and a failure in one must not skip the other.
function stopOwnedWatchers() { ownedFolderWatchers.stopAllWatchers() }
function stopLooseWatchers() { looseFileWatchers.stopLooseWatchers() }

// Per-space download roots, pushed by the worker (it owns the space records). Main
// needs them to authorize "reveal in folder" for files outside the home directory.
let workerDownloadRoots = []

// === Worker frame writer + the worker→main request router ===

const ownedFolderWatchers = require('./owned-folder-watchers.js')
const looseFileWatchers = require('./loose-file-watchers.js')

// The one path that puts a frame on the worker pipe — bootstrap, shutdown and every watcher event
// alike. Returns whether it went out: a lost watcher event is survivable, a lost bootstrap is not
// (see getWorker). Sync failures only — an unserialisable frame, a stream that rejects the write;
// the async EPIPE of a write racing the worker's death arrives on worker.on('error') in getWorker.
// Failures take the worker-bus policy (worker-bus-failure.js); outside debug they are reported once
// per worker: every frame after a pipe goes bad fails the same way, and the repeats would evict
// the crash that explains them from the log ring; a respawned worker reports again.
const reportBusFailure = createFailureGate({ isDebug, isQuitting })
const writeFailureReported = new WeakSet()

function sendToWorker(worker, frame) {
  try {
    worker.write(Buffer.from(JSON.stringify(frame) + '\n'))
    return true
  } catch (err) {
    reportBusFailure(err,
      (text) => ['worker frame write failed:', frame.type, '-', text],
      (text) => {
        if (writeFailureReported.has(worker)) return
        writeFailureReported.add(worker)
        console.warn('worker frame write failed:', frame.type, '-', text, '- further failures for this worker are not logged')
      })
    return false
  }
}

// Declared before getWorker: the worker's data handler closes over this binding, and a spawn
// dispatched synchronously would otherwise read it in its temporal dead zone.
const mainRequests = createMainRequestRouter({
  ownedFolderWatchers,
  looseFileWatchers,
  setDownloadRoots: (roots) => { workerDownloadRoots = roots },
  sendToWorker,
  isDebug,
  isQuitting,
})

// Asks every live worker to exit. Called once, from the quit sequence.
//
// 1. The shutdown frame lets the worker close the swarm and Bare.exit on its own.
// 2. Escalation covers a worker that cannot. The bare-sidecar Duplex has no kill(): destroy()
//    sends SIGTERM via the sidecar; a worker whose loop is starved cannot process the shutdown
//    frame OR a SIGTERM bare dispatches on that loop, so follow up with SIGKILL on the child.
//    Timers are unref'd so they never delay a clean exit; process.on('exit') is the backstop
//    when main exits before these fire.
// One worker, and resolves once it has actually gone. The escalation is unchanged and is what makes
// the promise certain to settle: the shutdown frame lets the worker close the swarm and exit
// itself, SIGTERM at 3s and SIGKILL at 5s cover one that cannot.
function stopWorker(worker) {
  return new Promise((resolve) => {
    worker.once('exit', resolve)
    sendToWorker(worker, { type: 'shutdown' })
    const child = worker._process
    setTimeout(() => { try { worker.destroy() } catch {} ; try { child?.kill('SIGTERM') } catch {} }, 3000).unref?.()
    setTimeout(() => { try { child?.kill('SIGKILL') } catch {} }, 5000).unref?.()
  })
}

function stopWorkers() {
  for (const worker of workers.values()) void stopWorker(worker)
}

function getWorker(specifier) {
  if (workers.has(specifier)) return workers.get(specifier)
  const p = getPear()
  const worker = p.run(entrypointFor(specifier), [])
  // A write racing the worker's death (the before-quit shutdown frame, a
  // relayed renderer frame, a watcher event) fails with an EPIPE that
  // arrives asynchronously as a stream 'error' event — the try/catch around
  // each worker.write() never sees it, and with no listener the emit throws
  // as an uncaught exception (Electron's error dialog). Consume it here;
  // cleanup runs off worker.once('exit') below either way.
  worker.on('error', (err) => {
    if (isDebug()) console.error('worker stream error (shutdown race):', err.message)
  })
  // A previous worker for this specifier may have left a no-op handler
  // registered on exit (see the worker.once('exit', ...) below). Clear it
  // before re-registering, otherwise ipcMain.handle throws.
  try { ipcMain.removeHandler('pear:worker:writeIPC:' + specifier) } catch {}

  // Every MIRALL_* hook the app reads. All are unset in a normal run.
  //
  //   Logging
  //     MIRALL_DEBUG, MIRALL_VERBOSE      log level
  //
  //   Test environment
  //     MIRALL_DHT_BOOTSTRAP              a hermetic testnet instead of the public DHT
  //     MIRALL_DOWNLOAD_FOLDER            start from a known download folder
  //     MIRALL_WINDOW_BOUNDS              start from a known window size and position
  //     MIRALL_FEATURE_FLAGS              feature flags without a build
  //     MIRALL_FORCE_A11Y                 the AX tree the frontend suite drives
  //     MIRALL_NO_DEVTOOLS                no devtools window
  //     MIRALL_LIST_FILES_CAP             most files a folder listing shows, lowered to reach
  //                                       the truncation banner with a handful of files
  //     MIRALL_MAX_FILES_PER_SHARE        largest folder a user may share, lowered to reach
  //                                       the refusal with a handful of files
  //     MIRALL_HOLD_MEMBER_FOLD           a file path; while it exists the membership fold does not
  //                                       run, holding a request on screen after a co-member settles it
  //
  //   Behaviour levers, settable on a real install without a release
  //     MIRALL_FOREIGN_FULL_WALK_EVERY    1 = check every mirror in full, undoing the skip
  //
  // The worker's whole starting state: it is sent once, before any request, and the worker never
  // asks main for these again. Three sources are mixed here on purpose — the packaged app (storage,
  // version, upgrade key), the user's stored preferences, and the MIRALL_* test overrides, each of
  // which is undefined unless its variable is set so JSON drops it and the worker's own default
  // stands. shared/core/runtime-config.js is what reads the result, and is the authority on what
  // each field means once it lands.
  const bootstrap = {
    type: 'bootstrap',
    // The wire contract's version and the window this sender accepts, checked by the worker before
    // it reads any other field. A frame with no protocolVersion is a host from before the field
    // existed and is refused like any other incompatible peer. min/max are inert while both equal
    // the version, and exist so a future client can advertise a range without another wire change.
    protocolVersion: IPC_PROTOCOL_VERSION,
    protocolMin: IPC_PROTOCOL_MIN_SUPPORTED,
    protocolMax: IPC_PROTOCOL_VERSION,
    storage: p.storage,
    appVersion: version,
    upgradeKey: upgrade || null,
    dev: isDev,
    verbose: isVerbose(),
    downloadFolder: readDownloadFolder(),
    ...readBandwidth(),
    dhtBootstrap: envJson('MIRALL_DHT_BOOTSTRAP'),
    // Test/debug override for the share:list-files row cap (undefined → omitted by JSON →
    // the runtime-config default). Lets the frontend suite exercise the truncation banner
    // with a handful of files; a bad value is caught by getListFilesCap's fail-safe.
    listFilesCap: process.env.MIRALL_LIST_FILES_CAP ? Number(process.env.MIRALL_LIST_FILES_CAP) : undefined,
    // The mirror-walk skip's rollback lever: 1 restores the pre-skip cadence without a release.
    foreignFullWalkEvery: process.env.MIRALL_FOREIGN_FULL_WALK_EVERY ? Number(process.env.MIRALL_FOREIGN_FULL_WALK_EVERY) : undefined,
    // Same idea for the add-folder admission gate, so the frontend suite can trip it with a
    // handful of files; a bad value is caught by getMaxFilesPerShare's fail-safe.
    maxFilesPerShare: process.env.MIRALL_MAX_FILES_PER_SHARE ? Number(process.env.MIRALL_MAX_FILES_PER_SHARE) : undefined,
    memberFoldHold: process.env.MIRALL_HOLD_MEMBER_FOLD || undefined,
    handshakeIdentityBindingEnabled: readFeatureFlags().handshakeIdentityBinding === true,
    // in-place files are served through the overlay instance, so enabling them implies overlay.
    overlayEnabled: readFeatureFlags().overlay === true || readFeatureFlags().inPlaceFiles === true,
    inPlaceFilesEnabled: readFeatureFlags().inPlaceFiles === true,
    // Hashing progress for a file being (re-)published: members see "preparing 34%" instead of a
    // frozen placeholder, and it is the liveness signal that keeps a download parked on a
    // re-publish alive while a large source hashes. On by default; set false to revert.
    sharePrepareProgressEnabled: readFeatureFlags().sharePrepareProgress !== false,
    // Bulk content rides its own transport by default when overlay is on; feature-flags.json
    // can set separateContentPlane:false to revert to the single-plane overlay.
    separateContentPlane: readFeatureFlags().separateContentPlane !== false,
    // Relay config rides the boot frame unconditionally: it is inert when relayMode is
    // 'off' (relayFunctionFor returns null, so swarm.relayThrough is never installed),
    // which is the shipped default.
    relayMode: config().get('network.relayMode'),
    relay: config().get('network.relay'),
    // The one secret in this frame besides identityKEK, and it travels the same way: read
    // at spawn, consumed in boot.js, never stored in runtime config.
    relaySeed: relaySecret.readRelaySeedHex(p.storage),
    // Read at spawn only. getDownloadConcurrency() re-reads it per acquire, so a live push would
    // take effect without a restart — but there is no setter by design, so a change means editing
    // config.json and restarting.
    downloadConcurrency: config().get('network.downloadConcurrency'),
    identityKEK: identityKEK(),
  }
  // The bootstrap is the one frame whose loss cannot be absorbed: without it the worker has no
  // storage path, no identity KEK and no feature flags, and it never asks again. Caching such a
  // worker would leave `pear:startWorker` reporting success while every later renderer request
  // hangs against a process that can never answer, so it is torn down and the failure is raised —
  // the next startWorker then spawns a fresh one.
  if (!sendToWorker(worker, bootstrap)) {
    try { worker.destroy() } catch {}
    throw new Error('worker bootstrap write failed')
  }

  // Raw bytes rather than a frame, so this is the one write that cannot go through sendToWorker:
  // the renderer has already serialised its own NDJSON envelope.
  let relayFailureReported = false
  const writeHandler = (_evt, data) => {
    try {
      worker.write(Buffer.from(data))
    } catch (err) {
      // Worker may have closed its socket before the renderer's last message arrived. Outside a quit
      // that is a request the renderer is still waiting on, and nothing else reports that it never
      // left. Once per worker, for the same reason as sendToWorker.
      reportBusFailure(err,
        (text) => ['worker write failed:', text],
        (text) => {
          if (relayFailureReported) return
          relayFailureReported = true
          console.warn('worker write failed:', text, '- further failures for this worker are not logged')
        })
    }
  }
  ipcMain.handle('pear:worker:writeIPC:' + specifier, writeHandler)

  const frames = createWorkerFrameReader()
  worker.on('data', (data) => {
    sendToAll('pear:worker:ipc:' + specifier, data)
    // Only worker→main control frames ('main-request') are parsed here; the reader has already
    // dropped anything too large to be one, before decoding it (see ipc-frame.js).
    for (const line of frames.push(data)) {
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg && msg.type === MAIN_REQUEST_FRAME) {
        mainRequests.dispatch(msg.command, msg.args || {}, worker)
      }
    }
  })
  // Streaming decoders: a log line split mid-character must not reach the log ring mangled.
  const stdoutDecoder = new StringDecoder('utf8')
  const stderrDecoder = new StringDecoder('utf8')
  // The renderer gets the raw bytes either way — it has its own streaming decoder, and gating the
  // forward on a decode that came back empty would drop the chunk carrying a split character.
  worker.stdout.on('data', (data) => {
    sendToAll('pear:worker:stdout:' + specifier, data)
    // Empty whenever a chunk ends mid-character: the decoder holds those bytes for the next one.
    // Writing the prefix anyway printed a bare '[worker stdout] ' that the next line continued.
    const text = stdoutDecoder.write(data)
    if (!text) return
    if (isDebug()) process.stdout.write('[worker stdout] ' + text)
    logRing.push('worker', 'log', text)
  })
  worker.stderr.on('data', (data) => {
    sendToAll('pear:worker:stderr:' + specifier, data)
    const text = stderrDecoder.write(data)
    if (!text) return
    process.stderr.write('[worker stderr] ' + text)
    logRing.push('worker', 'error', text)
  })

  worker.once('exit', (code) => {
    // A partial character at process death would otherwise be dropped along with the line it
    // belongs to — and a worker's LAST line is the one worth having.
    const stdoutTail = stdoutDecoder.end()
    if (stdoutTail) logRing.push('worker', 'log', stdoutTail)
    const stderrTail = stderrDecoder.end()
    if (stderrTail) logRing.push('worker', 'error', stderrTail)
    // Replace the writeHandler with a no-op instead of removing it. Late
    // renderer messages (common during shutdown) would otherwise hit
    // "No handler registered" and surface as Uncaught Promise rejections.
    try { ipcMain.removeHandler('pear:worker:writeIPC:' + specifier) } catch {}
    try { ipcMain.handle('pear:worker:writeIPC:' + specifier, () => undefined) } catch {}
    // The roots came from this worker and describe the spaces it had open. Keeping them past its
    // death leaves shell:showInFolder authorising paths nothing is serving any more.
    workerDownloadRoots = []
    sendToAll('pear:worker:exit:' + specifier, code)
    workers.delete(specifier)
  })

  workers.set(specifier, worker)
  return worker
}

// Backstop against orphaned worker subprocesses. When the main process exits for
// any reason (clean quit, OTA relaunch, an uncaught crash), synchronously
// hard-kill any worker child still alive. A healthy worker has already exited via
// the graceful shutdown request and removed itself from `workers`; this only
// reaps a wedged one whose busy-looped event loop could not self-exit. Only a
// synchronous SIGKILL runs reliably in an 'exit' handler — async work is ignored.
process.on('exit', () => {
  for (const worker of workers.values()) {
    try { worker._process?.kill('SIGKILL') } catch {}
  }
})

// Replacing a running worker without quitting. Its own sequence rather than a call pair at the IPC
// boundary, because the order is load-bearing and there was nowhere that said so.
const restartWorker = createWorkerRestart({
  stopWorker: (spec) => (workers.has(spec) ? stopWorker(workers.get(spec)) : Promise.resolve()),
  spawnWorker: (spec) => { getWorker(spec) },
  isQuitting,
})

function registerWorkerHost() {
  ipcMain.handle('pear:startWorker', (_evt, specifier) => {
    getWorker(specifier)
    return true
  })
  ipcMain.handle('pear:restartWorker', (_evt, specifier) => restartWorker(specifier))
}

module.exports = {
  initWorkerHost,
  registerWorkerHost,
  getWorker,
  stopWorker,
  stopWorkers,
  restartWorker,
  sendToWorker,
  downloadRoots,
  stopOwnedWatchers,
  stopLooseWatchers,
}
