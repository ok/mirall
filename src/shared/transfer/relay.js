import b4a from 'b4a'
import idEncoding from 'hypercore-id-encoding'

// Mirrors MAX_RELAYS in src/main/relay-keys.js — main bounds what is PERSISTED, this
// bounds what is APPLIED. Both are needed: the live network:set-relays frame comes
// straight from the renderer and never passes through main's sanitizer, so without a
// cap here the effective set could exceed the stored one and silently change on restart.
export const MAX_APPLIED_RELAYS = 8

export function decodeRelayKey(id) {
  if (typeof id !== 'string' || id.length === 0) return null
  try {
    const key = idEncoding.decode(id)
    return key.byteLength === 32 ? key : null
  } catch {
    return null
  }
}

// Dedupe on the DECODED bytes, not the string: z-base-32, lowercase hex, uppercase hex
// and the pear:// form are all the same relay, and hyperdht picks uniformly at random
// from the array, so duplicates would skew selection and crowd out the cap.
export function enabledRelayKeys(relays) {
  if (!Array.isArray(relays)) return []
  const seen = new Set()
  const keys = []
  for (const relay of relays) {
    if (!relay || relay.enabled === false) continue
    const key = decodeRelayKey(relay.publicKey)
    if (!key) continue
    const fingerprint = b4a.toString(key, 'hex')
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    keys.push(key)
    if (keys.length >= MAX_APPLIED_RELAYS) break
  }
  return keys
}

// hyperswarm calls this per connection attempt (index.js:210) and hyperdht calls it on
// the announce path with no arguments (server.js:354). The modes map onto its own
// semantics:
//   off    — no function at all, byte-identical to a build without relay support
//   always — every connection, the only honest way to TEST that a relay works
//   auto   — USE a relay after a punch fails or on a randomized NAT, and OFFER ours to
//            anyone who dials us (see below)
export function relayFunctionFor(keyBuffers, mode, onSelected) {
  if (!Array.isArray(keyBuffers) || keyBuffers.length === 0) return null
  const select = () => {
    if (onSelected) onSelected()
    return keyBuffers
  }
  if (mode === 'always') return select
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
      // Deliberately not `select()`: the offer is not a selection, and counting it would
      // make relaying.selected climb on every inbound connection. hyperdht's own
      // relaying.attempts (server.js:630) already counts the ones actually taken up.
      if (force === undefined) return keyBuffers
      return force || swarm?.dht?.randomized ? select() : null
    }
  }
  return null
}
