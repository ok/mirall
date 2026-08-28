// Pure verification helpers for the mirall/handshake channel: frame shape checks, the
// identity binding (a signature tying the sender's profileKey to this socket's Noise key
// and, in its V2 form, to the sender's per-space drive key), the leave-frame and
// membership:grant assertion checks, and the per-socket rate limiter. Stateless apart from
// the limiter's token buckets; swarm.js is the caller.
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Hypercore from 'hypercore'
import { HEX64 } from '../invite-envelope.js'

export { clampDisplayName } from '../identity-limits.js'

const BINDING_CONTEXT = b4a.from('mirall/handshake-binding/v1')
const BINDING_CONTEXT_V2 = b4a.from('mirall/handshake-binding/v2')
const SIG_HEX = /^[0-9a-f]{128}$/i

// Shape check for frames that assert the SENDER's identity (handshake,
// membership:request). Rejects malformed hex before any b4a.from reaches the data
// layer, so a garbage key can't poison the in-memory maps.
export function validSenderFrame (msg) {
  if (typeof msg.spaceTopic !== 'string' || !HEX64.test(msg.spaceTopic)) return false
  if (typeof msg.profileKey !== 'string' || !HEX64.test(msg.profileKey)) return false
  if (msg.driveKey != null && (typeof msg.driveKey !== 'string' || !HEX64.test(msg.driveKey))) return false
  // A handshake may carry the asserter's member-set (OR-Set) root for the creator-root
  // divergence cross-check.
  if (msg.creator != null && (typeof msg.creator !== 'string' || !HEX64.test(msg.creator))) return false
  return true
}

function bindingMessage (noisePublicKey, driveKeyBuf) {
  return driveKeyBuf
    ? b4a.concat([BINDING_CONTEXT_V2, noisePublicKey, driveKeyBuf])
    : b4a.concat([BINDING_CONTEXT, noisePublicKey])
}

// Sign our own (ephemeral) Noise static key with the profile core's signing key. No
// nonce: the Noise key is unique and possession-proven by the transport handshake, so a
// captured signature can't be replayed onto a different connection (a different Noise key).
// A handshake carries a driveKey, so bind it too (V2): the signed message covers
// noise||driveKey, making the signature vary per space. A membership:request/grant has no
// driveKey and stays V1.
export function signNoiseBinding (noisePublicKey, signerSecretKey, driveKeyBuf = null) {
  return b4a.toString(crypto.sign(bindingMessage(noisePublicKey, driveKeyBuf), signerSecretKey), 'hex')
}

// profileKey is the profile core's manifest hash, not the raw signer key. Rebuild the
// single-writer manifest from the signer key + namespace the sender supplied and confirm
// it hashes to profileKey — binding the signer to the claimed identity. Hypercore.key is
// a pure function, so a wrong signer/namespace simply fails to match (fail-safe).
function manifestFor (signerKeyHex, namespaceHex) {
  return {
    version: 1,
    hash: 'blake2b',
    allowPatch: false,
    quorum: 1,
    signers: [{ signature: 'ed25519', namespace: b4a.from(namespaceHex, 'hex'), publicKey: b4a.from(signerKeyHex, 'hex') }],
    prologue: null,
    linked: null,
    userData: null,
  }
}

export function verifyIdentityBinding (peerInfo, msg) {
  if (!peerInfo?.publicKey) return false
  if (typeof msg.sig !== 'string' || !SIG_HEX.test(msg.sig)) return false
  if (typeof msg.signerKey !== 'string' || !HEX64.test(msg.signerKey)) return false
  if (typeof msg.signerNs !== 'string' || !HEX64.test(msg.signerNs)) return false
  try {
    const derived = b4a.toString(Hypercore.key(manifestFor(msg.signerKey, msg.signerNs)), 'hex')
    if (derived !== msg.profileKey) return false
    const sig = b4a.from(msg.sig, 'hex')
    const signer = b4a.from(msg.signerKey, 'hex')
    const driveKeyBuf = (typeof msg.driveKey === 'string' && HEX64.test(msg.driveKey)) ? b4a.from(msg.driveKey, 'hex') : null
    // Prefer the V2 binding (noise||driveKey); fall back to V1 (noise only) so a peer that
    // carries a driveKey in its frame but signs only the V1 binding (an older release) still
    // verifies during a rolling upgrade. The V1 fallback means the driveKey binding is
    // best-effort, not mandatory.
    if (driveKeyBuf && crypto.verify(bindingMessage(peerInfo.publicKey, driveKeyBuf), sig, signer)) return true
    return crypto.verify(bindingMessage(peerInfo.publicKey, null), sig, signer)
  } catch {
    return false
  }
}

// A leave frame asserts the SENDER (profileKey) leaves for itself. Admissible iff it carries a
// valid identity binding proving control of profileKey on THIS connection's Noise key — robust to
// the per-socket auth index being torn down / not-yet-populated during the leave/reconnect race,
// and unforgeable/unreplayable by a third party (the binding is over the sender's Noise key).
export function leaveFrameBound (peerInfo, msg) {
  if (typeof msg.profileKey !== 'string' || !HEX64.test(msg.profileKey)) return false
  return verifyIdentityBinding(peerInfo, msg)
}

// One decision for the swarm onmessage choke point. Hex validation always applies; the
// identity binding applies only when enforceBinding is on (post-saturation). peerInfo ==
// null marks a locally-originated replay (trusted).
export function checkInboundSender (peerInfo, msg, { enforceBinding }) {
  if (!validSenderFrame(msg)) return { ok: false, reason: 'malformed' }
  if (!enforceBinding) return { ok: true }
  if (peerInfo == null) return { ok: true }
  if (!verifyIdentityBinding(peerInfo, msg)) return { ok: false, reason: 'identity-unbound' }
  return { ok: true }
}

// Per-socket token bucket keyed on the connection's Noise key (unspoofable, vs the
// spoofable msg.profileKey). `burst` is a number or a getter re-read on every take, passed the
// count of distinct scopes this socket has presented (see trackScopes). The bucket keeps the
// debt (frames used, decaying at +1 / refillMs) rather than the tokens left, so a cap that
// grows admits the frames its growth allows at once, and a cap that shrinks tightens at once.
// take() reports ban:true after abuseThreshold consecutive drops — the drop counter resets on
// any grant and decays at the refill rate, so a sustained flood self-evicts while a peer that
// backs off, or one whose honest burst simply outran the window, never accumulates a ban.
//
// trackScopes records the distinct scope strings a socket presents (the caller passes one per
// take) so the cap can follow what THIS peer has actually proven rather than a global figure.
// The caller must only pass scopes it has already validated against its own set, which is what
// bounds the per-socket memory.
export function createRateLimiter ({ burst, refillMs, abuseThreshold, now = Date.now, trackScopes = false }) {
  const capOf = typeof burst === 'function' ? burst : () => burst
  const buckets = new Map()
  return {
    take (noiseKeyHex, scope = null) {
      const t = now()
      let b = buckets.get(noiseKeyHex)
      if (!b) buckets.set(noiseKeyHex, b = { used: 0, last: t, drops: 0, scopes: trackScopes ? new Set() : null })
      if (b.scopes && typeof scope === 'string') b.scopes.add(scope)
      const cap = capOf(b.scopes ? b.scopes.size : 0)
      if (!cap) return { ok: true, ban: false }
      const decayed = (t - b.last) / refillMs
      b.used = Math.max(0, b.used - decayed)
      b.drops = Math.max(0, b.drops - decayed)
      b.last = t
      if (b.used + 1 > cap) { b.drops += 1; return { ok: false, ban: b.drops >= abuseThreshold } }
      b.used += 1
      b.drops = 0
      return { ok: true, ban: false }
    },
    forget (noiseKeyHex) { buckets.delete(noiseKeyHex) },
    clear () { buckets.clear() },
    size () { return buckets.size },
  }
}

// Two independent token-bucket lanes sharing one ban surface, so a multi-space peer's
// frames for topics we DON'T have (dropped cheaply, before any signature verify) can never
// starve the one frame for a topic we DO have. Lane pick is the caller's topic match; each
// lane bans on its own consecutive-drop threshold — a flood is a flood whichever lane it
// lands in. The matched lane's honest burst is one frame per space the two peers SHARE, our
// reciprocal, and one re-send inside a refill window — so its cap is
// burst + burstPerTopic x (the distinct topics THIS socket has matched), re-read per take and
// never counted past the topics we actually hold. Scaling by the shared count rather than by
// our own total is what keeps a peer that matched a single topic at a small cap no matter how
// many spaces we are in. burst 0 still switches the lane off.
export function createDualRateLimiter ({ matched, unmatched, now = Date.now, topics = () => 0 }) {
  const perTopic = matched.burstPerTopic || 0
  const matchedBurst = (matchedTopics) => (matched.burst ? matched.burst + perTopic * Math.min(matchedTopics, topics()) : 0)
  const lanes = {
    matched: createRateLimiter({ ...matched, burst: matchedBurst, now, trackScopes: true }),
    unmatched: createRateLimiter({ ...unmatched, now }),
  }
  return {
    // `topic` is charged only on the matched lane, and the caller has already resolved it
    // against our own topics — so the per-socket scope set can never exceed our space count.
    take (noiseKeyHex, isMatched, topic = null) {
      return isMatched ? lanes.matched.take(noiseKeyHex, topic) : lanes.unmatched.take(noiseKeyHex)
    },
    forget (noiseKeyHex) {
      lanes.matched.forget(noiseKeyHex)
      lanes.unmatched.forget(noiseKeyHex)
    },
    clear () {
      lanes.matched.clear()
      lanes.unmatched.clear()
    },
  }
}

// A membership:grant asserts the space's OR-Set root (creator) AND that the SENDER is an
// authorized member making that claim. Reuses the identity binding to prove the sender
// controls granterKey on this connection (rebinding profileKey → granterKey), then checks the
// asserted creator is well-formed. Returns { ok, creator, granterKey } | { ok:false, reason }.
export function checkGrantAssertion (peerInfo, msg, { enforceBinding }) {
  if (typeof msg.creator === 'string' && !HEX64.test(msg.creator)) return { ok: false, reason: 'malformed-creator' }
  const creator = typeof msg.creator === 'string' ? msg.creator : null
  if (typeof msg.granterKey !== 'string' || !HEX64.test(msg.granterKey)) {
    // A granter on an older release asserts no granterKey — accept only when binding isn't enforced.
    return enforceBinding ? { ok: false, reason: 'no-granter' } : { ok: true, creator, granterKey: null }
  }
  if (!enforceBinding) return { ok: true, creator, granterKey: msg.granterKey }
  if (peerInfo == null) return { ok: true, creator, granterKey: msg.granterKey }  // local replay
  if (!verifyIdentityBinding(peerInfo, { ...msg, profileKey: msg.granterKey })) {
    return { ok: false, reason: 'granter-unbound' }
  }
  return { ok: true, creator, granterKey: msg.granterKey }
}
