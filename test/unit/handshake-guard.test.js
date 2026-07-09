import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Hypercore from 'hypercore'
import {
  clampDisplayName, validSenderFrame, signNoiseBinding, verifyIdentityBinding, checkInboundSender,
  leaveFrameBound,
} from '../../src/shared/transfer/handshake-guard.js'

const hex = (n = 32) => b4a.toString(crypto.randomBytes(n), 'hex')

// Mirror the worker's single-writer profile core: profileKey is the manifest hash, the
// signer keypair is what actually signs, and the binding is over an ephemeral Noise key.
function boundSender () {
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
    spaceTopic: hex(),
    profileKey,
    sig: signNoiseBinding(noise.publicKey, signer.secretKey),
    signerKey: b4a.toString(signer.publicKey, 'hex'),
    signerNs: b4a.toString(namespace, 'hex'),
  }
  return { signer, namespace, noise, profileKey, msg }
}

test('clampDisplayName truncates to 80 and coerces empties/non-strings', (t) => {
  t.is(clampDisplayName('x'.repeat(200)).length, 80)
  t.is(clampDisplayName('Alice'), 'Alice')
  t.is(clampDisplayName(''), 'Unknown')
  t.is(clampDisplayName(undefined), 'Unknown')
  t.is(clampDisplayName(12345), 'Unknown')
})

test('validSenderFrame requires HEX64 profileKey + spaceTopic; driveKey optional but hex', (t) => {
  t.ok(validSenderFrame({ spaceTopic: hex(), profileKey: hex(), driveKey: hex() }))
  t.ok(validSenderFrame({ spaceTopic: hex(), profileKey: hex() }))
  t.absent(validSenderFrame({ spaceTopic: hex(), profileKey: 'not-hex' }))
  t.absent(validSenderFrame({ spaceTopic: 'short', profileKey: hex() }))
  t.absent(validSenderFrame({ spaceTopic: hex(), profileKey: hex(), driveKey: 'zz' }))
  t.absent(validSenderFrame({ profileKey: hex() }))
  t.absent(validSenderFrame({}))
})

test('verifyIdentityBinding accepts a correctly bound sender', (t) => {
  const { noise, msg } = boundSender()
  t.ok(verifyIdentityBinding({ publicKey: noise.publicKey }, msg))
})

test('REGRESSION (MIR-32): the driveKey is covered by the binding (V2), no-drive stays V1', (t) => {
  const { signer, namespace, noise, profileKey } = boundSender()
  const driveA = crypto.randomBytes(32)
  const driveB = crypto.randomBytes(32)
  const peerInfo = { publicKey: noise.publicKey }
  const bound = {
    spaceTopic: hex(),
    profileKey,
    driveKey: b4a.toString(driveA, 'hex'),
    sig: signNoiseBinding(noise.publicKey, signer.secretKey, driveA),
    signerKey: b4a.toString(signer.publicKey, 'hex'),
    signerNs: b4a.toString(namespace, 'hex'),
  }
  t.ok(verifyIdentityBinding(peerInfo, bound), 'a driveKey-bound handshake verifies')
  t.absent(verifyIdentityBinding(peerInfo, { ...bound, driveKey: b4a.toString(driveB, 'hex') }), 'swapping the driveKey breaks the binding')
  // The no-drive form (membership:request / membership:grant) still verifies as V1.
  const { noise: n2, msg } = boundSender()
  t.ok(verifyIdentityBinding({ publicKey: n2.publicKey }, msg), 'a no-driveKey binding still verifies (V1)')
})

test('accept-both: a V1 signature with a driveKey in the frame still verifies (rolling upgrade)', (t) => {
  // A legacy/un-upgraded peer signs V1 (noise only) but still puts its driveKey in the frame. The
  // upgraded verifier must fall back from V2 to V1 so it does not reject the old peer.
  const { signer, namespace, noise, profileKey } = boundSender()
  const msg = {
    spaceTopic: hex(),
    profileKey,
    driveKey: b4a.toString(crypto.randomBytes(32), 'hex'),
    sig: signNoiseBinding(noise.publicKey, signer.secretKey),   // V1 sig: no driveKeyBuf
    signerKey: b4a.toString(signer.publicKey, 'hex'),
    signerNs: b4a.toString(namespace, 'hex'),
  }
  t.ok(verifyIdentityBinding({ publicKey: noise.publicKey }, msg), 'V1-signed handshake with a driveKey verifies via the V1 fallback')
})

test('verifyIdentityBinding rejects a signature replayed onto a different connection', (t) => {
  const { msg } = boundSender()
  // The attacker holds a different Noise key (Noise proves possession of it), but the
  // signature is over the victim's Noise key → no match. This is why no nonce is needed.
  t.absent(verifyIdentityBinding({ publicKey: crypto.keyPair().publicKey }, msg))
})

test('verifyIdentityBinding rejects a signer/namespace that does not hash to profileKey', (t) => {
  const victim = boundSender()
  const attacker = boundSender()
  // Attacker signs its OWN Noise key with its OWN signer, but claims the victim's
  // profileKey. The reconstructed manifest hashes to the attacker's key, not the victim's.
  const forged = { ...attacker.msg, profileKey: victim.profileKey }
  t.absent(verifyIdentityBinding({ publicKey: attacker.noise.publicKey }, forged))
})

test('verifyIdentityBinding rejects malformed / missing binding fields', (t) => {
  const { noise, msg } = boundSender()
  const peerInfo = { publicKey: noise.publicKey }
  t.absent(verifyIdentityBinding(peerInfo, { ...msg, sig: undefined }))
  t.absent(verifyIdentityBinding(peerInfo, { ...msg, sig: 'beef' }))
  t.absent(verifyIdentityBinding(peerInfo, { ...msg, signerKey: 'not-hex' }))
  t.absent(verifyIdentityBinding(peerInfo, { ...msg, signerNs: undefined }))
  t.absent(verifyIdentityBinding({}, msg))
})

test('checkInboundSender: malformed always rejected, regardless of enforcement', (t) => {
  const bad = { profileKey: 'nope', spaceTopic: hex() }
  t.is(checkInboundSender({ publicKey: crypto.randomBytes(32) }, bad, { enforceBinding: true }).reason, 'malformed')
  t.is(checkInboundSender({ publicKey: crypto.randomBytes(32) }, bad, { enforceBinding: false }).reason, 'malformed')
})

test('checkInboundSender: binding only enforced when the flag is on', (t) => {
  const { noise, msg } = boundSender()
  const peerInfo = { publicKey: noise.publicKey }
  const spoof = { spaceTopic: msg.spaceTopic, profileKey: msg.profileKey }

  t.ok(checkInboundSender(peerInfo, msg, { enforceBinding: true }).ok, 'bound sender admitted')
  t.is(checkInboundSender(peerInfo, spoof, { enforceBinding: true }).reason, 'identity-unbound', 'unsigned rejected when enforced')
  t.ok(checkInboundSender(peerInfo, spoof, { enforceBinding: false }).ok, 'unsigned admitted pre-saturation')
})

test('checkInboundSender: null peerInfo is a trusted internal replay', (t) => {
  const { msg } = boundSender()
  t.ok(checkInboundSender(null, msg, { enforceBinding: true }).ok)
})

// A leave frame carries no spaceTopic — only the sender's identity binding. leaveFrameBound is the
// robust accept path (FIX-240) that lets a co-member honor a leave even after the per-socket auth
// index was torn down, without ever letting a third party evict a member.
function boundLeave () {
  const { noise, msg } = boundSender()
  const { spaceTopic, ...leave } = msg   // a real leave frame has spaceId, not spaceTopic
  return { noise, msg: { type: 'leave', spaceId: hex().slice(0, 16), ...leave } }
}

test('leaveFrameBound accepts a correctly bound leaver', (t) => {
  const { noise, msg } = boundLeave()
  t.ok(leaveFrameBound({ publicKey: noise.publicKey }, msg))
})

test('leaveFrameBound rejects a binding replayed onto a different connection', (t) => {
  const { msg } = boundLeave()
  t.absent(leaveFrameBound({ publicKey: crypto.keyPair().publicKey }, msg),
    'sig is bound to the leaver Noise key — a different connection cannot present it')
})

test('leaveFrameBound rejects a signer/namespace that does not hash to profileKey', (t) => {
  const { noise, msg } = boundLeave()
  t.absent(leaveFrameBound({ publicKey: noise.publicKey }, { ...msg, profileKey: hex() }))
})

test('leaveFrameBound rejects malformed / missing binding fields', (t) => {
  const { noise, msg } = boundLeave()
  const peerInfo = { publicKey: noise.publicKey }
  t.absent(leaveFrameBound(peerInfo, { ...msg, sig: undefined }))
  t.absent(leaveFrameBound(peerInfo, { ...msg, profileKey: 'not-hex' }))
  t.absent(leaveFrameBound(peerInfo, { ...msg, signerKey: undefined }))
  t.absent(leaveFrameBound(null, msg), 'no peerInfo → not bound (falls back to the socket-index path)')
})
