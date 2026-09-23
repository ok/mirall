// One recipe for a blind relay on the hermetic testnet, plus the peer flags that make a worker dial
// through it and the predicate that says the connection has stopped moving. Shared by the flow
// suite and the frontend scenarios, so the relay a test builds, the mode a peer boots with and the
// moment a test starts asserting cannot drift apart.
//
// Loopback caveat: with `relayMode: 'always'` the hole punch frequently wins before the relay
// carries a byte, so a test must assert the outcome the frame reports rather than wait longer.
import crypto from 'crypto'
import path from 'path'
import DHT from 'hyperdht'
import BlindRelay from 'blind-relay'
import idEncoding from 'hypercore-id-encoding'
import { mkTmpDir } from './fixtures.js'

export const RELAY_AUDIT_DWELL_MS = 500

// Both planes have landed somewhere: one socket per plane, each either paired through the relay or
// already direct. Before this holds a frame is a connection in flight, not an outcome.
export const bothPlanesSettled = (frame) =>
  frame.relay.connections.length + frame.relay.direct.control + frame.relay.direct.content === 2

const kekHex = () => crypto.randomBytes(32).toString('hex')

export const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')

export const flags = () => ({ identityKEK: kekHex(), handshakeIdentityBindingEnabled: true, relayAuditDwellMs: RELAY_AUDIT_DWELL_MS })

export const relayFlags = (key) => ({
  ...flags(),
  relayMode: 'always',
  relay: { publicKey: key, kind: 'open', label: 'Test relay', enabled: true, lastTest: null },
})

// Hands back an explicit close() rather than registering a teardown: a frontend scenario has no
// brittle test object and runs it in its own finally.
export async function startLocalRelay(bootstrap) {
  const dht = new DHT({ bootstrap })
  const relay = new BlindRelay.Server({ createStream: (opts) => dht.createRawStream(opts) })
  const server = dht.createServer((socket) => relay.accept(socket, { id: socket.remotePublicKey }))
  await server.listen()
  return {
    key: idEncoding.encode(server.publicKey),
    stats: relay.stats,
    close: async () => {
      try { await relay.close() } catch {}
      try { await server.close() } catch {}
      try { await dht.destroy() } catch {}
    },
  }
}

export async function localRelay(t, bootstrap) {
  const relay = await startLocalRelay(bootstrap)
  t.teardown(relay.close)
  return relay
}
