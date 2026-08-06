// The renderer's entire native surface. The renderer runs sandboxed with
// contextIsolation, so window.bridge — defined here — is all it gets: vetted
// wrappers over named ipcMain channels (app/window/tray/config/notifications,
// updater control, worker spawn + raw NDJSON pipe access) plus event
// subscriptions that return their own unsubscribe function. No ipcRenderer,
// Node, or Electron API leaks past this file by design.
const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('bridge', {
  pkg: () => ipcRenderer.sendSync('pkg'),
  isDev: () => ipcRenderer.sendSync('app:isDev'),
  getLocale: () => ipcRenderer.sendSync('app:getLocale'),
  getPlatform: () => process.platform,
  getPathForFile: (file) => webUtils.getPathForFile(file),

  applyUpdate: () => ipcRenderer.invoke('pear:applyUpdate'),
  checkForUpdate: () => ipcRenderer.invoke('pear:checkForUpdate'),
  appVersion: () => ipcRenderer.invoke('pear:appVersion'),
  getChangelog: () => ipcRenderer.invoke('app:getChangelog'),
  getIdentityProtection: () => ipcRenderer.invoke('app:identityProtection'),
  setVerbose: (on) => ipcRenderer.invoke('app:setVerbose', on),
  onMainLog: (listener) => {
    const wrap = (_evt, payload) => listener(payload)
    ipcRenderer.on('main:log', wrap)
    return () => ipcRenderer.removeListener('main:log', wrap)
  },

  onPearEvent: (name, listener) => {
    const wrap = () => listener()
    const channel = 'pear:event:' + name
    ipcRenderer.on(channel, wrap)
    return () => ipcRenderer.removeListener(channel, wrap)
  },

  startWorker: (specifier) => ipcRenderer.invoke('pear:startWorker', specifier),

  onWorkerIPC: (specifier, listener) => {
    const wrap = (_evt, data) => listener(Buffer.from(data))
    const channel = 'pear:worker:ipc:' + specifier
    ipcRenderer.on(channel, wrap)
    return () => ipcRenderer.removeListener(channel, wrap)
  },

  onWorkerStdout: (specifier, listener) => {
    const wrap = (_evt, data) => listener(Buffer.from(data))
    const channel = 'pear:worker:stdout:' + specifier
    ipcRenderer.on(channel, wrap)
    return () => ipcRenderer.removeListener(channel, wrap)
  },

  onWorkerStderr: (specifier, listener) => {
    const wrap = (_evt, data) => listener(Buffer.from(data))
    const channel = 'pear:worker:stderr:' + specifier
    ipcRenderer.on(channel, wrap)
    return () => ipcRenderer.removeListener(channel, wrap)
  },

  onWorkerExit: (specifier, listener) => {
    const wrap = (_evt, code) => listener(typeof code === 'number' ? code : 0)
    const channel = 'pear:worker:exit:' + specifier
    ipcRenderer.on(channel, wrap)
    return () => ipcRenderer.removeListener(channel, wrap)
  },

  writeWorkerIPC: (specifier, data) => ipcRenderer.invoke('pear:worker:writeIPC:' + specifier, data),

  getWindowBounds: () => ipcRenderer.invoke('window:getBounds'),
  setWindowBounds: (bounds) => ipcRenderer.invoke('window:setBounds', bounds),

  getZoom: () => ipcRenderer.invoke('zoom:get'),
  setZoom: (factor) => ipcRenderer.invoke('zoom:set', factor),

  setTheme: (mode) => ipcRenderer.invoke('theme:set', mode),

  getDownloadFolder: () => ipcRenderer.invoke('downloads:get'),
  setDownloadFolder: (folder) => ipcRenderer.invoke('downloads:set', folder),
  browseDownloadFolder: () => ipcRenderer.invoke('downloads:browse'),

  getBandwidth: () => ipcRenderer.invoke('bandwidth:get'),
  setBandwidth: (patch) => ipcRenderer.invoke('bandwidth:set', patch),

  browseShareFolder: () => ipcRenderer.invoke('share:browseFolder'),
  startOwnedFolderWatcher: (shareId, mountPath, ignore) =>
    ipcRenderer.invoke('owned-folder:start-watcher', { shareId, mountPath, ignore }),
  stopOwnedFolderWatcher: (shareId) =>
    ipcRenderer.invoke('owned-folder:stop-watcher', { shareId }),
  onZoomChanged: (listener) => {
    const wrap = (_evt, factor) => listener(factor)
    ipcRenderer.on('pear:event:zoom-changed', wrap)
    return () => ipcRenderer.removeListener('pear:event:zoom-changed', wrap)
  },

  notify: (spec) => ipcRenderer.invoke('notify:show', spec),
  notifyIsSupported: () => ipcRenderer.invoke('notify:isSupported'),
  isWindowFocused: () => ipcRenderer.invoke('notify:isWindowFocused'),
  focusWindow: () => ipcRenderer.invoke('notify:focus'),
  showInFolder: (fullPath) => ipcRenderer.invoke('shell:showInFolder', fullPath),
  onNotificationClick: (listener) => {
    const wrap = (_evt, data) => listener(data)
    ipcRenderer.on('notify:click', wrap)
    return () => ipcRenderer.removeListener('notify:click', wrap)
  },

  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  setPrefs: (partial) => ipcRenderer.invoke('prefs:set', partial),
  getConfig: () => ipcRenderer.sendSync('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  setTrayLabels: (labels) => ipcRenderer.invoke('tray:setLabels', labels),
  menuContextChanged: (ctx) => ipcRenderer.invoke('menu:context-changed', ctx),
  onFirstHideNotice: (listener) => {
    const wrap = (_evt, data) => listener(data)
    ipcRenderer.on('pear:event:first-hide-notice', wrap)
    return () => ipcRenderer.removeListener('pear:event:first-hide-notice', wrap)
  },
  onHiddenToTray: (listener) => {
    const wrap = () => listener()
    ipcRenderer.on('pear:event:hidden-to-tray', wrap)
    return () => ipcRenderer.removeListener('pear:event:hidden-to-tray', wrap)
  },
  onKeyboardCommand: (listener) => {
    const wrap = (_evt, id) => listener(id)
    ipcRenderer.on('keyboard:command', wrap)
    return () => ipcRenderer.removeListener('keyboard:command', wrap)
  },

  deepLink: {
    subscribe: (listener) => {
      const wrap = (_evt, payload) => listener(payload)
      ipcRenderer.on('deeplink', wrap)
      ipcRenderer.invoke('deeplink:flush').then((queued) => {
        for (const link of queued) listener(link)
      }).catch((err) => console.error('deeplink:flush failed:', err))
      return () => ipcRenderer.removeListener('deeplink', wrap)
    },
  },
})
