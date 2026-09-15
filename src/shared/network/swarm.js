// The peer-connection layer: one Hyperswarm topic per space, one Noise socket per peer carrying
// Corestore replication, the `mirall/handshake` JSON channel and the overlay content channel over
// Protomux. Every identity-asserting frame carries a signature binding the sender's profile key
// to this socket's Noise key (verified in handshake-guard.js), so frames are attributable to a
// member and cannot be replayed on another connection.
//
// This file owns connection intake and frame dispatch, handshake handling and the peer registry,
// topic joins and space cleanup, the membership frames (request / grant / deny / cancel) and the
// blind-relay install. Presence lives in presence-broadcast.js + presence.js, leaves in
// leave-protocol.js, connectivity in connectivity.js, admission in admission-gates.js and
// deferred-admission.js, the re-drive in convergence-tick.js.
import DHT from 'hyperdht'
import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import fs from 'bare-fs'
import b4a from 'b4a'
import { getStore, diagnoseStoreCores, isStorageInconsistency } from '../core/store.js'
import { getProfileKey, getProfile, getIdentitySigner } from '../spaces/profile.js'
import { getDrive, getSpace, upsertMember, ownLooseCatalogPublish } from '../spaces/space.js'
import { clearJoinRequest } from '../spaces/join-requests.js'
import { getRuntimeConfig, getResourceCaps, getConvergenceConfig, isSeparateContentPlaneEnabled, getPeerFrameMaxBytes, joinRequestAvatarMaxBytes } from '../core/runtime-config.js'
import { relayIdentityKeyPair } from './relay.js'
import { catalogKeyField } from '../shares/share-catalog.js'
import { HEX64 } from '../contract/invite-envelope.js'
import { clampDisplayName, signNoiseBinding } from './handshake-guard.js'
import { joinContentTopic, leaveContentTopic, destroyContentPeerSockets } from './content-swarm.js'
import { applyNetImpairment } from './net-impair.js'
import { clearListDeficits } from '../transfer/list-deficits.js'
import { peerLost, peerLostMeta, peerSeen, resetNetworkWatch } from '../audit/network-watch.js'

import { sanitizeAvatar } from '../contract/identity-limits.js'
import { createPresence } from './presence.js'
import { makeKeyedCoalescer } from '../core/coalesce.js'
import { createLogger } from '../core/logger.js'
import { initRelayInstall, pinRelayIdentity, relaySelectionCount, resetRelayInstall } from './relay-install.js'
import { initPeerProfileWatch, fetchPeerAvatar, resetPeerProfileWatch } from '../spaces/peer-profile-watch.js'
import { initMembershipFrames } from './membership-frames.js'
import { initFrameIntake, createFrameLimiters, receiveFrame, isBannedNoiseKey, forgetPeerLimits, getDroppedFrameCounters, resetFrameIntake } from './frame-intake.js'
import { compactStore, settleCompaction } from '../storage/compaction.js'
import { Subsystem } from '../core/subsystem.js'
import { createSwarmDiagnostics } from './swarm-diagnostics.js'
import { createAdmissionGates } from './admission-gates.js'
import { PEER_FRAME } from '../contract/peer-frames.js'
import { connectedPeers, socketToPeers, spaceTopics, spaceDiscoveries, socketMsgHandlers, pendingRequesters, boundSignerKeys, announceLedger, resetRegistries, authorizedOn, detachPeerFromSpace, forgetBoundSignerKey } from './swarm-registries.js'
import { initPresenceBroadcast, startPresenceHeartbeat, stopPresenceHeartbeat, resolveSpaceIdForTopic } from './presence-broadcast.js'
// Re-exported so swarm.js stays the public address for these: worker/main.js and the overlay
// backend import them from here.
export { broadcastDeparture, broadcastSharePrepareProgress, broadcastShareIndexProgress } from './presence-broadcast.js'
import { initDeferredAdmission, resetDeferredAdmission } from './deferred-admission.js'
export { readmitConnectedMembers } from './deferred-admission.js'
import { initLeaveProtocol, resetLeaveProtocol, sendPendingLeaveFrames, sendPendingCancelFrames } from './leave-protocol.js'
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
import { initConvergenceTick, resetConvergenceTick, startConvergenceTick, forgetSpaceConvergence, convergenceHealth, restartConvergenceTick } from './convergence-tick.js'
export { rescueStalledTransfers } from './convergence-tick.js'
import { initConnectivity, resetConnectivity, attachSwarmWatchers, noteBooted, noteConnection, noteAnnounced, scheduleStatusEmit } from './connectivity.js'
// The renderer's whole network picture comes through these; worker/main.js and the diagnostics
// bundle import them from swarm.js.
export {
  getSwarmStatus, setBrowserOnlineHint, getVerdictHistory, getDiagnosticCounters,
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
const peerOnlineHooks = new Set()       // notified on the same edge, for producers with no durable row for a resume to find (the mirror loops)
let membershipControlHandler = null     // membership:* frames (join request / grant / deny) routed to the worker
let connectionAttachHook = null         // per-connection (mux, socket) hook so content backends bind extra protocol channels (overlay)
let stalledOwnersHook = null            // worker-supplied probe: which owners are we waiting on?
let revokeServesForSpaceHook = null     // membership changed → drop the serve grants cached for that space (overlay owns them; swarm must not import it)
// Why a frame was dropped, for diagnostics — hardening nobody can see is hardening nobody can tune.

const DHT_VERSION = (() => {
  try {
    // Three levels up: this file is src/shared/transfer/, so ../../ would land on src/, where there
    // is no node_modules.
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
  getRelaySelections: relaySelectionCount,
  getDhtVersion: () => DHT_VERSION,
})
// The join gates. Deferred admission reads the registries itself (swarm-registries.js) and takes
// only the gates, the handshake callbacks and the IPC handle from here.
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

// Re-exported: worker/main.js and overlay-instance.js import the gates from here.
export const isApprovedMember = (spaceId, joinerKey) => gates.isApprovedMember(spaceId, joinerKey)
export const resolveInvite = (space, inviteId) => gates.resolveInvite(space, inviteId)

const BENIGN_SOCKET_ERRORS = ['timed out', 'reset by peer', 'Duplicate connection']
function isBenignSocketError(err) {
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

function initSwarm(_ipc, relaySeedHex = null) {
  initRelayInstall({ getSwarm: () => swarm })
  initPeerProfileWatch({ getIpc: () => ipcRef, connectedPeers })
  initFrameIntake({ handleHandshake, getMembershipControlHandler: () => membershipControlHandler })
  initMembershipFrames({ handlerForPeer, sendFrame, getLocalBinding })
  if (swarm) throw new Error('swarm: already running')
  ipcRef = _ipc
  // Tests inject a local hyperdht/testnet bootstrap via runtime-config so the
  // swarm stays off the public DHT; unset in production → default bootstrap.
  const dhtBootstrap = getRuntimeConfig().dhtBootstrap
  const caps = getResourceCaps()
  // The DHT node is built here rather than left to hyperswarm because dht.defaultKeyPair is the
  // relay-facing identity and hyperswarm gives no way to set it: its seed/keyPair options set
  // swarm.keyPair only, and the HyperDHT it constructs gets no keyPair, so defaultKeyPair stays
  // random. Under a private relay that key IS the membership on both sides — the relay socket is
  // opened with a bare dht.connect(relayKey), by relayConnection in hyperdht's connect.js and by
  // Server._relayConnection — so one enrolment covers both roles. Peers are unaffected — they
  // authenticate swarm.keyPair. Ownership is unchanged: hyperswarm.destroy() destroys this.dht
  // whether it built the node or was handed one, so destroySwarm still tears it down.
  const dht = new DHT({
    ...(dhtBootstrap ? { bootstrap: dhtBootstrap } : {}),
    keyPair: relayIdentityKeyPair(relaySeedHex),
  })
  pinRelayIdentity(relaySeedHex)
  swarm = new Hyperswarm({
    dht,
    maxServerConnections: caps.serverConnections || Infinity,
    maxClientConnections: caps.clientConnections || Infinity,
    // firewall returns true to REJECT — drop reconnects from a Noise key we evicted for flooding.
    firewall: (remoteKey) => isBannedNoiseKey(b4a.toString(remoteKey, 'hex')),
  })
  // The matched lane's cap follows the topics we joined (read per take, so joins and leaves
  // need no re-plumbing) — see createDualRateLimiter.
  createFrameLimiters()
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
      onmessage(str) { receiveFrame(conn, str) },
    })

    // One live control connection: the socket, who is on the other end, the Noise key they are
    // reached by, and the channel frames go out on. The frame path takes this whole rather than its
    // fields. Declared after the channel because it carries the channel's handler; onmessage above
    // closes over it and cannot run before channel.open() below.
    const conn = { socket, peerInfo, remoteKey, msgHandler, noiseHex }

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
  notifyPeerOnline(peerKey, spaceId)

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
  // A handshake is a presence arrival (trackPeerConnection leased the peer online), so the online set
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

function handleDisconnect(socket) {
  if (socket.remotePublicKey) forgetPeerLimits(b4a.toString(socket.remotePublicKey, 'hex'))
  announceLedger.forgetSocket(socket)
  for (const [profileKey, sock] of pendingRequesters) {
    if (sock === socket) {
      pendingRequesters.delete(profileKey)
      forgetBoundSignerKey(profileKey)
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

    presence.clear(peerKey)
    connectedPeers.delete(peerKey)
    forgetBoundSignerKey(peerKey)
  }
  scheduleStatusEmit()
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
      noteAnnounced()
      log.info('topic flushed — discoverable:', spaceId)
    },
    (err) => log.error('topic flush error:', spaceId, err.message)
  )
  scheduleStatusEmit()

  // Hyperswarm reuses existing sockets, so no connection event fires for them: handshake the new
  // space to every already-connected peer explicitly.
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

// Send path for the frames carrying variable-length content (an identity's name, avatar and
// catalog keys). Each is judged by the same byte cap we enforce on receive, and one over it is
// dropped there before it is parsed — so the only trace of the failure would be a warn line on the
// OTHER machine, which is the wrong one to diagnose from. Say it here, at error level, on the
// machine that built the frame.
function sendFrame(msgHandler, frame) {
  const str = JSON.stringify(frame)
  const maxBytes = getPeerFrameMaxBytes()
  // Measured the way the intake measures it: in BYTES, so a frame of multi-byte characters that
  // is under the cap by string length is still caught here rather than silently on the far side.
  const size = b4a.byteLength(str)
  if (maxBytes > 0 && size > maxBytes) {
    log.error('built an oversize', frame.type, 'frame:', size, 'bytes over a', maxBytes, 'cap — the receiver will drop it unparsed')
  }
  msgHandler.send(str)
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
    sendFrame(msgHandler, {
      type: PEER_FRAME.HANDSHAKE,
      profileKey: profileKeyHex,
      driveKey: driveKeyHex,
      displayName,
      spaceTopic: topicHex,
      ...looseField,
      ...(space?.creatorKey ? { creator: space.creatorKey } : {}),
      ...(getLocalBinding(driveKeyHex) || {}),
    })
    announceLedger.recordSend(socket, spaceId, 'handshake', Date.now())
    return
  }
  // No local drive ⇒ a pending v2 join: announce a join request instead, echoing the
  // (single-use) auto-admit nonce from the invite so an auto-admit invite resolves.
  const space = await getSpace(spaceId)
  if (space?.status === 'pending') {
    sendFrame(msgHandler, {
      type: PEER_FRAME.MEMBERSHIP_REQUEST,
      profileKey: profileKeyHex,
      displayName,
      // Not avatarMaxBytes: this is the one frame carrying peer-supplied unbounded content, and it
      // is charged against peerFrameMaxBytes on the far side BEFORE it is parsed. An avatar sized
      // for storage would take the whole join request over that cap, and the request would be
      // dropped unread — no banner for the owner, no feedback for us, pending forever. Over budget
      // the joiner arrives with initials instead of a picture, which is what an avatar-less peer
      // already renders as.
      avatar: sanitizeAvatar(profile?.avatar, joinRequestAvatarMaxBytes()),
      spaceTopic: topicHex,
      inviteId: space.inviteId || null,
      ...(getLocalBinding() || {}),
    })
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
    if (!detachPeerFromSpace(peer, spaceId)) continue
    try { peer.socket.destroy() } catch {}
    // The overlay content channel rides the CONTENT socket, not this one. Dropping only the
    // control socket leaves the bulk plane serving a space we have just left.
    try { destroyContentPeerSockets(key) } catch {}
    // The close handler that follows will find this key already gone from connectedPeers and skip
    // the rest of its per-peer teardown, so finish it here. Leaving the bound signer key behind is
    // the one that bites: a grant sealed after a later reconnect, before the fresh identity frame
    // rewrites it, would be sealed to a key the peer no longer holds.
    presence.clear(key)
    connectedPeers.delete(key)
    forgetBoundSignerKey(key)
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

// One subscriber's fault is not the swarm's: a throw here would abandon the reciprocal handshake
// that keeps two peers converged.
function notifyPeerOnline(peerKey, spaceId) {
  for (const fn of peerOnlineHooks) {
    try { fn(peerKey, spaceId) } catch (err) { log.debug('peer-online subscriber failed:', err.message) }
  }
}

// The level trigger that goes with isOwnerOnline: whoever gates work on it needs telling when the
// answer flips, or it waits out its own poll interval. A registry rather than a single slot, so the
// next producer that needs this edge subscribes instead of adding another call beside the first —
// which is exactly how the mirror's arrived. Returns its own unsubscribe.
export function onPeerOnline(fn) {
  peerOnlineHooks.add(fn)
  return () => peerOnlineHooks.delete(fn)
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

// The name the overlay's authorizer imports for authorizedOn (swarm-registries.js), which is where
// the rule lives.
export function senderAuthorizedOnSocket(socket, profileKeyHex) {
  return authorizedOn(socket, profileKeyHex)
}
// The bound signer key a connected peer last asserted, for sealing a membership:grant to it.
export function getBoundSignerKey(profileKeyHex) {
  return boundSignerKeys.get(profileKeyHex) || null
}

// test seam
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

async function destroySwarm() {
  if (!swarm) return
  log.info('destroying swarm...')
  resetConnectivity()
  resetNetworkWatch()
  stopPresenceHeartbeat()
  resetConvergenceTick()
  resetRegistries()
  clearListDeficits()
  presence.clearAll()
  resetFrameIntake()
  localBindings.clear()
  resetPeerProfileWatch()
  membersPoke.reset()
  ipcRef = null
  overlayReconnectHook = null
  peerOnlineHooks.clear()
  membershipControlHandler = null
  connectionAttachHook = null
  revokeServesForSpaceHook = null
  stalledOwnersHook = null
  resetLeaveProtocol()
  resetDeferredAdmission()
  corruptionDiagnosed = false
  resetRelayInstall()
  try {
    await swarm.destroy()
  } catch {}
  swarm = undefined
  // A compaction reads cores the durable tier closes right after this. Bounded on its own: it
  // runs under the runtime tier's shared budget, and a full-range compactRange the user just
  // started would otherwise spend the whole budget and skip every subsystem after this one.
  await settleCompaction()
  log.info('swarm destroyed')
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
    // Not in require(): a null seed is the normal case — no relay, or an open one.
    initSwarm(this.deps.ipc, this.deps.relaySeedHex ?? null)
  }

  // One unit: the level-triggered re-drive. Everything else the swarm owns is either event-driven
  // (no pass to stall) or already supervised by the subsystem that owns it.
  supervise({ now = Date.now() } = {}) {
    if (this.closed || this.stopping) return []
    return [{ key: 'convergence', label: 'convergence tick', ...convergenceHealth({ now }) }]
  }

  async recover(key) {
    if (this.stopping || key !== 'convergence') return
    restartConvergenceTick()
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
