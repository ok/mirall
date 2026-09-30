import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import {
  clampDisplayName, validSenderFrame, signNoiseBinding, verifyIdentityBinding, checkInboundSender,
  leaveFrameBound, frameEpoch, checkControlSender, rosterPathOf, MAX_ROSTER_PATH,
} from '../../src/shared/network/handshake-guard.js'
import { boundSender as boundIdentity } from '../helpers/identity-binding.js'

const hex = (n = 32) => b4a.toString(crypto.randomBytes(n), 'hex')

function boundSender() {
  const sender = boundIdentity()
  return { ...sender, msg: { spaceTopic: hex(), ...sender.fields } }
}

test('clampDisplayName truncates to 80 and coerces empties/non-strings', (t) => {
  t.is(clampDisplayName('x'.repeat(200)).length, 80)
  t.is(clampDisplayName('Alice'), 'Alice')
  t.is(clampDisplayName(''), 'Unknown')
  t.is(clampDisplayName(undefined), 'Unknown')
  t.is(clampDisplayName(12345), 'Unknown')
})

test('validSenderFrame requires HEX64 profileKey + topicRef or spaceTopic; driveKey optional but hex', (t) => {
  t.ok(validSenderFrame({ topicRef: hex(), profileKey: hex() }), 'a space named by reference')
  t.absent(validSenderFrame({ topicRef: 'zz', profileKey: hex() }), 'a malformed reference names nothing')
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

test('REGRESSION (MIR-54: an unverified signer key was recorded while enforcement was off): the verdict reports whether the binding verified', (t) => {
  const { noise, msg } = boundSender()
  const peerInfo = { publicKey: noise.publicKey }
  const spoof = { ...msg, signerKey: b4a.toString(crypto.keyPair().publicKey, 'hex'), sig: hex(64) }

  t.is(checkInboundSender(peerInfo, msg, { enforceBinding: false }).bound, true, 'a real binding is bound with enforcement off')
  const off = checkInboundSender(peerInfo, spoof, { enforceBinding: false })
  t.ok(off.ok, 'an unbound frame is still admitted with enforcement off')
  t.is(off.bound, false, 'but it is not bound')
  t.is(checkInboundSender(peerInfo, spoof, { enforceBinding: true }).reason, 'identity-unbound')
  t.is(checkInboundSender(null, msg, { enforceBinding: true }).bound, false, 'a local replay is admitted, never bound')
})

test('checkInboundSender: null peerInfo is a trusted internal replay', (t) => {
  const { msg } = boundSender()
  t.ok(checkInboundSender(null, msg, { enforceBinding: true }).ok)
})

// A leave frame carries no spaceTopic — only the sender's identity binding. leaveFrameBound is the
// robust accept path (FIX-240) that lets a co-member honor a leave even after the per-socket auth
// index was torn down, without ever letting a third party evict a member.
function boundLeave() {
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

test('validSenderFrame never refuses a handshake over its loose-catalog epoch: the epoch is a hint, like the key', (t) => {
  const base = { spaceTopic: hex(), profileKey: hex() }
  t.ok(validSenderFrame(base), 'a handshake from a sender that predates the field')
  t.ok(validSenderFrame({ ...base, looseCatalogEpoch: 7 }))
  t.ok(validSenderFrame({ ...base, looseCatalogEpoch: '0' }), 'a malformed epoch degrades the hint, never the peer')
})

test('frameEpoch: absent → 0, non-negative integer → itself, anything else → null', (t) => {
  t.is(frameEpoch(undefined), 0)
  t.is(frameEpoch(null), 0)
  t.is(frameEpoch(0), 0)
  t.is(frameEpoch(4), 4)
  t.is(frameEpoch('1'), null)
  t.is(frameEpoch(-2), null)
  t.is(frameEpoch(2.5), null)
  t.is(frameEpoch({}), null)
  t.is(frameEpoch([1]), null)
})

test('checkControlSender proves the key a cancel or deny names on this socket', (t) => {
  const sender = boundIdentity()
  const on = { publicKey: sender.noise.publicKey }
  const other = { publicKey: crypto.keyPair().publicKey }
  t.alike(checkControlSender(on, { joinerKey: hex() }), { ok: true, senderKey: null }, 'a frame naming no sender is unbound')
  t.alike(checkControlSender(on, { ...sender.fields }), { ok: true, senderKey: sender.profileKey }, 'a binding over this socket proves the key')
  t.alike(checkControlSender(other, { ...sender.fields }), { ok: false, reason: 'sender-unbound' }, 'a binding captured from another socket proves nothing')
  t.alike(checkControlSender(on, { ...sender.fields, profileKey: hex() }), { ok: false, reason: 'sender-unbound' }, 'nor does one for a different key')
  t.alike(checkControlSender(on, { ...sender.fields, profileKey: 'zz' }), { ok: false, reason: 'sender-unbound' }, 'a malformed key is refused')
})

test('rosterPathOf accepts only a bounded chain of person keys from the creator to the denier', (t) => {
  const creatorKey = hex()
  const denierKey = hex()
  const mid = hex()
  const facts = { creatorKey, denierKey }
  t.alike(rosterPathOf({ rosterPath: [creatorKey, mid, denierKey] }, facts), [creatorKey, mid, denierKey], 'a chain that starts and ends right')
  t.is(rosterPathOf({}, facts), null, 'no path')
  t.is(rosterPathOf({ rosterPath: 'x' }, facts), null, 'not an array')
  t.is(rosterPathOf({ rosterPath: [mid, denierKey] }, facts), null, 'not rooted at the creator')
  t.is(rosterPathOf({ rosterPath: [creatorKey, mid] }, facts), null, 'not ending at the denier')
  t.is(rosterPathOf({ rosterPath: [creatorKey, mid.toUpperCase(), denierKey] }, facts), null, 'a key in a second spelling')
  t.is(rosterPathOf({ rosterPath: [creatorKey, mid, mid, denierKey] }, facts), null, 'a repeated key')
  const long = [creatorKey, ...Array.from({ length: MAX_ROSTER_PATH - 1 }, () => hex()), denierKey]
  t.is(rosterPathOf({ rosterPath: long }, facts), null, 'longer than the cap')
  t.is(rosterPathOf({ rosterPath: [creatorKey, denierKey] }, { creatorKey: null, denierKey }), null, 'no creator to root it')
})
