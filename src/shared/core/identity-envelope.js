import sodium from 'sodium-native'
import b4a from 'b4a'

// secretbox envelope wrapping the master secret M under a KEK (key-encryption key).
// Runtime-agnostic (sodium-native, loads under Bare) so the same code can run in any
// host process, not just the worker. The KEK is supplied by an unlock provider; this
// file never touches Electron.
export const KEK_BYTES = sodium.crypto_secretbox_KEYBYTES
const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES

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
  const out = b4a.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
  if (!sodium.crypto_secretbox_open_easy(out, ciphertext, nonce, kek)) return null
  return out
}

export function zero(buf) {
  if (buf) sodium.sodium_memzero(buf)
}
