// Settings the renderer writes to main: the general preferences and the directory pickers. The
// download folder and the bandwidth caps are the worker's (settings:* requests).
//
// prefs:set is the one handler that reaches outside its own domain — three of the four preferences
// have an immediate effect on the tray or the app menu — so those actions are injected rather than
// re-implemented here.

const path = require('path')
const fs = require('fs')
const os = require('os')
const { app, ipcMain, dialog, BrowserWindow } = require('electron')
const { isMac, isLinux, isWindows } = require('which-runtime')
const pkg = require('../../package.json')
const { getPrefs, setPrefs } = require('./prefs.js')
const { registerBackupIpc } = require('./backup-settings.js')

const appName = pkg.productName || pkg.name
const version = pkg.version

// The config store is the entry's, not one this module opens: it is created once, after the
// userData path has been redirected, and a second store would write somewhere else.
let config = null
// The autostart entry's Icon= is a theme lookup name: the AppImage integration installs the icons
// under the product name, the deb under the package name.
let installKind = 'none'
function initSettings(deps) {
  config = deps.config
  installKind = deps.installKind ?? 'none'
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
  const icon = installKind === 'deb' ? pkg.name : appName
  const lines = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${appName}`,
    `Exec="${exec}" --hidden`,
    `Icon=${icon}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'Hidden=false',
    `X-AppImage-Version=${version}`,
    '',
  ]
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, lines.join('\n'))
}

function registerSettingsIpc({ createTray, destroyTray, applyAppMenuVisibility, targetWindow }) {
  ipcMain.handle('prefs:get', () => getPrefs())

  ipcMain.handle('prefs:set', (_evt, partial) => {
    const prefs = getPrefs()
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
    setPrefs(next)
    if (menuChanged) {
      for (const w of BrowserWindow.getAllWindows()) applyAppMenuVisibility(w)
    }
    return getPrefs()
  })

  async function pickDirectory(evt, defaultPath) {
    const options = { properties: ['openDirectory', 'createDirectory'] }
    if (typeof defaultPath === 'string' && defaultPath.length > 0) options.defaultPath = defaultPath
    const result = await dialog.showOpenDialog(targetWindow(evt), options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  }

  // The picker answers a name as its volume stores it, often decomposed on macOS, where the worker
  // keeps download folders composed (NFC): the renderer would compare two spellings of one folder.
  ipcMain.handle('downloads:browse', async (evt, defaultPath) => {
    const folder = await pickDirectory(evt, defaultPath)
    return folder && isMac ? folder.normalize('NFC') : folder
  })

  ipcMain.handle('share:browseFolder', (evt) => pickDirectory(evt))

  registerBackupIpc({ ipcMain, config, pickDirectory, dataDir: () => app.getPath('userData') })
}

module.exports = { initSettings, registerSettingsIpc }
