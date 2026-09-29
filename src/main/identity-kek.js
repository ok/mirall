const electron = require('electron')
const fs = require('fs')
const path = require('path')
const { SECRET_FILE, resolveSecretFile } = require('../shared/contract/secret-files.js')
const crypto = require('crypto')

// The os-keychain provider's host side: a random KEK held under Electron
// safeStorage (Keychain / DPAPI / libsecret), persisted as kek.enc (where: see
// contract/secret-files.js). main hands the worker the KEK hex over the bootstrap — never M — so a
// copied app-storage without the OS credential cannot unwrap identity.enc.
const kekFile = (storagePath) => resolveSecretFile(storagePath, SECRET_FILE.KEK, { join: path.join, dirname: path.dirname, exists: fs.existsSync })

const KEK_HEX = /^[0-9a-f]{64}$/
const UNREADABLE = '.unreadable-'

const stampOf = (date) => date.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')

function readKEK(file, safeStorage) {
  try {
    const kekHex = safeStorage.decryptString(fs.readFileSync(file))
    return KEK_HEX.test(kekHex) ? kekHex : null
  } catch {
    return null
  }
}

function mintKEK(file, safeStorage) {
  const kekHex = crypto.randomBytes(32).toString('hex')
  const fd = fs.openSync(file, 'wx', 0o600)
  fs.writeSync(fd, safeStorage.encryptString(kekHex))
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  return kekHex
}

// safeStorage/platform are injectable so the policy is unit-testable without
// Electron (require('electron') is a path string, not the API, outside a runtime).
function resolveKEKHex(storagePath, { safeStorage = electron.safeStorage, platform = process.platform, now = new Date() } = {}) {
  // On Linux a minimal desktop (tiling Wayland WM like Hyprland/Omarchy, a bare
  // Arch WM, headless) often has no running keyring daemon, so safeStorage would
  // refuse to start at all. Opt into the basic_text fallback (a fixed in-memory
  // key) so we degrade to 'weak' protection — identity.enc then leans on full-disk
  // encryption — instead of failing closed. No-op on macOS/Windows, and on Linux it
  // only engages when no libsecret/KWallet backend is found, so users with a real
  // keyring keep full protection (getSelectedStorageBackend stays non-basic_text).
  if (platform === 'linux') safeStorage.setUsePlainTextEncryption(true)
  if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable')
  const file = kekFile(storagePath)
  if (fs.existsSync(file)) {
    const kekHex = readKEK(file, safeStorage)
    if (kekHex) return kekHex
    // This keychain cannot open kek.enc: it was reset, or the folder came from another machine or
    // account. The app still starts, the identity sealed under the old key locks for the user to
    // restore, and the unreadable key is kept in case the keychain can open it again.
    fs.renameSync(file, `${file}${UNREADABLE}${stampOf(now)}`)
    console.warn('[identity] kek.enc is unreadable with this keychain; kept it aside and minted a new key')
  }
  return mintKEK(kekFile(storagePath), safeStorage)
}

// "Try again" on the locked screen: a set-aside key this keychain can open now (access granted
// again, the keychain item restored) goes back in place of the minted one, newest first. It is asked
// only while the identity is locked, when the minted key has sealed nothing.
function recoverUnreadableKEK(storagePath, { safeStorage = electron.safeStorage, now = new Date() } = {}) {
  const file = kekFile(storagePath)
  const dir = path.dirname(file)
  const prefix = path.basename(file) + UNREADABLE
  const candidates = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)).sort().reverse()
  for (const name of candidates) {
    const kekHex = readKEK(path.join(dir, name), safeStorage)
    if (!kekHex) continue
    if (fs.existsSync(file)) fs.renameSync(file, `${file}.unused-${stampOf(now)}`)
    fs.renameSync(path.join(dir, name), file)
    return kekHex
  }
  return null
}

function storageBackend(safeStorage = electron.safeStorage) {
  try { return safeStorage.getSelectedStorageBackend() } catch { return null }
}

module.exports = { resolveKEKHex, recoverUnreadableKEK, storageBackend }
