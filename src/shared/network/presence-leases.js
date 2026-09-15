// The one presence-lease store: who is online, as a lease rather than a socket. Marked on
// handshake, refreshed by heartbeats, cleared on disconnect, expired by TTL (which catches a
// silently-dead socket). connectedPeers stays the routing registry — where to send; this is the
// liveness the display and the fetch decisions read.
//
// It lives apart from the swarm because the folder, share and transfer domains read it and must not
// import the connection layer to do so.
import { createPresence } from './presence.js'

// The receiver controls the TTL — a peer cannot extend its own lease — so a peer counts as online
// only this long after the last heartbeat we actually received.
const PRESENCE_TTL_MS = 15000

// Installed by the connection layer: an expiry has to re-emit the roster and file-availability
// hints, which needs the IPC handle the worker wires at open.
let expireHandler = () => {}

export const presence = createPresence({
  ttl: PRESENCE_TTL_MS,
  onExpire: (peerKey, spaceId) => expireHandler(peerKey, spaceId),
})

export function setPresenceExpireHandler(fn) {
  expireHandler = fn || (() => {})
}

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

export function resetPresenceLeases() {
  expireHandler = () => {}
  presence.clearAll()
}
