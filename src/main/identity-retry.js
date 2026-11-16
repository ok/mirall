'use strict'

// The locked screen's "Try again". A set-aside key this keychain can open now (access granted again,
// the keychain item restored) goes back in place of the minted one, and the running worker is handed
// the key it now holds: no restart, the worker opens the identity in place. The answer is whether it
// opened; a key that locks the worker again is false, not an error.
const { ipcMain } = require('electron')

function registerIdentityRetry({ recoverKEK, adoptKEK, retryUnlock }) {
  ipcMain.handle('identity:retry-unlock', async () => {
    const kekHex = recoverKEK()
    if (kekHex) adoptKEK(kekHex)
    return retryUnlock()
  })
}

module.exports = { registerIdentityRetry }
