import crypto from 'hypercore-crypto'
import sodium from 'sodium-native'
import b4a from 'b4a'

// Reproduces Corestore's keypair derivation (corestore/index.js: NS, deriveSeed,
// generateNamespace, createKeyPair) so identity cores can be opened with an
// explicit keyPair instead of the persisted seed, while staying byte-identical to
// the keys that seed would derive — cores created by installs whose identity was
// the store seed keep their keys. Drift here breaks identity preservation — pinned
// by test/integration/identity-keys-pin.test.js.
const [NS] = crypto.namespace('corestore', 1)
const [CONTENT_NS] = crypto.namespace('mirall-space-content', 1)
const DEFAULT_NAMESPACE = b4a.alloc(32)

function generateNamespace(namespace, name) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash_batch(out, [namespace, b4a.from(name)])
  return out
}

function deriveSeed(masterSecret, namespace, name) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash_batch(out, [NS, namespace, b4a.from(name)], masterSecret)
  return out
}

export function deriveKeyPair(masterSecret, name, namespace = DEFAULT_NAMESPACE) {
  return crypto.keyPair(deriveSeed(masterSecret, namespace, name))
}

export function deriveDriveKeyPair(masterSecret, driveName) {
  return deriveKeyPair(masterSecret, 'db', generateNamespace(DEFAULT_NAMESPACE, driveName))
}

// 32-byte symmetric content key, domain-separated from the signing seeds above by a
// distinct top-level namespace so a content key can never collide with a keypair seed.
export function deriveContentKey(masterSecret, label) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash_batch(out, [CONTENT_NS, b4a.from(label)], masterSecret)
  return out
}
