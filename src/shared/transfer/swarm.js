// The peer-connection layer. Each space is a Hyperswarm topic; every discovered peer shares
// ONE Noise socket on which Protomux multiplexes Corestore replication, this module's
// `mirall/handshake` JSON channel, and the overlay content channel (bound via the connection
// attach hook). Every identity-asserting frame (handshake, membership:request/grant, leave)
// carries a signature binding the sender's profile key to this socket's Noise key — and, on
// handshakes, to its per-space drive key — verified in handshake-guard.js, so frames are
// attributable to a member and cannot be replayed on another connection. A handshake admits a
// peer to a space only through the membership gate (approved member + cross-checked creator
// root); membership control frames carry join requests, sealed grants of the SCK (space
// content key — possession is read access), denials, and acknowledged leaves. Liveness is a
// separate presence lease — heartbeat-refreshed, TTL-expired, cleared on disconnect:
// connectedPeers stays the routing registry (where to send), the lease is who is online.
import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import fs from 'bare-fs'
import b4a from 'b4a'
import { getStore, diagnoseStoreCores, isStorageInconsistency } from '../core/store.js'
import {
  getProfileKey, getProfile, openProfileBee, getIdentitySigner, } from '../spaces/profile.js'
import {
  getDrive, getSpace, upsertMember, clearJoinRequest, ownLooseCatalogPublish,
} from '../spaces/space.js'
import { getRuntimeConfig, isHandshakeIdentityBindingEnabled, getResourceCaps, getHandshakeRateLimit, getConvergenceConfig, getIdentityFrameDropWindow, isRelayEnabled, isSeparateContentPlaneEnabled, getPeerFrameMaxBytes, getPeerFrameLimits } from '../core/runtime-config.js'
import { enabledRelayKeys, relayFunctionFor, decodeRelayKey } from './relay.js'
import BlindRelay from 'blind-relay'
import { catalogKeyField } from '../shares/share-catalog.js'
import { HEX64 } from '../invite-envelope.js'
import { checkInboundSender, clampDisplayName, signNoiseBinding, createDualRateLimiter, createRateLimiter, validFrameShape } from './handshake-guard.js'
import { joinContentTopic, leaveContentTopic, destroyContentPeerSockets, getContentSwarm } from './content-swarm.js'
import { applyNetImpairment } from './net-impair.js'
import { clearListDeficits } from './list-deficits.js'
import { observePeerProfile } from '../audit/peer-watch.js'
import { peerLost, peerLostMeta, peerSeen, resetNetworkWatch } from '../audit/network-watch.js'
import { sealSck } from './sck-seal.js'
import { sanitizeAvatar } from '../identity-limits.js'
import { createPresence } from '../state/presence.js'
import { makeKeyedCoalescer } from '../state/coalesce.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { createSwarmDiagnostics } from './swarm-diagnostics.js'
import { createAdmissionGates } from './admission-gates.js'
import { connectedPeers, socketToPeers, spaceTopics, spaceDiscoveries, socketMsgHandlers, pendingRequesters, boundSignerKeys, announceLedger, resetRegistries } from './swarm-registries.js'
import {
  initPresenceBroadcast, startPresenceHeartbeat, stopPresenceHeartbeat, resolveSpaceIdForTopic,
  handlePresenceFrame, handleShareIndexProgressFrame, handleSharePrepareProgressFrame,
} from './presence-broadcast.js'
// Re-exported so swarm.js stays the public address for these: worker/main.js and the overlay
// backend import them from here.
export { broadcastDeparture, broadcastSharePrepareProgress, broadcastShareIndexProgress } from './presence-broadcast.js'
import {
  initDeferredAdmission, resetDeferredAdmission,
  reconcilePendingRequestersForApprover, emitPeerSharesUpdated,
} from './deferred-admission.js'
export { readmitConnectedMembers, emitSharesUpdated, reconcilePendingRequester } from './deferred-admission.js'
import {
  initLeaveProtocol, resetLeaveProtocol,
  handleLeaveFrame, handleLeaveAckFrame, handleMembershipCancelAck,
  sendPendingLeaveFrames, sendPendingCancelFrames,
} from './leave-protocol.js'
// Every one of these has callers in worker/main.js or worker/ipc/space-leave.js, so swarm.js stays
// their public address.
export {
  markSpaceLeaving, unmarkSpaceLeaving, isSpaceLeaving,
  configurePendingLeaves, registerPendingLeave, unregisterPendingLeave, hasPendingLeave,
  joinPendingLeaveTopic, leavePendingLeaveTopic, sendLeaveFrameToConnectedPeers,
  leaveAcksSatisfied, awaitLeaveAcks, takeLeaveAckedKeys,
  configurePendingCancels, registerPendingCancel, hasPendingCancel,
  joinPendingCancelTopic, leavePendingCancelTopic, sendPendingCancelToConnected,
} from './leave-protocol.js'
import {
  initConvergenceTick, resetConvergenceTick, startConvergenceTick, forgetSpaceConvergence,
} from './convergence-tick.js'
export { rescueStalledTransfers } from './convergence-tick.js'
import {
  initConnectivity, resetConnectivity, attachSwarmWatchers,
  noteBooted, noteConnection, noteAnnounced, scheduleStatusEmit,
} from './connectivity.js'
// The renderer's whole network picture comes through these; worker/main.js and the diagnostics
// bundle import them from swarm.js.
export {
  getSwarmStatus, statusEqual, setBrowserOnlineHint, getVerdictHistory, getDiagnosticCounters,
  getPeerSamples, checkLivenessNow, probeCanary, reconnectAll,
} from './connectivity.js'

const log = createLogger('swarm')

// Presence transitions arrive in bursts (one prune tick can expire dozens of (peer, space)
// leases; a reconnect handshakes several spaces back-to-back) and each members-updated frame
// costs the renderer several spaces:list round-trips — coalesce per space at the source.
const membersPoke = makeKeyedCoalescer(
  (spaceId) => { ipcRef?.emit('event:members-updated', { spaceId }) },
  { intervalMs: 250 },
)

// Lease-based presence: who's online. connectedPeers stays the socket/routing registry
// (where to send); presence is the liveness display source. Marked on handshake, refreshed
// by heartbeats, cleared on disconnect, expired by TTL (catches a silently-dead socket).
const PRESENCE_TTL_MS = 15000
// On silent-death lease expiry, re-emit so the roster + file availability re-derive (a peer that
// goes quiet without a clean disconnect would otherwise stay "online" until an unrelated refresh).
// files-updated is already coalesced downstream into event:reconcile by the hint bus.
const presence = createPresence({
  ttl: PRESENCE_TTL_MS,
  onExpire: (peerKey, spaceId) => {
    auditPeerLost(peerKey, spaceId)
    membersPoke.poke(spaceId)
    ipcRef?.emit('event:files-updated', { spaceId })
  },
})

// The episode is opened SYNCHRONOUSLY, because peerSeen and peerLeft are synchronous: awaiting the
// space name first would let a reconnect or a leave overtake the loss and open an episode for a peer
// that is already back. The name is snapshotted rather than joined at render time (a row outlives
// the space record), so it lands as a patch once the store read returns — well inside the floor.
function auditPeerLost(peerKey, spaceId, displayName = null) {
  const memberName = displayName || connectedPeers.get(peerKey)?.displayName || null
  peerLost(peerKey, spaceId, { memberName, spaceName: null })
  getSpace(spaceId).then((space) => {
    peerLostMeta(peerKey, spaceId, {
      memberName: memberName || peerName(space, peerKey),
      spaceName: space?.name ?? null,
    })
  }).catch((err) => log.debug('peer presence name lookup skipped:', err.message))
}

function peerName(space, peerKey) {
  return (space?.members || []).find((m) => m.publicKey === peerKey)?.displayName || null
}

let swarm
// The live Swarm subsystem, so the module-scope starts below can arm through ITS timer set.
let subsystem = null
let ipcRef
let overlayReconnectHook = null         // notified when an overlay-content owner (re)connects, so paused/interrupted overlay downloads (loose + folder) resume
let membershipControlHandler = null     // membership:* frames (join request / grant / deny) routed to the worker
let connectionAttachHook = null         // per-connection (mux, socket) hook so content backends bind extra protocol channels (overlay)
let stalledOwnersHook = null            // worker-supplied probe: which owners are we waiting on?
let revokeServesForSpaceHook = null     // membership changed → drop the serve grants cached for that space (overlay owns them; swarm must not import it)
const profileBeeAppendListeners = new Map()  // profileKey hex → { bee, listener } — the ONE held bee per peer
const bannedNoiseKeys = new Set()       // Noise keys evicted for identity-frame flooding; the firewall rejects their reconnects
let rateLimiter = null                  // dual-lane per-socket identity-frame token bucket, created in initSwarm
let frameLimiter = null                 // general per-socket budget charged for EVERY frame type
// Why a frame was dropped, for diagnostics — hardening nobody can see is hardening nobody can tune.
const droppedFrames = { oversize: 0, rate: 0, parse: 0, shape: 0, unknown: 0 }
function countDroppedFrame(reason) { droppedFrames[reason] += 1 }
export function getDroppedFrameCounters() { return { ...droppedFrames } }
// Unsettled identity-frame announcements per (socket, space), drained by the convergence
// tick — the level-triggered resend that heals a dropped handshake/membership:request.
let testDrop = null                     // test-only inbound identity-frame drop window

const DHT_VERSION = (() => {
  try {
    // Three levels: this file is src/shared/transfer/, so ../../ lands on src/, where there is no
    // node_modules. That typo made the reported version a permanent 'unknown'.
    const url = new URL('../../../node_modules/hyperdht/package.json', import.meta.url)
    const text = fs.readFileSync(url, 'utf8')
    const pkg = JSON.parse(text)
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
})()

// Read-only reporting over the live swarm. Accessors, not the handle: initSwarm/destroySwarm
// reassign `swarm`, and relaySelections is a counter this module keeps.
const diag = createSwarmDiagnostics({
  getSwarm: () => swarm,
  getRelaySelections: () => relaySelections,
  getDhtVersion: () => DHT_VERSION,
})
// The join gates. connectedPeers is passed rather than imported: it is this module's registry.
initDeferredAdmission({
  getGates: () => gates,
  log,
  handleHandshake: (...a) => handleHandshake(...a),
  sendSingleHandshake: (...a) => sendSingleHandshake(...a),
  getIpc: () => ipcRef,
})

initPresenceBroadcast({ presence, membersPoke, log, getSwarm: () => swarm, getIpc: () => ipcRef })
initLeaveProtocol({
  presence,
  log,
  getLocalBinding: (...a) => getLocalBinding(...a),
  getRevokeServesHook: () => revokeServesForSpaceHook,
  getSwarm: () => swarm,
  getIpc: () => ipcRef,
})
initConvergenceTick({
  log,
  sendSingleHandshake: (...a) => sendSingleHandshake(...a),
  getStalledOwners: () => stalledOwnersHook,
  getSwarm: () => swarm,
  getIpc: () => ipcRef,
})

initConnectivity({
  log,
  diag,
  dhtVersion: DHT_VERSION,
  getDroppedFrameCounters,
  getSwarm: () => swarm,
  getIpc: () => ipcRef,
})
const gates = createAdmissionGates({ connectedPeers, log, getIpc: () => ipcRef })

// Re-exported, not relocated: worker/main.js imports BOTH (isApprovedMember for the join-request
// auto-admit check, resolveInvite for the invite path) and overlay-instance.js imports
// isApprovedMember. The gates moved; swarm.js stays their public address so
// no caller has to learn a new import path for a refactor that changed nothing for them.
export const isApprovedMember = (spaceId, joinerKey) => gates.isApprovedMember(spaceId, joinerKey)
export const resolveInvite = (space, inviteId) => gates.resolveInvite(space, inviteId)

const BENIGN_SOCKET_ERRORS = ['timed out', 'reset by peer', 'Duplicate connection']
function isBenignSocketError (err) {
  const msg = err?.message || ''
  return BENIGN_SOCKET_ERRORS.some(s => msg.includes(s))
}

// A storage-inconsistency replication proof failure destroys the peer's replication
// stream and arrives at the socket 'error' handler naming only the peer, not the core
// that couldn't produce the proof (see isStorageInconsistency in store.js). Dump the
// open-core inventory once per worker — the same broken proof re-fails on every
// reconnect, and one named snapshot is enough to identify the core.
let corruptionDiagnosed = false

// === Connection intake & frame dispatch ===

function initSwarm(_ipc) {
  if (swarm) throw new Error('swarm: already running')
  ipcRef = _ipc
  // Tests inject a local hyperdht/testnet bootstrap via runtime-config so the
  // swarm stays off the public DHT; unset in production → default bootstrap.
  const dhtBootstrap = getRuntimeConfig().dhtBootstrap
  const caps = getResourceCaps()
  swarm = new Hyperswarm({
    ...(dhtBootstrap ? { bootstrap: dhtBootstrap } : {}),
    maxServerConnections: caps.serverConnections || Infinity,
    maxClientConnections: caps.clientConnections || Infinity,
    // firewall returns true to REJECT — drop reconnects from a Noise key we evicted for flooding.
    firewall: (remoteKey) => bannedNoiseKeys.has(b4a.toString(remoteKey, 'hex')),
  })
  // The matched lane's cap follows the topics we joined (read per take, so joins and leaves
  // need no re-plumbing) — see createDualRateLimiter.
  rateLimiter = createDualRateLimiter({ ...getHandshakeRateLimit(), topics: () => spaceTopics.size })
  frameLimiter = createRateLimiter(getPeerFrameLimits())
  const dropWindow = getIdentityFrameDropWindow()
  testDrop = dropWindow.count > 0 ? { ...dropWindow, seen: 0 } : null
  noteBooted()
  log.info('initialized')

  // Both are periodic ticks that outlive the call arming them, so they hang off the Swarm
  // subsystem's timer set — which the base closes on every ending, including a failed _open that
  // never reaches _close. _open is initSwarm's only caller and sets the pointer first, so the
  // fallback is defensive: an interval nobody can stop is one nobody should start.
  startPresenceHeartbeat(subsystem?.timers ?? null)
  startConvergenceTick(subsystem?.timers ?? null)
  attachSwarmWatchers()


  swarm.on('connection', (socket, peerInfo) => {
    applyNetImpairment(socket) // TEST-ONLY: no-op unless runtime-config.netImpair is set
    noteConnection()
    const remoteKey = peerInfo.publicKey ? b4a.toString(peerInfo.publicKey, 'hex').slice(0, 16) : 'unknown'
    log.info('connection from', remoteKey + '...')

    if (spaceTopics.size === 0) {
      log.info('no active spaces, ignoring connection from', remoteKey + '...')
      socket.destroy()
      return
    }

    const store = getStore()
    store.replicate(socket)
    log.debug('replicating corestore with', remoteKey + '...')

    const mux = Protomux.from(socket)
    const channel = mux.createChannel({
      protocol: 'mirall/handshake',
      onopen() {
        log.debug('handshake channel open with', remoteKey + '...')
        sendHandshakeMessages(socket, msgHandler)
      },
    })

    // Constant for the life of the connection, so it is derived once rather than per frame.
    const noiseHex = peerInfo?.publicKey ? b4a.toString(peerInfo.publicKey, 'hex') : null
    const msgHandler = channel.addMessage({
      encoding: c.string,
      onmessage(str) {
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
        // debug, not error: a malformed frame is now a metered, counted, expected event, and
        // logging it at error would hand any peer on the topic a log-spam primitive.
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
        if ((msg.type === 'handshake' || msg.type === 'membership:request') &&
            !admitIdentityFrame(socket, peerInfo, remoteKey, msg)) return

        try {
          dispatchFrame(socket, peerInfo, remoteKey, msg, msgHandler)
        } catch (err) {
          log.error('handshake dispatch error:', err)
        }
      },
    })

    // Let content backends bind extra protocol channels on THIS mux (overlay's
    // hyper-overlay/v2). Synchronous + before channel.open() — protomux won't pair
    // a channel opened after the remote's. Overlay's serve gate denies any request
    // until the handshake authenticates the sender on this socket, so binding here
    // (pre-auth) is safe.
    try { connectionAttachHook?.(mux, socket) } catch (err) { log.warn('connection attach hook failed:', err.message) }

    channel.open()
    socketMsgHandlers.set(socket, msgHandler)
    // Re-announce any pending outbound leave on the fresh connection: the co-member may be
    // exactly the peer that was offline when we left (see pendingLeaves above).
    sendPendingLeaveFrames(socket, msgHandler)
    sendPendingCancelFrames(socket, msgHandler)

    socket.on('close', () => {
      log.info('peer disconnected:', remoteKey + '...')
      socketMsgHandlers.delete(socket)
      handleDisconnect(socket)
    })
    socket.on('error', (err) => {
      const level = isBenignSocketError(err) ? 'debug' : 'warn'
      log[level]('peer error:', remoteKey + '...', err.message)
      // The error names the peer, not the core that couldn't produce the proof. Dump a
      // named open-core inventory (once) so the corrupt core can be identified.
      if (isStorageInconsistency(err) && !corruptionDiagnosed) {
        corruptionDiagnosed = true
        log.error('replication proof failed on a core with an inconsistent on-disk tree —', err.message)
        diagnoseStoreCores('replication proof failure with ' + remoteKey + '...')
      }
      handleDisconnect(socket)
    })
  })
}

// Gate for frames that assert the sender's profileKey (handshake, membership:request).
// Order matters: resolve the topic FIRST (a Map scan, no crypto) and charge the lane it
// picks — frames for topics we didn't join are dropped cheaply on a generous lane and can
// never starve the shared-space frame (a multi-space peer's connection-open burst used to
// eat the whole budget before its one matching frame). Only matched frames pay for
// signature verification and reach dispatch. Both lanes ban on a sustained flood. Returns
// false if the frame was dropped/rejected.
function admitIdentityFrame(socket, peerInfo, remoteKey, msg) {
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
function registerPendingRequester(socket, remoteKey, msg) {
  const cap = getResourceCaps().pendingRequesters
  if (!cap || pendingRequesters.size < cap || pendingRequesters.has(msg.profileKey)) {
    pendingRequesters.set(msg.profileKey, socket)
  } else {
    log.debug('pendingRequesters cap reached, dropping request from', remoteKey + '...')
  }
}

// Route a verified inbound frame to its handler. reply sends back over THIS connection's channel.
function dispatchFrame(socket, peerInfo, remoteKey, msg, msgHandler) {
  const reply = (payload) => { try { msgHandler.send(JSON.stringify(payload)) } catch {} }
  if (msg.type === 'handshake') {
    // Fire-and-forget: handleHandshake is async, so the synchronous try/catch around
    // dispatchFrame can't catch its rejection. A failure handling one peer's handshake
    // (e.g. a transiently unopenable peer drive) must degrade that peer, not crash the worker.
    handleHandshake(socket, peerInfo, msg).catch((err) => log.warn('handshake handling failed:', err?.message || err))
  } else if (msg.type === 'presence') {
    handlePresenceFrame(socket, msg)
  } else if (msg.type === 'leave') {
    handleLeaveFrame(socket, peerInfo, msg)
  } else if (msg.type === 'leave-ack') {
    handleLeaveAckFrame(socket, msg)
  } else if (msg.type === 'membership:cancel-ack') {
    handleMembershipCancelAck(socket, msg)
  } else if (msg.type === 'share-index-progress') {
    handleShareIndexProgressFrame(socket, msg)
  } else if (msg.type === 'share-prepare-progress') {
    handleSharePrepareProgressFrame(socket, msg)
  } else if (msg.type.startsWith('membership:')) {
    if (msg.type === 'membership:request' && msg.profileKey) registerPendingRequester(socket, remoteKey, msg)
    membershipControlHandler?.(msg, { socket, peerInfo, reply })  // handler verifies a grant's identity binding + asserted root
  } else {
    countDroppedFrame('unknown')
    log.debug('ignoring unknown peer frame type:', msg.type)
  }
}

async function sendHandshakeMessages(socket, msgHandler) {
  log.debug('sending handshakes for', spaceTopics.size, 'spaces')
  for (const [spaceId, topic] of spaceTopics) {
    await sendSingleHandshake(socket, msgHandler, spaceId, topic)
  }
}

// === Handshake handling & peer registry ===

// Register the live connection in the in-memory maps (connection registry, socket↔peers, presence
// lease) before any blocking I/O. Returns whether the peer is new to this space — which gates the
// reciprocal handshake so two peers don't ping-pong forever.
function trackPeerConnection(socket, spaceId, msg) {
  const peerKey = msg.profileKey
  let peerEntry = connectedPeers.get(peerKey)
  const isNewToSpace = !peerEntry || !peerEntry.spaces.has(spaceId)
  if (!peerEntry) {
    peerEntry = { socket, profileKey: peerKey, displayName: msg.displayName, avatar: null, spaces: new Map(), looseCatalogKeys: new Map() }
    connectedPeers.set(peerKey, peerEntry)
  } else {
    peerEntry.socket = socket
    peerEntry.displayName = msg.displayName
  }
  peerEntry.spaces.set(spaceId, msg.driveKey)
  // Carry the loose-catalog key on the live-meta tier too (like driveKey), so the member fold
  // prefers the fresh handshake value over a stale profile-bee record on a rejoin with a new key.
  // A v2 catalog is SCK-encrypted — its key travels in a distinct field so a reader knows to
  // apply the SCK; only one of the two is ever set per space.
  peerEntry.looseCatalogKeys.set(spaceId, {
    key: normalizeLooseCatalogKey(msg.looseCatalogKey),
    keyEnc: normalizeLooseCatalogKey(msg.looseCatalogKeyEnc),
  })
  if (!socketToPeers.has(socket)) socketToPeers.set(socket, new Set())
  socketToPeers.get(socket).add(peerKey)
  // A live handshake is proof of presence — lease them online now, before their first
  // heartbeat. Refreshed by presence frames; cleared on disconnect. The flip return value is
  // ignored here: the handshake path emits members-updated unconditionally after the persist.
  presence.mark(peerKey, spaceId)
  peerSeen(peerKey, spaceId)
  return isNewToSpace
}

// A peer's self-asserted loose-catalog key, normalized to canonical lowercase hex or null. The
// value is only a hint about the sender's own files, but must be a well-formed core key: a
// non-string (HEX64.test string-coerces, so [ '<64hex>' ] would slip through a bare test) or
// wrong-case value would otherwise reach openPeerCatalog and open a duplicate/invalid core.
function normalizeLooseCatalogKey(value) {
  return typeof value === 'string' && HEX64.test(value) ? value.toLowerCase() : null
}

// Persist the member (add new, or update a renamed display name), respecting the per-space cap.
// Serialized + re-read inside upsertMember, so concurrent handshakes can't clobber this write;
// existingMember only picks the log line — correctness comes from upsertMember's merge.
async function persistHandshakeMember(spaceId, space, msg, existingMember) {
  if (!space) return
  const memberCap = getResourceCaps().membersPerSpace
  if (!existingMember && memberCap && (space.members?.length || 0) >= memberCap) {
    log.warn('members-per-space cap reached for', spaceId, '- not persisting', msg.displayName)
    return
  }
  const changed = await upsertMember(spaceId, {
    publicKey: msg.profileKey,
    driveKey: msg.driveKey,
    displayName: msg.displayName,
    looseCatalogKey: normalizeLooseCatalogKey(msg.looseCatalogKey),
    looseCatalogKeyEnc: normalizeLooseCatalogKey(msg.looseCatalogKeyEnc),
  })
  if (changed) log.info(existingMember ? 'member updated:' : 'new member added:', msg.displayName, 'to space', spaceId)
}

async function handleHandshake(socket, peerInfo, msg) {
  msg.displayName = clampDisplayName(msg.displayName)
  log.info('handshake received from', msg.displayName)

  const spaceId = resolveSpaceIdForTopic(msg.spaceTopic)
  if (!spaceId) {
    log.debug('handshake topic not matched locally:', msg.spaceTopic?.slice(0, 16) + '...')
    return
  }

  const space = await getSpace(spaceId)

  // No local record for a topic we resolved means the topic is only joined for a pending-leave
  // replay (the space was purged). We only broadcast leave frames on it — we never admit its
  // peers. Stop here: the admit gate below optional-chains past a null space, which would
  // otherwise register an unadmitted peer into connectedPeers/presence for a space that no
  // longer exists (and emit reconcile hints the renderer can't resolve).
  if (!space) {
    log.debug('handshake for a space with no local record — ignoring:', spaceId)
    return
  }

  // While we're pending in this space we hold no content key — don't admit the peer.
  // But if it's a member we pre-seeded (the inviter), pull their avatar so it shows in the
  // spaces list / waiting view. After the grant flips us to approved, our re-handshake
  // draws the reciprocal back in.
  if (space?.status === 'pending') {
    if ((space.members || []).some((m) => m.publicKey === msg.profileKey)) {
      fetchPeerAvatar(msg.profileKey, msg, spaceId, space).catch((err) => {
        log.warn('pending inviter avatar fetch failed:', err.message)
      })
    }
    return
  }

  // Read gate: only admit a peer we (or a co-member) approved; everyone else is recorded as a
  // converging join request and the handshake stops here.
  if (!(await gates.admitMember(spaceId, space, msg))) return

  const peerKey = msg.profileKey
  const isNewToSpace = trackPeerConnection(socket, spaceId, msg)

  // Carry the persisted member's avatar (if any) so the join event shows it immediately.
  const existingMember = space?.members?.find((m) => m.publicKey === peerKey)
  const cachedAvatar = existingMember?.avatar || null

  log.info('peer joined space:', msg.displayName, '→', spaceId)
  ipcRef.emit('event:member-joined', {
    spaceId,
    member: { publicKey: peerKey, driveKey: msg.driveKey, displayName: msg.displayName, avatar: cachedAvatar, online: true },
  })
  ipcRef.emit('event:files-updated', { spaceId })

  // This peer is now admitted — clear any stale "wants to join" recorded before their approval
  // propagated, wherever it shows.
  if (clearJoinRequest(spaceId, peerKey)) {
    ipcRef.emit('event:join-requests-updated', { spaceId })
  }

  overlayReconnectHook?.(peerKey, spaceId)   // resume overlay downloads (loose + folder) owned by this peer (fn swallows its own errors)

  // Reciprocal handshake so the peer learns about us. New to this space: always. A
  // duplicate means the peer is re-announcing because it hasn't admitted US for this space
  // (its copy of our frame was likely dropped) — reply too, floored on our own send ledger
  // so two re-announcing peers converge instead of ping-ponging.
  {
    const handler = socketMsgHandlers.get(socket)
    if (handler) {
      const dupReplyDue = Date.now() - announceLedger.lastSentAt(socket, spaceId) >= getConvergenceConfig().dupReciprocalFloorMs
      if (isNewToSpace || dupReplyDue) {
        log.debug('sending reciprocal handshake for space', spaceId, 'to', msg.displayName)
        sendSingleHandshake(socket, handler, spaceId, msg.spaceTopic)
      }
    }
  }

  try {
    await persistHandshakeMember(spaceId, space, msg, existingMember)
  } catch (err) {
    // Presence is already leased; the fold self-heals the record only on a later append —
    // don't let a bee write error mute the arrival emit below.
    log.warn('handshake member persist failed:', err.message)
  }
  // A handshake is a presence arrival (recordHandshake leased the peer online), so the online set
  // changed even when the durable record didn't — emit unconditionally, the arrival mirror of the
  // onExpire departure emit. Emit AFTER the persist so a roster re-derive (useMembers/useSpaces) sees
  // the committed member; the pre-persist event:member-joined signal above would race it.
  membersPoke.poke(spaceId)
  // Files-view analogue of that poke: the early files hint above can be consumed before this
  // peer's looseCatalogKey lands in the member record, so a files:list re-derive misses their
  // loose catalog and never registers its append watch. Re-hint now that the record is committed.
  ipcRef.emit('event:files-updated', { spaceId })

  // Fetch avatar asynchronously — won't block peer state.
  fetchPeerAvatar(peerKey, msg, spaceId, space).catch((err) => {
    log.warn('avatar fetch failed:', msg.displayName, err.message)
  })
}

// The avatar value lives in the peer's profile bee. At handshake time that block may
// not have replicated yet, and a churning ("space-jump") connection can drop before it
// arrives — the pending block read then rejects with BLOCK_NOT_AVAILABLE instead of
// completing. It is transient: the block lands once the connection stabilizes (or on a
// reconnect), so retry a few times before giving up rather than leaving the member as
// initials. A genuinely unset avatar (null) is not retried.
const AVATAR_FETCH_ATTEMPTS = 4
const AVATAR_RETRY_BASE_MS = 1500

export function isBlockUnavailable(err) {
  return err?.code === 'BLOCK_NOT_AVAILABLE' || /not available|avatar sync timeout/i.test(err?.message || '')
}

// The long-lived holder: ONE bee per peer for the process lifetime, carrying the append listener
// that drives admission re-evaluation, the share-list refresh and the audit observer. Every other
// touch of a peer's bee is a bounded read that opens and closes its own session (withPeerBee), so
// this is the only session we keep — previously every avatar fetch opened another one and never
// closed it.
function ensurePeerProfileWatch(peerKey, profileKeyHex) {
  const held = profileBeeAppendListeners.get(peerKey)
  if (held) return held
  const peerProfileBee = openProfileBee(b4a.from(profileKeyHex, 'hex'))
  {
    const listener = () => {
      // The append may be a new approved/<space>/<joiner> record — re-evaluate any
      // join request we hold for a peer this member may have just approved. (The fold's
      // own watchers handle member-set re-derivation; this only drives admission.)
      reconcilePendingRequestersForApprover(peerKey).catch(err => {
        log.warn('approval-driven admit failed:', err.message)
      })
      // …or a new/removed `share/<space>/*` record (shares live in the peer's profile bee).
      // This is the only peer-side trigger that refreshes the share LIST — the drive-append
      // listener only covers files.
      emitPeerSharesUpdated(peerKey).catch(err => {
        log.warn('peer shares-updated emit failed:', err.message)
      })
      // The same append is the only signal that a peer created/deleted a folder share or started
      // mirroring one of ours. This hook is coarse — it fires for ANY bee change — so the
      // observer diffs the bee's own history rather than trusting the poke.
      observePeerProfile(peerKey, peerProfileBee)
    }
    peerProfileBee.core.on('append', listener)
    profileBeeAppendListeners.set(peerKey, { bee: peerProfileBee, listener })
    // Baseline now, not on the first append — otherwise the first share a peer creates after we
    // meet them is swallowed as "history".
    // Drop the entry if the bee never opens: caching a broken holder would make every later
    // avatar fetch for this peer hit the fast path and fail again for the process lifetime,
    // where the old per-fetch open self-healed on the next handshake.
    peerProfileBee.ready().then(
      () => observePeerProfile(peerKey, peerProfileBee, { baselineOnly: true }),
      (err) => {
        log.warn('peer profile bee failed to open — dropping the watch so the next handshake retries:', err.message)
        if (profileBeeAppendListeners.get(peerKey)?.bee === peerProfileBee) profileBeeAppendListeners.delete(peerKey)
        try { peerProfileBee.core.off('append', listener) } catch {}
        peerProfileBee.close().catch(() => {})
      },
    )
  }
  return profileBeeAppendListeners.get(peerKey)
}

async function fetchPeerAvatar(peerKey, msg, spaceId, space) {
  const { bee: peerProfileBee } = ensurePeerProfileWatch(peerKey, msg.profileKey)
  await peerProfileBee.ready()

  for (let attempt = 0; attempt < AVATAR_FETCH_ATTEMPTS; attempt++) {
    try {
      await Promise.race([
        peerProfileBee.core.update({ wait: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('avatar sync timeout')), 10000)),
      ])
      const avatarEntry = await peerProfileBee.get('avatar')
      const peerAvatar = sanitizeAvatar(avatarEntry?.value || null, getResourceCaps().avatarMaxBytes)
      if (!peerAvatar) return

      const peerEntry = connectedPeers.get(peerKey)
      if (peerEntry) peerEntry.avatar = peerAvatar

      // Persist avatar to space members (atomic merge — won't clobber a concurrent
      // membership write, and no-ops if the avatar is unchanged or the member is gone).
      if (space) {
        await upsertMember(spaceId, { publicKey: peerKey, avatar: peerAvatar }, { create: false })
      }

      ipcRef.emit('event:member-avatar-updated', { spaceId, publicKey: peerKey, avatar: peerAvatar })
      return
    } catch (err) {
      if (!isBlockUnavailable(err) || attempt === AVATAR_FETCH_ATTEMPTS - 1) {
        log.debug('avatar not available yet for', msg.displayName, '-', err.message)
        return
      }
      await new Promise((r) => setTimeout(r, AVATAR_RETRY_BASE_MS * (attempt + 1)))
    }
  }
}

function handleDisconnect(socket) {
  if (rateLimiter && socket.remotePublicKey) rateLimiter.forget(b4a.toString(socket.remotePublicKey, 'hex'))
  announceLedger.forgetSocket(socket)
  for (const [profileKey, sock] of pendingRequesters) {
    if (sock === socket) {
      pendingRequesters.delete(profileKey)
      if (!connectedPeers.has(profileKey)) boundSignerKeys.delete(profileKey)
    }
  }
  const peerKeys = socketToPeers.get(socket)
  if (!peerKeys) return
  socketToPeers.delete(socket)

  for (const peerKey of peerKeys) {
    const peer = connectedPeers.get(peerKey)
    if (!peer) continue

    // Peer already reconnected on a different socket — don't remove
    if (peer.socket !== socket) continue

    for (const [spaceId] of peer.spaces) {
      log.info('peer left:', peer.displayName, 'from space', spaceId)
      auditPeerLost(peerKey, spaceId, peer.displayName)
      ipcRef.emit('event:member-left', { spaceId, publicKey: peerKey })
      ipcRef.emit('event:files-updated', { spaceId })
    }

    presence.clear(peerKey)   // instant offline; don't wait for the lease to expire
    connectedPeers.delete(peerKey)
    if (!pendingRequesters.has(peerKey)) boundSignerKeys.delete(peerKey)   // prune the per-identity signer map
  }
  scheduleStatusEmit()
}

// Captured before the teardown drops the member from the roster: the audit row has to stay
// readable once the record is gone.

// === Topics, outbound handshakes & space cleanup ===

export async function joinSpaceTopic(spaceId) {
  const space = await getSpace(spaceId)
  if (!space) return
  const topicHex = space.topic
  const topic = b4a.from(topicHex, 'hex')

  spaceTopics.set(spaceId, topicHex)
  log.info('joining topic for space', spaceId, '(' + topicHex.slice(0, 16) + '...)')

  const discovery = swarm.join(topic, { server: true, client: true })
  spaceDiscoveries.set(spaceId, discovery)
  joinContentTopic(spaceId, topicHex) // no-op unless the content plane is active
  discovery.flushed().then(
    () => {
      noteAnnounced()
      log.info('topic flushed — discoverable:', spaceId)
    },
    (err) => log.error('topic flush error:', spaceId, err.message)
  )
  scheduleStatusEmit()

  // Send handshake for the new space to all already-connected peers
  // (Hyperswarm reuses existing sockets, so no new connection event fires)
  if (socketMsgHandlers.size > 0) {
    log.info('sending new space handshake to', socketMsgHandlers.size, 'existing connections')
    for (const [sock, handler] of socketMsgHandlers) {
      sendSingleHandshake(sock, handler, spaceId, topicHex)
    }
  }
}

// Proof that this connection's holder controls profileKey: a signature over our own
// (ephemeral) Noise static key by the profile signer, plus the signer key + manifest
// namespace the verifier needs to tie the signer back to profileKey. The Noise key is
// fixed for the swarm's lifetime, so compute it once; cleared in destroySwarm.
// The binding covers noise||driveKey, so it varies per space (the Noise key is fixed,
// the driveKey isn't). Cache per driveKey ('' = the no-drive form for membership:request/grant).
const localBindings = new Map()
function getLocalBinding(driveKeyHex = '') {
  if (localBindings.has(driveKeyHex)) return localBindings.get(driveKeyHex)
  const signer = getIdentitySigner()
  const noiseKey = swarm?.keyPair?.publicKey
  if (!signer || !noiseKey) return null
  const driveKeyBuf = driveKeyHex ? b4a.from(driveKeyHex, 'hex') : null
  const binding = {
    sig: signNoiseBinding(noiseKey, signer.secretKey, driveKeyBuf),
    signerKey: b4a.toString(signer.publicKey, 'hex'),
    signerNs: b4a.toString(signer.namespace, 'hex'),
  }
  localBindings.set(driveKeyHex, binding)
  return binding
}

async function sendSingleHandshake(socket, msgHandler, spaceId, topicHex) {
  const profile = await getProfile()
  const profileKeyHex = b4a.toString(getProfileKey(), 'hex')
  const displayName = profile?.displayName || 'Unknown'
  const drive = getDrive(spaceId)
  if (drive) {
    const driveKeyHex = b4a.toString(drive.key, 'hex')
    // Carry our (bound) view of the member-set (OR-Set) root so connected members cross-check
    // it. A peer holding only a provisional pin confirms it from this; a divergent root surfaces.
    const space = await getSpace(spaceId)
    // A v2 catalog is SCK-encrypted, so send its key in the …Enc field — the receiver reads the
    // field to decide whether to apply the SCK. A v1/plaintext key travels in the plain field.
    const loose = await ownLooseCatalogPublish(spaceId)
    const looseField = loose ? catalogKeyField(loose.keyHex, loose.encrypted, 'looseCatalogKey') : {}
    msgHandler.send(JSON.stringify({
      type: 'handshake',
      profileKey: profileKeyHex,
      driveKey: driveKeyHex,
      displayName,
      spaceTopic: topicHex,
      ...looseField,
      ...(space?.creatorKey ? { creator: space.creatorKey } : {}),
      ...(getLocalBinding(driveKeyHex) || {}),
    }))
    announceLedger.recordSend(socket, spaceId, 'handshake', Date.now())
    return
  }
  // No local drive ⇒ a pending v2 join: announce a join request instead, echoing the
  // (single-use) auto-admit nonce from the invite so an auto-admit invite resolves.
  const space = await getSpace(spaceId)
  if (space?.status === 'pending') {
    msgHandler.send(JSON.stringify({
      type: 'membership:request',
      profileKey: profileKeyHex,
      displayName,
      avatar: profile?.avatar || null,
      spaceTopic: topicHex,
      inviteId: space.inviteId || null,
      ...(getLocalBinding() || {}),
    }))
    announceLedger.recordSend(socket, spaceId, 'request', Date.now())
  }
}

export async function broadcastProfileUpdate() {
  if (socketMsgHandlers.size === 0) return
  log.info('broadcasting profile update to', socketMsgHandlers.size, 'peers')
  for (const [sock, msgHandler] of socketMsgHandlers) {
    await sendHandshakeMessages(sock, msgHandler)
  }
}

export async function leaveSpaceTopic(spaceId) {
  const space = await getSpace(spaceId)
  if (!space) return
  const topic = b4a.from(space.topic, 'hex')
  await swarm.leave(topic)
  spaceTopics.delete(spaceId)
  spaceDiscoveries.delete(spaceId)
  try { await leaveContentTopic(spaceId) } catch {} // no-op unless the content plane is active
  // The announce ledger self-prunes the left space on its next drain (status resolves null →
  // settled); the tick's per-space escalation state has to be dropped explicitly.
  forgetSpaceConvergence(spaceId)
  log.info('left topic for space', spaceId)
  scheduleStatusEmit()
}

// Detach every connected peer from this space; a peer left in no spaces has its socket dropped.
function disconnectPeersFromSpace(spaceId) {
  for (const [key, peer] of connectedPeers) {
    if (!peer.spaces.has(spaceId)) continue
    peer.spaces.delete(spaceId)
    peer.looseCatalogKeys?.delete(spaceId)
    if (peer.spaces.size === 0) {
      try { peer.socket.destroy() } catch {}
      // The overlay content channel rides the CONTENT socket, not this one. Dropping only the
      // control socket leaves the bulk plane serving a space we have just left.
      try { destroyContentPeerSockets(key) } catch {}
      connectedPeers.delete(key)
    }
  }
}

// Disconnect every member from this space. Overlay copies no bytes into a peer drive, so
// there is no per-member blob cache to purge here — leftover peer cores (written by older
// releases that cached file bytes per peer) are reclaimed by forgetUnreferencedPeerCores
// during leave. The progress contract (one cleaningPeer per member, then compactingPeerCache
// + a compaction) is kept so the leave UI step accounting stays correct.
export async function cleanupSpaceDrives(spaceId, members, onProgress, { compact = true } = {}) {
  const emit = (phase, data) => { if (onProgress) onProgress(phase, data) }

  disconnectPeersFromSpace(spaceId)
  const list = members || []
  for (const member of list) emit('cleaningPeer', { peerName: member.displayName })

  if (list.length > 0) {
    emit('compactingPeerCache')
    if (compact) await compactStore()
  }
}

// Returns tombstoned blocks to the OS. core.clear() / drive.clearAll() only mark
// blocks deleted in the shared RocksDB store; the bytes are not reclaimed from
// disk until a compaction with blob GC runs. Both leave-space and
// clear-peer-cache rely on this to actually shrink on-disk usage.
const COMPACTION_SETTLE_MS = 250

// Lets a test park the compaction tail so the bounded wait in destroySwarm is observable.
export function compactStoreForTest(makeTail) {
  compactionTail = makeTail()
}
let compactionTail = Promise.resolve()

function chainCompaction(opts, label) {
  const run = compactionTail.catch(() => {}).then(async () => {
    const db = getStore()?.storage?.db
    if (!db) return
    const t0 = Date.now()
    log.info('PROBE compaction start:', label)
    try {
      await db.flush()
      await db.compactRange(null, null, opts)
    } finally {
      log.info('PROBE compaction done:', label, 'in', Date.now() - t0, 'ms')
    }
  })
  compactionTail = run
  return run
}

// Forced full-range blob-GC compaction — used only by the rare user-initiated reclaim
// paths (leave-space, clear-cache, reclaim sweep). Always runs; chained so it never
// overlaps another compaction. `exclusive` blocks background compactions for the
// duration so they can't drop a swept block's delete tombstone before this blob-GC
// pass accounts its garbage — that race strands the blob value on disk permanently
// (orphaned blob files no later compaction can reclaim).
export function compactStore() {
  return chainCompaction({
    exclusive: true,
    blobGarbageCollectionPolicy: 1,
    blobGarbageCollectionAgeCutoff: 1.0,
    bottommostLevelCompaction: 2,
  }, 'forced full-range')
}

// === Liveness queries, membership frames & network status ===

// Online peers in a space (presence lease, not socket liveness) — the display liveness that
// members:online surfaces. The data plane still routes via connectedPeers (the socket).
export function getConnectedPeers(spaceId) {
  return presence.onlineIn(spaceId)
}

// Liveness (presence lease), unified with the members:online display so "owner offline →
// queue" matches what the user sees. It only gates whether to *attempt* a content:req; the
// actual send routes via connectedPeers and degrades to queued if the socket is gone, so a
// lease/socket race never streams to a dead peer.
export function isOwnerOnline(publicKey) {
  return presence.isOnlineAnywhere(publicKey)
}

// A connected peer's live metadata for a space (driveKey announced in its handshake,
// plus displayName/avatar), or null if it isn't currently handshaked here. The member
// registry uses this to enrich a newly-derived member entry; absent ⇒ the member is
// offline and its driveKey fills in on its next handshake.
export function getConnectedMemberMeta(spaceId, profileKeyHex) {
  const peer = connectedPeers.get(profileKeyHex)
  if (!peer || !peer.spaces.has(spaceId)) return null
  const loose = peer.looseCatalogKeys?.get(spaceId)
  return { driveKey: peer.spaces.get(spaceId) || null, looseCatalogKey: loose?.key || null, looseCatalogKeyEnc: loose?.keyEnc || null, displayName: peer.displayName, avatar: peer.avatar }
}

// The serve-authorization primitive, single-sourced so every serve path (the overlay's
// authorizer) reuses it. socketToPeers holds only identities that passed the identity binding on
// this socket, so this answers both "is the requester admitted here?" (owner side) and "did this
// reply come from the owner?" (consumer side) — and it survives an owner reconnect because the
// draining old socket keeps its entry until close, unlike a check against the single latest
// connectedPeers socket.
export function senderAuthorizedOnSocket(socket, profileKeyHex) {
  return !!socketToPeers.get(socket)?.has(profileKeyHex)
}
// The bound signer key a connected peer last asserted, for sealing a membership:grant to it.
export function getBoundSignerKey(profileKeyHex) {
  return boundSignerKeys.get(profileKeyHex) || null
}

// Is the owner of this drive reachable (presence lease), for transfer queue/resume gating?
// Find the peer by driveKey via the connection registry, then defer to its presence lease —
// so a lingering socket whose owner has gone silent reads offline, consistent with
// members:online and isOwnerOnline. Replication itself still rides the live socket.
export function isPeerConnectedByDriveKey(driveKeyHex) {
  for (const [profileKey, peer] of connectedPeers) {
    for (const [, dk] of peer.spaces) {
      if (dk === driveKeyHex) return presence.isOnlineAnywhere(profileKey)
    }
  }
  return false
}

export function getSwarmDht() {
  return swarm?.dht || null
}

// A pending joiner has no handshake yet, so it isn't in connectedPeers — fall back to
// the socket recorded when its membership:request arrived.
function handlerForPeer(profileKeyHex) {
  const peer = connectedPeers.get(profileKeyHex)
  if (peer) {
    const h = socketMsgHandlers.get(peer.socket)
    if (h) return h
  }
  const sock = pendingRequesters.get(profileKeyHex)
  return sock ? socketMsgHandlers.get(sock) || null : null
}

// Hand the joiner the SCK AND assert this space's OR-Set root, bound to our identity. The
// joiner pins creatorKey only from this authenticated assertion — never from the bearer
// invite. creatorKeyHex is our own pinned/derived root; granterKey + binding let the joiner
// verify WE are an authorized member making the claim.
export function sendMembershipGrant(profileKeyHex, topicHex, sckHex, creatorKeyHex, recipientSignerPkEd) {
  const handler = handlerForPeer(profileKeyHex)
  // Sealed-only: without the recipient's bound signer key we cannot seal, so we refuse to
  // grant rather than fall back to a plaintext SCK a transport observer could capture.
  if (!handler || !recipientSignerPkEd) return false
  try {
    const sckSealed = b4a.toString(sealSck(b4a.from(sckHex, 'hex'), recipientSignerPkEd), 'hex')
    handler.send(JSON.stringify({
      type: 'membership:grant',
      spaceTopic: topicHex,
      sckSealed,
      creator: creatorKeyHex || null,
      granterKey: b4a.toString(getProfileKey(), 'hex'),
      ...(getLocalBinding() || {}),
    }))
    return true
  } catch {
    return false
  }
}

// Withdraw our own pending join request (an ephemeral request-lifecycle signal, not
// convergence gossip): tell connected members so their "wants to join" banner clears. A
// pending joiner isn't admitted anywhere, so it isn't in any peer's connectedPeers — and
// cancelling doesn't promptly close the shared socket — so send over every socket;
// recipients no-op if they hold no matching request.
export function broadcastMembershipCancel(spaceId, topicHex, joinerKey) {
  for (const [, handler] of socketMsgHandlers) {
    try { handler.send(JSON.stringify({ type: 'membership:cancel', spaceTopic: topicHex, joinerKey })) } catch {}
  }
}

export function sendMembershipDeny(profileKeyHex, topicHex) {
  const handler = handlerForPeer(profileKeyHex)
  if (!handler) return false
  try {
    handler.send(JSON.stringify({ type: 'membership:deny', spaceTopic: topicHex }))
    return true
  } catch {
    return false
  }
}

async function destroySwarm() {
  if (!swarm) return
  log.info('destroying swarm...')
  resetConnectivity()
  resetNetworkWatch()
  stopPresenceHeartbeat()
  resetConvergenceTick()
  resetRegistries()
  clearListDeficits()
  testDrop = null
  presence.clearAll()
  for (const k of Object.keys(droppedFrames)) droppedFrames[k] = 0
  localBindings.clear()
  // Close the one held bee per peer, not just the map: each carries a live session and an
  // append listener.
  for (const held of profileBeeAppendListeners.values()) {
    try { held.bee.core.off('append', held.listener) } catch {}
    held.bee.close().catch(() => {})
  }
  profileBeeAppendListeners.clear()
  bannedNoiseKeys.clear()
  rateLimiter?.clear()
  rateLimiter = null
  frameLimiter = null
  membersPoke.reset()
  ipcRef = null
  overlayReconnectHook = null
  membershipControlHandler = null
  connectionAttachHook = null
  revokeServesForSpaceHook = null
  stalledOwnersHook = null
  resetLeaveProtocol()
  resetDeferredAdmission()
  corruptionDiagnosed = false
  relaySelections = 0
  try {
    await swarm.destroy()
  } catch {}
  swarm = undefined
  // A compaction reads cores the durable tier closes right after this. Bounded on its own: it
  // runs under the runtime tier's shared budget, and a full-range compactRange the user just
  // started would otherwise spend the whole budget and skip every subsystem after this one.
  await Promise.race([
    compactionTail.catch(() => {}),
    new Promise((resolve) => { const t = setTimeout(resolve, COMPACTION_SETTLE_MS); t.unref?.() }),
  ])
  compactionTail = Promise.resolve()
  log.info('swarm destroyed')
}

// === Blind relay ===

const RELAY_PROBE_TIMEOUT_MS = 10000

// hyperdht increments dht.stats.relaying only on its ANNOUNCE path (server.js:630-681);
// the dialing side is never counted. Since the relay function is ours, counting its
// selections is the one signal that covers both directions — without it the diagnostics
// read 0 on the peer doing the relaying, which is precisely the peer checking.
let relaySelections = 0

// BOTH swarms, always. The content plane carries every file byte, so configuring only
// the control swarm produces a build whose handshakes connect and whose transfers stall.
// Call this after initContentSwarm has run — the two swarms are constructed on
// consecutive lines and getContentSwarm() is null in between.
export function setRelayThrough(relays, mode) {
  const enabled = isRelayEnabled()
  const keys = enabled ? enabledRelayKeys(relays) : []
  const fn = enabled ? relayFunctionFor(keys, mode, () => { relaySelections++ }) : null
  for (const s of [swarm, getContentSwarm()]) {
    if (!s) continue
    s.relayThrough = fn
  }
  return { applied: fn ? keys.length : 0 }
}

// A mistyped or stale key is otherwise invisible until a space silently fails to sync
// weeks later. Reaching the Noise stream only proves something answers on that key, so
// the verdict waits for the blind-relay protomux channel to open.
export async function testRelayReachable(publicKey) {
  if (!isRelayEnabled()) return { ok: false, reason: 'disabled' }
  const key = decodeRelayKey(publicKey)
  if (!key) return { ok: false, reason: 'invalid-key' }
  const dht = swarm?.dht
  if (!dht) return { ok: false, reason: 'offline' }

  let socket = null
  let settle = null
  const verdict = new Promise((resolve) => { settle = resolve })
  const timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), RELAY_PROBE_TIMEOUT_MS)
  timer.unref?.()

  try {
    socket = dht.connect(key)
    socket.on('error', () => settle({ ok: false, reason: 'unreachable' }))
    socket.on('close', () => settle({ ok: false, reason: 'unreachable' }))
    const client = BlindRelay.Client.from(socket, { id: socket.publicKey })
    // 'open' fires when the remote opens ITS side of the blind-relay channel, which is
    // what distinguishes a relay from any other reachable hyperdht node. The Client
    // class emits only open/close/destroy/pair — it has no 'error' event — so a peer
    // that answers but speaks no blind-relay is caught by close/destroy or the timeout.
    client.on('open', () => settle({ ok: true }))
    client.on('close', () => settle({ ok: false, reason: 'not-a-relay' }))
    client.on('destroy', () => settle({ ok: false, reason: 'not-a-relay' }))
  } catch (err) {
    log.debug('relay probe failed:', err.message)
    settle({ ok: false, reason: 'unreachable' })
  }

  const result = await verdict
  clearTimeout(timer)
  if (socket) { try { socket.destroy() } catch {} }
  return result
}

export class Swarm extends Subsystem {
  constructor(name, deps) {
    super(name, deps)
    this.require('ipc', 'membershipControl', 'overlayBackend', 'stalledOwners')
  }

  async _open() {
    subsystem = this
    membershipControlHandler = this.deps.membershipControl
    stalledOwnersHook = this.deps.stalledOwners
    // Exclusive with the content plane: when it is on, the overlay channel rides the content
    // socket and the serve gate authorizes against that socket's hello. Binding here as well
    // would land content requests on a socket the gate cannot authenticate.
    if (!isSeparateContentPlaneEnabled()) {
      connectionAttachHook = (mux, socket) => this.deps.overlayBackend.attach(mux, socket)
    }
    overlayReconnectHook = (ownerKey, spaceId) => this.deps.overlayBackend.resumeForOwner(ownerKey, spaceId)
    revokeServesForSpaceHook = (spaceId, profileKey) => this.deps.overlayBackend.revokeServesForSpace(spaceId, profileKey)
    initSwarm(this.deps.ipc)
  }

  async _close() {
    // Before the sockets drop: the overlay's peer teardown fires the serve-end callbacks whose
    // audit rows the durable tier records, and those frames need a live connection.
    this.deps.overlayBackend.detach()
    await destroySwarm()
    subsystem = null
  }

  get dht() { return getSwarmDht() }
}
