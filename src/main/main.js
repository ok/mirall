// Electron main process — the host. Owns the BrowserWindow, tray, native
// notifications, and deep links; embeds pear-runtime as a library for OTA
// updates; spawns the Bare worker (all P2P and data logic) and relays NDJSON
// IPC frames renderer↔worker in both directions; runs the folder and loose-file
// watchers on the worker's behalf. Main holds no durable application state —
// that lives in the worker's store (preferences aside, which are main's
// config.json); what main keeps in memory is session-only.
// First, before any sibling module can load bare-sidecar: see asar-spawn.js.
require('./asar-spawn.js').installAsarSpawnFix()
const { app, BrowserWindow, dialog, ipcMain, protocol: electronProtocol } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { logRing } = require('./log-ring')
const { sendToAll, loadRedactLine, installMainLogForwarding } = require('./logging.js')
const { initPrefs, getPrefs } = require('./prefs.js')
const { markQuitting } = require('./quit-state.js')
const { preloadAsarCache, registerAppProtocol } = require('./app-protocol.js')
const { registerRelaySlot } = require('./relay-slot.js')
const { registerNetOnline, startNetOnlineWatch } = require('./net-online.js')
const { parseDeepLink } = require('./deeplink')
const { initUpdater, registerUpdater, getPear, applyPendingUpdate } = require('./updater.js')
const {
  initWorkerHost,
  registerWorkerHost,
  stopWorkers,
  stopFolderWatchers,
  stopLooseWatchers,
  downloadRoots,
} = require('./worker-host.js')
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

const { isMac, isLinux, isWindows } = require('which-runtime')
const { parseBootArgv, extractDeepLinks } = require('./boot-argv.js')
const { ConfigStore } = require('./config-store.js')
const { initDebugGate, setVerbose } = require('./debug-gate.js')
const { integrateXdgLinux, retireXdgAppImageEntry } = require('./xdg-integration.js')
const { linuxInstallKind, updatesOffReason } = require('./install-kind.js')

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
// OTA is off without an upgrade key (pear-runtime-updater throws otherwise), under --no-updates,
// and on a .deb install, whose updates come from the package manager (install-kind.js).
const installKind = linuxInstallKind({ isLinux, isPackaged: app.isPackaged })
const offReason = updatesOffReason({ installKind, updatesFlag: boot.flags.updates, upgrade })
const updatesEnabled = offReason === null
if (installKind === 'deb') console.log('[updater] deb install: updates come from the package manager')
const startHiddenFlag = !!boot.flags.hidden

// With --storage, redirect Electron's userData too, so config.json, the corestore and the
// applied-version marker share one directory: two instances pointed at separate stores must not
// share (and clobber) one userData.
if (customStorage) app.setPath('userData', customStorage)

// DIAGNOSTIC — armed as soon as the profile path is settled (--storage moves it), and before the
// updater, the worker host or any watcher can touch the disk. getDataDir is a thunk because
// app.getPath is only meaningful after the line above. See src/main/dir-tripwire.js.
require('./dir-tripwire.js').installDataDirTripwire({ getDataDir: () => app.getPath('userData') })

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

let identityKEKHex = null
let identityProtection = 'disabled'

process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason && (reason.stack || reason.message || reason))
})

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

initUpdater({ getDataDir, updatesEnabled, updatesOffReason: offReason })
initSettings({ config, installKind })
initWorkerHost({ config, getPear, isDev, identityKEK: () => identityKEKHex })
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

// === Download folder + bandwidth settings ===

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

registerUpdater()

ipcMain.handle('app:identityProtection', () => identityProtection)

ipcMain.handle('diagnostics:logs', async (_evt, opts) => {
  const redactLine = opts?.redact !== false ? await loadRedactLine() : null
  // Fail closed: if the redaction module could not load, ship no logs rather than raw ones.
  if (opts?.redact !== false && !redactLine) return []
  return logRing.snapshot(redactLine)
})

// null on the installs where no apply has ever failed — which is nearly all of them — so the
// bundle can leave the key out entirely rather than carry a permanent empty slot.

// Live verbose-logging toggle for main. Flips `debug` (so main's if(debug) logs
// fire even on a production build) and the `verbose` worker-spawn seed (so a
// respawned worker inherits it). The renderer flips the already-running worker
// separately over the worker IPC channel. A non-boolean arg leaves state
// untouched and just reports it; turning off reverts to the build default.
ipcMain.handle('app:setVerbose', (_evt, on) => setVerbose(on))

registerWorkerHost()

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
  stopFolderWatchers,
  stopLooseWatchers,
  flushConfig: () => configStore?.flush(),
  stopWorkers,
  // Promote any staged OTA bundle on the user's next clean quit. Returning the
  // promise defers the quit, because Electron does not await async listeners and
  // the swap must finish before the process exits — macOS/Linux: fsx.swap (fast);
  // Windows: MSIXManager.addPackage (seconds).
  applyUpdate: applyPendingUpdate,
  quit: () => app.quit(),
  onStepError: (step, err) => console.error('quit teardown step failed:', step, err),
}))

// === Theme, app menu, window creation ===

// === app:// asset serving, deep links, app lifecycle ===

app.setAsDefaultProtocolClient(protocol)

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
      // The package owns the desktop entry on a deb install; a per-user entry left by an earlier
      // AppImage would shadow it and keep routing the scheme to the old file.
      if (installKind === 'deb') retireXdgAppImageEntry({ appName, protocol, packageName: pkg.name, homedir: os.homedir() })
      else integrateXdgLinux({ appName, protocol, isLinux, homedir: os.homedir() })
    } catch (err) {
      console.error('[xdg] integration failed:', err.message)
    }
    // Before getPear, which opens the noAsar window: see wrapWithNoAsar.
    preloadAsarCache()
    registerAppProtocol()
    startNetOnlineWatch()
    require('./notifications').register({
      revealWindow,
      downloadRoots: () => [readDownloadFolder(), ...downloadRoots()],
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
