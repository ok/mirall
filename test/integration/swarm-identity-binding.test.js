import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { getIdentitySigner, getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { signNoiseBinding, verifyIdentityBinding } from '../../src/shared/transfer/handshake-guard.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

const hex = (n = 32) => b4a.toString(crypto.randomBytes(n), 'hex')

// The flow test proves manifestFor() reproduces a real profile-core key end-to-end, but
// that path is slow (testnet + two workers). This is the fast, deterministic guard: a
// binding built from the REAL profile core's signer must verify against the REAL
// profileKey — i.e. handshake-guard's hard-coded manifest shape still matches what the
// worker's profile hypercore actually hashes to. If hypercore changes its manifest
// layout, or getIdentitySigner returns the wrong namespace, this fails immediately
// instead of only surfacing as a network partition.
test('a binding from the real profile signer verifies against the real profileKey', async (t) => {
  await freshPeerWithIdentity(t)
  const signer = getIdentitySigner()
  t.ok(signer?.secretKey && signer?.publicKey && signer?.namespace, 'identity signer is available in identity mode')

  // Stand-in for the swarm's ephemeral Noise static key (the real one is per-process).
  const noise = crypto.keyPair()
  const msg = {
    spaceTopic: hex(),
    profileKey: getLocalPublicKeyHex(),
    sig: signNoiseBinding(noise.publicKey, signer.secretKey),
    signerKey: b4a.toString(signer.publicKey, 'hex'),
    signerNs: b4a.toString(signer.namespace, 'hex'),
  }
  t.ok(verifyIdentityBinding({ publicKey: noise.publicKey }, msg),
    'manifest reconstruction matches the live core → binding verifies')
})

test('a different signer cannot claim our profileKey', async (t) => {
  await freshPeerWithIdentity(t)
  const signer = getIdentitySigner()
  const noise = crypto.keyPair()
  const other = crypto.keyPair()
  const forged = {
    spaceTopic: hex(),
    profileKey: getLocalPublicKeyHex(),                       // our identity…
    sig: signNoiseBinding(noise.publicKey, other.secretKey),  // …signed by a foreign key
    signerKey: b4a.toString(other.publicKey, 'hex'),
    signerNs: b4a.toString(signer.namespace, 'hex'),
  }
  t.absent(verifyIdentityBinding({ publicKey: noise.publicKey }, forged),
    'foreign signer/manifest does not hash to our profileKey')
})

