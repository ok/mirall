// Electron main process — the host. Owns the BrowserWindow, tray, native
// notifications, and deep links; embeds pear-runtime as a library for OTA
// updates; spawns the Bare worker (all P2P and data logic) and relays NDJSON
// IPC frames renderer↔worker in both directions; runs the chokidar folder
// watchers on the worker's behalf (Bare has no recursive watch). Main holds no
// durable application state — that lives in the worker's store (preferences aside,
// which are main's config.json); what main keeps in memory is session-only.
const { app, BrowserWindow, dialog, ipcMain, protocol: electronProtocol } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { StringDecoder } = require('node:string_decoder')
const { logRing } = require('./log-ring')
const { sendToAll, loadRedactLine, installMainLogForwarding } = require('./logging.js')
const { initPrefs, getPrefs } = require('./prefs.js')
const { isQuitting, markQuitting } = require('./quit-state.js')
const {
  initWindow,
  registerWindow,
  createWindow,
  targetWindow,
  revealWindow,
  zoomByDirection,
} = require('./window.js')
const {
  initMenus,
  registerMenus,
  createTray,
  destroyTray,
  refreshAppMenu,
  applyAppMenuVisibility,
  sendKeyboardCommand,
} = require('./menus.js')
const {
  initSettings,
  registerSettingsIpc,
  readDownloadFolder,
  readBandwidth,
} = require('./settings-ipc.js')
const { createQuitSequence } = require('./lifecycle.js')

// Custom app:// scheme. Registered as standard+secure so the renderer
// document gets a stable origin across webContents.reload — file://
// otherwise becomes opaque on reload, which causes CSP `'self'` to stop
// matching the document's own scripts/styles and the page comes back
// blank. Must be registered before app.ready (hence module-top scope).
electronProtocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
}])

// Asar redirects fs reads transparently but not child_process.spawn — paths
// that resolve into app.asar/ via require.resolve will ENOTDIR when handed
// to spawn. bare-sidecar (Sidecar constructor) spawns the bare binary and
// passes the worker entrypoint as argv, both resolved through require.asset
// which returns asar paths. Translate them back to app.asar.unpacked here so
// the OS sees real files. No-op when not packaged or when paths aren't asar.
const childProcess = require('child_process')
const _spawn = childProcess.spawn
const fixAsarPath = (p) => typeof p === 'string'
  ? p.replace(/([\\/])app\.asar([\\/])/g, '$1app.asar.unpacked$2')
  : p
childProcess.spawn = function (file, args, options) {
  file = fixAsarPath(file)
  if (Array.isArray(args)) args = args.map(fixAsarPath)
  return _spawn.call(this, file, args, options)
}

const { isMac, isLinux, isWindows } = require('which-runtime')
const PearRuntime = require('pear-runtime')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const debounceify = require('debounceify')
const { parseBootArgv, extractDeepLinks } = require('./boot-argv.js')
const { ConfigStore } = require('./config-store.js')
const { readFeatureFlags } = require('./feature-flags.js')
const { envJson } = require('./env-json.js')
const relaySecret = require('./relay-secret.js')
const { initDebugGate, isDebug, isVerbose, setVerbose } = require('./debug-gate.js')
const { integrateXdgLinux } = require('./xdg-integration.js')
const applyErrors = require('./apply-error.js')

installMainLogForwarding()

const pkg = require('../../package.json')
const appName = pkg.productName || pkg.name
const protocol = pkg.name
const version = pkg.version
const upgrade = pkg.upgrade

// Deep links arrive as a positional in our own argv on Win/Linux, so they are
// peeled off here rather than parsed — see boot-argv.js for why a strict parse
// at module top is fatal. boot.deepLinks is dispatched once the instance lock is
// known to be ours, further down.
const boot = parseBootArgv(app.isPackaged ? process.argv.slice(1) : process.argv.slice(2), {
  name: appName,
  protocol,
})
for (const w of boot.warnings) console.warn('[argv] ignored:', w)
const customStorage = boot.flags.storage
// No upgrade key (e.g. running from source) → disable OTA. pear-runtime-updater throws otherwise.
const updatesEnabled = boot.flags.updates !== false && !!upgrade
const startHiddenFlag = !!boot.flags.hidden

// With --storage, redirect Electron's userData too, so config.json, the corestore and the
// applied-version marker share one directory: two instances pointed at separate stores must not
// share (and clobber) one userData.
if (customStorage) app.setPath('userData', customStorage)

// Test hook: force Chromium to always build the renderer accessibility tree.
// Without this, a backgrounded/secondary instance's web-content AX tree may
// never activate (lazy per-process), leaving automation snapshots empty.
if (process.env.MIRALL_FORCE_A11Y === '1') app.commandLine.appendSwitch('force-renderer-accessibility')

if (isWindows) app.setAppUserModelId(pkg.build?.appId || pkg.name)

app.setAboutPanelOptions({
  applicationName: appName,
  applicationVersion: version,
  copyright: `© ${new Date().getFullYear()} ${pkg.author}. ${pkg.license}.`,
  credits: pkg.description,
  iconPath: path.join(__dirname, '..', '..', 'resources', 'linux', 'icons', '256x256.png'),
  authors: [pkg.author],
  website: 'https://mirall.app',
})

const isDev = !app.isPackaged || !!process.env.PEAR_DEV_SERVER_URL
// The gate reads false until this runs, which only suppresses forwarding to the renderer — there
// is no renderer this early, and the log ring is written either way. See debug-gate.js.
initDebugGate({ isDev })

let pear = null
let identityKEKHex = null
let identityProtection = 'disabled'
const workers = new Map()

const { createWorkerFrameReader } = require('./ipc-frame.js')
const { createMainRequestRouter } = require('./main-requests.js')
const { entrypointFor } = require('./worker-entrypoints.js')
const { MAIN_REQUEST_FRAME } = require('../shared/contract/main-requests.js')

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason && (reason.stack || reason.message || reason))
})

function getAppPath() {
  if (!app.isPackaged) return null
  // app.getAppPath returns ".../Mirall.app/Contents/Resources/app" — three
  // levels up gets us the .app bundle root, which is what fsx.swap needs to
  // atomically replace during OTA. Two levels lands inside Contents/ and
  // produces a nested-bundle frankenswap.
  if (isMac) return path.join(app.getAppPath(), '..', '..', '..')
  if (isLinux && process.env.APPIMAGE) return process.env.APPIMAGE
  // Windows OTA goes through msix-manager.addPackage(nextApp), which doesn't
  // need a path to the currently-installed package — the swap is null here.
  return null
}

function getRuntimeName() {
  if (isMac) return appName + '.app'
  if (isWindows) return appName + '.msix'
  if (isLinux) return appName + '.AppImage'
  return appName
}

function getDataDir() {
  if (customStorage) return customStorage
  return app.getPath('userData')
}

let configStore = null
// Lazily opened on first read/write — by then app paths are resolved. load
// folds single-setting files written by older releases into config.json and
// removes them (see config-store.js).
function config() {
  if (!configStore) {
    configStore = new ConfigStore(getDataDir()).load()
  }
  return configStore
}

initSettings({ config })
initMenus({ revealWindow, targetWindow, zoomByDirection, appName, isDev })
initWindow({
  config,
  refreshAppMenu,
  applyAppMenuVisibility,
  sendKeyboardCommand,
  getPear,
  updatesEnabled,
  startHiddenFlag,
})

// === pear-runtime + OTA updater ===

function getPear() {
  if (pear) return pear
  const dir = getDataDir()
  fs.mkdirSync(dir, { recursive: true })

  // Dev / source path: no UPGRADE_KEY is baked into package.json, so the OTA
  // updater can't be constructed (PearRuntimeUpdater throws on missing
  // upgrade). Return a minimal shim that supports worker spawning + storage
  // path lookup. `updater` is null so the few code paths that touch it stay
  // guarded by `if (updatesEnabled)` or `if (!p.updater)`.
  if (!upgrade) {
    pear = {
      storage: path.join(dir, 'app-storage'),
      updater: null,
      run: (entrypoint, args = [], opts = {}) => PearRuntime.run(entrypoint, args, opts),
    }
    return pear
  }

  const store = new Corestore(path.join(dir, 'pear-runtime', 'corestore'))
  const swarm = new Hyperswarm()
  pear = new PearRuntime({
    dir,
    app: getAppPath(),
    // pear-runtime-updater derives `bundled` from `!!opts.app` unless overridden.
    // On Windows getAppPath is null (msix-manager doesn't need it), which
    // would leave the updater dormant — no initial check, no append listener,
    // no banner. Pass `bundled: app.isPackaged` explicitly on Windows so the
    // updater runs whenever the user is on the installed MSIX.
    bundled: isWindows ? app.isPackaged : undefined,
    updates: updatesEnabled,
    version,
    upgrade,
    name: getRuntimeName(),
    store,
    swarm,
  })
  // Electron's asar-fs wrapper intercepts any path matching /\.asar/i and
  // tries to mount it as an archive. The OTA mirror writes the staged
  // app.asar at .../next/<id>/by-arch/darwin-arm64/app/Mirall.app/Contents/
  // Resources/app.asar — Electron sees the .asar in the destination, can't
  // open the not-yet-written file as an archive, and throws "Invalid package
  // <path>". Setting process.noAsar = true tells splitPath to short-circuit
  // and treat the path as a regular file. We can't enable it globally — our
  // own requires into the running app.asar go through the same wrapper —
  // so we scope it to the updater's _update and applyUpdate calls.
  const wrapWithNoAsar = (fn) => async (...args) => {
    const prev = process.noAsar
    process.noAsar = true
    try { return await fn(...args) } finally { process.noAsar = prev }
  }
  const u = pear.updater
  u._update = wrapWithNoAsar(u._update.bind(u))
  u._debouncedUpdate = debounceify(u._update)
  // fsx.swap (renameat2 RENAME_EXCHANGE) swaps directory entries, so the
  // user-visible AppImage ends up pointing at the staged inode and inherits
  // its mode. localdrive only writes 0o755 when the source Hyperdrive entry
  // has executable=true; if that flag is missing we'd leave the user with a
  // non-executable AppImage after every OTA. chmod the staged file before
  // the swap to guarantee the post-swap mode regardless of seed metadata.
  const applyWithNoAsar = wrapWithNoAsar(u.applyUpdate.bind(u))
  u.applyUpdate = async () => {
    if (isLinux && u.updated && !u.applied && u.next) {
      const nextApp = path.join(u.next, 'by-arch', `linux-${process.arch}`, 'app', u.name)
      try { await fs.promises.chmod(nextApp, 0o755) } catch (err) {
        console.error('chmod staged AppImage failed:', err.message)
      }
    }
    try {
      const result = await applyWithNoAsar()
      applyErrors.clearApplyError(getDataDir())
      return result
    } catch (err) {
      applyErrors.recordApplyError(getDataDir(), err, { version, platform: process.platform })
      throw err
    }
  }
  if (updatesEnabled) {
    swarm.on('connection', (connection) => store.replicate(connection))
    swarm.join(u.drive.core.discoveryKey, { client: true, server: false })
    u.on('error', (err) => console.error('pear updater error:', err))
  }
  // Windows: msix-manager.addPackage takes seconds and runs invisibly during
  // before-quit, racing the user's relaunch and silently failing if the .msix
  // is locked by the still-running process. Pre-stage the swap while the user
  // is active so quit→relaunch is a plain restart with the new bits already
  // registered. Linux benefits too — fsx.swap is fast but apply-on-quit means
  // the staged AppImage sits unused until the user happens to quit cleanly.
  // macOS keeps the at-quit path: fsx.swap mid-session would let any later
  // disk re-read see new-version files mixed with old in-memory code.
  if (updatesEnabled && (isWindows || isLinux)) {
    u.on('updated', () => {
      u.applyUpdate().catch((err) => console.error('background apply failed:', err))
    })
  }
  pear.on('error', (err) => console.error('pear error:', err))
  return pear
}

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
// Reported once per worker: every frame after a pipe goes bad fails the same way, and the repeats
// would evict the crash that explains them from the log ring; a respawned worker reports again.
// Silent during a quit, where a half-written pipe is expected.
const writeFailureReported = new WeakSet()

function sendToWorker(worker, frame) {
  try {
    worker.write(Buffer.from(JSON.stringify(frame) + '\n'))
    return true
  } catch (err) {
    if (isQuitting()) {
      if (isDebug()) console.error('worker frame write failed during quit:', frame.type, '-', err.message)
    } else if (!writeFailureReported.has(worker)) {
      writeFailureReported.add(worker)
      console.warn('worker frame write failed:', frame.type, '-', err.message, '- further failures for this worker are not logged')
    }
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
})

// === Download folder + bandwidth settings ===

// Asks every live worker to exit. Called once, from the quit sequence.
//
// 1. The shutdown frame lets the worker close the swarm and Bare.exit on its own.
// 2. Escalation covers a worker that cannot. The bare-sidecar Duplex has no kill(): destroy()
//    sends SIGTERM via the sidecar; a worker whose loop is starved cannot process the shutdown
//    frame OR a SIGTERM bare dispatches on that loop, so follow up with SIGKILL on the child.
//    Timers are unref'd so they never delay a clean exit; process.on('exit') is the backstop
//    when main exits before these fire.
function stopWorkers() {
  for (const worker of workers.values()) {
    sendToWorker(worker, { type: 'shutdown' })
    const child = worker._process
    setTimeout(() => { try { worker.destroy() } catch {} ; try { child?.kill('SIGTERM') } catch {} }, 3000).unref?.()
    setTimeout(() => { try { child?.kill('SIGKILL') } catch {} }, 5000).unref?.()
  }
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

  // Every MIRALL_* test hook the app reads, in one list: MIRALL_DEBUG and MIRALL_VERBOSE (log
  // level), MIRALL_DHT_BOOTSTRAP (a hermetic testnet instead of the public DHT),
  // MIRALL_DOWNLOAD_FOLDER and MIRALL_WINDOW_BOUNDS (start from a known state),
  // MIRALL_FEATURE_FLAGS (flags without a build), MIRALL_FORCE_A11Y (the AX tree the frontend suite
  // drives), MIRALL_NO_DEVTOOLS, and the three caps below — MIRALL_LIST_FILES_CAP,
  // MIRALL_MAX_FILES_PER_SHARE and MIRALL_FOREIGN_FULL_WALK_EVERY. None is read in a shipped run.
  //
  // The worker's whole starting state: it is sent once, before any request, and the worker never
  // asks main for these again. Three sources are mixed here on purpose — the packaged app (storage,
  // version, upgrade key), the user's stored preferences, and the MIRALL_* test overrides, each of
  // which is undefined unless its variable is set so JSON drops it and the worker's own default
  // stands. shared/core/runtime-config.js is what reads the result, and is the authority on what
  // each field means once it lands.
  const bootstrap = {
    type: 'bootstrap',
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
    identityKEK: identityKEKHex,
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
      // Worker may have closed its socket before the renderer's last message arrived. During a quit
      // that is the expected FIN race and the message is moot; outside one it is a request the
      // renderer is still waiting on, and nothing else reports that it never left. Once per worker,
      // for the same reason as sendToWorker.
      if (isQuitting()) {
        if (isDebug()) console.error('worker write failed during quit:', err.message)
      } else if (!relayFailureReported) {
        relayFailureReported = true
        console.warn('worker write failed:', err.message, '- further failures for this worker are not logged')
      }
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
        mainRequests.handle(msg.command, msg.args || {}, worker).catch((err) => {
          if (isDebug()) console.error('main-request failed:', msg.command, err.message)
        })
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

// === Renderer IPC handlers + quit hooks ===

ipcMain.on('pkg', (evt) => { evt.returnValue = pkg })
ipcMain.on('app:isDev', (evt) => { evt.returnValue = isDev })

registerMenus()
ipcMain.on('app:getLocale', (evt) => { evt.returnValue = app.getLocale() })

// Renderer config lives in the same unified config.json (main is the only
// writer). The snapshot is read synchronously at renderer boot so theme/locale
// are known before first paint; writes are async patches.
ipcMain.on('config:get', (evt) => { evt.returnValue = config().rendererSnapshot() })
// Returns the post-write snapshot: main sanitizes on write (relay dedupe, cap, label
// length), so the renderer must adopt what was stored rather than its optimistic copy.
ipcMain.handle('config:set', (_evt, patch) => { config().setRenderer(patch); return config().rendererSnapshot() })

registerRelaySlot({ config, getPear })
registerNetOnline()

ipcMain.handle('pear:appVersion', async () => {
  const p = getPear()
  if (!p?.updater?.drive) return { length: 0, fork: 0, semver: null }
  const length = p.updater.drive.core.length
  const fork = p.updater.drive.core.fork
  let semver = null
  try {
    if (length > 0) {
      const co = p.updater.drive.checkout(length)
      const manifest = await co.get('/package.json')
      await co.close()
      if (manifest) semver = JSON.parse(manifest.toString()).version ?? null
    }
  } catch {}
  return { length, fork, semver }
})

ipcMain.handle('app:identityProtection', () => identityProtection)

ipcMain.handle('diagnostics:logs', async (_evt, opts) => {
  const redactLine = opts?.redact !== false ? await loadRedactLine() : null
  // Fail closed: if the redaction module could not load, ship no logs rather than raw ones.
  if (opts?.redact !== false && !redactLine) return []
  return logRing.snapshot(redactLine)
})

// null on the installs where no apply has ever failed — which is nearly all of them — so the
// bundle can leave the key out entirely rather than carry a permanent empty slot.
ipcMain.handle('diagnostics:lastApplyError', async (_evt, opts) => {
  const redactLine = opts?.redact !== false ? await loadRedactLine() : null
  if (opts?.redact !== false && !redactLine) return null
  return applyErrors.readLiveApplyError(getDataDir(), { version, redactLine })
})

// Live verbose-logging toggle for main. Flips `debug` (so main's if(debug) logs
// fire even on a production build) and the `verbose` worker-spawn seed (so a
// respawned worker inherits it). The renderer flips the already-running worker
// separately over the worker IPC channel. A non-boolean arg leaves state
// untouched and just reports it; turning off reverts to the build default.
ipcMain.handle('app:setVerbose', (_evt, on) => setVerbose(on))

ipcMain.handle('app:getChangelog', async () => {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'CHANGELOG.md')
    : path.join(__dirname, '..', '..', 'CHANGELOG.md')
  try {
    return await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    if (isDebug()) console.error('app:getChangelog read failed:', err.message)
    return ''
  }
})

ipcMain.handle('pear:checkForUpdate', async () => {
  const p = getPear()
  if (!p.updater) return { triggered: false, reason: 'updater disabled' }
  try {
    await p.updater._debouncedUpdate()
    return {
      triggered: true,
      length: p.updater.drive.core.length,
      fork: p.updater.drive.core.fork
    }
  } catch (err) {
    return { triggered: false, error: err.message }
  }
})

ipcMain.handle('pear:startWorker', (_evt, specifier) => {
  getWorker(specifier)
  return true
})

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

registerWindow()

registerSettingsIpc({ createTray, destroyTray, applyAppMenuVisibility, targetWindow })

// The one quit teardown. Electron re-emits before-quit to every listener on every
// app.quit(), so the update-apply step's deferral (preventDefault → apply → quit
// again) would run every sibling twice if they were separate listeners; the
// sequence runs once per process and the re-issued quit passes straight through.
// Step order and the continue-on-error rule live in lifecycle.js.
app.on('before-quit', createQuitSequence({
  // Read by the window close handler, which hides to tray unless the app is
  // quitting. Tray-menu Quit sets it directly before calling app.quit.
  markQuitting,
  stopOwnedWatchers: () => ownedFolderWatchers.stopAllWatchers(),
  stopLooseWatchers: () => looseFileWatchers.stopLooseWatchers(),
  flushConfig: () => configStore?.flush(),
  stopWorkers,
  // Promote any staged OTA bundle on the user's next clean quit. Returning the
  // promise defers the quit, because Electron does not await async listeners and
  // the swap must finish before the process exits — macOS/Linux: fsx.swap (fast);
  // Windows: MSIXManager.addPackage (seconds).
  applyUpdate: () => {
    if (!updatesEnabled) return null
    if (!pear?.updater?.updated || pear.updater.applied) return null
    return pear.updater.applyUpdate()
  },
  quit: () => app.quit(),
  onStepError: (step, err) => console.error('quit teardown step failed:', step, err),
}))

// === Theme, app menu, window creation ===

// === app:// asset serving, deep links, app lifecycle ===

app.setAsDefaultProtocolClient(protocol)

const { preloadAsarCache, registerAppProtocol } = require('./app-protocol.js')
const { registerRelaySlot } = require('./relay-slot.js')
const { registerNetOnline, startNetOnlineWatch } = require('./net-online.js')
const { parseDeepLink } = require('./deeplink')

const pendingDeepLinks = []
let deeplinkChannelOpen = false

async function dispatchDeepLink(rawUrl) {
  const link = await parseDeepLink(rawUrl)
  if (!link) {
    console.warn('ignored unrecognized deep link:', rawUrl)
    return
  }
  if (deeplinkChannelOpen) sendToAll('deeplink', link)
  else pendingDeepLinks.push(link)
  revealWindow().catch((err) => console.error('revealWindow on deeplink failed:', err))
}

ipcMain.handle('deeplink:flush', () => {
  deeplinkChannelOpen = true
  return pendingDeepLinks.splice(0)
})

app.on('open-url', (evt, url) => {
  evt.preventDefault()
  dispatchDeepLink(url).catch((err) => console.error('dispatchDeepLink failed:', err))
})

const lock = app.requestSingleInstanceLock()

if (!lock) {
  app.quit()
} else {
  app.on('second-instance', (_evt, args) => {
    const [url] = extractDeepLinks(args, protocol)
    if (url) dispatchDeepLink(url).catch((err) => console.error('dispatchDeepLink failed:', err))
    else revealWindow().catch((err) => console.error('revealWindow failed:', err))
  })

  // Cold start on Win/Linux: the URL arrived in our own argv, already peeled off
  // by parseBootArgv at module top.
  for (const url of boot.deepLinks) {
    dispatchDeepLink(url).catch((err) => console.error('dispatchDeepLink failed:', err))
  }

  app.whenReady().then(async () => {
    initPrefs({ config })
    try {
      integrateXdgLinux({ appName, protocol, isLinux, homedir: os.homedir() })
    } catch (err) {
      console.error('[xdg] integration failed:', err.message)
    }
    // Before getPear, which opens the noAsar window: see wrapWithNoAsar.
    preloadAsarCache()
    registerAppProtocol()
    startNetOnlineWatch()
    require('./notifications').register({
      revealWindow,
      downloadRoots: () => [readDownloadFolder(), ...workerDownloadRoots],
    })

    // Harden identity at rest before the worker can spawn (pear:startWorker only
    // fires after the window loads): restrict the storage dir to the current user
    // and resolve the KEK that unwraps identity.enc (see identity-kek.js). Fail
    // closed if secure storage is unavailable rather than write an unprotected key.
    const storagePath = getPear().storage
    try {
      fs.mkdirSync(storagePath, { recursive: true })
      if (!isWindows) fs.chmodSync(storagePath, 0o700)
    } catch (err) {
      // Survivable, unlike the KEK failure below, and the difference is what each one protects. The
      // mode is defence in depth over a file that is already encrypted; the KEK is the secret that
      // encrypts it, so starting without one would write an unprotected identity.
      console.error('[identity] storage perms failed:', err.message)
    }
    try {
      const identityKek = require('./identity-kek.js')
      identityKEKHex = identityKek.resolveKEKHex(storagePath)
      // 'weak' means safeStorage fell back to basic_text: the key is still encrypted, but with no
      // OS keyring behind it, so anyone with the file can read it and the user's protection is
      // whatever full-disk encryption they have. 'protected' means a real keyring holds the KEK.
      // An unavailable safeStorage is neither — it is fatal, below.
      identityProtection = identityKek.storageBackend() === 'basic_text' ? 'weak' : 'protected'
      if (identityProtection === 'weak') {
        console.warn('[identity] safeStorage backend is basic_text (no OS keyring); identity.enc is only weakly protected — rely on full-disk encryption')
      }
    } catch (err) {
      dialog.showErrorBox('Mirall cannot start', 'Secure storage is unavailable, so your identity key cannot be protected. ' + err.message)
      app.quit()
      return
    }

    await createWindow()
    if (getPrefs().minimizeToTray) createTray()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch((err) => console.error('createWindow failed:', err))
      } else {
        revealWindow().catch((err) => console.error('revealWindow failed:', err))
      }
    })
  })

  app.on('window-all-closed', () => {
    if (getPrefs().minimizeToTray) return
    if (!isMac) app.quit()
  })
}
