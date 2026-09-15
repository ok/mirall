// Everything an inbound peer frame passes through before a handler sees it: the size cap, the
// per-socket budget, the identity gate and the routing table.
//
// The order is the point. A frame is charged BEFORE it is decoded, because the budget exists to
// bound the work an unauthenticated peer can make us do and JSON.parse is that work. Only a frame
// whose topic we actually joined pays for signature verification.

import b4a from 'b4a'
import { createLogger } from '../core/logger.js'
import { PEER_FRAME, IDENTITY_ASSERTING } from '../contract/peer-frames.js'
import { HEX64 } from '../contract/invite-envelope.js'
import { getPeerFrameMaxBytes, getPeerFrameLimits, getHandshakeRateLimit, getResourceCaps, isHandshakeIdentityBindingEnabled, getIdentityFrameDropWindow } from '../core/runtime-config.js'
import { checkInboundSender, createDualRateLimiter, createRateLimiter, validFrameShape } from './handshake-guard.js'
import { handlePresenceFrame, handleShareIndexProgressFrame, handleSharePrepareProgressFrame, resolveSpaceIdForTopic } from './presence-broadcast.js'
import { handleLeaveFrame, handleLeaveAckFrame, handleMembershipCancelAck } from './leave-protocol.js'
import { spaceTopics, pendingRequesters, boundSignerKeys } from './swarm-registries.js'
import { handleHandshake } from './handshake-apply.js'

const log = createLogger('frame-intake')

const bannedNoiseKeys = new Set()       // Noise keys evicted for identity-frame flooding; the firewall rejects their reconnects
let rateLimiter = null                  // dual-lane per-socket identity-frame token bucket, built when the swarm opens
let frameLimiter = null                 // general per-socket budget charged for EVERY frame type
const droppedFrames = { oversize: 0, rate: 0, parse: 0, shape: 0, unknown: 0 }
function countDroppedFrame(reason) { droppedFrames[reason] += 1 }
function getDroppedFrameCounters() { return { ...droppedFrames } }
let testDrop = null                     // test-only inbound identity-frame drop window

// The membership-control handler is injected rather than imported: the composition root sets it at
// open, and importing the worker's handler here would close a cycle.
let getMembershipControlHandler = () => null

export function initFrameIntake(deps) {
  getMembershipControlHandler = deps.getMembershipControlHandler
}

// Built at swarm construction, from the caps live at that moment.
export function createFrameLimiters() {
  rateLimiter = createDualRateLimiter({ ...getHandshakeRateLimit(), topics: () => spaceTopics.size })
  frameLimiter = createRateLimiter(getPeerFrameLimits())
  const dropWindow = getIdentityFrameDropWindow()
  testDrop = dropWindow.count > 0 ? { ...dropWindow, seen: 0 } : null
}

export function isBannedNoiseKey(hex) {
  return bannedNoiseKeys.has(hex)
}

export function forgetPeerLimits(noiseHex) {
  rateLimiter?.forget(noiseHex)
}

export { getDroppedFrameCounters }

// One inbound frame, start to finish.
export function receiveFrame(conn, str) {
  const { socket, peerInfo, remoteKey, noiseHex } = conn
  // Charged BEFORE the decode: the point of a frame budget is to bound the work an
  // unauthenticated peer can make us do, and JSON.parse is that work. Every type is metered
  // here — the identity lanes below cover only handshake and membership:request, so without
  // this a peer could flood presence or share-prepare-progress (one renderer decoration
  // event per frame) at line rate.
  // str.length is a cheap lower bound on the UTF-8 size (every UTF-16 unit costs at least one
  // byte), so it rejects the clearly-oversized without a scan; byteLength settles the rest,
  // because a cap named in bytes that counted UTF-16 units would admit ~3x what it claims.
  const maxBytes = getPeerFrameMaxBytes()
  if (maxBytes > 0 && (str.length > maxBytes || b4a.byteLength(str) > maxBytes)) {
    countDroppedFrame('oversize')
    log.warn('dropping oversize peer frame:', str.length, 'bytes from', remoteKey + '...')
    return
  }
  if (noiseHex && frameLimiter) {
    const r = frameLimiter.take(noiseHex)
    if (!r.ok) {
      countDroppedFrame('rate')
      if (r.ban) {
        log.warn('evicting peer flooding the frame channel', remoteKey + '...')
        bannedNoiseKeys.add(noiseHex)
        try { peerInfo.ban(true) } catch {}
        socket.destroy()
      }
      return
    }
  }

  let msg
  // debug, not error: a malformed frame is metered and counted, and error-level would hand
  // any peer on the topic a log-spam primitive.
  try { msg = JSON.parse(str) } catch (err) { countDroppedFrame('parse'); log.debug('handshake parse error:', err.message); return }
  if (!validFrameShape(msg)) {
    countDroppedFrame('shape')
    log.debug('dropping malformed peer frame from', remoteKey + '...')
    return
  }

  // A frame asserting the SENDER's profileKey (handshake, membership:request) must be
  // well-formed and — when enforced — carry a signature binding the claimed profileKey to this
  // connection's Noise key. Gated before pendingRequesters.set so a spoofed request can't
  // capture a grant.
  if (IDENTITY_ASSERTING.includes(msg.type) && !admitIdentityFrame(conn, msg)) return

  try {
    dispatchFrame(conn, msg)
  } catch (err) {
    log.error('handshake dispatch error:', err)
  }
}

// Gate for frames that assert the sender's profileKey (handshake, membership:request).
// Order matters: resolve the topic FIRST (a Map scan, no crypto) and charge the lane it
// picks — frames for topics we didn't join are dropped cheaply on a generous lane and can
// never starve the shared-space frame. Only matched frames pay for signature verification and
// reach dispatch. Both lanes ban on a sustained flood. Returns false if the frame was
// dropped/rejected.
function admitIdentityFrame(conn, msg) {
  const { socket, peerInfo, remoteKey } = conn
  if (testDrop) {
    const i = testDrop.seen++
    if (i >= testDrop.after && i < testDrop.after + testDrop.count) {
      log.debug('TEST drop identity frame', msg.type, 'from', remoteKey + '...')
      return false
    }
  }
  const matched = typeof msg.spaceTopic === 'string' &&
    HEX64.test(msg.spaceTopic) && !!resolveSpaceIdForTopic(msg.spaceTopic)
  const noiseHex = peerInfo?.publicKey ? b4a.toString(peerInfo.publicKey, 'hex') : null
  if (noiseHex && rateLimiter) {
    // The topic is charged only when it matched one of ours, so the lane's cap grows with the
    // spaces this peer has actually proven it shares — not with our own space count.
    const r = rateLimiter.take(noiseHex, matched, matched ? msg.spaceTopic : null)
    if (!r.ok) {
      log.debug('rate-limited', msg.type, 'from', remoteKey + '...')
      if (r.ban) {
        log.warn('evicting flooding peer', remoteKey + '...')
        bannedNoiseKeys.add(noiseHex)
        try { peerInfo.ban(true) } catch {}
        socket.destroy()
      }
      return false
    }
  }
  if (!matched) {
    // Nothing to do with it (handleHandshake would return on the topic miss anyway) —
    // drop before paying for the signature verify.
    log.debug(msg.type, 'topic not matched locally:', String(msg.spaceTopic).slice(0, 16) + '...')
    return false
  }
  const verdict = checkInboundSender(peerInfo, msg, { enforceBinding: isHandshakeIdentityBindingEnabled() })
  if (!verdict.ok) {
    log.warn('rejected', msg.type, 'from', remoteKey + '... -', verdict.reason)
    return false
  }
  if (typeof msg.signerKey === 'string' && HEX64.test(msg.signerKey)) boundSignerKeys.set(msg.profileKey, msg.signerKey)
  return true
}

// A pending joiner has no drive/handshake yet, so remember its socket to deliver a grant later.
// Bounded by the pendingRequesters cap; an already-tracked requester re-registering is allowed.
function registerPendingRequester(conn, msg) {
  const { socket, remoteKey } = conn
  const cap = getResourceCaps().pendingRequesters
  if (!cap || pendingRequesters.size < cap || pendingRequesters.has(msg.profileKey)) {
    pendingRequesters.set(msg.profileKey, socket)
  } else {
    log.debug('pendingRequesters cap reached, dropping request from', remoteKey + '...')
  }
}

// The frame vocabulary and what each frame means live in contract/peer-frames.js; this is only the
// routing. A frame with no entry in the table is counted and dropped.
const PEER_FRAME_HANDLERS = Object.freeze({
  // Fire-and-forget: handleHandshake is async, so the synchronous try/catch around the dispatch
  // cannot catch its rejection. A failure handling one peer's handshake (e.g. a transiently
  // unopenable peer drive) must degrade that peer, not crash the worker.
  [PEER_FRAME.HANDSHAKE]: ({ socket, peerInfo }, msg) =>
    handleHandshake(socket, peerInfo, msg).catch((err) => log.warn('handshake handling failed:', err?.message || err)),
  [PEER_FRAME.PRESENCE]: ({ socket }, msg) => handlePresenceFrame(socket, msg),
  [PEER_FRAME.LEAVE]: ({ socket, peerInfo }, msg) => handleLeaveFrame(socket, peerInfo, msg),
  [PEER_FRAME.LEAVE_ACK]: ({ socket }, msg) => handleLeaveAckFrame(socket, msg),
  [PEER_FRAME.MEMBERSHIP_CANCEL_ACK]: ({ socket }, msg) => handleMembershipCancelAck(socket, msg),
  [PEER_FRAME.SHARE_INDEX_PROGRESS]: ({ socket }, msg) => handleShareIndexProgressFrame(socket, msg),
  [PEER_FRAME.SHARE_PREPARE_PROGRESS]: ({ socket }, msg) => handleSharePrepareProgressFrame(socket, msg),
  [PEER_FRAME.MEMBERSHIP_REQUEST]: toMembershipControl,
  [PEER_FRAME.MEMBERSHIP_GRANT]: toMembershipControl,
  [PEER_FRAME.MEMBERSHIP_DENY]: toMembershipControl,
  [PEER_FRAME.MEMBERSHIP_CANCEL]: toMembershipControl,
})

// The handler verifies a grant's identity binding and asserted root itself, which is why these
// four leave the swarm rather than being answered here.
function toMembershipControl(conn, msg) {
  const { socket, peerInfo, msgHandler } = conn
  if (msg.type === PEER_FRAME.MEMBERSHIP_REQUEST && msg.profileKey) registerPendingRequester(conn, msg)
  const reply = (payload) => { try { msgHandler.send(JSON.stringify(payload)) } catch {} }
  getMembershipControlHandler()?.(msg, { socket, peerInfo, reply })
}

function dispatchFrame(conn, msg) {
  const handle = PEER_FRAME_HANDLERS[msg.type]
  if (!handle) {
    countDroppedFrame('unknown')
    log.debug('ignoring unknown peer frame type:', msg.type)
    return
  }
  handle(conn, msg)
}

export function resetFrameIntake() {
  testDrop = null
  for (const k of Object.keys(droppedFrames)) droppedFrames[k] = 0
  bannedNoiseKeys.clear()
  rateLimiter?.clear()
  rateLimiter = null
  frameLimiter = null
}
