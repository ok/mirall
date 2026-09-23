import crypto from 'hypercore-crypto'
import sodium from 'sodium-native'
import b4a from 'b4a'
import Hypercore from 'hypercore'

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

// The name a participation's key derives from. The suffix re-rolls when a leave purges the space
// record, so a rejoin is a new participation; a record without one resolves to the unsuffixed name.
export function participationName(spaceId, driveSuffix) {
  return driveSuffix ? 'space-drive-' + spaceId + '-' + driveSuffix : 'space-drive-' + spaceId
}

// 'db' and the per-name namespace reproduce Hyperdrive's derivation for a drive of this name, so the
// id stays byte-identical to the drive key every existing peer already holds for this member. A pin
// test holds the output; changing either argument would change every member's participation id.
export function deriveParticipationKeyPair(masterSecret, spaceId, driveSuffix) {
  return deriveKeyPair(masterSecret, 'db', generateNamespace(DEFAULT_NAMESPACE, participationName(spaceId, driveSuffix)))
}

// The key a Corestore gives a core opened with that key pair: the hash of its single-signer manifest.
export function deriveParticipationId(masterSecret, spaceId, driveSuffix) {
  return Hypercore.key(deriveParticipationKeyPair(masterSecret, spaceId, driveSuffix).publicKey)
}

// 32-byte symmetric content key, domain-separated from the signing seeds above by a
// distinct top-level namespace so a content key can never collide with a keypair seed.
export function deriveContentKey(masterSecret, label) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash_batch(out, [CONTENT_NS, b4a.from(label)], masterSecret)
  return out
}
