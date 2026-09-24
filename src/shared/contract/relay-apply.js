// Whether a relay setting has reached the connections that already exist.
//
// A relay is chosen per connection: hyperswarm reads swarm.relayThrough when it dials and hyperdht
// when it answers, so a change governs the next connection and leaves every open one on the path it
// was built with. This names the states where that gap is visible to the user, and it lives in
// contract/ because both runtimes decide on it — the worker to apply the change itself when it can,
// the renderer to explain it when it cannot.

/** @typedef {'off' | 'auto' | 'always'} RelayMode */
/** @typedef {{ via: 'own' | 'adopted', supplied: boolean, relayMode: RelayMode, replaced: boolean }} RelayConnectionFacts */
/** @typedef {{ connections: readonly RelayConnectionFacts[], direct: { control: number, content: number } }} RelayFacts */
/** @typedef {'stale-relayed' | 'stale-direct' | 'replaced-relay' | null} RelayMismatch */

/**
 * @param {RelayMode} mode
 * @param {RelayFacts | null | undefined} relay
 * @returns {RelayMismatch}
 */
export function relayMismatch(mode, relay) {
  if (!relay) return null
  // Only connections this side supplied the relay for are ours to end: hyperdht relays when EITHER side
  // offers one, so a relay the peer supplied survives any local act — even one through our own key.
  const own = relay.connections.filter((c) => c.via === 'own' && c.supplied)
  if (mode === 'off') return own.length > 0 ? 'stale-relayed' : null
  if (mode === 'always' && relay.direct.control + relay.direct.content > 0) return 'stale-direct'
  // `auto` relays when a punch fails and offers our relay to inbound dials, so a relayed connection
  // built under it is the mode working. One built under `always` was relayed without a direct
  // attempt of its own and keeps that path until it closes.
  if (mode === 'auto' && own.some((c) => c.relayMode === 'always')) return 'stale-relayed'
  // A replaced slot leaves every connection built through the old key on it.
  return own.some((c) => c.replaced) ? 'replaced-relay' : null
}
