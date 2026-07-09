import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Hypercore from 'hypercore'
import { signNoiseBinding, checkGrantAssertion } from '../../src/shared/transfer/handshake-guard.js'
import { reconcileAssertedRoot } from '../../src/shared/spaces/creator-root.js'

const hex = (n = 32) => b4a.toString(crypto.randomBytes(n), 'hex')

// A membership:grant carrying the MIR-03 binding rebound onto granterKey: the granter's
// profile core is a single-writer manifest (granterKey is the manifest hash), the signer
// keypair signs the ephemeral Noise key, and the joiner verifies against that Noise key.
function boundGranter ({ creator } = {}) {
  const signer = crypto.keyPair()
  const namespace = crypto.randomBytes(32)
  const noise = crypto.keyPair()
  const manifest = {
    version: 1, hash: 'blake2b', allowPatch: false, quorum: 1,
    signers: [{ signature: 'ed25519', namespace, publicKey: signer.publicKey }],
    prologue: null, linked: null, userData: null,
  }
  const granterKey = b4a.toString(Hypercore.key(manifest), 'hex')
  const msg = {
    type: 'membership:grant',
    spaceTopic: hex(),
    sck: hex(),
    creator: creator ?? hex(),
    granterKey,
    sig: signNoiseBinding(noise.publicKey, signer.secretKey),
    signerKey: b4a.toString(signer.publicKey, 'hex'),
    signerNs: b4a.toString(namespace, 'hex'),
  }
  return { signer, namespace, noise, granterKey, msg }
}

test('checkGrantAssertion accepts a correctly-bound granter when enforced', (t) => {
  const { noise, granterKey, msg } = boundGranter()
  const verdict = checkGrantAssertion({ publicKey: noise.publicKey }, msg, { enforceBinding: true })
  t.ok(verdict.ok)
  t.is(verdict.creator, msg.creator)
  t.is(verdict.granterKey, granterKey)
})

test('REGRESSION (MIR-26: forged creator in grant is rejected when bound)', (t) => {
  const { msg } = boundGranter()
  // Attacker holds a different Noise key (Noise proves possession), but the binding signs the
  // victim granter's Noise key → the rebind to granterKey fails to verify on this connection.
  const verdict = checkGrantAssertion({ publicKey: crypto.keyPair().publicKey }, msg, { enforceBinding: true })
  t.absent(verdict.ok)
  t.is(verdict.reason, 'granter-unbound')
})

test('checkGrantAssertion rejects a malformed creator regardless of enforcement', (t) => {
  const { noise, msg } = boundGranter()
  const bad = { ...msg, creator: 'not-hex' }
  t.is(checkGrantAssertion({ publicKey: noise.publicKey }, bad, { enforceBinding: true }).reason, 'malformed-creator')
  t.is(checkGrantAssertion({ publicKey: noise.publicKey }, bad, { enforceBinding: false }).reason, 'malformed-creator')
})

test('checkGrantAssertion: a pre-MIR-26 granter (no granterKey) is lenient only when unenforced', (t) => {
  const legacy = { type: 'membership:grant', spaceTopic: hex(), sck: hex(), creator: hex() }
  t.is(checkGrantAssertion(null, legacy, { enforceBinding: true }).reason, 'no-granter')
  const lenient = checkGrantAssertion(null, legacy, { enforceBinding: false })
  t.ok(lenient.ok)
  t.is(lenient.creator, legacy.creator)
  t.is(lenient.granterKey, null)
})

test('checkGrantAssertion: capability phase admits without verifying the binding', (t) => {
  const { noise, msg } = boundGranter()
  const verdict = checkGrantAssertion({ publicKey: noise.publicKey }, msg, { enforceBinding: false })
  t.ok(verdict.ok)
  t.is(verdict.creator, msg.creator)
})

test('checkGrantAssertion: null peerInfo is a trusted local replay', (t) => {
  const { msg } = boundGranter()
  t.ok(checkGrantAssertion(null, msg, { enforceBinding: true }).ok)
})

test('checkGrantAssertion: a grant with no creator yields creator=null', (t) => {
  const { noise, msg } = boundGranter()
  delete msg.creator
  const verdict = checkGrantAssertion({ publicKey: noise.publicKey }, msg, { enforceBinding: true })
  t.ok(verdict.ok)
  t.is(verdict.creator, null)
})

test('reconcileAssertedRoot decision table — the contract onGrant and the handshake share', (t) => {
  const a = hex()
  const b = hex()
  t.is(reconcileAssertedRoot({ pinned: a, pinnedIsAuthenticated: true, asserted: null }), 'noop', 'no assertion → noop')
  t.is(reconcileAssertedRoot({ pinned: null, pinnedIsAuthenticated: false, asserted: a }), 'adopt', 'nothing pinned → adopt')
  t.is(reconcileAssertedRoot({ pinned: a, pinnedIsAuthenticated: false, asserted: a }), 'confirm', 'provisional + match → confirm')
  t.is(reconcileAssertedRoot({ pinned: b, pinnedIsAuthenticated: false, asserted: a }), 'adopt', 'provisional + differ → adopt (defeats forged invite)')
  t.is(reconcileAssertedRoot({ pinned: a, pinnedIsAuthenticated: true, asserted: a }), 'noop', 'authenticated + match → noop')
  t.is(reconcileAssertedRoot({ pinned: a, pinnedIsAuthenticated: true, asserted: b }), 'refuse', 'authenticated + differ → refuse')
})
