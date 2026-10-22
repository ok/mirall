// The Bare worker host: spawning one, framing what goes down its spawn pipe, and reaping it.
//
// The spawn pipe is main's own: the hello, the bootstrap, shutdown and watcher events go down it,
// and the worker's commands to main come back on it. Windows do not use it — each reaches the
// worker over its own socket connection (window-connections.js), opened once the worker has said
// where it listens.
//
// Exactly one function writes to a worker pipe. A lost watcher event is survivable; a lost
// bootstrap is not, so the spawn path treats a failed bootstrap write as a failed spawn rather
// than caching a worker nothing can talk to.

const { app, ipcMain } = require('electron')
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
const { createWindowConnections } = require('./window-connections.js')
const { envJson } = require('./env-json.js')
const { envOverride } = require('./env-overrides.js')
const { isVerbose } = require('./debug-gate.js')
const relaySecret = require('./relay-secret.js')
const { MAIN_REQUEST_FRAME } = require('../shared/contract/main-requests.js')
const { WORKER_SPECS } = require('../shared/contract/workers.js')
const { FRAME, IPC_PROTOCOL_VERSION, IPC_PROTOCOL_MIN_SUPPORTED } = require('../shared/contract/ipc-frames.js')

const pkg = require('../../package.json')
const version = pkg.version
const upgrade = pkg.upgrade

const envNumber = (raw) => (raw ? Number(raw) : undefined)

const workers = new Map()
const windowConnections = createWindowConnections()

// A worker that has not said where it listens by now never will: it is wedged, and the window's
// respawn path deals with a spawn that did not come up.
const LISTENING_TIMEOUT_MS = 30000

// Where each live worker listens, settled by its socket:listening command and rejected by its exit.
const listening = new WeakMap()

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function socketPathOf(worker) {
  const announced = listening.get(worker)
  if (!announced) return Promise.reject(new Error('worker is gone'))
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('worker did not open its socket')), LISTENING_TIMEOUT_MS)
  })
  return Promise.race([announced.promise, timeout]).finally(() => clearTimeout(timer))
}

// Bound by the entry. identityKEK is a getter, not a value: it is resolved inside whenReady, after
// this module is required but before the first spawn, and the bootstrap frame reads it then.
let getPear = null
let isDev = false
let identityKEK = () => null
let identityWeak = () => false

function initWorkerHost(d) {
  getPear = d.getPear
  isDev = d.isDev
  identityKEK = d.identityKEK
  identityWeak = d.identityWeak ?? (() => false)
}

function revealRoots() { return workerRevealRoots }

// Whether the worker a window talks to runs on this machine. Every worker in `workers` was spawned
// by this process and announced a socket under its own userData, so a live spawned worker is local.
// Vouched per window, for the worker that window claimed: a daemon a window reaches without this
// process having spawned it is not in the map and is not vouched for.
function workerIsLocal(senderId) {
  const worker = windowConnections.workerOf(senderId)
  if (!worker) return false
  for (const spawned of workers.values()) if (spawned === worker) return true
  return false
}

// The watchers live in main because Bare has no recursive watch, and they feed the worker through
// this module — so the quit sequence reaches them here. They stay two steps: the sequence records
// each by name, and a failure in one must not skip the other.
function stopFolderWatchers() { folderWatchers.stopAllWatchers() }
function stopLooseWatchers() { looseFileWatchers.stopLooseWatchers() }

// Download roots and mount paths, pushed by the worker (it owns the space and mount records). Main
// needs them to authorize "reveal in folder" for paths outside the home directory.
let workerRevealRoots = []

// === Worker frame writer + the worker→main request router ===

const folderWatchers = require('./folder-watchers.js')
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
  folderWatchers,
  looseFileWatchers,
  setRevealRoots: (roots) => { workerRevealRoots = roots },
  onSocketListening: (worker, socketPath) => listening.get(worker)?.resolve(socketPath),
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
  listening.set(worker, deferred())

  // Every environment hook main reads. All are unset in a normal run.
  //
  //   Test and development levers — ignored by a packaged build (see env-overrides.js)
  //     PEAR_DEV_SERVER_URL               load the renderer from a dev server
  //     MIRALL_VERBOSE                    verbose logging from launch
  //     MIRALL_DHT_BOOTSTRAP              a hermetic testnet instead of the public DHT
  //     MIRALL_DOWNLOAD_FOLDER            start from a known download folder
  //     MIRALL_WINDOW_BOUNDS              start from a known window size and position
  //     MIRALL_FE_BACKGROUND              open the window without taking focus
  //     MIRALL_FEATURE_FLAGS              feature flags without a build
  //     MIRALL_FORCE_A11Y                 the AX tree the frontend suite drives
  //     MIRALL_NO_DEVTOOLS                no devtools window
  //     MIRALL_LIST_FILES_CAP             most files a folder listing shows, lowered to reach
  //                                       the truncation banner with a handful of files
  //     MIRALL_MAX_FILES_PER_SHARE        largest folder a user may share, lowered to reach
  //                                       the refusal with a handful of files
  //     MIRALL_DERIVE_DEBOUNCE_MS         how long the membership fold trails a write, raised to
  //                                       hold a request on screen after a co-member settles it
  //     MIRALL_FREE_UP_MIN_BYTES          reclaimable bytes that bring up Storage's "Free up",
  //                                       lowered to reach it on a fresh profile
  //     MIRALL_MANAGED_TEST_SIGNING_KEY   an extra organization signing key (hex) for a local fixture
  //     MIRALL_MANAGED_ALLOW_HTTP_LOOPBACK  1 = accept the local stack's http://127.0.0.1 API
  //     MIRALL_MANAGED_PREVIEW_TIMEOUT_MS, MIRALL_MANAGED_DRIVE_GRACE_MS, MIRALL_MANAGED_HTTPS_POLL_MS,
  //     MIRALL_MANAGED_REPORT_DELAY_MS
  //                                       shortened waits for the organization configuration
  //
  //   Behaviour levers, settable on a real install without a release
  //     MIRALL_FOREIGN_FULL_WALK_EVERY    1 = check every mirror in full, undoing the skip
  //     MIRALL_LIST_FULL_READ_EVERY       1 = re-read every catalog on every listing
  //
  // The worker's starting state from the host: it is sent once, before any request, and the worker
  // never asks main for these again. Host facts (storage, version, upgrade key, the OS downloads
  // folder), the two secrets, and the MIRALL_* test overrides, each of which is undefined unless
  // its variable is set so JSON drops it and the worker's own default stands. No preference and no
  // feature flag rides here: the worker reads its settings.json and feature-flags.json itself, and
  // bootstrap-allowlist.test.js pins the key set. shared/core/runtime-config.js is what reads the
  // result, and is the authority on what each field means once it lands.
  // The introduction, sent before the bootstrap and on the same pipe: it carries the wire version
  // the worker checks before it reads any other field, and it is what makes the handshake something
  // a client that is not this process can also complete. min/max are inert while both equal the
  // version, and exist so a future client can advertise a range without another wire change. The
  // bootstrap that follows carries the secrets, and stays Electron's alone.
  //
  // No cursor: main parses no worker frames beyond its own control frames, so it has read nothing
  // to resume from. Each window resumes on its own connection's greeting.
  const hello = {
    type: FRAME.HELLO,
    protocolVersion: IPC_PROTOCOL_VERSION,
    protocolMin: IPC_PROTOCOL_MIN_SUPPORTED,
    protocolMax: IPC_PROTOCOL_VERSION,
    client: { kind: 'electron-main', name: 'mirall', version },
  }

  const bootstrap = {
    type: FRAME.BOOTSTRAP,
    storage: p.storage,
    appVersion: version,
    upgradeKey: upgrade || null,
    dev: isDev,
    verbose: isVerbose(),
    defaultDownloadFolder: app.getPath('downloads'),
    // A session override for the frontend harness; the stored folder is the worker's own.
    downloadFolder: envOverride('MIRALL_DOWNLOAD_FOLDER') || undefined,
    // Merged by the worker over feature-flags.json, so a dev run or the frontend suite can turn a
    // flag without a build.
    featureFlags: envJson('MIRALL_FEATURE_FLAGS', envOverride('MIRALL_FEATURE_FLAGS')) || undefined,
    dhtBootstrap: envJson('MIRALL_DHT_BOOTSTRAP', envOverride('MIRALL_DHT_BOOTSTRAP')),
    // Test/debug override for the share:list-files row cap (undefined → omitted by JSON →
    // the runtime-config default). Lets the frontend suite exercise the truncation banner
    // with a handful of files; a bad value is caught by getListFilesCap's fail-safe.
    listFilesCap: envNumber(envOverride('MIRALL_LIST_FILES_CAP')),
    // Stops every peer catalog drain after this many entries and reports it unfinished, so the
    // frontend suite can hold a reachable member's file list incomplete. Read raw by the drain,
    // where only a positive count truncates.
    testTruncatePeerDrainAfter: envNumber(envOverride('MIRALL_TEST_TRUNCATE_PEER_DRAIN_AFTER')),
    // The mirror-walk skip's rollback lever: 1 restores the pre-skip cadence without a release.
    foreignFullWalkEvery: envNumber(process.env.MIRALL_FOREIGN_FULL_WALK_EVERY),
    // The files:list memo's rollback lever, the same way: 1 re-reads every catalog on every listing.
    listFullReadEvery: envNumber(process.env.MIRALL_LIST_FULL_READ_EVERY),
    // Same idea for the add-folder admission gate, so the frontend suite can trip it with a
    // handful of files; a bad value is caught by getMaxFilesPerShare's fail-safe.
    maxFilesPerShare: envNumber(envOverride('MIRALL_MAX_FILES_PER_SHARE')),
    deriveDebounceMs: envNumber(envOverride('MIRALL_DERIVE_DEBOUNCE_MS')),
    freeUpMinBytes: envNumber(envOverride('MIRALL_FREE_UP_MIN_BYTES')),
    managedTestSigningKey: envOverride('MIRALL_MANAGED_TEST_SIGNING_KEY') || undefined,
    managedAllowHttpLoopback: envOverride('MIRALL_MANAGED_ALLOW_HTTP_LOOPBACK') === '1' || undefined,
    managedPreviewTimeoutMs: envNumber(envOverride('MIRALL_MANAGED_PREVIEW_TIMEOUT_MS')),
    managedDriveGraceMs: envNumber(envOverride('MIRALL_MANAGED_DRIVE_GRACE_MS')),
    managedHttpsPollMs: envNumber(envOverride('MIRALL_MANAGED_HTTPS_POLL_MS')),
    managedReportDelayMs: envNumber(envOverride('MIRALL_MANAGED_REPORT_DELAY_MS')),
    // No OS keychain holds the identity key here, so the backup is offered on day one.
    identityWeak: identityWeak(),
    // The one secret in this frame besides identityKEK, and it travels the same way: read
    // at spawn, consumed in boot.js, never stored in runtime config.
    relaySeed: relaySecret.readRelaySeedHex(p.storage, identityKEK()),
    identityKEK: identityKEK(),
  }
  // Neither frame's loss can be absorbed: without the hello the worker refuses everything that
  // follows, and without the bootstrap it has no storage path and no identity KEK, and it never
  // asks again. Caching such a worker would leave `pear:startWorker` reporting
  // success while every later renderer request hangs against a process that can never answer, so it
  // is torn down and the failure is raised — the next startWorker then spawns a fresh one.
  if (!sendToWorker(worker, hello) || !sendToWorker(worker, bootstrap)) {
    try { worker.destroy() } catch {}
    throw new Error('worker handshake write failed')
  }

  const frames = createWorkerFrameReader()
  worker.on('data', (data) => {
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
    listening.get(worker)?.reject(new Error('worker exited before it opened its socket'))
    listening.delete(worker)
    // The roots came from this worker and describe the spaces it had open. Keeping them past its
    // death leaves shell:showInFolder authorising paths nothing is serving any more.
    workerRevealRoots = []
    windowConnections.workerExited(worker, code)
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

// Spawns the worker if none is running, then opens this window's own connection to it. Resolves
// once the window can write; a worker that dies first rejects, after its exit reached the window.
async function startWorkerFor(sender, specifier) {
  const worker = getWorker(specifier)
  windowConnections.claim(sender, specifier, worker)
  await windowConnections.open(sender.id, await socketPathOf(worker))
  return true
}

function registerWorkerHost() {
  ipcMain.handle('pear:startWorker', (evt, specifier) => startWorkerFor(evt.sender, specifier))
  // False when this window has no connection: the renderer fails the request at once rather than
  // waiting out its timeout.
  for (const specifier of WORKER_SPECS) {
    ipcMain.handle('pear:worker:writeIPC:' + specifier, (evt, data) => windowConnections.write(evt.sender.id, data))
  }
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
  revealRoots,
  workerIsLocal,
  stopFolderWatchers,
  stopLooseWatchers,
}
