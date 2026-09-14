// The tray and the application menu — the two surfaces the renderer does not draw.
//
// Both are rebuilt rather than mutated: Electron's Menu is immutable once set, so a label change,
// a locale change or a space appearing means a new menu. revealWindow and targetWindow are
// injected because a menu item acts on the window, and the window knows nothing about menus.

const path = require('path')
const { app, Menu, Tray, ipcMain, nativeImage } = require('electron')
const { isMac, isWindows } = require('which-runtime')
const { getPrefs } = require('./prefs.js')
const { markQuitting } = require('./quit-state.js')
const { buildAppMenuTemplate } = require('./menu.js')

const trayLabels = { show: 'Show Mirall', settings: 'Settings…', quit: 'Quit Mirall', tooltip: 'Mirall' }
let tray = null
let menuCtx = { inSpace: false, spaces: [] }

let revealWindow = null
let targetWindow = null
let zoomByDirection = null
let appName = null
let isDev = false

function initMenus(deps) {
  revealWindow = deps.revealWindow
  targetWindow = deps.targetWindow
  zoomByDirection = deps.zoomByDirection
  appName = deps.appName
  isDev = deps.isDev
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
    { label: trayLabels.quit, click: () => { markQuitting(); app.quit() } },
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

function sendKeyboardCommand(id, win = targetWindow()) {
  if (!win || win.isDestroyed()) return
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
      zoomIn: () => zoomByDirection('in'),
      zoomOut: () => zoomByDirection('out'),
      zoomReset: () => zoomByDirection('reset'),
    },
  })
  return Menu.buildFromTemplate(template)
}

function refreshAppMenu() {
  Menu.setApplicationMenu(buildAppMenu())
}

function applyAppMenuVisibility(win) {
  if (isMac || !win || win.isDestroyed()) return
  const autoHide = !!getPrefs().appMenuAutoHide
  win.setAutoHideMenuBar(autoHide)
  win.setMenuBarVisibility(!autoHide)
}

function registerMenus() {
  ipcMain.handle('menu:context-changed', (_evt, ctx) => {
    const inSpace = !!(ctx && ctx.inSpace)
    const spaces = Array.isArray(ctx && ctx.spaces) ? ctx.spaces : []
    const sameSpaces = spaces.length === menuCtx.spaces.length &&
      spaces.every((s, i) => s.id === menuCtx.spaces[i].id && s.name === menuCtx.spaces[i].name)
    if (inSpace === menuCtx.inSpace && sameSpaces) return
    menuCtx = { inSpace, spaces }
    refreshAppMenu()
  })

  ipcMain.handle('tray:setLabels', (_evt, labels) => {
    if (!labels || typeof labels !== 'object') return
    if (typeof labels.show === 'string' && labels.show.length > 0) trayLabels.show = labels.show
    if (typeof labels.settings === 'string' && labels.settings.length > 0) trayLabels.settings = labels.settings
    if (typeof labels.quit === 'string' && labels.quit.length > 0) trayLabels.quit = labels.quit
    if (typeof labels.tooltip === 'string' && labels.tooltip.length > 0) trayLabels.tooltip = labels.tooltip
    refreshTrayMenu()
  })
}

module.exports = {
  initMenus,
  registerMenus,
  createTray,
  destroyTray,
  refreshTrayMenu,
  refreshAppMenu,
  applyAppMenuVisibility,
  sendKeyboardCommand,
}
