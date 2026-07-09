import test from 'brittle'
import os from 'os'
import fs from 'fs'
import path from 'path'
import mod from '../../src/main/identity-kek.js'

const { resolveKEKHex, storageBackend } = mod

// A temp storage dir per call; kek.enc lands in dirname(storagePath).
function tmpStoragePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-kek-'))
  return path.join(dir, 'app-storage')
}

// Trivial reversible "cipher" so the kek.enc round-trip is observable.
const enc = (s) => Buffer.from('enc:' + s, 'utf8')
const dec = (buf) => buf.toString('utf8').replace(/^enc:/, '')

// Linux desktop with no running keyring daemon (Hyprland/Omarchy, bare WM, headless):
// backend is basic_text and isEncryptionAvailable() stays false until the app opts into
// the in-memory fallback via setUsePlainTextEncryption(true).
function linuxNoKeyring() {
  let plain = false
  const calls = []
  return {
    calls,
    setUsePlainTextEncryption(v) { plain = v; calls.push(v) },
    isEncryptionAvailable() { return plain },
    getSelectedStorageBackend() { return 'basic_text' },
    encryptString: enc,
    decryptString: dec,
  }
}

// Linux with a real backend (gnome-libsecret): available regardless of the opt-in, and
// the backend stays libsecret — the plaintext fallback must not downgrade it.
function linuxLibsecret() {
  const calls = []
  return {
    calls,
    setUsePlainTextEncryption(v) { calls.push(v) },
    isEncryptionAvailable() { return true },
    getSelectedStorageBackend() { return 'gnome_libsecret' },
    encryptString: enc,
    decryptString: dec,
  }
}

// macOS/Windows: Keychain/DPAPI available; getSelectedStorageBackend is Linux-only and
// throws off-Linux (storageBackend swallows it → null → 'protected').
function appleKeychain() {
  const calls = []
  return {
    calls,
    setUsePlainTextEncryption(v) { calls.push(v) },
    isEncryptionAvailable() { return true },
    getSelectedStorageBackend() { throw new Error('linux only') },
    encryptString: enc,
    decryptString: dec,
  }
}

test('REGRESSION (FIX-1: keyringless Linux degrades to weak, not fail-closed)', (t) => {
  const sp = tmpStoragePath()

  // The bug: without the Linux opt-in, a keyringless box reports encryption
  // unavailable and resolveKEKHex throws → "Mirall cannot start".
  t.exception(
    () => resolveKEKHex(sp, { safeStorage: linuxNoKeyring(), platform: 'darwin' }),
    /safeStorage unavailable/,
    'no opt-in → throws (pre-fix behaviour)'
  )

  // The fix: on Linux we opt into the basic_text fallback, so the same box resolves a
  // KEK and starts. main then maps basic_text → the already-built "weak" tier.
  const ss = linuxNoKeyring()
  const hex = resolveKEKHex(sp, { safeStorage: ss, platform: 'linux' })
  t.is(typeof hex, 'string')
  t.is(hex.length, 64, '32-byte KEK as hex')
  t.alike(ss.calls, [true], 'setUsePlainTextEncryption(true) called on Linux')
  t.ok(fs.existsSync(path.join(path.dirname(sp), 'kek.enc')), 'kek.enc persisted')
  t.is(storageBackend(ss), 'basic_text', 'backend reports basic_text → weak tier')
})

test('KEK persists: second resolve reads the same value back from kek.enc', (t) => {
  const sp = tmpStoragePath()
  const first = resolveKEKHex(sp, { safeStorage: linuxNoKeyring(), platform: 'linux' })
  const second = resolveKEKHex(sp, { safeStorage: linuxNoKeyring(), platform: 'linux' })
  t.is(second, first, 'decrypts the persisted KEK rather than minting a new one')
})

test('Linux with a real keyring keeps full protection (no downgrade)', (t) => {
  const sp = tmpStoragePath()
  const ss = linuxLibsecret()
  const hex = resolveKEKHex(sp, { safeStorage: ss, platform: 'linux' })
  t.is(hex.length, 64)
  t.is(storageBackend(ss), 'gnome_libsecret', 'backend stays libsecret → protected tier')
})

test('macOS resolves without touching the Linux plaintext opt-in', (t) => {
  const sp = tmpStoragePath()
  const ss = appleKeychain()
  const hex = resolveKEKHex(sp, { safeStorage: ss, platform: 'darwin' })
  t.is(hex.length, 64)
  t.alike(ss.calls, [], 'setUsePlainTextEncryption never called off-Linux')
  t.is(storageBackend(ss), null, 'Linux-only backend query → null → protected tier')
})

test('genuine unavailability still fails closed', (t) => {
  const sp = tmpStoragePath()
  const ss = appleKeychain()
  ss.isEncryptionAvailable = () => false
  t.exception(
    () => resolveKEKHex(sp, { safeStorage: ss, platform: 'darwin' }),
    /safeStorage unavailable/,
    'no secure storage anywhere → still throws (fatal dialog path preserved)'
  )
})
