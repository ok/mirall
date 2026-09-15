// The swarm's shared indexes: who is connected, over which socket, on which topics. Every section of
// swarm.js reads them, which is exactly why they belong to none of it.
//
// Exported bindings, not accessors: a Map's identity never changes, so importers mutate contents
// through a stable reference. resetRegistries() is what a teardown calls instead of clearing each
// one by hand.
import { createAnnounceLedger } from './announce-ledger.js'

// profileKey → { socket, profileKey, displayName, avatar, spaces: Map<spaceId, driveKey>,
//                looseCatalogKeys: Map<spaceId, { key, keyEnc }> }
export const connectedPeers = new Map()
// socket → Set<profileKey>  (reverse index for disconnect lookup)
export const socketToPeers = new Map()
export const spaceTopics = new Map()
// spaceId → PeerDiscovery (kept so reconnectAll can refresh)
export const spaceDiscoveries = new Map()
// socket → Protomux msgHandler (for sending handshakes to existing connections)
export const socketMsgHandlers = new Map()
// profileKey → socket. A pending joiner has no drive or handshake yet, so its socket is tracked here
// to grant against later.
export const pendingRequesters = new Map()
// profileKey → signerKey hex. Every identity frame a peer sends carries its bound ed25519 signer
// key; remembering it per profileKey is what lets a membership:grant be sealed to a
// CURRENTLY-CONNECTED joiner, independent of the join-request record's lifecycle (which loses it
// across leave/rejoin churn). A grant only ever reaches a connected joiner, so its key is always here.
export const boundSignerKeys = new Map()

// Which identity frames went out on which socket and still await their implicit ack. Same test as
// the Maps above — the handshake records into it, disconnect prunes it, the outbound handshake
// stamps it and the convergence tick drains it — so it is nobody's private state either.
export const announceLedger = createAnnounceLedger()

const ALL = [connectedPeers, socketToPeers, spaceTopics, spaceDiscoveries, socketMsgHandlers, pendingRequesters, boundSignerKeys, announceLedger]

export function resetRegistries() {
  for (const m of ALL) m.clear()
}

// === Reading the indexes ===
//
// The questions the swarm asks of these Maps. Each rule has one implementation, so every caller
// gets the same answer.

// True when this identity passed the identity binding on THIS socket. Answers both "is the
// requester admitted here?" (owner side) and "did this reply come from the owner?" (consumer
// side). Deliberately per socket rather than per peer: a draining socket keeps its entry until
// close, so during an owner reconnect both sockets are authorized rather than neither.
export function authorizedOn(socket, profileKeyHex) {
  return !!socketToPeers.get(socket)?.has(profileKeyHex)
}

// The channel a frame addressed to one peer goes out on. A pending joiner has no handshake yet, so
// it isn't in connectedPeers — fall back to the socket recorded when its membership:request arrived.
export function handlerForPeer(profileKeyHex) {
  const peer = connectedPeers.get(profileKeyHex)
  if (peer) {
    const h = socketMsgHandlers.get(peer.socket)
    if (h) return h
  }
  const sock = pendingRequesters.get(profileKeyHex)
  return sock ? socketMsgHandlers.get(sock) || null : null
}

// A connected peer's live metadata for a space (driveKey announced in its handshake, plus
// displayName/avatar), or null if it isn't currently handshaked here. The member registry uses this
// to enrich a newly-derived member entry; absent ⇒ the member is offline and its driveKey fills in
// on its next handshake.
export function getConnectedMemberMeta(spaceId, profileKeyHex) {
  const peer = connectedPeers.get(profileKeyHex)
  if (!peer || !peer.spaces.has(spaceId)) return null
  const loose = peer.looseCatalogKeys?.get(spaceId)
  return { driveKey: peer.spaces.get(spaceId) || null, looseCatalogKey: loose?.key || null, looseCatalogKeyEnc: loose?.keyEnc || null, displayName: peer.displayName, avatar: peer.avatar }
}

// The bound signer key a connected peer last asserted, for sealing a membership:grant to it.
export function getBoundSignerKey(profileKeyHex) {
  return boundSignerKeys.get(profileKeyHex) || null
}

// The peers sharing this space with us, as [profileKey, entry].
export function* peersInSpace(spaceId) {
  for (const [profileKey, peer] of connectedPeers) {
    if (peer.spaces.has(spaceId)) yield [profileKey, peer]
  }
}

// Send one frame to one peer. Best-effort: a socket mid-close must not abort a fan-out, so a
// failed send is reported rather than thrown. Returns whether the frame reached a channel.
export function safeSend(peer, frame) {
  const handler = socketMsgHandlers.get(peer.socket)
  if (!handler) return false
  try {
    handler.send(frame)
    return true
  } catch {
    return false
  }
}

// Fan one frame out to a space. The caller serializes it once: every recipient gets the same
// bytes. Returns how many peers it reached.
export function broadcastToSpace(spaceId, frame) {
  let sent = 0
  for (const [, peer] of peersInSpace(spaceId)) {
    if (safeSend(peer, frame)) sent++
  }
  return sent
}

// === Detaching a peer from a space ===

// Remove one space from a peer's membership, with the loose catalog key that belongs to it.
// Returns true when the peer is left in no space at all — the condition for forgetting the peer
// itself.
//
// What follows that `true` belongs to the caller, because it differs by event. When WE leave a
// space the control socket is destroyed and its close handler completes the teardown; when THEY
// leave, the socket stays up — they remain a peer, just not here — so that path unwinds
// socketToPeers itself.
export function detachPeerFromSpace(peer, spaceId) {
  peer.spaces.delete(spaceId)
  peer.looseCatalogKeys?.delete(spaceId)
  return peer.spaces.size === 0
}

// Forget the signer key a departing peer bound. The key may only outlive the socket while the peer
// is still connected elsewhere or still pending a grant; otherwise it has to go, or a grant sealed
// after a later reconnect can be sealed to a key that peer no longer holds. Every teardown path —
// a socket close, and a leave that strands a peer in no space — asks this one question.
export function forgetBoundSignerKey(profileKey) {
  if (connectedPeers.has(profileKey) || pendingRequesters.has(profileKey)) return
  boundSignerKeys.delete(profileKey)
}

// Remove one identity from a socket's set, and the socket once no identity rides it. The
// disconnect path does not use this: there the socket itself is gone, so its whole entry goes at
// once.
export function forgetPeerOnSocket(socket, profileKey) {
  const set = socketToPeers.get(socket)
  if (!set) return
  set.delete(profileKey)
  if (set.size === 0) socketToPeers.delete(socket)
}
