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
import os from 'bare-os'
import { getStore, diagnoseStoreCores, isStorageInconsistency } from '../core/store.js'
import {
  getProfileKey, getProfile, openProfileBee, revokeApproval, adoptVouchees, getIdentitySigner, } from '../spaces/profile.js'
import {
  getDrive, getSpace, upsertMember, removeMember, listSpaces,
  listJoinRequests, getJoinRequestDriveKey, clearJoinRequest,
  ownLooseCatalogPublish, persistLeftTombstone,
} from '../spaces/space.js'
import { getRuntimeConfig, getUpgradeKey, isHandshakeIdentityBindingEnabled, getResourceCaps, getHandshakeRateLimit, getConvergenceConfig, getIdentityFrameDropWindow, isRelayEnabled, isSeparateContentPlaneEnabled, getPeerFrameMaxBytes, getPeerFrameLimits } from '../core/runtime-config.js'
import { enabledRelayKeys, relayFunctionFor, decodeRelayKey } from './relay.js'
import BlindRelay from 'blind-relay'
import crypto from 'hypercore-crypto'
import idEncoding from 'hypercore-id-encoding'
import { catalogKeyField } from '../shares/share-catalog.js'
import { HEX64 } from '../invite-envelope.js'
import { checkInboundSender, clampDisplayName, signNoiseBinding, createDualRateLimiter, createRateLimiter, validFrameShape, leaveFrameBound } from './handshake-guard.js'
import { createAnnounceLedger, escalationDue, announceStatus } from './announce-ledger.js'
import { joinContentTopic, leaveContentTopic, refreshContentDiscoveries, destroyContentPeerSockets, contentPlaneHasPeer, getContentPlaneStatus, getContentSwarm } from './content-swarm.js'
import { applyNetImpairment } from './net-impair.js'
import { takeIncompleteListSpaces, clearListDeficits } from './list-deficits.js'
import { LOOSE_SHARE_ID } from './transfer-id.js'
import { shareDecoKey } from './decoration-key.js'
import { record } from '../audit/audit-log.js'
import { observePeerProfile } from '../audit/peer-watch.js'
import { observeReachability, peerLost, peerLostMeta, peerSeen, peerLeft, resetNetworkWatch } from '../audit/network-watch.js'
import { sealSck } from './sck-seal.js'
import { sanitizeAvatar } from '../identity-limits.js'
import { markLeft, rosterDeficits, recomputeMemberView, scheduleCapture, captureDeficits } from '../spaces/member-registry.js'
import { createPresence, presenceFrameKind } from '../state/presence.js'
import { makeKeyedCoalescer } from '../state/coalesce.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { classify, stabilise, routableAddressKind, CANARY, BLOCKED_DWELL_MS, NAT_SETTLE_MS, LIVENESS_FAILURES_FOR_OFFLINE } from '../core/reachability.js'
import { createSwarmDiagnostics } from './swarm-diagnostics.js'
import { createAdmissionGates } from './admission-gates.js'

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
const PRESENCE_HEARTBEAT_MS = 5000
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
let presenceTimer = null

let swarm
let ipcRef
const connectedPeers = new Map()  // profileKey → { socket, profileKey, displayName, avatar, spaces: Map<spaceId, driveKey> }
const socketToPeers = new Map()   // socket → Set<profileKey>  (reverse index for disconnect lookup)
const spaceTopics = new Map()
const spaceDiscoveries = new Map() // spaceId → PeerDiscovery (kept so reconnectAll can refresh)
const leavingSpaces = new Set()         // spaceIds whose teardown is in flight
const leaveAcks = new Map()             // spaceId (we are leaving) → Set<profileKeyHex> of co-members that applied our leave

export function markSpaceLeaving(spaceId) { leavingSpaces.add(spaceId) }
export function unmarkSpaceLeaving(spaceId) { leavingSpaces.delete(spaceId) }
export function isSpaceLeaving(spaceId) { return leavingSpaces.has(spaceId) }
let overlayReconnectHook = null         // notified when an overlay-content owner (re)connects, so paused/interrupted overlay downloads (loose + folder) resume
let membershipControlHandler = null     // membership:* frames (join request / grant / deny) routed to the worker
let connectionAttachHook = null         // per-connection (mux, socket) hook so content backends bind extra protocol channels (overlay)
let revokeServesForSpaceHook = null     // membership changed → drop the serve grants cached for that space (overlay owns them; swarm must not import it)
const profileBeeAppendListeners = new Map()  // profileKey hex → { bee, listener } — the ONE held bee per peer
const socketMsgHandlers = new Map()     // socket → Protomux msgHandler (for sending handshakes to existing connections)
const pendingRequesters = new Map()     // profileKey → socket (a pending joiner has no drive/handshake yet, so track its socket to grant later)
// Every identity frame a peer sends carries its bound ed25519 signer key; remember it per
// profileKey so a membership:grant can always be sealed to a CURRENTLY-CONNECTED joiner —
// independent of the fragile join-request-record lifecycle (which loses it across leave/rejoin
// churn). A grant only reaches a connected joiner, so its signer key is always here.
const boundSignerKeys = new Map()       // profileKey → signerKey hex
const pendingAdmitInflight = new Set()  // 'spaceId:joinerKey' currently being admitted via reconcile
const bannedNoiseKeys = new Set()       // Noise keys evicted for identity-frame flooding; the firewall rejects their reconnects
let rateLimiter = null                  // dual-lane per-socket identity-frame token bucket, created in initSwarm
let frameLimiter = null                 // general per-socket budget charged for EVERY frame type
// Why a frame was dropped, for diagnostics — hardening nobody can see is hardening nobody can tune.
const droppedFrames = { oversize: 0, rate: 0, parse: 0, shape: 0, unknown: 0 }
function countDroppedFrame(reason) { droppedFrames[reason] += 1 }
export function getDroppedFrameCounters() { return { ...droppedFrames } }
// Unsettled identity-frame announcements per (socket, space), drained by the convergence
// tick — the level-triggered resend that heals a dropped handshake/membership:request.
const announceLedger = createAnnounceLedger()
let convergenceTimer = null
let convergenceTicking = false          // re-entrancy guard: the tick is async, setInterval isn't
const deficitTicks = new Map()          // spaceId → consecutive ticks with a roster deficit
const lastRefreshAt = new Map()         // spaceId → last escalation (discovery.refresh) time
const escalationsSpent = new Map()      // spaceId → discovery.refreshes spent on the current deficit
let testDrop = null                     // test-only inbound identity-frame drop window

let dhtReady = false
let readyAt = 0
let announced = false
let hostChangeCount = 0
let lastKnownHost = null
let currentReachability = { verdict: 'unknown', cause: null, confidence: 'predicted', evidence: null, since: 0, pending: null }
let verdictHistory = []
let lastCanaryResult = { state: CANARY.UNAVAILABLE, at: 0 }
let browserOnlineHint = true
let lastConnectionAt = null
let lastEmittedStatus = null
let statusEmitTimer = null
let lastReconnectAt = 0
let bootedAt = 0
const STATUS_EMIT_DEBOUNCE_MS = 300
const RECONNECT_THROTTLE_MS = 5000
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
  bootedAt = Date.now()
  log.info('initialized')

  presenceTimer = setInterval(() => {
    try { broadcastPresence() } catch (err) { log.debug('presence heartbeat failed:', err.message) }
    presence.prune()
  }, PRESENCE_HEARTBEAT_MS)
  presenceTimer.unref?.()
  startConvergenceTick()

  swarm.on('update', scheduleStatusEmit)

  const onDhtReady = () => {
    // fullyBootstrapped() can resolve after destroySwarm; without this the liveness and interface
    // loops are re-armed on a swarm that no longer exists.
    if (!swarm || dhtReady) return
    dhtReady = true
    readyAt = Date.now()
    scheduleStatusEmit()
    scheduleFirstCanaryProbe()
    startLivenessLoop()
    startInterfaceWatch()
  }
  swarm.dht.on('ready', onDhtReady)
  swarm.dht.fullyBootstrapped().then(onDhtReady, () => {})
  swarm.dht.on('persistent', scheduleStatusEmit)
  swarm.dht.on('network-change', scheduleStatusEmit)
  swarm.dht.on('wake-up', scheduleStatusEmit)
  swarm.dht.on('nat-update', (host) => {
    if (typeof host === 'string' && lastKnownHost !== null && host !== lastKnownHost) hostChangeCount++
    if (typeof host === 'string') lastKnownHost = host
    scheduleStatusEmit()
  })

  swarm.on('connection', (socket, peerInfo) => {
    livenessFailures = 0
    applyNetImpairment(socket) // TEST-ONLY: no-op unless runtime-config.netImpair is set
    lastConnectionAt = Date.now()
    scheduleStatusEmit()
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
function memberSnapshot (space, publicKey) {
  return {
    spaceName: space?.name ?? null,
    memberName: (space?.members || []).find((m) => m.publicKey === publicKey)?.displayName ?? null,
  }
}

function recordMemberLeft (spaceId, profileKey, snapshot) {
  record('member.left', {
    actor: { type: 'peer', key: profileKey, name: snapshot.memberName },
    space: { id: spaceId, name: snapshot.spaceName },
    target: { kind: 'member', id: profileKey, name: snapshot.memberName },
  })
}

// === Leave protocol ===

async function handleLeaveFrame(socket, peerInfo, msg) {
  const { spaceId, profileKey } = msg
  if (!spaceId || !profileKey) return

  // Our own teardown destroys the sockets that clear the auth index, so an inbound
  // frame for a space we're leaving races into the rejection below — drop it quietly.
  if (leavingSpaces.has(spaceId)) return

  // Accept iff the sender proves it controls profileKey on THIS connection: the fast path is the
  // per-socket auth index; the robust path is the frame's identity binding, which survives the
  // teardown/reconnect race that clears or has-not-yet-populated that index. Additive — the binding
  // proof is strictly stronger than the index, so a third party still cannot evict a member.
  const onSocket = socketToPeers.get(socket)?.has(profileKey) || false
  if (!onSocket && !leaveFrameBound(peerInfo, msg)) {
    log.warn('leave frame rejected — sender not authenticated on socket and no valid binding')
    return
  }

  const space = await getSpace(spaceId)
  if (!space?.members) return

  // Take over the leaver's vouchees before touching anything else. The revoke below unroots the
  // leaver, and from then on the fold stops walking its bee, so the subtree it alone vouched for
  // could never be recovered. The leaver is connected right now, which is the best window there is
  // to read that record. When it is unreadable, apply NOTHING: the replication-driven path retries
  // once the departure record lands, which is strictly better than tombstoning here while our vouch
  // still stands (a tombstone would suppress every retry).
  if (!(await adoptVouchees(spaceId, profileKey))) {
    log.warn('leave frame deferred — leaver record unreadable, cannot adopt:', profileKey.slice(0, 12))
    return
  }

  // After the deferral above, so a leave we did not apply records nothing.
  const leftSnapshot = memberSnapshot(space, profileKey)

  // Tombstone the leaver FIRST so the member-view fold can't re-add them from their stale
  // still-active record (their del-record may not replicate before they disconnect). Set
  // before removeMember so any in-flight re-derive already subtracts them. Persist it so the
  // subtraction survives a restart, incl. the creator/root where revokeApproval is a no-op.
  // msg.ts is untrusted wire data used as the durable self-clear stamp — reject a non-finite /
  // non-positive value (a negative would make tombstoneActive false and re-add the leaver). It is
  // the leaver's own clock, same as the member/<S>.ts a rejoin writes, so the comparison stays
  // single-clock in the common path.
  const leaveTs = (typeof msg.ts === 'number' && Number.isFinite(msg.ts) && msg.ts > 0) ? msg.ts : Date.now()
  markLeft(spaceId, profileKey, leaveTs)
  let durablyApplied = true
  try { await persistLeftTombstone(spaceId, profileKey, leaveTs) } catch (err) {
    durablyApplied = false
    log.warn('persist leave tombstone failed:', err.message)
  }

  // Revoke our own approval so a later rejoin needs fresh approval, not a silent re-admit off the
  // surviving grow-only record. Unconditional + idempotent: a leaver already pruned by the fold (or a
  // duplicate frame) must still lose our vouch. No-op for the creator (we hold no approval for the
  // root). Safe to unroot the leaver here — its vouchees were adopted above.
  try { await revokeApproval(spaceId, profileKey) } catch (err) {
    durablyApplied = false
    log.warn('approval revoke on leave failed:', err.message)
  }

  // Ack the leaver over its own socket so it can stop waiting (awaitLeaveAcks) — but ONLY once the
  // durable tombstone + revoke actually landed, since that is exactly what the ack attests. A
  // swallowed durable failure must not resolve the wait early; the leaver falls back to the cap.
  const selfKey = getProfileKey()
  if (durablyApplied && selfKey) {
    try { socketMsgHandlers.get(socket)?.send(JSON.stringify({ type: 'leave-ack', spaceId, profileKey: b4a.toString(selfKey, 'hex') })) } catch {}
  }

  const removed = await removeMember(spaceId, profileKey)
  if (!removed) return
  log.info('peer left space (leave frame):', profileKey.slice(0, 12) + '...', '→', spaceId)

  presence.clear(profileKey, spaceId)   // the leaver is offline in this space immediately
  peerLeft(profileKey, spaceId)         // ...but that is a LEAVE; member.left carries it

  const peer = connectedPeers.get(profileKey)
  if (peer) {
    peer.spaces.delete(spaceId)
    peer.looseCatalogKeys?.delete(spaceId)
    if (peer.spaces.size === 0) {
      connectedPeers.delete(profileKey)
      const set = socketToPeers.get(peer.socket)
      if (set) {
        set.delete(profileKey)
        if (set.size === 0) socketToPeers.delete(peer.socket)
      }
      // The overlay content channel rides the CONTENT socket, not this one: a peer we no longer
      // share any space with must lose that socket too, or we keep serving it bulk bytes.
      try { destroyContentPeerSockets(profileKey) } catch {}
    }
  }
  // Their leave revokes our serve grants for this space: the grant is cached per (peer, path) at
  // request time and re-checked against that cache only, so a membership change has to invalidate
  // it actively — otherwise an in-flight transfer keeps streaming to a peer no longer entitled.
  revokeServesForSpaceHook?.(spaceId, profileKey)

  recordMemberLeft(spaceId, profileKey, leftSnapshot)

  ipcRef.emit('event:member-left', { spaceId, publicKey: profileKey })
  ipcRef.emit('event:files-updated', { spaceId })
}

// ── pending outbound leaves (leave-while-alone recovery) ────────────────────────
// spaceId → { topic, ts }. A leave that provably reached no member is re-announced on
// every new connection until a co-member acks its durable apply. Seeded from the
// pendingleave/ markers at boot (the space record itself is already purged); the worker
// injects onApplied to clear the marker + leave the topic. ts is the ORIGINAL leave
// stamp so a genuine later rejoin (strictly newer member/<S> ts) always outranks the
// replayed tombstone on co-members.
const pendingLeaves = new Map()
const pendingLeaveFramesSent = new WeakMap()   // socket → Set<spaceId> (ack eligibility for the record-less space)
let onPendingLeaveApplied = null

export function configurePendingLeaves(onApplied) { onPendingLeaveApplied = onApplied }

export function registerPendingLeave(spaceId, topicHex, ts) {
  pendingLeaves.set(spaceId, { topic: topicHex, ts })
}

export function unregisterPendingLeave(spaceId) { pendingLeaves.delete(spaceId) }

export function hasPendingLeave(spaceId) { return pendingLeaves.has(spaceId) }

// Join/leave the topic of a PURGED space (both leave-replay and cancel-replay need this — the
// space record is gone, so joinSpaceTopic can't read it). Return whether they acted, for logging.
function joinPurgedSpaceTopic(spaceId, topicHex) {
  if (!swarm || spaceDiscoveries.has(spaceId)) return false
  spaceTopics.set(spaceId, topicHex)
  spaceDiscoveries.set(spaceId, swarm.join(b4a.from(topicHex, 'hex'), { server: true, client: true }))
  return true
}

async function leavePurgedSpaceTopic(spaceId) {
  const topicHex = spaceTopics.get(spaceId)
  if (!topicHex) return false
  try { await swarm.leave(b4a.from(topicHex, 'hex')) } catch {}
  spaceTopics.delete(spaceId)
  spaceDiscoveries.delete(spaceId)
  return true
}

export function joinPendingLeaveTopic(spaceId, topicHex) {
  if (joinPurgedSpaceTopic(spaceId, topicHex)) log.info('joined topic for pending-leave replay:', spaceId)
}

export async function leavePendingLeaveTopic(spaceId) {
  if (await leavePurgedSpaceTopic(spaceId)) log.info('left pending-leave topic:', spaceId)
}

function sendPendingLeaveFrames(socket, msgHandler) {
  if (pendingLeaves.size === 0) return
  const profileKey = getProfileKey()
  if (!profileKey) return
  const profileKeyHex = b4a.toString(profileKey, 'hex')
  let sent = pendingLeaveFramesSent.get(socket)
  if (!sent) pendingLeaveFramesSent.set(socket, (sent = new Set()))
  for (const [spaceId, { ts }] of pendingLeaves) {
    sent.add(spaceId)
    try {
      msgHandler.send(JSON.stringify({ type: 'leave', spaceId, profileKey: profileKeyHex, ts, ...(getLocalBinding() || {}) }))
    } catch (err) {
      log.debug('pending-leave frame send failed:', err.message)
    }
  }
}

export function sendLeaveFrameToConnectedPeers(spaceId) {
  if (socketMsgHandlers.size === 0) return
  const profileKey = getProfileKey()
  if (!profileKey) return
  const profileKeyHex = b4a.toString(profileKey, 'hex')
  leaveAcks.set(spaceId, new Set())   // collect co-member acks BEFORE the frames go out (no missed-ack race)
  const payload = JSON.stringify({
    type: 'leave',
    spaceId,
    profileKey: profileKeyHex,
    ts: Date.now(),
    ...(getLocalBinding() || {}),
  })
  for (const [, handler] of socketMsgHandlers) {
    try { handler.send(payload) } catch (err) {
      log.warn('leave frame send failed:', err.message)
    }
  }
}

export function leaveAcksSatisfied(expectedKeys, receivedSet) {
  for (const k of expectedKeys) if (!receivedSet.has(k)) return false
  return true
}

// Wait (bounded) for the connected members of a space to confirm they applied our leave — an
// observed signal that the load-bearing revokeApproval ran on our approvers before we tear
// down. Resolves early on full coverage; falls back to the cap for peers on older releases
// (which never ack) or a straggler. No connected members ⇒ nothing to wait for.
export async function awaitLeaveAcks(spaceId, { capMs = 2000, pollMs = 50, floorMs = 0 } = {}) {
  const received = leaveAcks.get(spaceId)
  const expected = new Set(getConnectedPeers(spaceId))
  try {
    if (!received || expected.size === 0) return true
    const start = Date.now()
    for (;;) {
      const elapsed = Date.now() - start
      // Hold at least floorMs even once every ack lands: an ack proves the co-member ran its
      // revoke, but NOT that it pulled our `del member/<S>` block (authored just before the frame)
      // so it can re-host the departure to members offline at leave time. The floor preserves a
      // replication window for that block.
      if (elapsed >= floorMs && leaveAcksSatisfied(expected, received)) return true
      if (elapsed >= capMs) return false
      await new Promise((r) => setTimeout(r, pollMs))
    }
  } finally {
    // Snapshot the acked keys before dropping the ledger, so the pending-leave arm decision can
    // ask "which members provably applied the leave" — the boolean return conflates that with
    // "nobody was connected" (vacuous true), which would skip the marker exactly when a member
    // dropped mid-leave.
    if (received) lastLeaveAckedKeys.set(spaceId, new Set(received))
    leaveAcks.delete(spaceId)
  }
}

// spaceId → Set<keyHex> of members that acked our most recent leave (populated by awaitLeaveAcks).
const lastLeaveAckedKeys = new Map()
export function takeLeaveAckedKeys(spaceId) {
  const set = lastLeaveAckedKeys.get(spaceId)
  lastLeaveAckedKeys.delete(spaceId)
  return set || new Set()
}

function handleLeaveAckFrame(socket, msg) {
  const { spaceId, profileKey } = msg
  if (!spaceId || !profileKey) return
  // A pending-leave replay ack arrives on a socket with no live handshake for the purged
  // space (we no longer handshake it), so the strict rule below would drop it. Accept it
  // from a socket this pending frame went out on: the Noise session pins the counterparty,
  // and the worst a false ack does is stop the re-announce — the pre-marker behavior.
  if (pendingLeaves.has(spaceId) && pendingLeaveFramesSent.get(socket)?.has(spaceId)) {
    pendingLeaves.delete(spaceId)
    log.info('pending leave acked — clearing marker:', spaceId)
    Promise.resolve(onPendingLeaveApplied?.(spaceId)).catch((err) => log.debug('pending-leave clear failed:', err.message))
  }
  // Only count an ack from a peer that authenticated as this profileKey on this socket, so a peer
  // can't forge acks for other members and collapse the leaver's flush wait early.
  if (!socketToPeers.get(socket)?.has(profileKey)) return
  leaveAcks.get(spaceId)?.add(profileKey)
}

// ── pending outbound cancels (withdraw-a-request delivery) ──────────────────────
// A withdrawing pending joiner must reach at least one member showing its request; that member
// writes a durable denied tombstone which replicates to the rest. Re-announced on every new
// connection until an applied ack lands. In-memory: cleared on restart.
const pendingCancels = new Map()   // spaceId → { topic, joinerKey, attempts }
const pendingCancelFramesSent = new WeakMap()   // socket → Set<spaceId> (ack eligibility)
// Bound the replay so an abandoned withdrawal to an always-offline space can't hold the topic for
// the whole session; a member reached before the cap converges it, past it we give up (a member
// offline the entire time keeps the stale request — the documented in-memory-only residual).
const MAX_CANCEL_ATTEMPTS = 30
let onPendingCancelApplied = null

export function configurePendingCancels(onApplied) { onPendingCancelApplied = onApplied }

export function registerPendingCancel(spaceId, topicHex, joinerKey) {
  pendingCancels.set(spaceId, { topic: topicHex, joinerKey, attempts: 0 })
}

export function hasPendingCancel(spaceId) { return pendingCancels.has(spaceId) }

export function joinPendingCancelTopic(spaceId, topicHex) { joinPurgedSpaceTopic(spaceId, topicHex) }
export async function leavePendingCancelTopic(spaceId) { await leavePurgedSpaceTopic(spaceId) }

function sendPendingCancelFrames(socket, msgHandler) {
  if (pendingCancels.size === 0) return
  let sent = pendingCancelFramesSent.get(socket)
  if (!sent) pendingCancelFramesSent.set(socket, (sent = new Set()))
  for (const [spaceId, pc] of pendingCancels) {
    try { msgHandler.send(JSON.stringify({ type: 'membership:cancel', spaceTopic: pc.topic, joinerKey: pc.joinerKey })) } catch { continue }
    sent.add(spaceId)
    if (++pc.attempts >= MAX_CANCEL_ATTEMPTS) {
      pendingCancels.delete(spaceId)
      leavePurgedSpaceTopic(spaceId).catch((err) => log.debug('pending-cancel give-up leave failed:', err.message))
    }
  }
}

// Initial send of a freshly-registered cancel on every current connection. Goes through
// sendPendingCancelFrames (not broadcastMembershipCancel) so ack eligibility is recorded per socket
// — otherwise a member acking over the existing connection would be rejected by handleMembershipCancelAck.
export function sendPendingCancelToConnected() {
  for (const [socket, handler] of socketMsgHandlers) sendPendingCancelFrames(socket, handler)
}

// A member acked our cancel with applied:true (it wrote the converging tombstone) on a socket we
// actually sent the cancel on — stop replaying and drop the topic. The socket + frame-sent check
// mirrors handleLeaveAckFrame: a peer that never received our cancel can't clear it.
function handleMembershipCancelAck(socket, msg) {
  if (!msg.applied || typeof msg.spaceTopic !== 'string') return
  for (const [spaceId, pc] of pendingCancels) {
    if (pc.topic !== msg.spaceTopic) continue
    if (!pendingCancelFramesSent.get(socket)?.has(spaceId)) return
    pendingCancels.delete(spaceId)
    Promise.resolve(onPendingCancelApplied?.(spaceId)).catch((err) => log.debug('pending-cancel clear failed:', err.message))
    return
  }
}

// Membership removal is the member-set fold's job (member-registry): a peer drops from the
// set when their replicated `del member/S` (leave) lands, and stays an offline member
// otherwise. This layer deliberately never prunes membership on disconnect — admission is
// separate from membership display, and a dead socket says nothing about membership.

// === Deferred admission of pending joiners ===

// A peer we recorded as a pending join request may since have been approved by a
// co-member. Re-run the gate; if it now passes, admit them. If we hold their driveKey
// (captured from a post-grant re-handshake) we replay their handshake directly — opening
// their drive, listing them as a member, sending the reciprocal, and clearing the stale
// request via the shared admit path. If we only ever saw their membership:request (no
// drive), we prompt a fresh handshake over the live socket so they re-send with a driveKey
// the gate can then admit for content — rather than bailing and leaving them unadmitted.
export async function reconcilePendingRequester(spaceId, joinerKey) {
  const key = spaceId + ':admit:' + joinerKey
  if (pendingAdmitInflight.has(key)) return
  pendingAdmitInflight.add(key)
  try {
    const space = await getSpace(spaceId)
    if (!space || space.status === 'pending') return
    if ((space.members || []).some((m) => m.publicKey === joinerKey)) return
    if (!(await gates.isApprovedByPeers(space, joinerKey))) return
    const sock = connectedPeers.get(joinerKey)?.socket || pendingRequesters.get(joinerKey)
    const topic = spaceTopics.get(spaceId)
    if (!sock || !topic) return
    const driveKey = getJoinRequestDriveKey(spaceId, joinerKey)
    if (!driveKey) {
      const handler = socketMsgHandlers.get(sock)
      if (handler) await sendSingleHandshake(sock, handler, spaceId, topic)
      return
    }
    const req = listJoinRequests(spaceId).find((r) => r.publicKey === joinerKey)
    await handleHandshake(sock, null, {
      type: 'handshake',
      profileKey: joinerKey,
      driveKey,
      displayName: req?.displayName || 'Unknown',
      spaceTopic: topic,
    })
  } finally {
    pendingAdmitInflight.delete(key)
  }
}

async function reconcilePendingRequestersForSpace(spaceId) {
  for (const req of listJoinRequests(spaceId)) {
    reconcilePendingRequester(spaceId, req.publicKey).catch((err) => {
      log.warn('pending requester reconcile failed:', err.message)
    })
  }
}

async function reconcilePendingRequestersForApprover(approverKey) {
  const spaces = await listSpaces()
  for (const space of spaces) {
    if (!(space.members || []).some((m) => m.publicKey === approverKey)) continue
    await reconcilePendingRequestersForSpace(space.spaceId)
  }
}

const readmitInflight = new Set()

// The derived member set just vouched for joinerKey; admit it if we have a live socket but no
// admitted handshake for this space (its handshake raced ahead of the record that admits it, so we
// bounced it to a join request and never sent the reciprocal — leaving a connected member showing as
// Unknown/Offline). Replaying handleHandshake opens its drive, lists it, marks presence, and sends
// the reciprocal. If we never captured its driveKey, send our handshake instead to prompt a fresh
// one. Unlike reconcilePendingRequester this trusts the fold (no isApprovedByPeers re-check), so it
// also admits the creator, who is approved by nobody.
async function admitDerivedMember(spaceId, joinerKey) {
  const sock = connectedPeers.get(joinerKey)?.socket || pendingRequesters.get(joinerKey)
  const topic = spaceTopics.get(spaceId)
  if (!sock || !topic) return
  const driveKey = getJoinRequestDriveKey(spaceId, joinerKey)
  if (!driveKey) {
    const handler = socketMsgHandlers.get(sock)
    if (handler) await sendSingleHandshake(sock, handler, spaceId, topic)
    return
  }
  const req = listJoinRequests(spaceId).find((r) => r.publicKey === joinerKey)
  await handleHandshake(sock, null, {
    type: 'handshake',
    profileKey: joinerKey,
    driveKey,
    displayName: req?.displayName || 'Unknown',
    spaceTopic: topic,
  })
}

export function readmitConnectedMembers(spaceId, keys) {
  for (const key of keys) {
    if (!pendingRequesters.has(key) && !connectedPeers.has(key)) continue
    const guard = spaceId + ':' + key
    if (readmitInflight.has(guard)) continue
    readmitInflight.add(guard)
    admitDerivedMember(spaceId, key)
      .catch((err) => log.warn('readmit on derive failed:', err.message))
      .finally(() => readmitInflight.delete(guard))
  }
}

export function emitSharesUpdated(spaceId) {
  if (ipcRef) ipcRef.emit('event:shares-updated', { spaceId })
}

// A peer's profile bee appended (it holds their `share/<space>/*` records), so refresh the
// share list for every space we share with them. Coarse by design — any bee change pokes
// the list — but cheap, and it's the renderer's only signal that a peer added/removed a share.
// We poke the FILE list too: files:list hides a peer's folder-share contents using prefixes read
// from this same profile bee, but the renderer's useFiles refreshes only on event:files-updated
// (the profile-bee append fires shares-updated, not files-updated). Without this a peer's
// newly-shared — or slow-to-replicate — folder would leak its files into the flat loose-file list
// until some unrelated files-updated happened to fire.
async function emitPeerSharesUpdated(profileKeyHex) {
  if (!ipcRef) return
  for (const space of await listSpaces()) {
    if ((space.members || []).some((m) => m.publicKey === profileKeyHex)) {
      ipcRef.emit('event:shares-updated', { spaceId: space.spaceId })
      ipcRef.emit('event:files-updated', { spaceId: space.spaceId })
      ipcRef.emit('event:mirrors-updated', { spaceId: space.spaceId })
    }
  }
}

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
      announced = true
      scheduleStatusEmit()
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

// === Convergence tick ===

// Re-send identity frames whose implicit ack never arrived. Settled means: for a member
// space, some identity on that socket is admitted to it (their reciprocal proved the round
// trip); for a pending space, the grant/deny flipped the status. A space that is leaving,
// left, or only held as a pending-leave replay topic (no record) has nothing to announce.
async function drainAnnounceLedger() {
  if (socketMsgHandlers.size === 0) return
  // Resolve per-space status only for the spaces actually in the ledger — a converged client
  // with an empty ledger does no bee reads at all.
  const pending = announceLedger.spaceIds()
  if (pending.size === 0) return
  const cfg = getConvergenceConfig()
  const status = new Map()
  for (const spaceId of pending) {
    if (!spaceTopics.has(spaceId) || isSpaceLeaving(spaceId)) continue
    // announceStatus distinguishes "present but statusless" (owner-created / v1 → 'active',
    // a real member space) from "gone" (null → settled). Conflating them killed the owner's heal.
    status.set(spaceId, announceStatus(await getSpace(spaceId)))
  }
  const isSettled = (socket, spaceId, kind) => {
    const st = status.get(spaceId)
    if (!st) return true
    if (kind === 'request') return st !== 'pending'
    for (const k of socketToPeers.get(socket) || []) {
      if (connectedPeers.get(k)?.spaces.has(spaceId)) return true
    }
    return false
  }
  const due = announceLedger.due({
    now: Date.now(),
    baseMs: cfg.announceBaseMs,
    capMs: cfg.announceCapMs,
    maxAttempts: cfg.announceMaxAttempts,
    isSettled,
  })
  for (const { socketId: socket, spaceId } of due) {
    const handler = socketMsgHandlers.get(socket)
    const topic = spaceTopics.get(spaceId)
    // A dead socket (disconnected during a prior await) leaves zombie ledger entries the pure
    // due() can't see socketMsgHandlers to prune — forget it here so its bucket evaporates.
    if (!handler) { announceLedger.forgetSocket(socket); continue }
    if (!topic) continue
    log.debug('re-announcing space', spaceId)
    await sendSingleHandshake(socket, handler, spaceId, topic)
  }
}

// One slow, global, deficit-gated pass — the level-triggered re-drive an app restart used
// to be: re-send unacked identity frames, re-fold rosters whose considered records haven't
// replicated (escalating a persistent deficit to a throttled discovery refresh — fresh
// connections mean fresh replication streams), and re-poke listings that gave up on a peer
// catalog under the read budget. A converged, quiet swarm does nothing here.
async function runConvergenceTick() {
  await drainAnnounceLedger()
  const cfg = getConvergenceConfig()
  const deficits = rosterDeficits()
  for (const spaceId of spaceTopics.keys()) {
    if (!deficits.has(spaceId) || isSpaceLeaving(spaceId)) {
      // Deficit cleared: reset all per-space escalation state so a LATER deficit (a new member
      // not yet replicated) gets a fresh escalation budget.
      deficitTicks.delete(spaceId)
      lastRefreshAt.delete(spaceId)
      escalationsSpent.delete(spaceId)
      continue
    }
    const ticks = (deficitTicks.get(spaceId) || 0) + 1
    deficitTicks.set(spaceId, ticks)
    recomputeMemberView(spaceId)
    const spent = escalationsSpent.get(spaceId) || 0
    const due = spent < cfg.convergenceMaxEscalations && escalationDue({
      ticks,
      escalateTicks: cfg.convergenceEscalateTicks,
      lastRefreshAt: lastRefreshAt.get(spaceId) || 0,
      minMs: cfg.convergenceRefreshMinMs,
      now: Date.now(),
    })
    if (due) {
      lastRefreshAt.set(spaceId, Date.now())
      escalationsSpent.set(spaceId, spent + 1)
      log.info('convergence refresh — roster deficit persisted', ticks, 'ticks for', spaceId)
      const discovery = spaceDiscoveries.get(spaceId)
      if (discovery) {
        try {
          discovery.refresh({ client: true, server: true }).catch((err) => log.debug('convergence refresh failed:', spaceId, err.message))
        } catch (err) {
          log.debug('convergence refresh failed:', spaceId, err.message)
        }
      }
    }
  }
  for (const spaceId of takeIncompleteListSpaces()) {
    if (spaceTopics.has(spaceId) && !isSpaceLeaving(spaceId)) ipcRef?.emit('event:files-updated', { spaceId })
  }
  // Re-attempt incomplete peer-bee captures: a capture that raced a starved or
  // short-lived session heals here on a later one. Throttled per key inside the
  // scheduler; retired keys (complete or past the sweep cap) never come back.
  for (const key of await captureDeficits()) scheduleCapture(key)
  try { await rescueStalledTransfers() } catch (err) { log.debug('stalled-transfer rescue failed:', err.message) }
}

// Hyperswarm stops re-dialing a peer whose connections keep dying young: a link that drops inside
// its prove-yourself window never resets the peer's attempt counter, and after the fourth such
// close the peer loses its retry timer altogether — the next automatic dial is a topic re-lookup
// ten minutes out. The escalation above cannot save us: it is gated on a ROSTER deficit, and a
// two-peer space whose roster is fully replicated never has one, so a download can sit dead while
// the swarm believes it is converged.
//
// A pending download whose owner we hold no socket for is exactly that state, and a discovery
// refresh is the one lever that clears it (rediscovering a peer resets its attempts). Both planes
// need it: the bulk plane carries the bytes, but the control plane carries the presence lease the
// download's resume gate reads — rescuing only one leaves the transfer gated behind the other.
// Refresh eagerly at first — a flapping link brings the peer back within a second or two, and every
// cycle we sit out is a cycle the transfer makes no progress. But an owner who is simply offline
// would then have us re-announce forever, so each fruitless attempt backs the next one off, up to a
// quiet ceiling. Any attempt that finds every owner reachable resets it.
const STALL_RESCUE_MIN_MS = 10_000
const STALL_RESCUE_MAX_MS = 300_000
let stalledOwnersHook = null
let lastStallRescueAt = 0
let stallRescueBackoffMs = STALL_RESCUE_MIN_MS
let stallRescueInFlight = false


export async function rescueStalledTransfers() {
  if (!swarm || !stalledOwnersHook || stallRescueInFlight) return false

  stallRescueInFlight = true
  try {
    const contentActive = getContentPlaneStatus().active
    let controlDown = false
    let contentDown = false
    for (const ownerKey of await stalledOwnersHook()) {
      if (!connectedPeers.has(ownerKey)) controlDown = true
      if (contentActive && !contentPlaneHasPeer(ownerKey)) contentDown = true
    }
    if (!controlDown && !contentDown) {
      stallRescueBackoffMs = STALL_RESCUE_MIN_MS // everyone we are waiting on is reachable
      return false
    }
    if (Date.now() - lastStallRescueAt < stallRescueBackoffMs) return false

    lastStallRescueAt = Date.now()
    stallRescueBackoffMs = Math.min(stallRescueBackoffMs * 2, STALL_RESCUE_MAX_MS)
    log.info('stalled transfer — refreshing discovery:', controlDown ? 'control' : '', contentDown ? 'content' : '')
    if (controlDown) {
      for (const [spaceId, discovery] of spaceDiscoveries) {
        try { await discovery.refresh({ client: true, server: true }) } catch (err) { log.debug('stall refresh failed for', spaceId, err.message) }
      }
    }
    if (contentDown) await refreshContentDiscoveries()
    return true
  } finally {
    stallRescueInFlight = false
  }
}

function startConvergenceTick() {
  if (convergenceTimer) return
  const { convergenceTickMs } = getConvergenceConfig()
  if (!convergenceTickMs) return
  convergenceTimer = setInterval(() => {
    // The tick is async and setInterval doesn't await it — skip a fire that lands while the
    // previous run is still in flight, so overlapping runs can't double-send or double-count.
    if (convergenceTicking) return
    convergenceTicking = true
    runConvergenceTick()
      .catch((err) => log.debug('convergence tick failed:', err.message))
      .finally(() => { convergenceTicking = false })
  }, convergenceTickMs)
  convergenceTimer.unref?.()
}

export async function leaveSpaceTopic(spaceId) {
  const space = await getSpace(spaceId)
  if (!space) return
  const topic = b4a.from(space.topic, 'hex')
  await swarm.leave(topic)
  spaceTopics.delete(spaceId)
  spaceDiscoveries.delete(spaceId)
  try { await leaveContentTopic(spaceId) } catch {} // no-op unless the content plane is active
  // The tick's cleanup only visits current spaceTopics, so a left space's escalation state
  // would dangle (and mistime escalation on a same-space rejoin) — drop it here. The announce
  // ledger self-prunes the left space on its next drain (status resolves null → settled).
  deficitTicks.delete(spaceId)
  lastRefreshAt.delete(spaceId)
  escalationsSpent.delete(spaceId)
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

// === Presence & ephemeral broadcasts ===

// Heartbeat: advertise our own liveness per space to the peers in it. The recipient leases
// us for PRESENCE_TTL_MS from when it receives this — we can't extend our own lease.
function broadcastPresence() {
  if (socketMsgHandlers.size === 0) return
  const profileKeyHex = b4a.toString(getProfileKey(), 'hex')
  for (const [spaceId, topicHex] of spaceTopics) {
    for (const [, peer] of connectedPeers) {
      if (!peer.spaces.has(spaceId)) continue
      const handler = socketMsgHandlers.get(peer.socket)
      if (handler) { try { handler.send(JSON.stringify({ type: 'presence', profileKey: profileKeyHex, spaceTopic: topicHex })) } catch {} }
    }
  }
}

// Graceful-quit departure: tell every connected peer we're going offline NOW so they flip us
// offline immediately instead of waiting out the socket close / 15s presence TTL. Reuses the
// presence frame with offline:true (NOT the leave frame — that mints membership tombstones we must
// not trigger on a mere quit). Best-effort; socket close + TTL remain the backstops.
export function broadcastDeparture() {
  // Stop our own heartbeat first: a heartbeat firing later in the shutdown teardown window would
  // re-mark us online on a receiver (mark after clear) and undo this departure.
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null }
  if (!swarm || socketMsgHandlers.size === 0) return
  const profileKeyHex = b4a.toString(getProfileKey(), 'hex')
  for (const [spaceId, topicHex] of spaceTopics) {
    for (const [, peer] of connectedPeers) {
      if (!peer.spaces.has(spaceId)) continue
      const handler = socketMsgHandlers.get(peer.socket)
      if (handler) { try { handler.send(JSON.stringify({ type: 'presence', profileKey: profileKeyHex, spaceTopic: topicHex, offline: true })) } catch {} }
    }
  }
}

// Owner→members: live indexing/hashing progress for a file still advertised with contentHash:null
// (consumer status 'preparing'). Ephemeral, scoped to peers connected on this space.
export function broadcastSharePrepareProgress(spaceId, payload) {
  if (socketMsgHandlers.size === 0) return
  const profileKeyHex = b4a.toString(getProfileKey(), 'hex')
  const frame = JSON.stringify({ type: 'share-prepare-progress', profileKey: profileKeyHex, spaceId, ...payload })
  for (const [, peer] of connectedPeers) {
    if (!peer.spaces.has(spaceId)) continue
    const handler = socketMsgHandlers.get(peer.socket)
    if (handler) { try { handler.send(frame) } catch {} }
  }
}

// A share is admission-gated at 5k files and a folder that grows past it keeps publishing, so this
// is a display bound, not a limit — it only stops a peer-supplied count from rendering as nonsense.
const MAX_WIRE_COUNT = 1_000_000

// Owner→members: how much of a share is still waiting to be indexed. Ephemeral like the per-file
// frame above, and for the same reason — the queue is not durable state, so it is re-announced
// rather than replicated. It carries what the catalog cannot: files that have no entry yet because
// their publish has not started.
export function broadcastShareIndexProgress(spaceId, payload) {
  if (socketMsgHandlers.size === 0) return
  const profileKeyHex = b4a.toString(getProfileKey(), 'hex')
  const frame = JSON.stringify({ type: 'share-index-progress', profileKey: profileKeyHex, spaceId, ...payload })
  for (const [, peer] of connectedPeers) {
    if (!peer.spaces.has(spaceId)) continue
    const handler = socketMsgHandlers.get(peer.socket)
    if (handler) { try { handler.send(frame) } catch {} }
  }
}

// Re-surface an owner's queue depth to our renderer. Same anti-spoof guard as the prepare frame:
// accept only from an identity authenticated on this socket. Non-authoritative and count-only —
// it names no file and gates no content, so the worst a bad frame can do is a wrong number in a
// notice. Its own validator: the prepare frame's requires total > 0 and bytes within it, which a
// queue summary does not satisfy.
function handleShareIndexProgressFrame(socket, msg) {
  const { profileKey, spaceId, shareId, adding, bytesQueued } = msg
  if (typeof profileKey !== 'string' || typeof spaceId !== 'string' || typeof shareId !== 'string') return
  if (!socketToPeers.get(socket)?.has(profileKey)) return
  // The sender is carried through as `ownerKey` so the consumer can require it to be the share's
  // actual owner. Authentication proves only WHO is speaking: without this any approved co-member
  // could describe someone else's share, and the notice names that someone by display name.
  // Wire numbers are peer-controlled: whole counts only, bounded, so a bad frame cannot reach the
  // renderer as a fractional or astronomically pluralized sentence.
  const safeCount = (n) => (Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_WIRE_COUNT) : 0)
  const safeBytes = (n) => (Number.isFinite(n) && n > 0 ? Math.min(n, Number.MAX_SAFE_INTEGER) : 0)
  ipcRef.emit('event:share-index-progress', {
    spaceId, shareId, ownerKey: profileKey, adding: safeCount(adding), bytesQueued: safeBytes(bytesQueued),
  })
}

// Receive a peer's heartbeat: refresh its lease, but only for an identity already
// authenticated on this socket (same guard as the leave frame) — so presence can't be
// spoofed for a peer we never handshaked. The TTL is ours; any sender-claimed expiry is
// ignored.
function handlePresenceFrame(socket, msg) {
  const kind = presenceFrameKind(msg)
  if (kind === 'ignore') return
  const { profileKey, spaceTopic } = msg
  if (!socketToPeers.get(socket)?.has(profileKey)) return
  const spaceId = resolveSpaceIdForTopic(spaceTopic)
  if (!spaceId) return
  if (kind === 'clear') {
    // Explicit graceful-quit departure (offline:true): flip the peer offline now, don't wait for
    // the socket close or the TTL. Gate the emit on a real online→offline transition (like the mark
    // path) so repeated departure frames can't amplify reconcile hints. Idempotent with the
    // socket-close handleDisconnect that follows.
    if (presence.clear(profileKey, spaceId)) {
      membersPoke.poke(spaceId)
      ipcRef?.emit('event:files-updated', { spaceId })
    }
    return
  }
  if (presence.mark(profileKey, spaceId)) {
    // Same-socket lease restore: the peer went silent past the TTL and is back without
    // a re-handshake — the arrival mirror of the onExpire departure emit.
    peerSeen(profileKey, spaceId)
    membersPoke.poke(spaceId)
    ipcRef?.emit('event:files-updated', { spaceId })
  }
}

// Re-surface a peer's indexing progress to our renderer. Same anti-spoof guard as presence/leave:
// accept only from an identity authenticated on this socket. Non-authoritative — the row shows it
// only while genuinely 'preparing', and contentHash still gates the content itself.
function handleSharePrepareProgressFrame(socket, msg) {
  const { profileKey, spaceId, shareId, relPath, bytes, total, eta } = msg
  if (typeof profileKey !== 'string' || typeof spaceId !== 'string') return
  if (typeof shareId !== 'string' || typeof relPath !== 'string') return
  if (!socketToPeers.get(socket)?.has(profileKey)) return
  const key = shareId === LOOSE_SHARE_ID ? '/' + relPath : shareDecoKey(shareId, relPath)
  // The owner finished (or abandoned) the hash. Decorations are cleared only by this frame, so
  // without it the bar sits at ~100% and repaints stale on the next re-hash of the same path. It
  // carries no numbers to validate, and clears at most a cosmetic bar a progress frame repaints.
  if (msg.done === true) {
    // Phase-scoped: this key is SHARED with our own download of the same file, and a re-publish
    // restarts that download the moment the materialized hash replicates — a `done` landing just
    // after it must not take down a live download bar.
    ipcRef.emit('event:decoration', { channel: 'transfer', spaceId, key, phase: 'preparing', done: true })
    return
  }
  // Wire numbers are peer-controlled: drop anything non-finite / out of range so a bad frame
  // can't reach the renderer as a NaN bar (width:'NaN%' / aria-valuenow=NaN).
  if (!Number.isFinite(bytes) || !Number.isFinite(total) || total <= 0 || bytes < 0 || bytes > total) return
  // null/absent = the owner is still warming up its estimate ("Estimating…"); preserve it. Any
  // other value is a peer-controlled number, so clamp non-finite/non-positive to 0.
  const safeEta = eta == null ? null : (Number.isFinite(eta) && eta > 0 ? eta : 0)
  ipcRef.emit('event:decoration', { channel: 'transfer', spaceId, key, phase: 'preparing', bytes, total, speed: 0, eta: safeEta })
}

function resolveSpaceIdForTopic(topicHex) {
  for (const [spaceId, topic] of spaceTopics) if (topic === topicHex) return spaceId
  return null
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
  if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null }
  if (firstProbeTimer) { clearTimeout(firstProbeTimer); firstProbeTimer = null }
  if (livenessTimer) { clearInterval(livenessTimer); livenessTimer = null }
  if (interfaceTimer) { clearInterval(interfaceTimer); interfaceTimer = null }
  if (livenessRetryTimer) { clearTimeout(livenessRetryTimer); livenessRetryTimer = null }
  if (statusEmitTimer) {
    clearTimeout(statusEmitTimer)
    statusEmitTimer = null
  }
  resetNetworkWatch()
  if (presenceTimer) {
    clearInterval(presenceTimer)
    presenceTimer = null
  }
  if (convergenceTimer) {
    clearInterval(convergenceTimer)
    convergenceTimer = null
  }
  convergenceTicking = false
  announceLedger.clear()
  deficitTicks.clear()
  lastRefreshAt.clear()
  escalationsSpent.clear()
  clearListDeficits()
  testDrop = null
  presence.clearAll()
  dhtReady = false
  readyAt = 0
  announced = false
  lastConnectionAt = null
  lastEmittedStatus = null
  hostChangeCount = 0
  for (const k of Object.keys(droppedFrames)) droppedFrames[k] = 0
  lastKnownHost = null
  currentReachability = { verdict: 'unknown', cause: null, confidence: 'predicted', evidence: null, since: 0, pending: null }
  verdictHistory = []
  lastCanaryResult = { state: CANARY.UNAVAILABLE, at: 0 }
  lastCanaryAt = 0
  livenessFailures = 0
  livenessCheckedAt = 0
  interfaceKind = 'physical'
  canaryInFlight = null
  browserOnlineHint = true
  localBindings.clear()
  boundSignerKeys.clear()
  spaceTopics.clear()
  spaceDiscoveries.clear()
  connectedPeers.clear()
  socketToPeers.clear()
  leaveAcks.clear()
  // Close the one held bee per peer, not just the map: each carries a live session and an
  // append listener.
  for (const held of profileBeeAppendListeners.values()) {
    try { held.bee.core.off('append', held.listener) } catch {}
    held.bee.close().catch(() => {})
  }
  profileBeeAppendListeners.clear()
  socketMsgHandlers.clear()
  pendingRequesters.clear()
  pendingAdmitInflight.clear()
  bannedNoiseKeys.clear()
  rateLimiter?.clear()
  rateLimiter = null
  frameLimiter = null
  membersPoke.reset()
  ipcRef = null
  leavingSpaces.clear()
  overlayReconnectHook = null
  membershipControlHandler = null
  connectionAttachHook = null
  revokeServesForSpaceHook = null
  stalledOwnersHook = null
  onPendingLeaveApplied = null
  onPendingCancelApplied = null
  pendingLeaves.clear()
  lastLeaveAckedKeys.clear()
  pendingCancels.clear()
  readmitInflight.clear()
  lastReconnectAt = 0
  bootedAt = 0
  corruptionDiagnosed = false
  lastStallRescueAt = 0
  stallRescueBackoffMs = STALL_RESCUE_MIN_MS
  stallRescueInFlight = false
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

const VERDICT_HISTORY_CAP = 200

function recordVerdictTransition(next) {
  const prev = verdictHistory[verdictHistory.length - 1]
  if (prev && prev.verdict === next.verdict && prev.cause === next.cause) return
  verdictHistory.push({ at: Date.now(), verdict: next.verdict, cause: next.cause, confidence: next.confidence })
  if (verdictHistory.length > VERDICT_HISTORY_CAP) verdictHistory.shift()
}

function recomputeReachability() {
  const dht = swarm?.dht || {}
  const stats = diag.snapshotStats()
  const now = Date.now()
  const raw = classify({
    now,
    bootedAt,
    readyAt,
    dhtReady,
    suspended: !!swarm?.suspended || !!swarm?.destroyed,
    browserOnline: browserOnlineHint,
    hasInterface: interfaceKind !== 'none',
    interfaceKind,
    address: {
      publicHost: typeof dht.host === 'string' ? dht.host : null,
      publicPort: typeof dht.port === 'number' ? dht.port : 0,
    },
    routing: { tableSize: diag.safeRoutingTableSize() },
    dhtHealth: diag.snapshotDhtHealth(),
    peerReach: diag.snapshotPeerReach(),
    dials: { attempted: stats.connects.client.attempted, opened: stats.connects.client.opened },
    canary: lastCanaryResult,
    liveness: { failures: livenessFailures, checkedAt: livenessCheckedAt },
  })
  currentReachability = stabilise(raw, currentReachability, now)
  recordVerdictTransition(currentReachability)
  return currentReachability
}

export function setBrowserOnlineHint(online) {
  const next = online !== false
  if (next === browserOnlineHint) return
  browserOnlineHint = next
  scheduleStatusEmit()
}

export function getVerdictHistory() {
  return verdictHistory.slice()
}

export function getDiagnosticCounters() {
  return {
    readyAt,
    bootedAt,
    hostChangeCount,
    localPortStable: diag.safeAddress().port > 0,
    droppedFrames: getDroppedFrameCounters(),
  }
}

export function getPeerSamples() {
  return diag.snapshotPeerSamples()
}

const CANARY_TIMEOUT_MS = 10000
const CANARY_MIN_INTERVAL_MS = 15 * 60 * 1000
const CANARY_MAX_DIALS = 3

let canaryInFlight = null
let lastCanaryAt = 0

function parseUpgradeKey(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const bare = raw.replace(/^pear:\/\//, '').split('/')[0].trim()
  if (!bare) return null
  try {
    const key = idEncoding.decode(bare)
    return key.byteLength === 32 ? key : null
  } catch { return null }
}

function dialOnce(dht, peer) {
  return new Promise((resolve) => {
    let socket = null
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (socket) { try { socket.destroy() } catch {} }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), CANARY_TIMEOUT_MS)
    timer.unref?.()
    try {
      socket = dht.connect(peer.publicKey, { relayAddresses: peer.relayAddresses })
      socket.on('open', () => finish(true))
      socket.on('error', () => finish(false))
      socket.on('close', () => finish(false))
    } catch (err) {
      log.debug('canary dial threw:', err.message)
      finish(false)
    }
  })
}

// Two stages, because a single probe cannot distinguish "your network is broken" from
// "our seeder is down". Stage 1 asks the DHT whether the seeder is announcing at all; if
// it is not, we report seeder-down and the reducer leaves the user's verdict untouched.
async function runCanaryProbe(upgradeKey) {
  const driveKey = parseUpgradeKey(upgradeKey)
  if (!driveKey) return { state: CANARY.UNAVAILABLE, reason: 'no-key' }
  const dht = swarm?.dht
  if (!dht || !dhtReady) return { state: CANARY.UNAVAILABLE, reason: 'no-dht' }

  const topic = crypto.discoveryKey(driveKey)
  const found = []
  const stream = dht.lookup(topic)
  const stage1Started = Date.now()
  const stage1Timer = setTimeout(() => { try { stream.destroy() } catch {} }, CANARY_TIMEOUT_MS)
  stage1Timer.unref?.()
  try {
    for await (const reply of stream) {
      for (const peer of reply.peers || []) {
        if (found.length >= CANARY_MAX_DIALS) break
        found.push(peer)
      }
      if (found.length >= CANARY_MAX_DIALS) break
    }
  } catch (err) {
    log.debug('canary lookup failed:', err.message)
  } finally {
    clearTimeout(stage1Timer)
    try { stream.destroy() } catch {}
  }
  const stage1 = { announceRecords: found.length, ms: Date.now() - stage1Started }

  if (found.length === 0) return { state: CANARY.SEEDER_DOWN, stage1 }

  const stage2Started = Date.now()
  let dials = 0
  for (const peer of found) {
    dials++
    if (await dialOnce(dht, peer)) {
      return { state: CANARY.REACHABLE, stage1, stage2: { dials, opened: 1, ms: Date.now() - stage2Started } }
    }
  }
  return { state: CANARY.UNREACHABLE, stage1, stage2: { dials, opened: 0, ms: Date.now() - stage2Started } }
}

// Tier 2 needs joined topics to produce evidence, so a user with no spaces has only the
// NAT shape — a prediction. One automatic probe turns it into a measurement. Deliberately
// not on a timer: this fires once per swarm, and every other probe is user-initiated.
let firstProbeTimer = null

// Only runs while nothing else can produce evidence — with peers connected, their presence
// IS the liveness signal, and a periodic ping from every idle client would be pointless
// DHT traffic. Targets our own routing table (public infrastructure built for exactly
// this), never the seeder.
// A local syscall, not a network round-trip: if the machine has no non-internal address
// there is definitively no network, and we can say so instantly instead of waiting for
// probes to time out — and say the *right* thing, rather than blaming a VPN or a router.
const INTERFACE_POLL_MS = 3000

let interfaceKind = 'physical'
let interfaceTimer = null

function readInterfaceKind() {
  try {
    return routableAddressKind(os.networkInterfaces())
  } catch {
    // Never invent an outage from a failed read.
    return 'physical'
  }
}

function startInterfaceWatch() {
  if (interfaceTimer) return
  interfaceKind = readInterfaceKind()
  interfaceTimer = setInterval(() => {
    const next = readInterfaceKind()
    if (next === interfaceKind) return
    // A route reappearing is a fresh start for the probe, not a continuation.
    if (interfaceKind === 'none' && next !== 'none') livenessFailures = 0
    interfaceKind = next
    scheduleStatusEmit()
  }, INTERFACE_POLL_MS)
  interfaceTimer.unref?.()
}

const LIVENESS_INTERVAL_MS = 15000
const LIVENESS_RETRY_MS = 2000
const LIVENESS_TIMEOUT_MS = 5000

let livenessTimer = null
let livenessFailures = 0
let livenessCheckedAt = 0

// Routing-table entries only: they are real IPs seen over the wire. The bootstrap list is
// hostnames, and dht.ping() rejects those instantly as "not a valid IP address" — which
// would be counted as a failure and declare a healthy network dead.
function livenessTarget() {
  const dht = swarm?.dht
  if (!dht) return null
  try {
    const nodes = dht.toArray({ limit: 8 })
    if (nodes && nodes.length) return nodes[Math.floor(nodes.length / 2)]
  } catch {}
  return null
}

async function checkLiveness() {
  const dht = swarm?.dht
  if (!dht || !dhtReady || swarm.suspended || swarm.destroyed) return
  if (swarm.connections?.size > 0) { livenessFailures = 0; return }

  const target = livenessTarget()
  if (!target) return

  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), LIVENESS_TIMEOUT_MS)
    timer.unref?.()
  })
  let alive = false
  try {
    alive = await Promise.race([dht.ping(target).then(() => true, () => false), timeout])
  } catch { alive = false }
  clearTimeout(timer)

  const before = livenessFailures
  livenessFailures = alive ? 0 : Math.min(livenessFailures + 1, LIVENESS_FAILURES_FOR_OFFLINE)
  livenessCheckedAt = Date.now()
  if (before !== livenessFailures) scheduleStatusEmit()

  // Confirm a first failure promptly rather than after another full interval.
  if (!alive && livenessFailures < LIVENESS_FAILURES_FOR_OFFLINE) scheduleLivenessRetry()
}

let livenessRetryTimer = null

function scheduleLivenessRetry() {
  if (livenessRetryTimer) return
  livenessRetryTimer = setTimeout(() => {
    livenessRetryTimer = null
    checkLiveness().catch((err) => log.debug('liveness retry failed:', err.message))
  }, LIVENESS_RETRY_MS)
  livenessRetryTimer.unref?.()
}

// Lets a network transition the OS *did* notice trigger an immediate re-check instead of
// waiting out the interval.
export async function checkLivenessNow() {
  await checkLiveness()
  return { failures: livenessFailures, checkedAt: livenessCheckedAt }
}

function startLivenessLoop() {
  if (livenessTimer) return
  livenessTimer = setInterval(() => {
    checkLiveness().catch((err) => log.debug('liveness check failed:', err.message))
  }, LIVENESS_INTERVAL_MS)
  livenessTimer.unref?.()
}

function scheduleFirstCanaryProbe() {
  if (firstProbeTimer || spaceTopics.size > 0) return
  firstProbeTimer = setTimeout(() => {
    firstProbeTimer = null
    if (spaceTopics.size > 0) return
    probeCanary(getUpgradeKey()).catch((err) => log.debug('first canary probe failed:', err.message))
  }, NAT_SETTLE_MS)
  firstProbeTimer.unref?.()
}

export async function probeCanary(upgradeKey, { force = false } = {}) {
  const now = Date.now()
  if (!force) {
    if (now - lastCanaryAt < CANARY_MIN_INTERVAL_MS) return lastCanaryResult
    if (canaryInFlight) return canaryInFlight
  }

  canaryInFlight = runCanaryProbe(upgradeKey)
    .then((result) => {
      lastCanaryResult = { ...result, at: Date.now() }
      lastCanaryAt = Date.now()
      scheduleStatusEmit()
      return lastCanaryResult
    })
    .catch((err) => {
      log.debug('canary probe failed:', err.message)
      lastCanaryResult = { state: CANARY.UNAVAILABLE, at: Date.now() }
      return lastCanaryResult
    })
    .finally(() => { canaryInFlight = null })

  return canaryInFlight
}

export function getSwarmStatus() {
  if (!swarm) return diag.offlineStatusSnapshot()

  const reachability = recomputeReachability()

  const peerCount = swarm.connections?.size || 0
  const connecting = swarm.connecting || 0
  const suspended = !!swarm.suspended
  const destroyed = !!swarm.destroyed
  const state = (suspended || destroyed || !dhtReady)
    ? 'offline'
    : peerCount > 0 ? 'online' : 'connecting'

  const dht = swarm.dht || {}
  const addr = diag.safeAddress()
  const pubKey = swarm.keyPair?.publicKey
    ? b4a.toString(swarm.keyPair.publicKey, 'hex')
    : ''
  const nodeId = dht.id ? b4a.toString(dht.id, 'hex') : null

  return {
    state,
    dhtReady,
    announced,
    peerCount,
    connecting,
    suspended,
    lastConnectionAt,
    bootedAt,
    identity: { publicKey: pubKey, nodeId },
    address: {
      publicHost: typeof dht.host === 'string' ? dht.host : null,
      publicPort: typeof dht.port === 'number' ? dht.port : 0,
      localPort: addr.port,
    },
    nat: {
      firewalled: dhtReady ? !!dht.firewalled : null,
      randomized: dhtReady ? !!dht.randomized : null,
      ephemeral: !!dht.ephemeral,
    },
    routing: {
      bootstrap: diag.getBootstrapList(),
      tableSize: diag.safeRoutingTableSize(),
    },
    topics: spaceTopics.size,
    contentPlane: getContentPlaneStatus(),
    stats: diag.snapshotStats(),
    peerReach: diag.snapshotPeerReach(),
    dhtHealth: diag.snapshotDhtHealth(),
    canary: lastCanaryResult,
    liveness: { failures: livenessFailures, checkedAt: livenessCheckedAt, interfaceKind },
    reachability,
    versions: { dht: DHT_VERSION },
  }
}

// The scalar fields the network-status dedup compares — a status is "equal" iff all match. Kept as
// a list of accessors (rather than a 24-term && chain) so the comparison stays flat and a new field
// is one line. Sub-objects (identity/address/nat/stats) are assumed present, as before; the top
// level is guarded in statusEqual.
const STATUS_FIELDS = [
  (s) => s.state,
  (s) => s.dhtReady,
  (s) => s.announced,
  (s) => s.peerCount,
  (s) => s.connecting,
  (s) => s.suspended,
  (s) => s.lastConnectionAt,
  (s) => s.bootedAt,
  (s) => s.identity.publicKey,
  (s) => s.identity.nodeId,
  (s) => s.address.publicHost,
  (s) => s.address.publicPort,
  (s) => s.address.localPort,
  (s) => s.nat.firewalled,
  (s) => s.nat.randomized,
  (s) => s.nat.ephemeral,
  (s) => s.routing.tableSize,
  (s) => s.topics,
  (s) => s.stats.updates,
  (s) => s.stats.connects.client.opened,
  (s) => s.stats.connects.client.closed,
  (s) => s.stats.connects.server.opened,
  (s) => s.stats.connects.server.closed,
  (s) => s.stats.bannedPeers,
  // Without these three the status emitter's dedup drops every relay counter change
  // and the diagnostics screen never updates.
  (s) => s.stats.relaying.selected,
  (s) => s.stats.relaying.attempts,
  (s) => s.stats.relaying.successes,
  (s) => s.stats.relaying.aborts,
  (s) => s.peerReach.discovered,
  (s) => s.peerReach.connected,
  (s) => s.peerReach.exhausted,
  (s) => s.dhtHealth.online,
  (s) => s.dhtHealth.degraded,
  (s) => s.dhtHealth.timeoutsRate,
  (s) => s.canary.state,
  (s) => s.canary.at,
  (s) => s.liveness.failures,
  (s) => s.liveness.interfaceKind,
  (s) => s.reachability.verdict,
  (s) => s.reachability.cause,
  (s) => s.reachability.confidence,
]

export function statusEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return STATUS_FIELDS.every((field) => field(a) === field(b))
}

// A blocked user generates LESS swarm activity, not more, so a pending escalation would
// otherwise sit unemitted until something unrelated happened. One-shot and armed only
// from the emit path — never from getSwarmStatus, which is a read and must not start
// timers that outlive destroySwarm.
let dwellTimer = null

function armDwellRecheck(pending) {
  if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null }
  if (!pending) return
  dwellTimer = setTimeout(() => { dwellTimer = null; scheduleStatusEmit() }, BLOCKED_DWELL_MS / 2)
  dwellTimer.unref?.()
}

function scheduleStatusEmit() {
  if (statusEmitTimer) return
  statusEmitTimer = setTimeout(() => {
    statusEmitTimer = null
    if (!ipcRef) return
    const next = getSwarmStatus()
    armDwellRecheck(next.reachability?.pending)
    if (statusEqual(next, lastEmittedStatus)) return
    lastEmittedStatus = next
    try {
      ipcRef.emit('event:network-status', next)
    } catch (err) {
      log.warn('status emit failed:', err.message)
    }
    // AFTER the emit, and in its own guard: auditing must never fail into the operation it
    // describes, and a throw here would otherwise leave the UI without a status update. It rides
    // the EMIT path rather than getSwarmStatus because that is a read and must not start timers
    // (see armDwellRecheck above); the tracker owns its own hold-down timer, so a stable-blocked
    // idle app still gets its row.
    try {
      observeReachability({
        verdict: next.reachability.verdict,
        cause: next.reachability.cause,
        since: next.reachability.since,
        evidence: {
          confidence: next.reachability.confidence,
          peersDiscovered: next.peerReach.discovered,
          peersExhausted: next.peerReach.exhausted,
          peersConnected: next.peerReach.connected,
          publicPort: next.address.publicPort,
          interfaceKind: next.liveness.interfaceKind,
        },
      })
    } catch (err) {
      log.warn('connectivity audit skipped:', err.message)
    }
  }, STATUS_EMIT_DEBOUNCE_MS)
}

export async function reconnectAll() {
  const now = Date.now()
  if (now - lastReconnectAt < RECONNECT_THROTTLE_MS) {
    return { ok: false, throttled: true }
  }
  lastReconnectAt = now
  log.info('reconnect requested for', spaceDiscoveries.size, 'topics')
  for (const [spaceId, discovery] of spaceDiscoveries) {
    try {
      await discovery.refresh({ client: true, server: true })
      log.debug('refreshed discovery for', spaceId)
    } catch (err) {
      log.warn('refresh failed for', spaceId, err.message)
    }
  }
  try { await refreshContentDiscoveries() } catch {} // content plane (no-op unless active)
  scheduleStatusEmit()
  return { ok: true }
}

export class Swarm extends Subsystem {
  constructor(name, deps) {
    super(name, deps)
    this.require('ipc', 'membershipControl', 'overlayBackend', 'stalledOwners')
  }

  async _open() {
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
  }

  get dht() { return getSwarmDht() }
}
