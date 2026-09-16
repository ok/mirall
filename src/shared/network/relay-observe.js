// Records which blind relay carries a raw stream, and whether this side supplied the relay or
// adopted it from the peer's handshake. hyperdht keeps both facts on private handshake state; they
// cross a public surface exactly once, in blind-relay's client, which hyperdht obtains through
// Client.from(relaySocket) and which emits 'pair' with the peer's raw stream once the relay has
// matched both ends. The wrapper is installed for the life of the swarm and restored on close;
// nothing under node_modules changes. Upstream request to expose this on the stream itself:
// https://github.com/holepunchto/hyperdht/issues/303
import BlindRelay from 'blind-relay'

const pairings = new WeakMap()
const observed = new WeakSet()
let restore = null

export function installRelayObserver({ Client = BlindRelay.Client } = {}) {
  if (restore) return
  const from = Client.from
  Client.from = function (stream, opts) {
    const client = from.call(this, stream, opts)
    if (!observed.has(client)) {
      observed.add(client)
      client.on('pair', (isInitiator, _token, rawStream) => {
        pairings.set(rawStream, {
          relayKey: stream.remotePublicKey,
          adopted: !isInitiator,
          relayEndpoint: endpointOf(stream),
        })
      })
    }
    return client
  }
  restore = () => { Client.from = from }
}

export function resetRelayObserver() {
  if (restore) restore()
  restore = null
}

export function relayPairingFor(rawStream) {
  return rawStream ? pairings.get(rawStream) ?? null : null
}

// After pairing the peer raw stream points at the relay's endpoint; once a hole punch moves it
// elsewhere the connection has gone direct.
export function isStillRelayed(rawStream, relayEndpoint) {
  if (!relayEndpoint) return false
  return rawStream.remoteHost === relayEndpoint.host && rawStream.remotePort === relayEndpoint.port
}

function endpointOf(relaySocket) {
  const raw = relaySocket?.rawStream
  return raw && typeof raw.remotePort === 'number' ? { host: raw.remoteHost, port: raw.remotePort } : null
}
