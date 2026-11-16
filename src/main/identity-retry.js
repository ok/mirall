'use strict'

// The locked screen's "Try again". The running worker is asked first: only a worker locked by a key
// that could not open the identity has a key to replace. Then a set-aside key this keychain can open
// now (access granted again, the keychain item restored) goes back in place of the minted one, and the
// worker is handed the key it now holds: no restart, it opens the identity in place. A worker that is
// not locked is left alone — the key file is what its open identity is sealed under — and the screen
// is stale. The answer is whether the identity is open; a key that locks the worker again is false,
// not an error.
const { ipcMain } = require('electron')
const { IDENTITY_LOCK_CODES } = require('../shared/contract/errors.js')

function registerIdentityRetry({ workerStatus, recoverKEK, adoptKEK, retryUnlock }) {
  ipcMain.handle('identity:retry-unlock', async () => {
    const status = await workerStatus()
    if (!status.locked) return true
    if (!IDENTITY_LOCK_CODES.includes(status.code)) return false
    const kekHex = recoverKEK()
    if (kekHex) adoptKEK(kekHex)
    return retryUnlock()
  })
}

module.exports = { registerIdentityRetry }
