// The embedded pear-runtime and the OTA updater it carries.
//
// The runtime is constructed lazily: building it opens drives and joins a swarm, which a run that
// never spawns a worker has no reason to pay for. applyUpdate is wrapped rather than called
// directly — the update lands inside an asar window that has to be opened and closed around it,
// and the applied build needs its executable bit back on the platforms that lose it.
//
// The user's update mode decides how far a pass goes (update-policy.js): every pass is gated, every
// apply is checked, and the update swarm is joined only while the mode or a pass the user asked for
// needs it.

const path = require('path')
const fs = require('fs')
const { app, ipcMain } = require('electron')
const PearRuntime = require('pear-runtime')
const Hyperswarm = require('hyperswarm')
const Corestore = require('corestore')
const debounceify = require('debounceify')
const { isMac, isWindows, isLinux } = require('which-runtime')
const { isDebug } = require('./debug-gate.js')
const { loadRedactLine } = require('./logging.js')
const applyErrors = require('./apply-error.js')
const updateCache = require('./update-cache.js')
const { trackUpdateDownload } = require('./update-progress.js')
const { initialUpdateStatus, createUpdateStatus } = require('./update-status.js')
const { createUpdatePolicy } = require('./update-policy.js')
const { UPDATE_MODE, UPDATE_MODES, UPDATE_STATE } = require('../shared/contract/update-status.js')

const pkg = require('../../package.json')
const appName = pkg.productName || pkg.name
const version = pkg.version
const upgrade = pkg.upgrade

let pear = null
// The swarm that follows the update drive: the runtime's own, used for nothing else.
let updateSwarm = null
let joined = false
// Passes the user asked for that need the update network while the mode keeps it closed.
let userPasses = 0
// The version a non-automatic pass let through to download, until the updater names what it staged.
let passTarget = null
let passManual = false
// Update passes and prunes take turns: a prune never runs while a pass mirrors or prefetches.
let cacheTurn = Promise.resolve()
let passRunning = false
let manualCheck = false
// The download of the pass in flight, from its first block to the end of the pass.
let download = null
// How long a check the user asked for waits for a peer of the update drive before it runs anyway.
const PEER_WAIT_MS = 15_000

function withCacheTurn(fn) {
  const run = cacheTurn.catch(() => {}).then(fn)
  cacheTurn = run
  return run
}

function pruneInTurn(updater) {
  return withCacheTurn(() => updateCache.pruneUpdateCache({ updater, prefix: appPrefix(), log: console }))
}

// Bound by the entry: the data directory is resolved after userData is redirected, and the
// update-enabled flag comes from argv and the install kind. The reason names what turned updates
// off so a manual check can say so instead of triggering a lookup nothing will apply.
let getDataDir = null
let updatesEnabled = false
let updatesOffReason = null
let updateStatus = createUpdateStatus(initialUpdateStatus({ offReason: null, canRestart: false }))
// The mode lives in config.json; the policy reads it through the entry's accessor on every decision,
// and the status learns it when the runtime is built.
let setUpdateMode = null
let policy = createUpdatePolicy({ running: version, getMode: () => UPDATE_MODE.AUTOMATIC })

function initUpdater(d) {
  getDataDir = d.getDataDir
  updatesEnabled = d.updatesEnabled
  updatesOffReason = d.updatesOffReason ?? null
  setUpdateMode = d.setUpdateMode
  policy = createUpdatePolicy({ running: version, getMode: d.getUpdateMode })
  updateStatus = createUpdateStatus(initialUpdateStatus({ offReason: updatesOffReason, canRestart: canRelaunchIntoUpdate() }))
}

// What the windows show beside the state: the mode, and whether the update in flight or staged
// waits for the user. An update already applied in place (Windows, Linux) cannot wait any more.
function dispatchPolicy() {
  const u = pear?.updater
  const held = !u?.applied && !policy.mayInstall(u?.nextVersion ?? passTarget)
  updateStatus.dispatch({ type: 'policy', mode: policy.mode(), held })
}

// A pass already running keeps the network until it ends: a download cut off mid-way would stall
// rather than finish and wait.
function syncUpdateNetwork() {
  if (!updateSwarm || !pear?.updater) return
  const wanted = policy.mode() !== UPDATE_MODE.NEVER || userPasses > 0 || passRunning
  if (wanted === joined) return
  joined = wanted
  const topic = pear.updater.drive.core.discoveryKey
  if (wanted) {
    updateSwarm.join(topic, { client: true, server: false })
    return
  }
  updateSwarm.leave(topic).catch((err) => console.error('update swarm leave failed:', err))
  for (const connection of updateSwarm.connections) connection.destroy()
}

// The hook the updater awaits before each pass; true stops the pass before it downloads anything.
async function gatePass() {
  const decision = await policy.gate(pear.updater.drive, { manual: passManual })
  if (decision === null) {
    passTarget = null
    updateStatus.dispatch({ type: 'pass-start' })
    return false
  }
  if (decision.available === undefined) return true
  updateStatus.dispatch({ type: 'pass-start' })
  if (decision.skip) {
    updateStatus.dispatch({ type: 'available', version: decision.available })
    return true
  }
  passTarget = decision.available
  return false
}

// Windows and Linux put a staged update in place as soon as it may install: see the note at the
// 'updated' listener.
function prestage(u) {
  if (!(isWindows || isLinux) || !policy.mayInstall(u.nextVersion)) return
  u.applyUpdate().catch((err) => console.error('background apply failed:', err))
}

// macOS swaps the bundle at quit and an AppImage is swapped in place, so a relaunch starts the new
// build from the same path. An MSIX relaunched from its old package folder can start the version it
// is replacing.
function canRelaunchIntoUpdate() {
  return app.isPackaged && (isMac || (isLinux && !!process.env.APPIMAGE))
}

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

// Where this platform's build sits in the update drive, as the updater mirrors it.
function appPrefix() {
  return `/by-arch/${process.platform}-${process.arch}/app/${getRuntimeName()}`
}

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
    skipUpdate: gatePass,
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
  const pass = wrapWithNoAsar(u._update.bind(u))
  // Every pass is followed by a prune, whether the pass succeeded or not: the prune keeps the latest
  // version only when it is whole on this device. A failed prune never fails the pass.
  u._update = async () => {
    passRunning = true
    const manual = manualCheck
    manualCheck = false
    passManual = manual
    try {
      await withCacheTurn(pass)
      updateStatus.dispatch({ type: 'pass-end', reached: u.drive.core.peers.length > 0, manual })
    } catch (err) {
      updateStatus.dispatch({ type: 'pass-failed' })
      throw err
    } finally {
      passRunning = false
      syncUpdateNetwork()
      download?.stop()
      download = null
      await pruneInTurn(u).catch((err) => console.error('update cache prune failed:', err))
    }
  }
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
    updateSwarm = swarm
    swarm.on('connection', (connection) => store.replicate(connection))
    dispatchPolicy()
    syncUpdateNetwork()
    u.on('error', (err) => console.error('pear updater error:', err))
    u.on('updating', () => {
      download?.stop()
      download = trackUpdateDownload(u.checkout, appPrefix())
      updateStatus.dispatch({ type: 'downloading' })
    })
    // The updater's monitor sets the pace and counts the peers; the fraction is the app's own.
    u.on('updating-progress', (stats) => {
      if (download) updateStatus.dispatch({ type: 'progress', fraction: download.fraction(), peers: stats.peers })
    })
    u.on('updated', () => {
      dispatchPolicy()
      updateStatus.dispatch({ type: 'ready', version: u.nextVersion })
    })
    // The boot pass usually runs before any peer is connected, so the first peer gets a pass of its
    // own: that is the check that tells whether this build is current.
    if (u.bundled) {
      u.drive.core.once('peer-add', () => {
        u._debouncedUpdate().catch((err) => console.error('update pass failed:', err))
      })
    }
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
    u.on('updated', () => prestage(u))
  }
  pear.on('error', (err) => console.error('pear error:', err))
  return pear
}

// The quit sequence's apply step. Reads the runtime binding directly rather than through getPear:
// a run that never built one has no update to apply, and constructing it here — mid-teardown, to
// open drives and join a swarm — is the opposite of what quitting means.
function applyPendingUpdate() {
  if (!updatesEnabled) return null
  if (!pear?.updater?.updated || pear.updater.applied) return null
  if (!policy.mayInstall(pear.updater.nextVersion)) return null
  return pear.updater.applyUpdate()
}

function waitForPeer(core, ms) {
  if (core.peers.length > 0) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      core.off('peer-add', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    core.on('peer-add', done)
  })
}

// A pass the user asked for: a check, or the download of a version they approved. It opens the
// update network for its own duration when the mode keeps it closed.
async function runUserPass(updater) {
  manualCheck = true
  userPasses++
  syncUpdateNetwork()
  try {
    await waitForPeer(updater.drive.core, PEER_WAIT_MS)
    await updater._debouncedUpdate()
  } finally {
    userPasses--
    syncUpdateNetwork()
  }
}

async function runManualCheck(updater) {
  updateStatus.dispatch({ type: 'pass-start' })
  await runUserPass(updater)
}

// The user's go-ahead for the version they were shown. One already staged is ready at once; any
// other downloads now.
function installAvailable(updater) {
  const { state, nextVersion } = updateStatus.get()
  if (state !== UPDATE_STATE.AVAILABLE || !nextVersion) return false
  policy.approve(nextVersion)
  if (updater.updated && !updater.applied && updater.nextVersion === nextVersion) {
    dispatchPolicy()
    updateStatus.dispatch({ type: 'ready', version: nextVersion })
    prestage(updater)
    return true
  }
  passTarget = nextVersion
  dispatchPolicy()
  updateStatus.dispatch({ type: 'downloading' })
  runUserPass(updater).catch((err) => console.error('update install failed:', err))
  return true
}

// A mode change takes effect at once: a staged update it no longer lets install waits, one it now
// lets install is ready, and a version that waited downloads.
function changeUpdateMode(mode) {
  setUpdateMode(mode)
  const u = pear?.updater
  dispatchPolicy()
  if (!updatesEnabled || !u) return
  syncUpdateNetwork()
  if (mode !== UPDATE_MODE.AUTOMATIC) return
  if (u.updated && !u.applied) {
    updateStatus.dispatch({ type: 'ready', version: u.nextVersion })
    prestage(u)
  } else if (updateStatus.get().state === UPDATE_STATE.AVAILABLE) {
    u._debouncedUpdate().catch((err) => console.error('update pass failed:', err))
  }
}

function onUpdateStatus(listener) {
  return updateStatus.subscribe(listener)
}

function registerUpdater() {
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

  ipcMain.handle('diagnostics:lastApplyError', async (_evt, opts) => {
    const redactLine = opts?.redact !== false ? await loadRedactLine() : null
    if (opts?.redact !== false && !redactLine) return null
    return applyErrors.readLiveApplyError(getDataDir(), { version, redactLine })
  })

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

  ipcMain.handle('updater:cache-info', async () => {
    const p = getPear()
    return updateCache.updateCacheInfo({ updater: p.updater, dataDir: getDataDir(), prefix: appPrefix() })
  })

  // Never starts a pass, and never waits on one: a pass in flight (a download can take minutes) ends
  // in its own prune.
  ipcMain.handle('updater:prune', async () => {
    const p = getPear()
    if (!p.updater || passRunning) return { clearedBlocks: 0 }
    return pruneInTurn(p.updater)
  })

  ipcMain.handle('pear:updateStatus', () => updateStatus.get())

  // Returns once the check has started; how it ends arrives on the status stream.
  ipcMain.handle('pear:checkForUpdate', () => {
    if (!updatesEnabled) return { triggered: false, reason: updatesOffReason ?? 'updates disabled' }
    const p = getPear()
    if (!p.updater) return { triggered: false, reason: 'updater disabled' }
    runManualCheck(p.updater).catch((err) => console.error('update check failed:', err))
    return { triggered: true }
  })

  ipcMain.handle('pear:installUpdate', () => {
    if (!updatesEnabled) return { triggered: false, reason: updatesOffReason ?? 'updates disabled' }
    const p = getPear()
    if (!p.updater) return { triggered: false, reason: 'updater disabled' }
    return installAvailable(p.updater) ? { triggered: true } : { triggered: false, reason: 'no update waiting' }
  })

  ipcMain.handle('pear:setUpdateMode', (_evt, mode) => {
    if (!UPDATE_MODES.includes(mode)) throw new Error(`unknown update mode: ${mode}`)
    changeUpdateMode(mode)
    return updateStatus.get()
  })

  // The quit sequence applies a staged macOS update before the process exits, so the relaunched
  // process starts the new bundle.
  ipcMain.handle('app:relaunch', () => {
    if (!updateStatus.get().canRestart) return false
    app.relaunch(isLinux ? { execPath: process.env.APPIMAGE, args: process.argv.slice(1) } : undefined)
    app.quit()
    return true
  })
}

module.exports = { initUpdater, registerUpdater, getPear, getAppPath, applyPendingUpdate, onUpdateStatus }
