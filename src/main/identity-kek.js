const electron = require('electron')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// The os-keychain provider's host side: a random KEK held under Electron
// safeStorage (Keychain / DPAPI / libsecret), persisted as kek.enc beside the
// store. main hands the worker the KEK hex over the bootstrap — never M — so a
// copied app-storage without the OS credential cannot unwrap identity.enc.
const kekFile = (storagePath) => path.join(path.dirname(storagePath), 'kek.enc')

// safeStorage/platform are injectable so the policy is unit-testable without
// Electron (require('electron') is a path string, not the API, outside a runtime).
function resolveKEKHex(storagePath, { safeStorage = electron.safeStorage, platform = process.platform } = {}) {
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
  if (fs.existsSync(file)) return safeStorage.decryptString(fs.readFileSync(file))
  const kekHex = crypto.randomBytes(32).toString('hex')
  const fd = fs.openSync(file, 'wx', 0o600)
  fs.writeSync(fd, safeStorage.encryptString(kekHex))
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  return kekHex
}

function storageBackend(safeStorage = electron.safeStorage) {
  try { return safeStorage.getSelectedStorageBackend() } catch { return null }
}

module.exports = { resolveKEKHex, storageBackend }
