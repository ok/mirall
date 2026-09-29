// Saving and choosing a recovery key file. The worker seals and opens the key; main only moves the
// sealed text between a file the user picked and the renderer, so it never sees a secret.

const fs = require('fs')
const path = require('path')
const { app, ipcMain, dialog } = require('electron')
const { ARG_MAX } = require('../shared/contract/limits.js')

const FILTERS = [{ name: 'Mirall recovery key', extensions: ['mirallkey'] }]
const FILE_NAME = /^[\w.-]+\.mirallkey$/

async function saveRecoveryFile(win, file, { showSaveDialog = dialog.showSaveDialog, documentsDir = () => app.getPath('documents') } = {}) {
  const { fileName, content } = file ?? {}
  if (typeof fileName !== 'string' || !FILE_NAME.test(fileName)) throw new Error('recovery:save needs a .mirallkey file name')
  if (typeof content !== 'string' || Buffer.byteLength(content) > ARG_MAX.recoveryFile) throw new Error('recovery:save needs the sealed key')
  const result = await showSaveDialog(win, { defaultPath: path.join(documentsDir(), fileName), filters: FILTERS })
  if (result.canceled || !result.filePath) return { saved: false }
  await fs.promises.writeFile(result.filePath, content, { mode: 0o600 })
  return { saved: true }
}

async function openRecoveryFile(win, { showOpenDialog = dialog.showOpenDialog } = {}) {
  const result = await showOpenDialog(win, { properties: ['openFile'], filters: FILTERS })
  if (result.canceled || result.filePaths.length === 0) return { ok: false, reason: 'cancelled' }
  const filePath = result.filePaths[0]
  if ((await fs.promises.stat(filePath)).size > ARG_MAX.recoveryFile) return { ok: false, reason: 'too-large' }
  return { ok: true, fileName: path.basename(filePath), content: await fs.promises.readFile(filePath, 'utf-8') }
}

function registerRecoveryFile({ targetWindow }) {
  ipcMain.handle('recovery:save', (evt, file) => saveRecoveryFile(targetWindow(evt), file))
  ipcMain.handle('recovery:open', (evt) => openRecoveryFile(targetWindow(evt)))
}

module.exports = { registerRecoveryFile, saveRecoveryFile, openRecoveryFile }
