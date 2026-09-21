// Whether a relay setting has reached the connections that already exist.
//
// A relay is chosen per connection: hyperswarm reads swarm.relayThrough when it dials and hyperdht
// when it answers, so a change governs the next connection and leaves every open one on the path it
// was built with. This names the two states where that gap is visible to the user, and it lives in
// contract/ because both runtimes decide on it — the worker to apply the change itself when it can,
// the renderer to explain it when it cannot.

/** @typedef {'off' | 'auto' | 'always'} RelayMode */
/** @typedef {{ via: 'own' | 'adopted', relayMode: RelayMode }} RelayConnectionFacts */
/** @typedef {{ connections: readonly RelayConnectionFacts[], direct: { control: number, content: number } }} RelayFacts */
/** @typedef {'stale-relayed' | 'stale-direct' | null} RelayMismatch */

/**
 * @param {RelayMode} mode
 * @param {RelayFacts | null | undefined} relay
 * @returns {RelayMismatch}
 */
export function relayMismatch(mode, relay) {
  if (!relay) return null
  if (mode === 'always') return relay.direct.control + relay.direct.content > 0 ? 'stale-direct' : null
  // Only connections through OUR relay are ours to end: hyperdht relays when EITHER side offers one,
  // so an adopted relay survives any local act.
  const own = relay.connections.filter((c) => c.via === 'own')
  // `auto` relays when a punch fails and offers our relay to inbound dials, so a relayed connection
  // built under it is the mode working. One built under `always` was relayed without a direct
  // attempt of its own and keeps that path until it closes.
  if (mode === 'auto') return own.some((c) => c.relayMode === 'always') ? 'stale-relayed' : null
  return own.length > 0 ? 'stale-relayed' : null
}
