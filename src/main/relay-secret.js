const electron = require('electron')
const fs = require('fs')
const path = require('path')
const sodium = require('sodium-native')

// The member seed behind a private-relay ticket, at rest. It is a bearer credential — whoever holds
// it can present that member identity at that relay — so it does not go in config.json, which is
// plain text, lands in backups, and is the file a user copies when they move machines. It is
// written under Electron safeStorage, beside kek.enc, mode 0600.
//
// A sealed vault is also read: {v: 2, nonce, ciphertext}, XChaCha20-Poly1305 under a subkey of the
// identity KEK, which a runtime without Electron can open. The writer stays on safeStorage until a
// release that reads the sealed form has shipped, because an installed build (and a dev build
// sharing its store) that cannot read the vault silently loses the private relay.
const HEX_32 = /^[0-9a-f]{64}$/
const SEALED_VERSION = 2
const AAD = Buffer.from('mirall/relay-ticket/v2')
const SUBKEY_CONTEXT = Buffer.from('relaytkt')
const SUBKEY_ID = 1
const { crypto_aead_xchacha20poly1305_ietf_NPUBBYTES: NONCE_BYTES, crypto_aead_xchacha20poly1305_ietf_ABYTES: TAG_BYTES } = sodium

const seedFile = (storagePath) => path.join(path.dirname(storagePath), 'relay-ticket.enc')

// The KEK also wraps identity.enc; the vault gets its own subkey so no key serves two primitives.
function sealingKey(kekHex) {
  if (typeof kekHex !== 'string' || !HEX_32.test(kekHex)) throw new Error('a sealed relay seed needs the identity key')
  const key = Buffer.alloc(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
  sodium.crypto_kdf_derive_from_key(key, SUBKEY_ID, SUBKEY_CONTEXT, Buffer.from(kekHex, 'hex'))
  return key
}

// The sealed envelope, or null for a safeStorage blob (binary, never a JSON object with a version).
// A sealed envelope of a version this build does not know is an error, not a safeStorage blob.
function parseSealed(raw) {
  let env
  try { env = JSON.parse(raw.toString('utf-8')) } catch { return null }
  if (typeof env?.v !== 'number') return null
  if (env.v !== SEALED_VERSION) throw new Error(`unsupported sealed relay seed version ${env.v}`)
  return env
}

// Throws on a wrong key or a tampered file: the AEAD tag covers the ciphertext and the AAD.
function openSealed(env, kekHex) {
  const ciphertext = Buffer.from(String(env.ciphertext), 'base64')
  const nonce = Buffer.from(String(env.nonce), 'base64')
  if (nonce.length !== NONCE_BYTES || ciphertext.length < TAG_BYTES) throw new Error('malformed sealed relay seed')
  const seed = Buffer.alloc(ciphertext.length - TAG_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(seed, null, ciphertext, AAD, nonce, sealingKey(kekHex))
  return seed.toString('hex')
}

function readRelaySeedHex(storagePath, kekHex, { safeStorage = electron.safeStorage } = {}) {
  const file = seedFile(storagePath)
  try {
    if (!fs.existsSync(file)) return null
    const raw = fs.readFileSync(file)
    const sealed = parseSealed(raw)
    const hex = sealed ? openSealed(sealed, kekHex) : safeStorage.decryptString(raw)
    return HEX_32.test(hex) ? hex : null
  } catch (err) {
    // A vault we cannot read silently degrades the relay identity to an ephemeral key, and
    // the relay then stops admitting us with no diagnosable reason. Say so.
    console.warn('[relay] could not read the member seed:', err && err.message ? err.message : err)
    return null
  }
}

function writeRelaySeedHex(storagePath, seedHex, { safeStorage = electron.safeStorage } = {}) {
  if (!HEX_32.test(seedHex)) throw new Error('relay seed must be 32 hex-encoded bytes')
  const file = seedFile(storagePath)
  const tmp = file + '.tmp'
  const fd = fs.openSync(tmp, 'w', 0o600)
  try {
    fs.writeSync(fd, safeStorage.encryptString(seedHex))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

// Throws rather than swallowing: a seed we failed to delete is a durable member identity the
// config no longer accounts for, and the node would keep presenting it on every later boot with
// nothing on screen to explain why. The caller reports the failure instead of claiming success.
// `force` already makes a missing file a no-op, so anything reaching the catch is real — a
// locked file on Windows, EPERM, a read-only volume.
function clearRelaySeed(storagePath) {
  fs.rmSync(seedFile(storagePath), { force: true })
}

// test seam: seals a seed in the form readRelaySeedHex opens, which no production writer emits yet.
function _sealForTests(seedHex, kekHex) {
  const nonce = Buffer.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  const seed = Buffer.from(seedHex, 'hex')
  const ciphertext = Buffer.alloc(seed.length + TAG_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, seed, AAD, null, nonce, sealingKey(kekHex))
  return Buffer.from(JSON.stringify({ v: SEALED_VERSION, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') }))
}

// test seam: seedFile and _sealForTests are exported for tests only.
module.exports = { readRelaySeedHex, writeRelaySeedHex, clearRelaySeed, seedFile, _sealForTests }
