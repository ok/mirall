import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Hypercore from 'hypercore'
import { signNoiseBinding } from '../../src/shared/network/handshake-guard.js'

// An identity the way the worker's single-writer profile core has one: profileKey is the manifest
// hash, the signer keypair is what actually signs, and the binding is over a Noise key. Passing the
// same signer and namespace with a new Noise key is the same profile on a new connection.
export function boundSender({ signer = crypto.keyPair(), namespace = crypto.randomBytes(32), noise = crypto.keyPair() } = {}) {
  const manifest = {
    version: 1, hash: 'blake2b', allowPatch: false, quorum: 1,
    signers: [{ signature: 'ed25519', namespace, publicKey: signer.publicKey }],
    prologue: null, linked: null, userData: null,
  }
  const profileKey = b4a.toString(Hypercore.key(manifest), 'hex')
  const fields = {
    profileKey,
    sig: signNoiseBinding(noise.publicKey, signer.secretKey),
    signerKey: b4a.toString(signer.publicKey, 'hex'),
    signerNs: b4a.toString(namespace, 'hex'),
  }
  return { signer, namespace, noise, profileKey, fields }
}
