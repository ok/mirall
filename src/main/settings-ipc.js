// Settings the renderer writes: the download folder, the bandwidth caps, the general preferences
// and the two directory pickers.
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

function registerSettingsIpc({ createTray, destroyTray, applyAppMenuVisibility, targetWindow }) {
  ipcMain.handle('downloads:get', () => readDownloadFolder())

  ipcMain.handle('downloads:set', (_evt, folder) => {
    validateDownloadFolder(folder)
    writeDownloadFolder(folder)
    return folder
  })

  ipcMain.handle('bandwidth:get', () => readBandwidth())

  ipcMain.handle('bandwidth:set', (_evt, patch) => config().setBandwidth(patch))

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

  ipcMain.handle('downloads:browse', (evt, defaultPath) => pickDirectory(
    evt,
    typeof defaultPath === 'string' && defaultPath.length > 0 ? defaultPath : readDownloadFolder(),
  ))

  ipcMain.handle('share:browseFolder', (evt) => pickDirectory(evt))
}

module.exports = { initSettings, registerSettingsIpc, readDownloadFolder, readBandwidth }
