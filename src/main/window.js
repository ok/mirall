// The BrowserWindow and everything persisted about it: zoom, bounds and theme.
//
// The window is created once and hidden rather than closed, so its state has to survive a hide as
// well as a quit — which is why every one of these reads and writes goes through config.json
// rather than living on the window object.

const path = require('path')
const { app, BrowserWindow, ipcMain, nativeTheme, screen, shell } = require('electron')
const { isMac } = require('which-runtime')
const { usableBounds } = require('./window-bounds.js')
const { matchWindowShortcut } = require('./window-shortcuts.js')
const { logRing } = require('./log-ring.js')
const { isDebug } = require('./debug-gate.js')
const { getPrefs, setPrefs } = require('./prefs.js')
const { isQuitting } = require('./quit-state.js')
const { sendToAll, MAIN_LOG_PREFIX } = require('./logging.js')

// Bound once by the entry. The menu actions are injected because a window action rebuilds a menu
// and a menu item acts on a window; neither owns the other.
let config = null
let refreshAppMenu = null
let applyAppMenuVisibility = null
let sendKeyboardCommand = null
let getPear = null
let updatesEnabled = false
let startHiddenFlag = false

function initWindow(d) {
  config = d.config
  refreshAppMenu = d.refreshAppMenu
  applyAppMenuVisibility = d.applyAppMenuVisibility
  sendKeyboardCommand = d.sendKeyboardCommand
  getPear = d.getPear
  updatesEnabled = d.updatesEnabled
  startHiddenFlag = d.startHiddenFlag
}

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

// Every zoom trigger — the View menu, the keyboard chord, the renderer's zoom:set — routes here so
// applyZoom stays the sole writer of the persisted factor and of currentZoom.
function zoomByDirection(direction, win = targetWindow()) {
  if (!win) return currentZoom
  if (direction === 'in') return applyZoom(win, currentZoom + ZOOM_STEP)
  if (direction === 'out') return applyZoom(win, currentZoom - ZOOM_STEP)
  return applyZoom(win, ZOOM_DEFAULT)
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

// Match --color-background in :root / .dark in src/renderer/styles/tailwind.css. The native
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

// === Tray, autostart, window reveal ===

// The one answer to "which window does this act on": sender, then focused, then any live window
// — never a destroyed one (setBounds / setZoomFactor on it throws).
function targetWindow(evt) {
  const sender = evt && evt.sender ? BrowserWindow.fromWebContents(evt.sender) : null
  const candidates = [sender, BrowserWindow.getFocusedWindow(), ...BrowserWindow.getAllWindows()]
  return candidates.find((w) => w && !w.isDestroyed()) ?? null
}

// dock.hide has a one-second cooldown after a previous call, so a call made while AppKit is still
// settling is silently dropped. Deferring to the next tick is what makes it take effect.
function hideDockSoon() {
  setTimeout(() => { try { app.dock.hide() } catch {} }, 0)
}

async function revealWindow() {
  const win = targetWindow()
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

function maybeShowFirstHideNotice() {
  // The preference record is the only flag: setPrefs updates it in place, so a second hide in the
  // same session reads true here without waiting for the write to land.
  if (getPrefs().firstHideNoticeShown) return
  setPrefs({ ...getPrefs(), firstHideNoticeShown: true })
  sendToAll('pear:event:first-hide-notice', { platform: process.platform })
}

async function createWindow() {
  // Required here, not at module scope: the contract package is ESM, and requiring it while the
  // entry's own CJS load is still in flight trips Node's require(esm) race guard. By the time a
  // window is created the graph has settled.
  const { MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT } = require('../shared/contract/limits.js')
  refreshAppMenu()
  const restored = readWindowBounds()
  const startHidden = startHiddenFlag
    || (isMac && app.getLoginItemSettings().wasOpenedAtLogin)
  const winOpts = {
    width: 1200,
    height: 1000,
    minWidth: MIN_WINDOW_WIDTH,
    // At default zoom this is the height needed for the space sidebar to still
    // show at least two members in the list with the Storage box collapsed.
    minHeight: MIN_WINDOW_HEIGHT,
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
  if (startHidden && isMac) hideDockSoon()
  // A position no display can show would open the window out of reach, so it is dropped and only
  // the remembered size survives — Electron then centres it on the primary display.
  if (restored) {
    const placeable = usableBounds(restored, screen.getAllDisplays())
    if (typeof placeable.x === 'number') {
      winOpts.x = placeable.x
      winOpts.y = placeable.y
    }
    winOpts.width = placeable.width
    winOpts.height = placeable.height
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

  // DevTools shortcut, bound straight to the webContents rather than left to the View menu's
  // toggleDevTools accelerator: the menu bar can be auto-hidden on Win/Linux (appMenuAutoHide),
  // and F12 / Ctrl-Shift-I must keep working in a field install whatever the menu state.
  win.webContents.on('before-input-event', (event, input) => {
    const match = matchWindowShortcut(input, { isMac })
    if (!match) return
    if (match.kind === 'devtools') {
      win.webContents.toggleDevTools()
    } else {
      zoomByDirection(match.direction, win)
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
    if (isDebug()) console.log(`[renderer ${tag}] ${sourceId}:${line} ${message}`)
  })

  if (isDebug()) {
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
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward') sendKeyboardCommand('nav.back', win)
  })
  win.on('swipe', (_e, direction) => {
    if (direction === 'left') sendKeyboardCommand('nav.back', win)
  })

  win.on('close', (e) => {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    if (!win.isDestroyed()) writeWindowBounds(win.getBounds())

    if (isQuitting() || !getPrefs().minimizeToTray) return

    e.preventDefault()
    win.hide()
    if (isMac) hideDockSoon()
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
  if (isDebug() && process.env.MIRALL_NO_DEVTOOLS !== '1') win.webContents.openDevTools({ mode: 'detach' })
}

// Renderer pushes its theme choice so the BrowserWindow's native background tracks it across
// launches and OS theme changes. This is also the persistence path — the mode is written to
// config.json (appearance.theme).
function applyBackgroundColor(mode) {
  const color = resolveBackgroundColor(mode)
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.setBackgroundColor(color)
  }
}

function registerWindow() {
  ipcMain.handle('window:getBounds', (evt) => {
    const win = targetWindow(evt)
    if (!win) return null
    return win.getBounds()
  })

  ipcMain.handle('zoom:get', () => currentZoom)

  ipcMain.handle('zoom:set', (evt, factor) => {
    const win = targetWindow(evt)
    if (!win) return currentZoom
    return applyZoom(win, factor)
  })

  ipcMain.handle('window:setBounds', (evt, bounds) => {
    const win = targetWindow(evt)
    if (!win) return
    win.setBounds(bounds)
  })

  ipcMain.handle('theme:set', (_evt, mode) => {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return false
    writeStoredTheme(mode)
    applyBackgroundColor(mode)
    return true
  })

  nativeTheme.on('updated', () => {
    if (readStoredTheme() !== 'system') return
    applyBackgroundColor('system')
  })
}

module.exports = {
  initWindow,
  registerWindow,
  createWindow,
  targetWindow,
  revealWindow,
  zoomByDirection,
  maybeShowFirstHideNotice,
  applyBackgroundColor,
  readStoredTheme,
}
