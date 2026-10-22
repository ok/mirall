'use strict'

// The backup's main-process side: what a picked or typed folder is — whether it shares a disk with
// Mirall's own data (the failure a backup is meant to survive) and whether it holds files a backup may
// not start beside — and putting back the host's groups of the settings a restored backup carried. The
// worker puts back its own groups (downloads, network) when it stages the restore.
const fs = require('fs')
const path = require('path')
const { BACKUP_SETTING_GROUPS } = require('../shared/contract/backup-settings.js')
const { fitsNewBackup } = require('../shared/contract/backup-folder.js')

function sameDisk(a, b) {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev
  } catch {
    return false
  }
}

async function otherFiles(folder) {
  try {
    return !fitsNewBackup(await fs.promises.readdir(folder))
  } catch {
    return false
  }
}

function isFolder(folder) {
  try {
    return fs.statSync(folder).isDirectory()
  } catch {
    return false
  }
}

// Null unless the path names an existing folder: a typed path is not known to be one.
async function describeFolder(folder, dataDir) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || !isFolder(folder)) return null
  return { folder, sameDisk: sameDisk(folder, dataDir), otherFiles: await otherFiles(folder) }
}

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

function applyRestoredSettings(json, { store }) {
  const { appearance, notifications } = restoredGroups(json)
  store.setRenderer({ appearance, notifications })
}

function registerBackupIpc({ ipcMain, config, pickDirectory, dataDir }) {
  ipcMain.handle('backup:browse', async (evt, defaultPath) => {
    const folder = await pickDirectory(evt, defaultPath)
    return folder ? describeFolder(folder, dataDir()) : null
  })

  ipcMain.handle('backup:inspect', (_evt, folder) => describeFolder(folder, dataDir()))

  ipcMain.handle('backup:apply-settings', (_evt, json) => {
    if (typeof json !== 'string') throw new Error('Settings must be a string')
    applyRestoredSettings(json, { store: config() })
    return config().rendererSnapshot()
  })
}

module.exports = { applyRestoredSettings, registerBackupIpc }
