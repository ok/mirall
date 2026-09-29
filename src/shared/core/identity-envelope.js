import sodium from 'sodium-native'
import b4a from 'b4a'

// The envelopes that wrap a secret under a key: v1 is secretbox (no header authentication), v2 is
// an AEAD whose associated data authenticates the header. Runtime-agnostic (sodium-native, loads under
// Bare) so the same code can run in any host process. The key is supplied by an unlock provider or
// derived from a passphrase; this file never touches Electron.
/** @internal */
export const KEK_BYTES = sodium.crypto_secretbox_KEYBYTES
const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES

/** @internal */
export function randomKEK() {
  const k = b4a.alloc(KEK_BYTES)
  sodium.randombytes_buf(k)
  return k
}

export function wrap(masterSecret, kek) {
  const nonce = b4a.alloc(NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  const ciphertext = b4a.alloc(masterSecret.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(ciphertext, masterSecret, nonce, kek)
  return { nonce, ciphertext }
}

export function unwrap({ nonce, ciphertext }, kek) {
  if (nonce.length !== NONCE_BYTES || ciphertext.length < sodium.crypto_secretbox_MACBYTES) return null
  const out = b4a.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
  if (!sodium.crypto_secretbox_open_easy(out, ciphertext, nonce, kek)) return null
  return out
}

const AEAD_NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
const AEAD_TAG_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES

// XChaCha20-Poly1305: the tag covers the ciphertext and `aad`, so a changed header fails exactly like
// a wrong key. Random nonces are safe at this nonce length.
export function seal(secret, key, aad) {
  const nonce = b4a.alloc(AEAD_NONCE_BYTES)
  sodium.randombytes_buf(nonce)
  const ciphertext = b4a.alloc(secret.length + AEAD_TAG_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, secret, aad, null, nonce, key)
  return { nonce, ciphertext }
}

export function open({ nonce, ciphertext }, key, aad) {
  if (nonce.length !== AEAD_NONCE_BYTES || ciphertext.length < AEAD_TAG_BYTES) return null
  const out = b4a.alloc(ciphertext.length - AEAD_TAG_BYTES)
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(out, null, ciphertext, aad, nonce, key)
  } catch {
    return null
  }
  return out
}
