'use strict'

// The backup's main-process side: the folder picker, and putting back the settings a restored backup
// carried. Main is config.json's only writer, so each group goes through the store's own setter and
// is checked there; a download folder is kept only when it can be used on this device.
const { BACKUP_SETTING_GROUPS } = require('../shared/contract/backup-settings.js')

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function restoredGroups(json) {
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    return {}
  }
  if (!isPlainObject(parsed)) return {}
  return Object.fromEntries(BACKUP_SETTING_GROUPS.filter((group) => isPlainObject(parsed[group])).map((group) => [group, parsed[group]]))
}

function applyRestoredSettings(json, { store, folderUsable }) {
  const { appearance, downloads, network, notifications } = restoredGroups(json)
  store.setRenderer({ appearance, notifications })
  if (network) store.setBandwidth(network)
  if (typeof downloads?.folder === 'string' && folderUsable(downloads.folder)) store.set('downloads.folder', downloads.folder)
}

function registerBackupIpc({ ipcMain, config, pickDirectory, validateDownloadFolder }) {
  ipcMain.handle('backup:browse', (evt) => pickDirectory(evt, config().get('backup.folder') || undefined))

  ipcMain.handle('backup:apply-settings', (_evt, json) => {
    if (typeof json !== 'string') throw new Error('Settings must be a string')
    const folderUsable = (folder) => {
      try {
        validateDownloadFolder(folder)
        return true
      } catch {
        return false
      }
    }
    applyRestoredSettings(json, { store: config(), folderUsable })
    return config().rendererSnapshot()
  })
}

module.exports = { applyRestoredSettings, registerBackupIpc }
