// Applying an admitted handshake, and undoing it on disconnect. This is where a peer becomes known:
// the admission gates decide, the registries record where to reach them, the presence lease records
// that they are here, and the durable member record catches up behind both.
//
// The emit order is load-bearing. A handshake is a presence arrival even when the durable record
// does not change, and the roster re-derive has to see the committed member — so the arrival hints
// straddle the persist rather than preceding it.
import { getSpace, upsertMember } from '../spaces/space.js'
import { clearJoinRequest } from '../spaces/join-requests.js'
import { getMembershipCaps, getConvergenceConfig } from '../core/runtime-config.js'
import { HEX64 } from '../contract/invite-envelope.js'
import { peerLost, peerLostMeta, peerSeen } from '../audit/network-watch.js'
import { fetchPeerAvatar } from '../spaces/peer-profile-watch.js'
import { makeKeyedCoalescer } from '../core/coalesce.js'
import { createLogger } from '../core/logger.js'
import { clampDisplayName } from './handshake-guard.js'
import { createAdmissionGates } from './admission-gates.js'
import { presence, setPresenceExpireHandler } from './presence-leases.js'
import { sendSingleHandshake } from './identity-frames.js'
import { resolveSpaceIdForTopic } from './presence-broadcast.js'
import { scheduleStatusEmit } from './network-status.js'
import { memberWaits } from './share-wait.js'
import { clearWaitingFor } from '../transfer/serve-ledger.js'
import {
  connectedPeers, socketToPeers, socketMsgHandlers, pendingRequesters, announceLedger,
  forgetBoundSignerKey,
} from './swarm-registries.js'

const log = createLogger('handshake-apply')

let getIpc = () => null
// Notified when an overlay-content owner (re)connects, so paused/interrupted overlay downloads
// (loose + folder) resume.
let onOwnerReconnect = () => {}
// Notified on the same edge, for producers with no durable row for a resume to find (the mirror
// loops). A registry rather than a single slot, so the next producer that needs this edge
// subscribes instead of adding another call beside the first.
const peerOnlineHooks = new Set()

export function initHandshakeApply(deps) {
  getIpc = deps.getIpc
  onOwnerReconnect = deps.onOwnerReconnect || (() => {})
}

const gates = createAdmissionGates({ connectedPeers, log, getIpc: () => getIpc() })

export const isApprovedMember = (spaceId, joinerKey, opts) => gates.isApprovedMember(spaceId, joinerKey, opts)
export const resolveInvite = (space, inviteId) => gates.resolveInvite(space, inviteId)
export function getAdmissionGates() {
  return gates
}

// Presence transitions arrive in bursts (one prune tick can expire dozens of (peer, space)
// leases; a reconnect handshakes several spaces back-to-back) and each members-updated frame
// costs the renderer several spaces:list round-trips — coalesce per space at the source.
export const membersPoke = makeKeyedCoalescer(
  (spaceId) => { getIpc()?.emit('event:members-updated', { spaceId }) },
  { intervalMs: 250 },
)

// On silent-death lease expiry, re-emit so the roster + file availability re-derive (a peer that
// goes quiet without a clean disconnect would otherwise stay "online" until an unrelated refresh).
// files-updated is already coalesced downstream into event:reconcile by the hint bus.
setPresenceExpireHandler((personKey, spaceId) => {
  auditPeerLost(personKey, spaceId)
  membersPoke.poke(spaceId)
  getIpc()?.emit('event:files-updated', { spaceId })
})

// The episode is opened SYNCHRONOUSLY, because peerSeen and peerLeft are synchronous: awaiting the
// space name first would let a reconnect or a leave overtake the loss and open an episode for a peer
// that is already back. The name is snapshotted rather than joined at render time (a row outlives
// the space record), so it lands as a patch once the store read returns — well inside the floor.
function auditPeerLost(personKey, spaceId, displayName = null) {
  const memberName = displayName || connectedPeers.get(personKey)?.displayName || null
  peerLost(personKey, spaceId, { memberName, spaceName: null })
  getSpace(spaceId).then((space) => {
    peerLostMeta(personKey, spaceId, {
      memberName: memberName || peerName(space, personKey),
      spaceName: space?.name ?? null,
    })
  }).catch((err) => log.debug('peer presence name lookup skipped:', err.message))
}

function peerName(space, personKey) {
  return (space?.members || []).find((m) => m.publicKey === personKey)?.displayName || null
}

// One subscriber's fault is not the swarm's: a throw here would abandon the reciprocal handshake
// that keeps two peers converged.
function notifyPeerOnline(personKey, spaceId) {
  for (const fn of peerOnlineHooks) {
    try { fn(personKey, spaceId) } catch (err) { log.debug('peer-online subscriber failed:', err.message) }
  }
}

// The level trigger that goes with isOwnerOnline: whoever gates work on it needs telling when the
// answer flips, or it waits out its own poll interval. Returns its own unsubscribe.
export function onPeerOnline(fn) {
  peerOnlineHooks.add(fn)
  return () => peerOnlineHooks.delete(fn)
}

// Register the live connection in the in-memory maps (connection registry, socket↔peers, presence
// lease) before any blocking I/O. Returns whether the peer is new to this space — which gates the
// reciprocal handshake so two peers don't ping-pong forever.
function trackPeerConnection(socket, spaceId, msg) {
  const personKey = msg.profileKey
  let peerEntry = connectedPeers.get(personKey)
  const isNewToSpace = !peerEntry || !peerEntry.spaces.has(spaceId)
  if (!peerEntry) {
    peerEntry = { socket, profileKey: personKey, displayName: msg.displayName, avatar: null, spaces: new Map(), looseCatalogKeys: new Map() }
    connectedPeers.set(personKey, peerEntry)
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
  socketToPeers.get(socket).add(personKey)
  // A live handshake is proof of presence — lease them online now, before their first
  // heartbeat. Refreshed by presence frames; cleared on disconnect. The flip return value is
  // ignored here: the handshake path emits members-updated unconditionally after the persist.
  presence.mark(personKey, spaceId)
  peerSeen(personKey, spaceId)
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
  const memberCap = getMembershipCaps().maxMembersPerSpace
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

// New to this space: always reply. A duplicate means the peer is re-announcing because it hasn't
// admitted US for this space (its copy of our frame was likely dropped) — reply too, floored on our
// own send ledger so two re-announcing peers converge instead of ping-ponging.
function replyReciprocalHandshake(socket, spaceId, msg, isNewToSpace) {
  const handler = socketMsgHandlers.get(socket)
  if (!handler) return
  const dupReplyDue = Date.now() - announceLedger.lastSentAt(socket, spaceId) >= getConvergenceConfig().dupReciprocalFloorMs
  if (!isNewToSpace && !dupReplyDue) return
  log.debug('sending reciprocal handshake for space', spaceId, 'to', msg.displayName)
  sendSingleHandshake(socket, handler, spaceId, msg.spaceTopic)
}

export async function handleHandshake(socket, peerInfo, msg) {
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

  const personKey = msg.profileKey
  const isNewToSpace = trackPeerConnection(socket, spaceId, msg)

  // Carry the persisted member's avatar (if any) so the join event shows it immediately.
  const existingMember = space?.members?.find((m) => m.publicKey === personKey)
  const cachedAvatar = existingMember?.avatar || null

  log.info('peer joined space:', msg.displayName, '→', spaceId)
  const ipc = getIpc()
  ipc.emit('event:member-joined', {
    spaceId,
    member: { publicKey: personKey, driveKey: msg.driveKey, displayName: msg.displayName, avatar: cachedAvatar, online: true },
  })
  ipc.emit('event:files-updated', { spaceId })

  // This peer is now admitted — clear any stale "wants to join" recorded before their approval
  // propagated, wherever it shows.
  if (clearJoinRequest(spaceId, personKey)) {
    ipc.emit('event:join-requests-updated', { spaceId })
  }

  memberWaits.ownerReconnected(personKey)
  onOwnerReconnect(personKey, spaceId)   // resume overlay downloads (loose + folder) owned by this peer (fn swallows its own errors)
  notifyPeerOnline(personKey, spaceId)

  replyReciprocalHandshake(socket, spaceId, msg, isNewToSpace)
  // After our handshake, so a peer that has already admitted us reads it; one that has not yet is
  // covered by ownerReconnected above.
  memberWaits.resend(personKey)

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
  ipc.emit('event:files-updated', { spaceId })

  // Fetch avatar asynchronously — won't block peer state.
  fetchPeerAvatar(personKey, msg, spaceId, space).catch((err) => {
    log.warn('avatar fetch failed:', msg.displayName, err.message)
  })
}

// Drop a peer's live state entirely. Leaving the bound signer key behind is the one that bites: a
// grant sealed after a later reconnect, before the fresh identity frame rewrites it, would be
// sealed to a key the peer no longer holds.
export function forgetPeer(personKey) {
  presence.clear(personKey)
  clearWaitingFor(personKey)
  connectedPeers.delete(personKey)
  forgetBoundSignerKey(personKey)
}

export function handleDisconnect(socket) {
  announceLedger.forgetSocket(socket)
  for (const [profileKey, sock] of pendingRequesters) {
    if (sock === socket) {
      pendingRequesters.delete(profileKey)
      forgetBoundSignerKey(profileKey)
    }
  }
  const personKeys = socketToPeers.get(socket)
  if (!personKeys) return
  socketToPeers.delete(socket)

  const ipc = getIpc()
  for (const personKey of personKeys) {
    const peer = connectedPeers.get(personKey)
    if (!peer) continue

    // Peer already reconnected on a different socket — don't remove
    if (peer.socket !== socket) continue

    for (const [spaceId] of peer.spaces) {
      log.info('peer left:', peer.displayName, 'from space', spaceId)
      auditPeerLost(personKey, spaceId, peer.displayName)
      ipc.emit('event:member-left', { spaceId, publicKey: personKey })
      ipc.emit('event:files-updated', { spaceId })
    }

    forgetPeer(personKey)
  }
  scheduleStatusEmit()
}

export function resetHandshakeApply() {
  getIpc = () => null
  onOwnerReconnect = () => {}
  peerOnlineHooks.clear()
  membersPoke.reset()
}
