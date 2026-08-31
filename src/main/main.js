// Electron main process — the host. Owns the BrowserWindow, tray, native
// notifications, and deep links; embeds pear-runtime as a library for OTA
// updates; spawns the Bare worker (all P2P and data logic) and relays NDJSON
// IPC frames renderer↔worker in both directions; runs the chokidar folder
// watchers on the worker's behalf (Bare has no recursive watch). Main holds no
// application state — durable state lives in the worker's store.
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, nativeTheme, net, protocol: electronProtocol, shell, webContents } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { logRing } = require('./log-ring')

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
const { buildAppMenuTemplate } = require('./menu.js')
const { matchWindowShortcut } = require('./window-shortcuts.js')
const { ConfigStore } = require('./config-store.js')
const { primeFeatureFlags, readFeatureFlags } = require('./feature-flags.js')

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

// When --storage is set, redirect Electron's userData path too so that
// window-bounds.json, the corestore, and the applied-version marker all
// live in the same custom dir. This makes multi-instance dev (run two
// Mirall.apps on the same machine pointing at separate stores) actually
// work — without this, both instances share userData and clobber state.
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
// `verbose` seeds the worker bootstrap; `debug` is the live gate behind main's
// own if(debug) log guards. Both are mutable so the renderer dev console
// (window.mirall.verbose) can flip them at runtime — see app:setVerbose.
// baseDebug remembers the build default so turning verbose back off restores it.
const baseDebug = process.env.MIRALL_DEBUG === '1' || isDev
let verbose = process.env.MIRALL_VERBOSE === '1'
let debug = baseDebug

let pear = null
let identityKEKHex = null
let identityProtection = 'disabled'
const workers = new Map()

const { isControlFrameCandidate } = require('./ipc-frame.js')

let tray = null
let isQuitting = false
let firstHideNoticeShown = false
const trayLabels = { show: 'Show Mirall', settings: 'Settings…', quit: 'Quit Mirall', tooltip: 'Mirall' }

const PREFS_DEFAULTS = {
  minimizeToTray: true,
  openAtLogin: false,
  firstHideNoticeShown: false,
  appMenuAutoHide: false,
}

let prefs = { ...PREFS_DEFAULTS }

let menuCtx = { inSpace: false, spaces: [] }

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason && (reason.stack || reason.message || reason))
})

function integrateXdgLinux() {
  if (!isLinux || !process.env.APPIMAGE || !process.env.APPDIR) return
  const appdir = process.env.APPDIR
  const appimage = process.env.APPIMAGE
  const home = os.homedir()

  const srcDesktop = path.join(appdir, `${appName}.desktop`)
  if (!fs.existsSync(srcDesktop)) return

  // Rewrite Exec= to the absolute AppImage path so the launcher entry self-heals
  // if the user moves the AppImage. %U lets the DE pass mirall:// URLs to us.
  // Also ensure x-scheme-handler/mirall is declared so xdg-mime can pick this
  // .desktop as the default handler for the protocol.
  const mimeToken = 'x-scheme-handler/' + protocol
  let desktop = fs.readFileSync(srcDesktop, 'utf8')
    .replace(/^Exec=.*$/m, `Exec="${appimage}" %U`)
  if (/^MimeType=/m.test(desktop)) {
    desktop = desktop.replace(/^MimeType=(.*)$/m, (_m, list) => {
      const items = list.split(';').filter(Boolean)
      if (!items.includes(mimeToken)) items.push(mimeToken)
      return 'MimeType=' + items.join(';') + ';'
    })
  } else {
    desktop = desktop.replace(/(\n?)$/, `\nMimeType=${mimeToken};\n`)
  }

  const appsDir = path.join(home, '.local', 'share', 'applications')
  fs.mkdirSync(appsDir, { recursive: true })
  writeIfChanged(path.join(appsDir, `${appName}.desktop`), desktop)

  const iconsRoot = path.join(home, '.local', 'share', 'icons', 'hicolor')
  for (const size of [16, 32, 48, 64, 128, 256]) {
    const src = path.join(appdir, 'usr', 'share', 'icons', 'hicolor',
      `${size}x${size}`, 'apps', `${appName}.png`)
    if (!fs.existsSync(src)) continue
    const destDir = path.join(iconsRoot, `${size}x${size}`, 'apps')
    fs.mkdirSync(destDir, { recursive: true })
    copyFileIfChanged(src, path.join(destDir, `${appName}.png`))
  }

  // Detached + unref so we don't block startup or care about the result. If the
  // tool is missing, the DE picks up the new entry on its next scan anyway.
  try {
    require('child_process')
      .spawn('update-desktop-database', [appsDir], { detached: true, stdio: 'ignore' })
      .unref()
  } catch {}
  try {
    require('child_process')
      .spawn('xdg-mime', ['default', `${appName}.desktop`, mimeToken], { detached: true, stdio: 'ignore' })
      .unref()
  } catch {}
}

function writeIfChanged(dest, contents) {
  try { if (fs.readFileSync(dest, 'utf8') === contents) return } catch {}
  fs.writeFileSync(dest, contents)
}

function copyFileIfChanged(src, dest) {
  try {
    const s = fs.statSync(src), d = fs.statSync(dest)
    if (s.size === d.size && s.mtimeMs <= d.mtimeMs) return
  } catch {}
  fs.copyFileSync(src, dest)
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
    configStore = new ConfigStore(getDataDir(), {
      readFeatures: () => ({ relay: readFeatureFlags().relay === true }),
    }).load()
  }
  return configStore
}

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
      on: () => pear,
      removeListener: () => pear,
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
      clearApplyError()
      return result
    } catch (err) {
      recordApplyError(err)
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

// === Renderer broadcast + log forwarding ===

let redactLinePromise = null
function loadRedactLine() {
  if (!redactLinePromise) {
    redactLinePromise = import('../shared/core/diagnostics-redact.js')
      .then((m) => m.redactLine)
      .catch((err) => {
        console.error('[main] redaction module unavailable:', err.message)
        return null
      })
  }
  return redactLinePromise
}

function sendToAll(channel, payload) {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue
    // A render frame can be disposed while its webContents isn't yet destroyed (teardown, a crashed
    // subprocess). wc.send then throws "Render frame was disposed"; swallow it per-target so the
    // failure can't propagate back into the log-forwarding console override below and feed a loop.
    try { wc.send(channel, payload) } catch {}
  }
}

// Mirror main-process console output into the renderer DevTools console while
// debug logging is on, so window.mirall.verbose surfaces BOTH worker and main
// logs in one place — main's own logs otherwise only reach the terminal, which a
// packaged user never sees. The original console still writes to stdout/stderr.
// Two guards prevent a feedback loop with the renderer→main console mirror in
// createWindow: we never forward main's own "[renderer …]" echo lines, and that
// mirror skips our "[main]" lines.
const MAIN_LOG_PREFIX = '[main]'
const RENDERER_ECHO_PREFIX = '[renderer '
function installMainLogForwarding() {
  const { format } = require('util')
  // Re-entrancy guard: forwarding a log calls sendToAll, and a failed send can itself be logged
  // (e.g. Electron's "Error sending from webFrameMain" when a frame is disposed). Without this flag
  // that log re-enters here, forwards again, fails again — an unbounded loop that hangs main.
  let forwarding = false
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console)
    console[level] = (...args) => {
      orig(...args)
      const text = format(...args)
      logRing.push('main', level, text)
      if (!debug || forwarding) return
      if (text.startsWith(RENDERER_ECHO_PREFIX)) return
      forwarding = true
      try { sendToAll('main:log', { level, text }) } catch {} finally { forwarding = false }
    }
  }
}
installMainLogForwarding()

// === Persisted window state: zoom, bounds, theme, prefs ===

const ZOOM_MIN = 0.5
const ZOOM_MAX = 1.5
const ZOOM_STEP = 0.05
const ZOOM_DEFAULT = 1.0
let currentZoom = ZOOM_DEFAULT

function clampZoom(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ZOOM_DEFAULT
  const rounded = Math.round(value * 100) / 100
  if (rounded < ZOOM_MIN) return ZOOM_MIN
  if (rounded > ZOOM_MAX) return ZOOM_MAX
  return rounded
}

function readZoom() {
  return clampZoom(config().get('window.zoom'))
}

function writeZoom(factor) {
  config().set('window.zoom', factor)
}

function applyZoom(win, factor) {
  const next = clampZoom(factor)
  if (next === currentZoom) return next
  currentZoom = next
  if (!win.isDestroyed()) win.webContents.setZoomFactor(next)
  writeZoom(next)
  sendToAll('pear:event:zoom-changed', next)
  return next
}

function readWindowBounds() {
  const b = config().get('window.bounds')
  if (b && typeof b.x === 'number' && typeof b.y === 'number' &&
      typeof b.width === 'number' && typeof b.height === 'number') {
    return b
  }
  return null
}

function writeWindowBounds(bounds) {
  config().set('window.bounds', bounds)
}

// Match :root / .dark CSS vars in src/styles/tailwind.css. The native
// BrowserWindow background is what Electron paints on newly-revealed
// pixels during a fast OS-driven resize before the renderer has a chance
// to repaint, so it must match the rendered body background — otherwise
// you get a flash of the wrong color along the resize edges.
const BG_LIGHT = '#fbf9f5'
const BG_DARK = '#282c34'

function readStoredTheme() {
  const mode = config().get('appearance.theme')
  if (mode === 'light' || mode === 'dark' || mode === 'system') return mode
  return 'system'
}

function writeStoredTheme(mode) {
  config().set('appearance.theme', mode)
}

function resolveBackgroundColor(mode) {
  const effective = mode === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : mode
  return effective === 'dark' ? BG_DARK : BG_LIGHT
}

function readPrefs() {
  return { ...PREFS_DEFAULTS, ...config().get('general') }
}

function writePrefs(next) {
  config().set('general', next)
}

// === Tray, autostart, window reveal ===

async function revealWindow() {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
  if (!win) {
    await createWindow()
    return
  }
  if (isMac) {
    try { await app.dock.show() } catch {}
  }
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

function trayIconPath() {
  if (isMac) return path.join(__dirname, '..', '..', 'resources', 'tray', 'mirallTrayTemplate.png')
  if (isWindows) return path.join(__dirname, '..', '..', 'resources', 'tray', 'tray.ico')
  return path.join(__dirname, '..', '..', 'resources', 'tray', 'tray.png')
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: trayLabels.show, click: () => { revealWindow().catch((err) => console.error('revealWindow failed:', err)) } },
    {
      label: trayLabels.settings,
      accelerator: 'CmdOrCtrl+,',
      registerAccelerator: false,
      click: () => {
        revealWindow()
          .then(() => sendKeyboardCommand('settings.open'))
          .catch((err) => console.error('settings reveal failed:', err))
      },
    },
    { type: 'separator' },
    { label: trayLabels.quit, click: () => { isQuitting = true; app.quit() } },
  ])
}

function createTray() {
  if (tray) return tray
  const img = nativeImage.createFromPath(trayIconPath())
  if (img.isEmpty()) {
    console.error('tray icon not found:', trayIconPath())
    return null
  }
  if (isMac) img.setTemplateImage(true)
  tray = new Tray(img)
  tray.setToolTip(trayLabels.tooltip)
  tray.setContextMenu(buildTrayMenu())
  if (!isMac) tray.on('click', () => { revealWindow().catch((err) => console.error('revealWindow failed:', err)) })
  if (isWindows) tray.on('double-click', () => { revealWindow().catch((err) => console.error('revealWindow failed:', err)) })
  return tray
}

function refreshTrayMenu() {
  if (!tray) return
  tray.setToolTip(trayLabels.tooltip)
  tray.setContextMenu(buildTrayMenu())
}

function destroyTray() {
  if (!tray) return
  tray.destroy()
  tray = null
}

function setOpenAtLogin(enabled) {
  if (isMac) {
    app.setLoginItemSettings({ openAtLogin: enabled })
    return
  }
  if (isWindows) {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: ['--hidden'],
      enabled: true,
      name: pkg.build?.appId || pkg.name,
    })
    return
  }
  if (isLinux) writeLinuxAutostart(enabled)
}

function writeLinuxAutostart(enabled) {
  const dir = path.join(os.homedir(), '.config', 'autostart')
  const file = path.join(dir, `${appName}.desktop`)
  if (!enabled) {
    try { fs.rmSync(file, { force: true }) } catch {}
    return
  }
  const exec = process.env.APPIMAGE || process.execPath
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${appName}`,
    `Exec="${exec}" --hidden`,
    `Icon=${appName}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'Hidden=false',
    `X-AppImage-Version=${version}`,
    '',
  ]
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, lines.join('\n'))
}

function maybeShowFirstHideNotice() {
  if (firstHideNoticeShown || prefs.firstHideNoticeShown) return
  firstHideNoticeShown = true
  prefs = { ...prefs, firstHideNoticeShown: true }
  writePrefs(prefs)
  sendToAll('pear:event:first-hide-notice', { platform: process.platform })
}

function applyErrorPath() {
  return path.join(getDataDir(), 'pear-runtime', 'last-apply-error.json')
}

function recordApplyError(err) {
  try {
    const file = applyErrorPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({
      timestamp: new Date().toISOString(),
      version,
      platform: process.platform,
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
    }, null, 2))
  } catch (writeErr) {
    console.error('record apply error failed:', writeErr)
  }
}

function clearApplyError() {
  try { fs.rmSync(applyErrorPath(), { force: true }) } catch {}
}

// Per-space download roots, pushed by the worker (it owns the space records). Main
// needs them to authorize "reveal in folder" for files outside the home directory.
let workerDownloadRoots = []

function getDefaultDownloadFolder() {
  return app.getPath('downloads')
}

function readDownloadFolder() {
  if (process.env.MIRALL_DOWNLOAD_FOLDER) return process.env.MIRALL_DOWNLOAD_FOLDER
  const folder = config().get('downloads.folder')
  if (typeof folder === 'string' && folder.length > 0) return folder
  return getDefaultDownloadFolder()
}

function readBandwidth() {
  const network = config().get('network')
  return {
    downloadKBps: network?.downloadKBps ?? 0,
    uploadKBps: network?.uploadKBps ?? 0,
  }
}

function writeDownloadFolder(folder) {
  config().set('downloads.folder', folder)
}

function validateDownloadFolder(folder) {
  if (typeof folder !== 'string' || folder.length === 0) {
    throw new Error('Path is empty')
  }
  if (!path.isAbsolute(folder)) {
    throw new Error('Path must be absolute')
  }
  let stat
  try { stat = fs.statSync(folder) } catch {
    throw new Error('Folder does not exist')
  }
  if (!stat.isDirectory()) throw new Error('Path is not a directory')
  const probe = path.join(folder, '.mirall-write-test')
  try {
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
  } catch {
    throw new Error('Folder is not writable')
  }
}

// === Worker spawn + renderer⇄worker IPC relay ===

function getWorker(specifier) {
  if (workers.has(specifier)) return workers.get(specifier)
  const p = getPear()
  // Resolved at boot (preloadAsarCache) so that require.resolve runs while
  // process.noAsar is still false. Resolving lazily here would race with the
  // OTA updater's noAsar window and surface as MODULE_NOT_FOUND.
  let entrypoint = WORKER_ENTRYPOINTS.get(specifier)
  if (!entrypoint) entrypoint = require.resolve(path.join(__dirname, '..', '..', specifier))
  const worker = p.run(entrypoint, [])
  // A write racing the worker's death (the before-quit shutdown frame, a
  // relayed renderer frame, a watcher event) fails with an EPIPE that
  // arrives asynchronously as a stream 'error' event — the try/catch around
  // each worker.write() never sees it, and with no listener the emit throws
  // as an uncaught exception (Electron's error dialog). Consume it here;
  // cleanup runs off worker.once('exit') below either way.
  worker.on('error', (err) => {
    if (debug) console.error('worker stream error (shutdown race):', err.message)
  })
  // A previous worker for this specifier may have left a no-op handler
  // registered on exit (see the worker.once('exit', ...) below). Clear it
  // before re-registering, otherwise ipcMain.handle throws.
  try { ipcMain.removeHandler('pear:worker:writeIPC:' + specifier) } catch {}

  const bootstrap = {
    type: 'bootstrap',
    storage: p.storage,
    appVersion: version,
    upgradeKey: upgrade || null,
    dev: isDev,
    verbose,
    downloadFolder: readDownloadFolder(),
    ...readBandwidth(),
    dhtBootstrap: process.env.MIRALL_DHT_BOOTSTRAP ? JSON.parse(process.env.MIRALL_DHT_BOOTSTRAP) : null,
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
    // 'off', and a stable frame shape means flipping the flag can never be the change
    // that breaks worker boot.
    relayEnabled: readFeatureFlags().relay === true,
    relayMode: config().get('network.relayMode'),
    relays: config().get('network.relays'),
    identityKEK: identityKEKHex,
  }
  worker.write(Buffer.from(JSON.stringify(bootstrap) + '\n'))

  const writeHandler = (_evt, data) => {
    try {
      worker.write(Buffer.from(data))
    } catch (err) {
      // Worker may have closed its socket before the renderer's last message
      // arrived (e.g., during app shutdown). Swallow the EPIPE / FIN race —
      // there's no recipient anymore, the message is moot.
      if (debug) console.error('worker write failed (shutdown race):', err.message)
    }
  }
  ipcMain.handle('pear:worker:writeIPC:' + specifier, writeHandler)

  let workerBuffer = ''
  worker.on('data', (data) => {
    sendToAll('pear:worker:ipc:' + specifier, data)
    workerBuffer += data.toString()
    const lines = workerBuffer.split('\n')
    workerBuffer = lines.pop() ?? ''
    for (const line of lines) {
      // Only worker→main control frames ('main-request') need parsing here; a large
      // worker→renderer response (already broadcast above) must not be JSON.parsed on
      // main's UI thread. isControlFrameCandidate gates by size (see ipc-frame.js).
      if (!isControlFrameCandidate(line)) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg && msg.type === 'main-request') {
        handleMainRequest(msg.command, msg.args || {}, worker).catch((err) => {
          if (debug) console.error('main-request failed:', msg.command, err.message)
        })
      }
    }
  })
  worker.stdout.on('data', (data) => {
    const text = data.toString()
    if (debug) process.stdout.write('[worker stdout] ' + text)
    logRing.push('worker', 'log', text)
    sendToAll('pear:worker:stdout:' + specifier, data)
  })
  worker.stderr.on('data', (data) => {
    const text = data.toString()
    process.stderr.write('[worker stderr] ' + text)
    logRing.push('worker', 'error', text)
    sendToAll('pear:worker:stderr:' + specifier, data)
  })

  const onBeforeQuit = () => {
    // 1. Ask the worker to exit cleanly (it closes the swarm, then Bare.exit).
    try { worker.write(Buffer.from(JSON.stringify({ type: 'shutdown' }) + '\n')) } catch {}
    // 2. Escalate if it's still alive. NOTE: the bare-sidecar Duplex has no
    //  kill method — the previous `worker.kill` threw and was swallowed by
    //  the catch, so a wedged worker was never reaped and orphaned itself at
    //  100% CPU. destroy sends SIGTERM via the sidecar's _destroy; a worker
    //  whose event loop is starved by a busy loop can't process the shutdown
    //  IPC OR a SIGTERM bare dispatches on that loop, so follow up with an
    //  uncatchable SIGKILL on the underlying child. Timers are unref'd so they
    //  never delay a clean exit; the process.on('exit') backstop is the real
    //  guarantee when the main process exits before these fire.
    const child = worker._process
    setTimeout(() => { try { worker.destroy() } catch {} ; try { child?.kill('SIGTERM') } catch {} }, 3000).unref?.()
    setTimeout(() => { try { child?.kill('SIGKILL') } catch {} }, 5000).unref?.()
  }
  app.on('before-quit', onBeforeQuit)

  worker.once('exit', (code) => {
    app.removeListener('before-quit', onBeforeQuit)
    // Replace the writeHandler with a no-op instead of removing it. Late
    // renderer messages (common during shutdown) would otherwise hit
    // "No handler registered" and surface as Uncaught Promise rejections.
    try { ipcMain.removeHandler('pear:worker:writeIPC:' + specifier) } catch {}
    try { ipcMain.handle('pear:worker:writeIPC:' + specifier, () => undefined) } catch {}
    sendToAll('pear:worker:exit:' + specifier, code)
    workers.delete(specifier)
  })

  workers.set(specifier, worker)
  return worker
}

// === Renderer IPC handlers + quit hooks ===

ipcMain.on('pkg', (evt) => { evt.returnValue = pkg })
ipcMain.on('app:isDev', (evt) => { evt.returnValue = isDev })

ipcMain.handle('menu:context-changed', (_evt, ctx) => {
  const inSpace = !!(ctx && ctx.inSpace)
  const spaces = Array.isArray(ctx && ctx.spaces) ? ctx.spaces : []
  const sameSpaces = spaces.length === menuCtx.spaces.length &&
    spaces.every((s, i) => s.id === menuCtx.spaces[i].id && s.name === menuCtx.spaces[i].name)
  if (inSpace === menuCtx.inSpace && sameSpaces) return
  menuCtx = { inSpace, spaces }
  refreshAppMenu()
})
ipcMain.on('app:getLocale', (evt) => { evt.returnValue = app.getLocale() })

// Renderer config lives in the same unified config.json (main is the only
// writer). The snapshot is read synchronously at renderer boot so theme/locale
// are known before first paint; writes are async patches.
ipcMain.on('config:get', (evt) => { evt.returnValue = config().rendererSnapshot() })
// Returns the post-write snapshot: main sanitizes on write (relay dedupe, cap, label
// length), so the renderer must adopt what was stored rather than its optimistic copy.
ipcMain.handle('config:set', (_evt, patch) => { config().setRenderer(patch); return config().rendererSnapshot() })

ipcMain.handle('pear:applyUpdate', async () => {
  const u = getPear().updater
  if (!u) return
  await u.applyUpdate()
})

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

// Live verbose-logging toggle for main. Flips `debug` (so main's if(debug) logs
// fire even on a production build) and the `verbose` worker-spawn seed (so a
// respawned worker inherits it). The renderer flips the already-running worker
// separately over the worker IPC channel. A non-boolean arg leaves state
// untouched and just reports it; turning off reverts to the build default.
// net.online is documented as asymmetric: false is a strong indicator the user cannot
// reach remote sites, true is inconclusive. So it is only ever used to declare offline —
// never to declare healthy.
const NET_ONLINE_POLL_MS = 2000
let lastNetOnline = null

function startNetOnlineWatch() {
  const tick = () => {
    let online = true
    try { online = net.online !== false } catch {}
    if (online === lastNetOnline) return
    lastNetOnline = online
    sendToAll('net:online', online)
  }
  tick()
  const timer = setInterval(tick, NET_ONLINE_POLL_MS)
  timer.unref?.()
}

ipcMain.handle('net:online', () => {
  try { return net.online !== false } catch { return true }
})

ipcMain.handle('diagnostics:logs', async (_evt, opts) => {
  const redactLine = opts?.redact !== false ? await loadRedactLine() : null
  // Fail closed: if the redaction module could not load, ship no logs rather than raw ones.
  if (opts?.redact !== false && !redactLine) return []
  return logRing.snapshot(redactLine)
})

ipcMain.handle('app:setVerbose', (_evt, on) => {
  if (typeof on === 'boolean') { verbose = on; debug = on || baseDebug }
  return debug
})

ipcMain.handle('app:getChangelog', async () => {
  const file = app.isPackaged
    ? path.join(process.resourcesPath, 'CHANGELOG.md')
    : path.join(__dirname, '..', '..', 'CHANGELOG.md')
  try {
    return await fs.promises.readFile(file, 'utf8')
  } catch (err) {
    if (debug) console.error('app:getChangelog read failed:', err.message)
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

// before-quit fires before any window's close event. Setting isQuitting here
// covers system-initiated quits (Cmd-Q, OS shutdown, app menu Quit) so the
// close handler doesn't hide-to-tray instead of quitting. Tray-menu Quit
// also sets this directly before calling app.quit — idempotent re-set is
// harmless.
app.on('before-quit', () => { isQuitting = true })

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

// Promote any staged OTA bundle on the user's next clean quit. Defer the quit
// (preventDefault → await applyUpdate → re-quit) because Electron does not
// await async listeners and the swap must finish before the process exits —
// macOS/Linux: fsx.swap (fast); Windows: MSIXManager.addPackage (seconds).
let updateApplyAttempted = false
app.on('before-quit', (event) => {
  if (updateApplyAttempted) return
  if (!updatesEnabled) return
  if (!pear?.updater?.updated || pear.updater.applied) return
  updateApplyAttempted = true
  event.preventDefault()
  pear.updater.applyUpdate()
    .catch((err) => console.error('apply update on quit failed:', err))
    .finally(() => app.quit())
})

ipcMain.handle('window:getBounds', (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender) ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return null
  return win.getBounds()
})

ipcMain.handle('zoom:get', () => currentZoom)

ipcMain.handle('zoom:set', (evt, factor) => {
  const win = BrowserWindow.fromWebContents(evt.sender) ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return currentZoom
  return applyZoom(win, factor)
})

ipcMain.handle('window:setBounds', (evt, bounds) => {
  const win = BrowserWindow.fromWebContents(evt.sender) ?? BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win) return
  win.setBounds(bounds)
})

ipcMain.handle('downloads:get', () => readDownloadFolder())

ipcMain.handle('downloads:set', (_evt, folder) => {
  validateDownloadFolder(folder)
  writeDownloadFolder(folder)
  return folder
})

ipcMain.handle('bandwidth:get', () => readBandwidth())

ipcMain.handle('bandwidth:set', (_evt, patch) => config().setBandwidth(patch))

ipcMain.handle('prefs:get', () => prefs)

ipcMain.handle('prefs:set', (_evt, partial) => {
  if (!partial || typeof partial !== 'object') return prefs
  const next = { ...prefs, ...partial }
  if (typeof partial.openAtLogin === 'boolean' && partial.openAtLogin !== prefs.openAtLogin) {
    setOpenAtLogin(partial.openAtLogin)
  }
  if (typeof partial.minimizeToTray === 'boolean' && partial.minimizeToTray !== prefs.minimizeToTray) {
    if (partial.minimizeToTray) createTray()
    else destroyTray()
  }
  const menuChanged = typeof partial.appMenuAutoHide === 'boolean' && partial.appMenuAutoHide !== prefs.appMenuAutoHide
  prefs = next
  writePrefs(prefs)
  if (menuChanged) {
    for (const w of BrowserWindow.getAllWindows()) applyAppMenuVisibility(w)
  }
  return prefs
})

ipcMain.handle('tray:setLabels', (_evt, labels) => {
  if (!labels || typeof labels !== 'object') return
  if (typeof labels.show === 'string' && labels.show.length > 0) trayLabels.show = labels.show
  if (typeof labels.settings === 'string' && labels.settings.length > 0) trayLabels.settings = labels.settings
  if (typeof labels.quit === 'string' && labels.quit.length > 0) trayLabels.quit = labels.quit
  if (typeof labels.tooltip === 'string' && labels.tooltip.length > 0) trayLabels.tooltip = labels.tooltip
  refreshTrayMenu()
})

ipcMain.handle('downloads:browse', async (evt, defaultPath) => {
  const win = BrowserWindow.fromWebContents(evt.sender)
    ?? BrowserWindow.getFocusedWindow()
    ?? BrowserWindow.getAllWindows()[0]
  const current = typeof defaultPath === 'string' && defaultPath.length > 0
    ? defaultPath
    : readDownloadFolder()
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: current,
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('share:browseFolder', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender)
    ?? BrowserWindow.getFocusedWindow()
    ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

// === Folder watcher bridge (chokidar on the worker's behalf) ===

const ownedFolderWatchers = require('./owned-folder-watchers.js')
const looseFileWatchers = require('./loose-file-watchers.js')

async function handleMainRequest(command, args, worker) {
  if (command === 'downloads:roots') {
    workerDownloadRoots = Array.isArray(args?.roots)
      ? args.roots.filter((r) => typeof r === 'string' && r.length > 0).map((r) => path.resolve(r))
      : []
    return
  }
  if (command === 'loose-file:watch') {
    looseFileWatchers.addLooseWatch(
      args.spaceId,
      args.absPath,
      (event) => {
        const frame = JSON.stringify({ type: 'event:loose-file-fs-event', ...event }) + '\n'
        try { worker.write(Buffer.from(frame)) } catch (err) {
          if (debug) console.error('loose fs-event write failed:', err.message)
        }
      },
      (err) => {
        if (debug) console.warn('loose watcher error', args.absPath, '-', err.message)
      },
    )
    return
  }
  if (command === 'loose-file:unwatch') {
    looseFileWatchers.removeLooseWatch(args.spaceId, args.absPath)
    return
  }
  if (command === 'owned-folder:start-watcher') {
    ownedFolderWatchers.startWatcher(
      args.shareId,
      args.mountPath,
      args.ignore || [],
      (event) => {
        const frame = JSON.stringify({ type: 'event:owned-folder-fs-event', ...event }) + '\n'
        try { worker.write(Buffer.from(frame)) } catch (err) {
          if (debug) console.error('fs-event write failed:', err.message)
        }
      },
      (err) => {
        if (debug) console.warn('watcher error', args.shareId, '-', err.message)
      },
    )
    return
  }
  if (command === 'owned-folder:stop-watcher') {
    ownedFolderWatchers.stopWatcher(args.shareId)
    return
  }
}

ipcMain.handle('owned-folder:start-watcher', (_evt, { shareId, mountPath, ignore }) => {
  const worker = workers.get('/src/worker/main.js')
  if (!worker) return { ok: false, reason: 'worker-not-running' }
  ownedFolderWatchers.startWatcher(
    shareId,
    mountPath,
    ignore || [],
    (event) => {
      const frame = JSON.stringify({ type: 'event:owned-folder-fs-event', ...event }) + '\n'
      try { worker.write(Buffer.from(frame)) } catch (err) {
        if (debug) console.error('owned-folder fs-event write failed:', err.message)
      }
    },
    (err) => {
      if (debug) console.warn('owned-folder watcher error', shareId, '-', err.message)
    },
  )
  return { ok: true }
})

ipcMain.handle('owned-folder:stop-watcher', (_evt, { shareId }) => {
  ownedFolderWatchers.stopWatcher(shareId)
  return { ok: true }
})

app.on('before-quit', () => {
  try { ownedFolderWatchers.stopAllWatchers() } catch {}
  try { looseFileWatchers.stopLooseWatchers() } catch {}
  try { configStore?.flush() } catch {}
})

// === Theme, app menu, window creation ===

// Renderer pushes its theme choice so the BrowserWindow's native background
// tracks it across launches and OS theme changes. This is also the persistence
// path — the mode is written to config.json (appearance.theme).
ipcMain.handle('theme:set', (_evt, mode) => {
  if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return false
  writeStoredTheme(mode)
  const color = resolveBackgroundColor(mode)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.setBackgroundColor(color)
  }
  return true
})

nativeTheme.on('updated', () => {
  if (readStoredTheme() !== 'system') return
  const color = resolveBackgroundColor('system')
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.setBackgroundColor(color)
  }
})

function sendKeyboardCommand(id) {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (!win) return
  win.webContents.send('keyboard:command', id)
}

function buildAppMenu() {
  const send = (id) => () => sendKeyboardCommand(id)
  const template = buildAppMenuTemplate({
    platform: process.platform,
    isDev,
    inSpace: menuCtx.inSpace,
    spaces: menuCtx.spaces,
    appName,
    handlers: {
      openAbout: send('profile.open'),
      openProfile: send('profile.open'),
      openActivityLog: send('activity.open'),
      openSpace: (spaceId) => sendKeyboardCommand(`space.open.${spaceId}`),
      openSettings: send('settings.open'),
      newSpace: send('space.new'),
      joinSpace: send('space.join'),
      addFiles: send('space.addFiles'),
      addFolder: send('space.addFolder'),
      invite: send('space.invite'),
      navBack: send('nav.back'),
      navHome: send('nav.home'),
      openPalette: send('palette.open'),
      showShortcuts: send('shortcuts.show'),
      whatsNew: send('help.whatsNew'),
      sendFeedback: send('help.feedback'),
      openDocs: send('help.docs'),
    },
  })
  return Menu.buildFromTemplate(template)
}

function refreshAppMenu() {
  Menu.setApplicationMenu(buildAppMenu())
}

function applyAppMenuVisibility(win) {
  if (isMac || !win || win.isDestroyed()) return
  const autoHide = !!prefs.appMenuAutoHide
  win.setAutoHideMenuBar(autoHide)
  win.setMenuBarVisibility(!autoHide)
}

async function createWindow() {
  refreshAppMenu()
  const restored = readWindowBounds()
  const startHidden = startHiddenFlag
    || (isMac && app.getLoginItemSettings().wasOpenedAtLogin)
  const winOpts = {
    width: 1200,
    height: 1000,
    minWidth: 900,
    // At default zoom this is the height needed for the space sidebar to still
    // show at least two members in the list with the Storage box collapsed.
    minHeight: 870,
    show: !startHidden,
    backgroundColor: resolveBackgroundColor(readStoredTheme()),
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  }
  if (startHidden && isMac) {
    setTimeout(() => { try { app.dock.hide() } catch {} }, 0)
  }
  if (restored) {
    winOpts.x = restored.x
    winOpts.y = restored.y
    winOpts.width = restored.width
    winOpts.height = restored.height
  }
  if (process.env.MIRALL_WINDOW_BOUNDS) {
    try {
      const b = JSON.parse(process.env.MIRALL_WINDOW_BOUNDS)
      if (Number.isFinite(b.x)) winOpts.x = b.x
      if (Number.isFinite(b.y)) winOpts.y = b.y
      if (Number.isFinite(b.width)) winOpts.width = b.width
      if (Number.isFinite(b.height)) winOpts.height = b.height
    } catch {}
  }
  const win = new BrowserWindow(winOpts)
  applyAppMenuVisibility(win)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url).catch((err) => console.error('openExternal failed:', err))
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      event.preventDefault()
      shell.openExternal(url).catch((err) => console.error('openExternal failed:', err))
    }
  })

  // DevTools shortcut. With the application menu disabled (Win/Linux), the
  // default F12 / Ctrl-Shift-I accelerators don't fire because they were
  // bound to menu items. Wire them directly to the webContents instead so
  // we can still debug field installs.
  win.webContents.on('before-input-event', (event, input) => {
    const match = matchWindowShortcut(input, { isMac })
    if (!match) return
    if (match.kind === 'devtools') {
      win.webContents.toggleDevTools()
    } else if (match.direction === 'in') {
      applyZoom(win, currentZoom + ZOOM_STEP)
    } else if (match.direction === 'out') {
      applyZoom(win, currentZoom - ZOOM_STEP)
    } else {
      applyZoom(win, ZOOM_DEFAULT)
    }
    event.preventDefault?.()
  })

  currentZoom = readZoom()
  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) win.webContents.setZoomFactor(currentZoom)
  })

  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // Skip our own forwarded main logs (the renderer prints them as [main] …),
    // otherwise mirroring them back here would feed the forwarding loop.
    if (typeof message === 'string' && message.startsWith(MAIN_LOG_PREFIX)) return
    const tag = ['VERBOSE', 'INFO', 'WARNING', 'ERROR'][level] || 'INFO'
    logRing.push('renderer', tag.toLowerCase(), `${sourceId}:${line} ${message}`)
    if (debug) console.log(`[renderer ${tag}] ${sourceId}:${line} ${message}`)
  })

  if (debug) {
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('[mirall] renderer did-fail-load', code, desc, url)
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[mirall] renderer process gone:', details)
    })

    win.webContents.on('preload-error', (_e, preloadPath, err) => {
      console.error('[mirall] preload error in', preloadPath, err)
    })
  }

  let saveTimer = null
  const persist = () => {
    if (win.isDestroyed()) return
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (win.isDestroyed()) return
      writeWindowBounds(win.getBounds())
    }, 300)
  }
  win.on('resize', persist)
  win.on('move', persist)

  // OS-level "back" gestures → reuse the renderer's nav.back command.
  // Windows sends WM_APPCOMMAND for mouse back/forward buttons as 'app-command';
  // macOS three-finger trackpad swipe arrives as 'swipe'. (Mouse side buttons on
  // macOS/Linux are handled directly in the renderer as mouse button 3.)
  win.on('app-command', (e, cmd) => {
    if (cmd === 'browser-backward' && !win.isDestroyed()) {
      win.webContents.send('keyboard:command', 'nav.back')
    }
  })
  win.on('swipe', (_e, direction) => {
    if (direction === 'left' && !win.isDestroyed()) {
      win.webContents.send('keyboard:command', 'nav.back')
    }
  })

  win.on('close', (e) => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    if (!win.isDestroyed()) writeWindowBounds(win.getBounds())

    if (isQuitting || !prefs.minimizeToTray) return

    e.preventDefault()
    win.hide()
    if (isMac) {
      // dock.hide has a 1-second cooldown after a previous call. Defer
      // via setTimeout so the no-op fires after AppKit settles.
      setTimeout(() => { try { app.dock.hide() } catch {} }, 0)
    }
    sendToAll('pear:event:hidden-to-tray', null)
    maybeShowFirstHideNotice()
  })

  if (updatesEnabled) {
    const p = getPear()
    const onUpdating = () => { if (!win.isDestroyed()) win.webContents.send('pear:event:updating') }
    const onUpdated = () => { if (!win.isDestroyed()) win.webContents.send('pear:event:updated') }
    p.updater.on('updating', onUpdating)
    p.updater.on('updated', onUpdated)
    win.on('closed', () => {
      p.updater.removeListener('updating', onUpdating)
      p.updater.removeListener('updated', onUpdated)
    })
  }

  const devUrl = process.env.PEAR_DEV_SERVER_URL
  if (devUrl) {
    await win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
    return
  }
  await win.loadURL('app://-/index.html')
  if (debug && process.env.MIRALL_NO_DEVTOOLS !== '1') win.webContents.openDevTools({ mode: 'detach' })
}

// === app:// asset serving, deep links, app lifecycle ===

const APP_PROTOCOL_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.map': 'application/json',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

// Preloaded at boot (see preloadAsarCache) — the protocol handler serves
// from this map instead of doing fs.readFile per request. The ui/ tree
// lives inside app.asar; reading it on demand races with the OTA updater's
// process.noAsar = true window (see getPear), which causes fs.readFile
// to return ENOTDIR for asar paths. Caching at boot, before any updater
// work can start, makes renderer asset loads independent of the noAsar
// global. Total ui/ payload is ~3 MB → negligible RAM.
const APP_PROTOCOL_CACHE = new Map()
const WORKER_ENTRYPOINTS = new Map()

function preloadAsarCache() {
  const uiRoot = path.join(__dirname, '..', '..', 'assets')
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const e of entries) {
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) walk(abs)
      else if (e.isFile()) {
        const rel = path.relative(uiRoot, abs).split(path.sep).join('/')
        APP_PROTOCOL_CACHE.set(rel, fs.readFileSync(abs))
      }
    }
  }
  walk(uiRoot)

  // Worker specifiers are repo-rooted ('/src/worker/main.js'); resolve against
  // the package root (two levels up from this file) so the spec stays stable
  // regardless of where in src/ this module lives.
  const repoRoot = path.join(__dirname, '..', '..')
  for (const spec of ['/src/worker/main.js']) {
    WORKER_ENTRYPOINTS.set(spec, require.resolve(path.join(repoRoot, spec)))
  }

  // feature-flags.json is asar-internal too: read + cache it here, before
  // getPear opens the updater's noAsar window, so worker bootstrap's flag reads
  // never hit an ENOTDIR fallback that would silently disable every flag.
  primeFeatureFlags(repoRoot)

  // pear-runtime-updater.applyUpdate does a lazy `require('msix-manager')`
  // on the win32 branch — and our wrapWithNoAsar (see getPear) flips
  // process.noAsar = true around that call, which breaks Electron's
  // asar-as-virtual-dir resolution and surfaces as
  // `Cannot find module 'msix-manager'` (MODULE_NOT_FOUND, recorded to
  // last-apply-error.json so OTA never applies). Warm the cache here, before
  // getPear opens the noAsar window, so the lazy require returns from
  // Module._cache without touching the filesystem. Node's pathCache key
  // includes the requiring module's parent.paths — so we must preload from
  // pear-runtime-updater's OWN context (Module.createRequire(updaterIndex)),
  // not main.js's, otherwise the later resolution under noAsar still misses
  // and falls through to a fresh (failing) walk.
  if (isWindows) {
    const Module = require('module')
    const updaterIndex = require.resolve('pear-runtime-updater')
    Module.createRequire(updaterIndex)('msix-manager')
  }
}

function registerAppProtocol() {
  electronProtocol.handle('app', async (request) => {
    let url
    try { url = new URL(request.url) } catch { return new Response('Bad Request', { status: 400 }) }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    if (rel.includes('..')) return new Response('Forbidden', { status: 403 })
    const data = APP_PROTOCOL_CACHE.get(rel)
    if (!data) return new Response('Not Found', { status: 404 })
    const mime = APP_PROTOCOL_MIME[path.extname(rel).toLowerCase()] || 'application/octet-stream'
    return new Response(data, { headers: { 'Content-Type': mime, 'Cache-Control': 'no-cache' } })
  })
}

app.setAsDefaultProtocolClient(protocol)

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
    prefs = readPrefs()
    firstHideNoticeShown = prefs.firstHideNoticeShown
    try { integrateXdgLinux() } catch (err) { console.error('[xdg] integration failed:', err.message) }
    // Preload before getPear runs — getPear installs the noAsar
    // wrappers on the OTA updater, after which any read of an asar path
    // can race with _update and return ENOTDIR.
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
      console.error('[identity] storage perms failed:', err.message)
    }
    try {
      const identityKek = require('./identity-kek.js')
      identityKEKHex = identityKek.resolveKEKHex(storagePath)
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
    if (prefs.minimizeToTray) createTray()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow().catch((err) => console.error('createWindow failed:', err))
      } else {
        revealWindow().catch((err) => console.error('revealWindow failed:', err))
      }
    })
  })

  app.on('window-all-closed', () => {
    if (prefs.minimizeToTray) return
    if (!isMac) app.quit()
  })
}
