// Everything an inbound peer frame passes through before a handler sees it: the size cap, the
// per-socket budget, the identity gate and the routing table.
//
// The order is the point. A frame is charged BEFORE it is decoded, because the budget exists to
// bound the work an unauthenticated peer can make us do and JSON.parse is that work. Only a frame
// that names a space we hold pays for signature verification.

import b4a from 'b4a'
import { createLogger } from '../core/logger.js'
import { PEER_FRAME, IDENTITY_ASSERTING, MEMBERSHIP_CONTROL_FRAMES } from '../contract/peer-frames.js'
import { getPeerFrameMaxBytes, getPeerFrameLimits, getHandshakeRateLimit, getConnectionCaps, isHandshakeIdentityBindingEnabled, getIdentityFrameDropWindow, isTopicRefsEnforced, getConvergenceConfig } from '../core/runtime-config.js'
import { checkInboundSender, createDualRateLimiter, createRateLimiter, validFrameShape } from './handshake-guard.js'
import { handlePresenceFrame, handleShareIndexProgressFrame, handleSharePrepareProgressFrame } from './presence-broadcast.js'
import { handleLeaveFrame, handleLeaveAckFrame, handleMembershipCancelAck, sendPendingCancelFrames, sendPendingLeaveFrames } from './leave-protocol.js'
import { sendSingleHandshake } from './identity-frames.js'
import { frameSpace, noteLegacyTopic, rememberUnheldTopic, noteSpaceProven } from './topic-refs.js'
import { handleShareWaitFrame } from './share-wait.js'
import { spaceTopics, boundSignerKeys, parkPendingRequester } from './swarm-registries.js'
import { handleHandshake } from './handshake-apply.js'

const log = createLogger('frame-intake')

const bannedNoiseKeys = new Set()       // Noise keys evicted for identity-frame flooding; the firewall rejects their reconnects
let rateLimiter = null                  // dual-lane per-socket identity-frame token bucket, built when the swarm opens
let frameLimiter = null                 // general per-socket budget charged for EVERY frame type
const droppedFrames = { oversize: 0, rate: 0, parse: 0, shape: 0, unknown: 0 }
function countDroppedFrame(reason) { droppedFrames[reason] += 1 }
function getDroppedFrameCounters() { return { ...droppedFrames } }
let testDrop = null                     // test-only inbound identity-frame drop window
const spaceRefAnswers = new WeakMap()   // socket → Map<spaceId, when we last answered its space-ref>

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

  const named = frameSpace(msg, socket)
  if (named?.legacy && noteLegacyTopic(socket, named.spaceId)) answerInBearerForm(conn, named.spaceId)
  if (!named) rememberUnheldTopic(socket, msg)
  const spaceId = named?.spaceId ?? null

  // A frame asserting the SENDER's profileKey (handshake, membership:request) must be
  // well-formed and — when enforced — carry a signature binding the claimed profileKey to this
  // connection's Noise key. Gated before pendingRequesters.set so a spoofed request can't
  // capture a grant.
  let bound = false
  if (IDENTITY_ASSERTING.includes(msg.type)) {
    const admitted = admitIdentityFrame(conn, msg, spaceId)
    if (!admitted) return
    bound = admitted.bound
  }
  answerSpaceNamed(conn, msg, named)

  try {
    dispatchFrame(conn, msg, spaceId, bound)
  } catch (err) {
    log.error('handshake dispatch error:', err)
  }
}

// A frame that names a space by reference, and passed the identity gate if it asserts an identity,
// proves the sender holds the topic. With topic refs enforced the first proof on a socket is answered
// with what an unproven socket is not sent. A space-ref asks for our identity frame: the first is
// answered at once, since its sender never matched what we sent before it held the space, and a
// repeat once per floor window.
function answerSpaceNamed(conn, msg, named) {
  if (!named || named.legacy) return
  const { spaceId } = named
  const first = noteSpaceProven(conn.socket, spaceId)
  const asked = msg.type === PEER_FRAME.SPACE_REF && spaceRefAnswerDue(conn.socket, spaceId)
  if (first && isTopicRefsEnforced()) answerProvenSpace(conn, spaceId)
  else if (asked) sendSingleHandshake(conn.socket, conn.msgHandler, spaceId).catch((err) => log.debug('space-ref answer failed:', err?.message || err))
}

// Stamped before the answer is built, so a burst of space-refs is answered once.
function spaceRefAnswerDue(socket, spaceId) {
  let answered = spaceRefAnswers.get(socket)
  if (!answered) spaceRefAnswers.set(socket, (answered = new Map()))
  const now = Date.now()
  const last = answered.get(spaceId)
  if (last !== undefined && now - last < getConvergenceConfig().dupReciprocalFloorMs) return false
  answered.set(spaceId, now)
  return true
}

function answerProvenSpace({ socket, msgHandler }, spaceId) {
  sendSingleHandshake(socket, msgHandler, spaceId).catch((err) => log.debug('proven-space handshake failed:', err?.message || err))
  sendPendingLeaveFrames(socket, msgHandler, { onlySpaceId: spaceId })
  sendPendingCancelFrames(socket, msgHandler, { onlySpaceId: spaceId })
}

// A peer that names a space by its bearer topic cannot read a topicRef, so what we sent it for that
// space is sent again in its form, now that it has shown it holds the topic.
function answerInBearerForm({ socket, msgHandler }, spaceId) {
  sendSingleHandshake(socket, msgHandler, spaceId).catch((err) => log.debug('bearer-form handshake failed:', err?.message || err))
  sendPendingCancelFrames(socket, msgHandler, { onlySpaceId: spaceId, resend: true })
}

// Gate for frames that assert the sender's profileKey (handshake, membership:request).
// Order matters: the space is resolved FIRST (a memoized hash compare, no signature work) and the
// lane it picks is charged — frames naming no space of ours are dropped cheaply on a generous lane
// and can never starve the shared-space frame. Only matched frames pay for signature verification
// and reach dispatch. Both lanes ban on a sustained flood. Returns null if the frame was
// dropped/rejected, else whether its binding verified.
function admitIdentityFrame(conn, msg, spaceId) {
  const { socket, peerInfo, remoteKey } = conn
  if (testDrop) {
    const i = testDrop.seen++
    if (i >= testDrop.after && i < testDrop.after + testDrop.count) {
      log.debug('TEST drop identity frame', msg.type, 'from', remoteKey + '...')
      return null
    }
  }
  const matched = spaceId !== null
  const noiseHex = peerInfo?.publicKey ? b4a.toString(peerInfo.publicKey, 'hex') : null
  if (noiseHex && rateLimiter) {
    // The space is charged only when it matched one of ours, so the lane's cap grows with the
    // spaces this peer has actually proven it shares — not with our own space count.
    const r = rateLimiter.take(noiseHex, matched, spaceId)
    if (!r.ok) {
      log.debug('rate-limited', msg.type, 'from', remoteKey + '...')
      if (r.ban) {
        log.warn('evicting flooding peer', remoteKey + '...')
        bannedNoiseKeys.add(noiseHex)
        try { peerInfo.ban(true) } catch {}
        socket.destroy()
      }
      return null
    }
  }
  if (!matched) {
    // Names no space of ours: drop before paying for the signature verify.
    log.debug(msg.type, 'names no space of ours from', remoteKey + '...')
    return null
  }
  const verdict = checkInboundSender(peerInfo, msg, { enforceBinding: isHandshakeIdentityBindingEnabled() })
  if (!verdict.ok) {
    log.warn('rejected', msg.type, 'from', remoteKey + '... -', verdict.reason)
    return null
  }
  if (verdict.bound) boundSignerKeys.set(msg.profileKey, msg.signerKey)
  if (msg.type === PEER_FRAME.MEMBERSHIP_REQUEST) registerPendingRequester(conn, msg.profileKey, verdict.bound)
  return { bound: verdict.bound }
}

function registerPendingRequester({ socket, remoteKey }, profileKey, bound) {
  if (!parkPendingRequester(profileKey, socket, { bound, cap: getConnectionCaps().maxPendingRequesters })) {
    log.debug('pending requester not parked (cap, or unbound move), from', remoteKey + '...')
  }
}

// The frame vocabulary and what each frame means live in contract/peer-frames.js; this is only the
// routing. A frame with no entry in the table is counted and dropped.
const PEER_FRAME_HANDLERS = Object.freeze({
  // Fire-and-forget: the async handlers' rejections escape the synchronous try/catch around the
  // dispatch. A failure handling one peer's frame (e.g. a transiently unreadable record) must
  // degrade that peer, not crash the worker.
  [PEER_FRAME.HANDSHAKE]: (conn, msg, spaceId, bound) => {
    const park = bound ? () => registerPendingRequester(conn, msg.profileKey, true) : null
    return handleHandshake(conn.socket, msg, spaceId, { park, bound }).catch((err) => log.warn('handshake handling failed:', err?.message || err))
  },
  [PEER_FRAME.PRESENCE]: ({ socket }, msg, spaceId) => handlePresenceFrame(socket, msg, spaceId),
  [PEER_FRAME.LEAVE]: ({ socket, peerInfo }, msg, spaceId) =>
    handleLeaveFrame(socket, peerInfo, msg, spaceId).catch((err) => log.warn('leave handling failed:', err?.message || err)),
  [PEER_FRAME.LEAVE_ACK]: ({ socket }, msg) => handleLeaveAckFrame(socket, msg),
  [PEER_FRAME.MEMBERSHIP_CANCEL_ACK]: ({ socket }, msg) => handleMembershipCancelAck(socket, msg),
  [PEER_FRAME.SHARE_INDEX_PROGRESS]: ({ socket }, msg) => handleShareIndexProgressFrame(socket, msg),
  [PEER_FRAME.SHARE_PREPARE_PROGRESS]: ({ socket }, msg) => handleSharePrepareProgressFrame(socket, msg),
  [PEER_FRAME.SHARE_WAIT]: ({ socket }, msg) => handleShareWaitFrame(socket, msg),
  // Answered in answerSpaceNamed, which sees every frame that names a space.
  [PEER_FRAME.SPACE_REF]: () => {},
  ...Object.fromEntries(MEMBERSHIP_CONTROL_FRAMES.map((type) => [type, toMembershipControl])),
})

// The handler verifies a grant's identity binding and asserted root itself, which is why these
// four leave the swarm rather than being answered here.
function toMembershipControl(conn, msg, spaceId) {
  const { socket, peerInfo, msgHandler } = conn
  const reply = (payload) => { try { msgHandler.send(JSON.stringify(payload)) } catch {} }
  getMembershipControlHandler()?.(msg, { socket, peerInfo, reply, spaceId })
}

function dispatchFrame(conn, msg, spaceId, bound) {
  const handle = PEER_FRAME_HANDLERS[msg.type]
  if (!handle) {
    countDroppedFrame('unknown')
    log.debug('ignoring unknown peer frame type:', msg.type)
    return
  }
  handle(conn, msg, spaceId, bound)
}

export function resetFrameIntake() {
  testDrop = null
  for (const k of Object.keys(droppedFrames)) droppedFrames[k] = 0
  bannedNoiseKeys.clear()
  rateLimiter?.clear()
  rateLimiter = null
  frameLimiter = null
}
