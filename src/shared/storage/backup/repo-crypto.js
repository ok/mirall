// The backup repository's keys and sealed blobs. The repository key is random, never derived from the
// master secret, and stored in the repository header wrapped under a key that is: only the identity
// that made the backup can open it. Every object and snapshot is sealed with XChaCha20-Poly1305 and
// padded to 4 KiB, so the target sees only bucketed sizes. An object is named by a keyed hash of its
// plaintext, so a repeat is stored once without the name revealing the content.
import sodium from 'sodium-native'
import b4a from 'b4a'
import { seal, open } from '../../core/identity-envelope.js'

const MAGIC = b4a.from('MBOB')
const VERSION = 1
const PAD = 4096
const NONCE = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
const KDF_CONTEXT = b4a.from('mbackup1')
const SUBKEY = Object.freeze({ id: 1, object: 2, snapshot: 3 })

const wrapAad = (repoId) => b4a.from(`mirall-backup|1|${repoId}`)

export function newRepoKey() {
  const key = b4a.alloc(32)
  sodium.randombytes_buf(key)
  return key
}

export function wrapRepoKey(repoKey, wrapKey, repoId) {
  const { nonce, ciphertext } = seal(repoKey, wrapKey, wrapAad(repoId))
  return { nonce: b4a.toString(nonce, 'base64'), ciphertext: b4a.toString(ciphertext, 'base64') }
}

export function unwrapRepoKey(wrap, wrapKey, repoId) {
  if (typeof wrap?.nonce !== 'string' || typeof wrap?.ciphertext !== 'string') return null
  return open({ nonce: b4a.from(wrap.nonce, 'base64'), ciphertext: b4a.from(wrap.ciphertext, 'base64') }, wrapKey, wrapAad(repoId))
}

export function repoSubkeys(repoKey) {
  const derive = (id) => {
    const out = b4a.alloc(32)
    sodium.crypto_kdf_derive_from_key(out, id, KDF_CONTEXT, repoKey)
    return out
  }
  return { id: derive(SUBKEY.id), object: derive(SUBKEY.object), snapshot: derive(SUBKEY.snapshot) }
}

export function objectId(keys, plain) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, plain, keys.id)
  return b4a.toString(out, 'hex')
}

function pad(plain) {
  const size = Math.ceil((plain.byteLength + 4) / PAD) * PAD
  const out = b4a.alloc(size)
  new DataView(out.buffer, out.byteOffset, 4).setUint32(0, plain.byteLength, true)
  out.set(plain, 4)
  return out
}

function unpad(padded) {
  if (padded.byteLength < 4) return null
  const length = new DataView(padded.buffer, padded.byteOffset, 4).getUint32(0, true)
  return length + 4 <= padded.byteLength ? padded.subarray(4, 4 + length) : null
}

export function sealBlob(key, plain, ad) {
  const { nonce, ciphertext } = seal(pad(plain), key, b4a.from(ad))
  return b4a.concat([MAGIC, b4a.from([VERSION]), nonce, ciphertext])
}

// The plaintext, or null for anything that is not a blob this key and associated data sealed.
export function openBlob(key, sealed, ad) {
  const head = MAGIC.length + 1
  if (sealed.byteLength < head + NONCE || !b4a.equals(sealed.subarray(0, MAGIC.length), MAGIC) || sealed[MAGIC.length] !== VERSION) return null
  const padded = open({ nonce: sealed.subarray(head, head + NONCE), ciphertext: sealed.subarray(head + NONCE) }, key, b4a.from(ad))
  return padded ? unpad(padded) : null
}
