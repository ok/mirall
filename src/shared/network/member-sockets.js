// The sockets that carry one person: the control socket the handshake bound, plus every content
// socket a content-hello bound. members:reach folds them per space and the Activity Log's relay
// stretches read them per person, so the roster and the log decide the path from one list.
import { connectedPeers } from './swarm-registries.js'
import { contentSocketsFor } from './content-swarm.js'
import { isRelayedSocket } from './relayed-connections.js'
import { memberReach } from './member-reach.js'

export function socketsOf(personKey, peer = connectedPeers.get(personKey)) {
  return [peer?.socket, ...contentSocketsFor(personKey)]
}

// Only a person the control plane holds is connected, as members:reach lists them: a content
// socket that outlives its control socket does not keep its person reachable.
export function reachOf(personKey) {
  const peer = connectedPeers.get(personKey)
  if (!peer) return null
  return memberReach([[personKey, socketsOf(personKey, peer)]], isRelayedSocket)[personKey] ?? null
}
