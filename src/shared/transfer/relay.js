import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { decodeRelayKey } from './relay-ticket.js'

export { decodeRelayKey }

// One slot in, at most one key out. hyperdht's selectRelay handles arrays, functions and a
// bare key; a one-element array is the least invasive shape.
export function enabledRelayKeys(relay) {
  if (!relay || relay.enabled === false) return []
  const key = decodeRelayKey(relay.publicKey)
  return key ? [key] : []
}

// The key the relay matches in its firewall, and the only thing derived from a ticket seed.
// No seed means today's behaviour — a fresh random key per boot, which is the correct
// identity for an open relay: one that admits everyone has no business holding a durable
// name for us. hypercore-crypto.keyPair and hyperdht's own createKeyPair are the same
// sodium.crypto_sign_seed_keypair call, so a seeded pair is exactly the key the operator
// wrote to their roster when they minted the ticket.
export function relayIdentityKeyPair(seedHex) {
  if (typeof seedHex !== 'string' || !/^[0-9a-f]{64}$/.test(seedHex)) return crypto.keyPair()
  return crypto.keyPair(b4a.from(seedHex, 'hex'))
}

// hyperswarm calls this per connection attempt (index.js:210) and hyperdht calls it on
// the announce path with no arguments (server.js:354). The modes map onto its own
// semantics:
//   off    — no function at all, byte-identical to a build without relay support
//   always — every connection, the only honest way to TEST that a relay works
//   auto   — USE a relay after a punch fails or on a randomized NAT, and OFFER ours to
//            anyone who dials us (see below)
export function relayFunctionFor(keyBuffers, mode, onSelected, { offerable = true } = {}) {
  if (!Array.isArray(keyBuffers) || keyBuffers.length === 0) return null
  const select = () => {
    if (onSelected) onSelected()
    return keyBuffers
  }
  // `always` offers on the announce path too, so it needs the same guard as `auto` below — a
  // private relay must not be handed to a peer that cannot be admitted to it. Withholding costs
  // nothing between members: hyperdht relays the connection if EITHER side supplies a relay
  // (server.js:402), and a private relay only works when both ends are members anyway.
  if (mode === 'always') return (force) => (force === undefined && !offerable ? null : select())
  if (mode === 'auto') {
    return (force, swarm) => {
      // `force === undefined` IS the announce path: hyperdht reaches us through
      // selectRelay(this.relayThrough) with no arguments (server.js:354), while every dial
      // passes peerInfo.forceRelaying, seeded to a boolean false (peer-info.js:28). The
      // distinction is a calling convention, not an API — the unit test pins both shapes.
      //
      // Offering costs nothing on a healthy link: hyperdht returns before it touches the
      // relay whenever the direct path works (server.js:395-398). What it buys is a peer
      // with no relay of its own using OURS, which it adopts straight out of the handshake
      // payload (connect.js:518,782) with no configuration at either end.
      //
      // A PRIVATE relay is not offerable: it admits only its roster, so a stranger who
      // adopts this key gets a handshake refusal it cannot tell from the relay being down,
      // and the operator sees it as noise in their refusal counter. Offering a path that is
      // guaranteed to fail, to someone who can never be admitted, is worse than not offering.
      //
      // Deliberately not `select()`: the offer is not a selection, and counting it would
      // make relaying.selected climb on every inbound connection. hyperdht's own
      // relaying.attempts (server.js:630) already counts the ones actually taken up.
      if (force === undefined) return offerable ? keyBuffers : null
      return force || swarm?.dht?.randomized ? select() : null
    }
  }
  return null
}
