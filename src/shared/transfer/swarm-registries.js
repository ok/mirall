// The swarm's shared indexes: who is connected, over which socket, on which topics. Every section of
// swarm.js reads them, which is exactly why they belong to none of it.
//
// Extracted first, before the sections that use them. Measured, the shared registries were the bulk
// of every remaining section's dependency list — presence needed 11 identifiers from the core and
// deferred admission 10, of which four each were these Maps. Giving them a home is what makes those
// sections cheap to move; doing it the other way round means threading Maps through injected
// dependency objects and calling the result a decomposition.
//
// Exported bindings, not accessors: a Map's identity never changes, so importers mutate contents
// through a stable reference. resetRegistries() is what a teardown calls instead of clearing each
// one by hand — the reason destroySwarm knew about all of them.
import { createAnnounceLedger } from './announce-ledger.js'

// profileKey → { socket, profileKey, displayName, avatar, spaces: Map<spaceId, driveKey> }
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
