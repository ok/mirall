import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import DHT from 'hyperdht'
import BlindRelay from 'blind-relay'
import idEncoding from 'hypercore-id-encoding'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { waitFor } from '../helpers/poll.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const flags = () => ({ identityKEK: kekHex(), handshakeIdentityBindingEnabled: true })
const slotFor = (key) => ({ publicKey: key, kind: 'open', label: 'Test relay', enabled: true, lastTest: null })
const relayFlags = (key) => ({ ...flags(), relayMode: 'always', relay: slotFor(key) })

async function localRelay(t, bootstrap) {
  const dht = new DHT({ bootstrap })
  const relay = new BlindRelay.Server({ createStream: (opts) => dht.createRawStream(opts) })
  const server = dht.createServer((socket) => relay.accept(socket, { id: socket.remotePublicKey }))
  await server.listen()
  t.teardown(async () => {
    try { await relay.close() } catch {}
    try { await server.close() } catch {}
    try { await dht.destroy() } catch {}
  })
  return { key: idEncoding.encode(server.publicKey), stats: relay.stats }
}

// Both planes accounted for, whichever path each one ended up on.
const settled = (frame) => frame.relay.connections.length + frame.relay.direct.control + frame.relay.direct.content === 2

// REGRESSION (FIX-RELAY-APPLY: a relay mode change reached swarm.relayThrough at once but never
// touched a connection that already existed, so turning the relay on or off did nothing until the
// app was restarted — the transport chooses a relay once, when the connection is built.)
test('REGRESSION (FIX-RELAY-APPLY: a relay mode change reaches connections that already exist)', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const relay = await localRelay(t, bootstrap)

  // Both peers start with NO relay, so the connection they build cannot be relayed.
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  await connectInSpace(t, A, B)
  t.is(relay.stats.pairings.requested, 0, 'nothing is relayed yet')

  // Exactly what the settings toggle sends. Nothing is downloading, so each worker applies it to the
  // live connections itself and says so.
  const first = await A.request('network:set-relay', { mode: 'always', relay: slotFor(relay.key) })
  t.is(first.mismatch, 'stale-direct', 'the live connections contradict the setting')
  t.is(first.reconnected, true, 'and the worker did not leave it at that')

  // By the time B is told, A's reconnect may already have pulled both of them onto the relay — which
  // is the same outcome reached from the other side, not a second thing to apply.
  const second = await B.request('network:set-relay', { mode: 'always', relay: slotFor(relay.key) })
  t.ok(second.reconnected === true || second.mismatch === null,
    'the second peer either applied its own change or had nothing left to apply')

  await waitFor(() => relay.stats.pairings.requested >= 1, 30000, { label: 'a pairing through the relay' })
  t.ok(relay.stats.pairings.matched >= 1, 'the relay matched both ends')

  // A reconnect that leaves the space disconnected is not a fix.
  await A.until('network:status:get', {}, settled, { ms: 30000 })
  await B.until('network:status:get', {}, settled, { ms: 30000 })
})

test('turning the relay off takes the live connections off it', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const relay = await localRelay(t, bootstrap)

  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: relayFlags(relay.key) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: relayFlags(relay.key) })
  await connectInSpace(t, A, B)
  await waitFor(() => relay.stats.pairings.requested >= 1, 30000, { label: 'a relayed connection to begin with' })

  const before = relay.stats.pairings.requested
  for (const peer of [A, B]) await peer.request('network:set-relay', { mode: 'off', relay: null })

  // On loopback the punch wins, so what is asserted is that the RECONNECTED connections asked the
  // relay for nothing — the counter is cumulative, so a single new pairing would show.
  await A.until('network:status:get', {}, (frame) => frame.relay.direct.control + frame.relay.direct.content === 2, { ms: 30000 })
  t.is(relay.stats.pairings.requested, before, 'the reconnected connections asked the relay for nothing')
  t.is((await A.request('network:status:get')).relay.connections.length, 0, 'and none is still running through it')
})
