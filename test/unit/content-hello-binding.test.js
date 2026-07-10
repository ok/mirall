import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Hypercore from 'hypercore'
import { signNoiseBinding, verifyIdentityBinding } from '../../src/shared/transfer/handshake-guard.js'

// The content plane authenticates each connection with a mirall/content-hello frame that binds
// the profileKey to THIS connection's Noise key, reusing signNoiseBinding / verifyIdentityBinding.
// A content-hello carries no spaceTopic and no driveKey, so it rides the V1 binding
// (context || noiseKey). These assert the exact frame content-swarm builds and its anti-replay.
function contentHello () {
  const signer = crypto.keyPair()
  const namespace = crypto.randomBytes(32)
  const noise = crypto.keyPair()
  const manifest = {
    version: 1, hash: 'blake2b', allowPatch: false, quorum: 1,
    signers: [{ signature: 'ed25519', namespace, publicKey: signer.publicKey }],
    prologue: null, linked: null, userData: null,
  }
  const profileKey = b4a.toString(Hypercore.key(manifest), 'hex')
  const msg = {
    type: 'content-hello',
    profileKey,
    sig: signNoiseBinding(noise.publicKey, signer.secretKey),
    signerKey: b4a.toString(signer.publicKey, 'hex'),
    signerNs: b4a.toString(namespace, 'hex'),
  }
  return { signer, namespace, noise, profileKey, msg }
}

test('content-hello verifies against the Noise key it was signed for', (t) => {
  const { noise, msg } = contentHello()
  t.ok(verifyIdentityBinding({ publicKey: noise.publicKey }, msg))
})

test('content-hello replayed onto another content connection is rejected', (t) => {
  const { msg } = contentHello()
  // The attacker's content connection has a different Noise key (Noise proves possession); the
  // signature is over the victim's content Noise key, so it does not verify here.
  t.absent(verifyIdentityBinding({ publicKey: crypto.keyPair().publicKey }, msg))
})

test('content-hello with a signer that does not hash to profileKey is rejected', (t) => {
  const victim = contentHello()
  const attacker = contentHello()
  const forged = { ...attacker.msg, profileKey: victim.profileKey }
  t.absent(verifyIdentityBinding({ publicKey: attacker.noise.publicKey }, forged))
})

test('content-hello with malformed / missing binding fields is rejected', (t) => {
  const { noise, msg } = contentHello()
  const peerInfo = { publicKey: noise.publicKey }
  t.absent(verifyIdentityBinding(peerInfo, { ...msg, sig: undefined }))
  t.absent(verifyIdentityBinding(peerInfo, { ...msg, signerKey: 'not-hex' }))
  t.absent(verifyIdentityBinding(peerInfo, { ...msg, signerNs: undefined }))
  t.absent(verifyIdentityBinding({}, msg))
})
