// Derivations from a license key, part of the app↔Console contract: every label is frozen and
// pinned by the Console's bundle-v1.json "derivation". Unkeyed BLAKE2b-256 over label ‖ input, since
// sodium-native refuses a key shorter than 16 bytes and a license key is 15.
import sodium from 'sodium-native'
import b4a from 'b4a'

const BUNDLE_KEY = b4a.from('mirall/bundle-key/v2')
const KEY_HINT = b4a.from('mirall/key-hint/v1')
const ENROLL_KEY = b4a.from('mirall/enroll-key/v1')
export const KEY_HINT_BYTES = 8

function labelled(label, input) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.concat([label, input]))
  return out
}

export function bundleKeyPair(licenseKeyBytes) {
  const seed = labelled(BUNDLE_KEY, licenseKeyBytes)
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_seed_keypair(publicKey, secretKey, seed)
  sodium.sodium_memzero(seed)
  return { publicKey, secretKey }
}

// Proves the license once, at enrollment: the Console holds only the public half.
export function enrollKeyPair(licenseKeyBytes) {
  const seed = labelled(ENROLL_KEY, licenseKeyBytes)
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  sodium.sodium_memzero(seed)
  return { publicKey, secretKey }
}

export const keyHint = (bundlePublicKey) => labelled(KEY_HINT, bundlePublicKey).subarray(0, KEY_HINT_BYTES)
