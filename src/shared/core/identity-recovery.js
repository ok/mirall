import sodium from 'sodium-native'
import b4a from 'b4a'
import { seal, open } from './identity-envelope.js'
import { deriveKeyPair } from './identity-keys.js'
import { AppError } from './errors.js'
import { CODES } from '../contract/errors.js'
import { ARG_MAX } from '../contract/limits.js'
import { RECOVERY_FILE_TYPE, RECOVERY_FILE_VERSION, RECOVERY_PASSPHRASE_MIN, isLongEnoughPassphrase, readRecoveryHeader } from '../contract/recovery-key.js'

// The portable recovery file: a bundle of identity secrets sealed under a key stretched from the
// user's passphrase with Argon2id, so it opens on any machine, unlike identity.enc, which is bound to
// this machine's keychain. The header travels in the clear and every field a reader trusts is bound
// into the AEAD's associated data, so none can be swapped, stripped or cheapened without failing the
// open. A wrong passphrase and a tampered file are indistinguishable by design.
export const MAX_RECOVERY_FILE_BYTES = ARG_MAX.recoveryFile

const KDF_ALG = 'argon2id'
const MASTER_SLOT = 'master'
const SECRET_HEX = /^[0-9a-f]{64}$/
const KEY_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES
const DEFAULT_KDF = { opslimit: sodium.crypto_pwhash_OPSLIMIT_SENSITIVE, memlimit: sodium.crypto_pwhash_MEMLIMIT_MODERATE }
// A file names its own cost, so a crafted one could ask for gigabytes or hours; these bound it.
const OPSLIMIT_RANGE = [sodium.crypto_pwhash_OPSLIMIT_MIN, sodium.crypto_pwhash_OPSLIMIT_SENSITIVE]
const MEMLIMIT_RANGE = [sodium.crypto_pwhash_MEMLIMIT_MIN, sodium.crypto_pwhash_MEMLIMIT_MODERATE]

const invalid = (why) => new AppError(CODES.RECOVERY_FILE_INVALID, `recovery file: ${why}`)
const inRange = (n, [min, max]) => Number.isInteger(n) && n >= min && n <= max

export function identityPublicKeyHex(masterSecret) {
  return b4a.toString(deriveKeyPair(masterSecret, 'profile').publicKey, 'hex')
}

export function wipeSecret(buf) {
  sodium.sodium_memzero(buf)
}

export function assertPassphrase(passphrase) {
  if (!isLongEnoughPassphrase(passphrase)) {
    throw new AppError(CODES.INVALID_ARGUMENT, `recovery: a passphrase needs at least ${RECOVERY_PASSPHRASE_MIN} characters`)
  }
}

function recoveryAad({ v, identityPub, createdAt, slots, kdf }) {
  return b4a.from([RECOVERY_FILE_TYPE, v, identityPub, createdAt, slots.join(','), kdf.alg, kdf.opslimit, kdf.memlimit, kdf.salt].join('|'))
}

async function stretch(passphrase, salt, { opslimit, memlimit }) {
  const key = sodium.sodium_malloc(KEY_BYTES)
  const pw = b4a.from(passphrase, 'utf-8')
  try {
    await sodium.crypto_pwhash_async(key, pw, salt, opslimit, memlimit, sodium.crypto_pwhash_ALG_ARGON2ID13)
  } finally {
    sodium.sodium_memzero(pw)
  }
  return key
}

// `slots` maps a slot name to its 32-byte secret; `master` (M) is required, and a reader ignores any
// slot it does not know, so a later secret joins the bundle without a new file version.
export async function buildRecoveryFile(slots, passphrase, { createdAt, kdf = DEFAULT_KDF }) {
  if (!slots[MASTER_SLOT]) throw new AppError(CODES.INVALID_ARGUMENT, 'recovery: the bundle needs a master secret')
  const salt = b4a.alloc(sodium.crypto_pwhash_SALTBYTES)
  sodium.randombytes_buf(salt)
  const header = {
    type: RECOVERY_FILE_TYPE,
    v: RECOVERY_FILE_VERSION,
    createdAt,
    identityPub: identityPublicKeyHex(slots[MASTER_SLOT]),
    slots: Object.keys(slots).sort(),
    kdf: { alg: KDF_ALG, opslimit: kdf.opslimit, memlimit: kdf.memlimit, salt: b4a.toString(salt, 'base64') },
  }
  const plain = b4a.from(JSON.stringify(Object.fromEntries(header.slots.map((name) => [name, b4a.toString(slots[name], 'hex')]))))
  const key = await stretch(passphrase, salt, kdf)
  try {
    const { nonce, ciphertext } = seal(plain, key, recoveryAad(header))
    return JSON.stringify({ ...header, nonce: b4a.toString(nonce, 'base64'), ciphertext: b4a.toString(ciphertext, 'base64') }, null, 2)
  } finally {
    sodium.sodium_memzero(key)
    sodium.sodium_memzero(plain)
  }
}

function parseHeader(text) {
  if (typeof text !== 'string' || b4a.byteLength(text) > MAX_RECOVERY_FILE_BYTES) throw invalid('too large')
  if (!readRecoveryHeader(text)) throw invalid('not a recovery key this build reads')
  const file = JSON.parse(text)
  if (!Array.isArray(file.slots) || !file.slots.includes(MASTER_SLOT)) throw invalid('no master slot')
  const kdf = file.kdf
  if (!kdf || kdf.alg !== KDF_ALG || !inRange(kdf.opslimit, OPSLIMIT_RANGE) || !inRange(kdf.memlimit, MEMLIMIT_RANGE)) {
    throw invalid('unsupported key derivation')
  }
  const salt = b4a.from(String(kdf.salt), 'base64')
  if (salt.length !== sodium.crypto_pwhash_SALTBYTES) throw invalid('bad salt')
  const nonce = b4a.from(String(file.nonce), 'base64')
  if (nonce.length !== sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES) throw invalid('bad nonce')
  return { file, salt, nonce, ciphertext: b4a.from(String(file.ciphertext), 'base64') }
}

// Opening a recovery file through the app: one at a time, and each wrong passphrase doubles the wait
// before the next attempt, to a ceiling. One throttle serves every request that opens a recovery file,
// so spreading guesses across them gains nothing. The Argon2 cost is what stands against an attacker
// holding the file; this only slows guessing through the app.
export function createPassphraseThrottle({ baseMs = 1000, ceilingMs = 30000 } = {}) {
  let failures = 0
  let queue = Promise.resolve()
  async function attempt(text, passphrase) {
    const wait = failures === 0 ? 0 : Math.min(ceilingMs, baseMs * 2 ** (failures - 1))
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    try {
      const opened = await openRecoveryFile(text, passphrase)
      failures = 0
      return opened
    } catch (err) {
      if (err?.code === CODES.WRONG_PASSPHRASE) failures++
      throw err
    }
  }
  return function openThrottled(text, passphrase) {
    const turn = queue.then(() => attempt(text, passphrase))
    queue = turn.catch(() => {})
    return turn
  }
}

export async function openRecoveryFile(text, passphrase) {
  const { file, salt, nonce, ciphertext } = parseHeader(text)
  const key = await stretch(passphrase, salt, file.kdf)
  let plain
  try {
    plain = open({ nonce, ciphertext }, key, recoveryAad(file))
  } finally {
    sodium.sodium_memzero(key)
  }
  if (!plain) throw new AppError(CODES.WRONG_PASSPHRASE, 'recovery: the passphrase does not open this file')
  try {
    const master = JSON.parse(b4a.toString(plain))[MASTER_SLOT]
    if (typeof master !== 'string' || !SECRET_HEX.test(master)) throw invalid('no master secret')
    return { masterSecret: b4a.from(master, 'hex'), identityPub: file.identityPub, createdAt: file.createdAt }
  } finally {
    sodium.sodium_memzero(plain)
  }
}
