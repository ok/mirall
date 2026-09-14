// The embedded pear-runtime and the OTA updater it carries.
//
// The runtime is constructed lazily: building it opens drives and joins a swarm, which a run that
// never spawns a worker has no reason to pay for. applyUpdate is wrapped rather than called
// directly — the update lands inside an asar window that has to be opened and closed around it,
// and the applied build needs its executable bit back on the platforms that lose it.

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

const pkg = require('../../package.json')
const appName = pkg.productName || pkg.name
const version = pkg.version
const upgrade = pkg.upgrade

let pear = null

// Bound by the entry: the data directory is resolved after userData is redirected, and the
// update-enabled flag comes from argv.
let getDataDir = null
let updatesEnabled = false

function initUpdater(d) {
  getDataDir = d.getDataDir
  updatesEnabled = d.updatesEnabled
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

// The quit sequence's apply step. Reads the runtime binding directly rather than through getPear:
// a run that never built one has no update to apply, and constructing it here — mid-teardown, to
// open drives and join a swarm — is the opposite of what quitting means.
function applyPendingUpdate() {
  if (!updatesEnabled) return null
  if (!pear?.updater?.updated || pear.updater.applied) return null
  return pear.updater.applyUpdate()
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
}

module.exports = { initUpdater, registerUpdater, getPear, getAppPath, applyPendingUpdate }
