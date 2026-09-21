import test from 'brittle'
import { EventEmitter } from 'node:events'
import b4a from 'b4a'
import idEncoding from 'hypercore-id-encoding'
import { installRelayObserver, resetRelayObserver } from '../../src/shared/network/relay-observe.js'
import {
  initRelayedConnections,
  resetRelayedConnections,
  trackConnection,
  describeConnection,
  snapshotRelayedConnections,
  relayVia,
} from '../../src/shared/network/relayed-connections.js'

const OWN = b4a.alloc(32, 1)
const OTHER = b4a.alloc(32, 2)
const PEER = b4a.alloc(32, 9)
const RELAY_ENDPOINT = { host: '203.0.113.9', port: 49737 }

class Stub extends EventEmitter {
  static from() { return new Stub() }
}

function harness(t, { own = { key: OWN, label: 'Hetzner box' }, member = null } = {}) {
  const calls = { change: 0, relayed: [], unrelayed: [] }
  const state = { own, member }
  installRelayObserver({ Client: Stub })
  initRelayedConnections({
    ownRelay: () => state.own,
    onChange: () => { calls.change++ },
    onRelayed: (socket) => { calls.relayed.push(socket) },
    onUnrelayed: (socket) => { calls.unrelayed.push(socket) },
  })
  t.teardown(() => { resetRelayedConnections(); resetRelayObserver() })
  const track = (socket, over = {}) => trackConnection(socket, { plane: 'control', memberOf: () => state.member, ...over })
  return { calls, state, track }
}

function snapshotWithoutSeen() {
  const { seen, ...rest } = snapshotRelayedConnections()
  return rest
}

function socketOf({ relayKey = null, adopted = false } = {}) {
  const rawStream = Object.assign(new EventEmitter(), { remoteHost: RELAY_ENDPOINT.host, remotePort: RELAY_ENDPOINT.port })
  const socket = Object.assign(new EventEmitter(), { remotePublicKey: PEER, rawStream })
  if (relayKey) {
    const client = Stub.from({ remotePublicKey: relayKey, rawStream: { remoteHost: RELAY_ENDPOINT.host, remotePort: RELAY_ENDPOINT.port } }, {})
    client.emit('pair', !adopted, b4a.alloc(4), rawStream, b4a.alloc(4))
  }
  return socket
}

test('a direct socket counts as direct and returns null', (t) => {
  const { calls, track } = harness(t)
  t.is(track(socketOf()), null)
  t.alike(snapshotWithoutSeen(), { connections: [], direct: { control: 1, content: 0 }, digest: '' })
  t.is(calls.relayed.length, 0)
})

// Only the control swarm has an 'update' watcher, so a direct connection that does not announce
// itself reaches the status frame whenever something unrelated fires — and the direct counters are
// what says whether an `always` relay has been applied to the live connections.
test('a direct socket announces itself to the status frame, opening and closing', (t) => {
  const { calls, track } = harness(t)
  const socket = socketOf()
  track(socket, { plane: 'content' })
  t.is(calls.change, 1)
  socket.emit('close')
  t.is(calls.change, 2)
})

test("a relayed socket through the configured key is 'own' and carries the configured label", (t) => {
  const { calls, track } = harness(t)
  const socket = socketOf({ relayKey: OWN })
  track(socket, { now: 5 })
  const snap = snapshotRelayedConnections()
  t.is(snap.connections.length, 1)
  t.is(snap.connections[0].via, 'own')
  t.is(snap.connections[0].relayKey, idEncoding.encode(OWN))
  t.is(snap.connections[0].noiseKey, b4a.toString(PEER, 'hex'))
  t.is(snap.connections[0].since, 5)
  t.alike(snap.direct, { control: 0, content: 0 })
  t.is(describeConnection(socket).relayLabel, 'Hetzner box')
  t.is(calls.relayed[0], socket)
  t.is(calls.change, 1)
})

test("a relayed socket through another key is 'adopted' even when this side initiated the pairing", (t) => {
  const { track } = harness(t)
  const socket = socketOf({ relayKey: OTHER, adopted: false })
  track(socket)
  t.is(snapshotRelayedConnections().connections[0].via, 'adopted')
  t.is(describeConnection(socket).relayLabel, null)
})

test("our own key handed back by the peer is still 'own'", (t) => {
  const { track } = harness(t)
  track(socketOf({ relayKey: OWN, adopted: true }))
  t.is(snapshotRelayedConnections().connections[0].via, 'own')
  t.is(relayVia(OWN, OWN), 'own')
  t.is(relayVia(OTHER, OWN), 'adopted')
  t.is(relayVia(OTHER, null), 'adopted')
})

test('an empty configured label reads as no label', (t) => {
  const { track } = harness(t, { own: { key: OWN, label: '' } })
  const socket = socketOf({ relayKey: OWN })
  track(socket)
  t.is(describeConnection(socket).relayLabel, null)
})

test('the provenance is fixed at pairing time and survives a relay config change', (t) => {
  const { state, track } = harness(t)
  const socket = socketOf({ relayKey: OWN })
  track(socket)
  state.own = { key: OTHER, label: 'New relay' }
  t.is(snapshotRelayedConnections().connections[0].via, 'own')
  t.is(describeConnection(socket).relayLabel, 'Hetzner box')
  state.own = { key: null, label: null }
  t.is(snapshotRelayedConnections().connections[0].via, 'own')
})

test("'remote-changed' to a different endpoint drops the entry and counts the peer as direct", (t) => {
  const { calls, track } = harness(t)
  const socket = socketOf({ relayKey: OWN })
  track(socket)
  socket.rawStream.remoteHost = '198.51.100.4'
  socket.rawStream.emit('remote-changed')
  t.alike(snapshotWithoutSeen(), { connections: [], direct: { control: 1, content: 0 }, digest: '' })
  t.is(calls.unrelayed.length, 1)
  t.is(calls.change, 2)
  socket.emit('close')
  t.alike(snapshotRelayedConnections().direct, { control: 0, content: 0 })
  t.is(calls.unrelayed.length, 1, 'close after going direct does not repeat the hook')
})

test("'remote-changed' to the relay's own endpoint keeps the entry", (t) => {
  const { calls, track } = harness(t)
  const socket = socketOf({ relayKey: OWN })
  track(socket)
  socket.rawStream.emit('remote-changed')
  t.is(snapshotRelayedConnections().connections.length, 1)
  t.is(calls.unrelayed.length, 0)
})

test('close removes a relayed entry, releases its dwell, and removes a direct socket alike', (t) => {
  const { calls, track } = harness(t)
  const relayed = socketOf({ relayKey: OWN })
  const direct = socketOf()
  track(relayed)
  track(direct)
  relayed.emit('close')
  t.alike(snapshotWithoutSeen(), { connections: [], direct: { control: 1, content: 0 }, digest: '' })
  t.is(calls.unrelayed[0], relayed)
  direct.emit('close')
  t.alike(snapshotRelayedConnections().direct, { control: 0, content: 0 })
})

test('a socket closing after a reset does not drive the direct count negative', (t) => {
  const { track } = harness(t)
  const socket = socketOf()
  track(socket)
  resetRelayedConnections()
  socket.emit('close')
  t.alike(snapshotRelayedConnections().direct, { control: 0, content: 0 })
})

test('the name is resolved at read time through the registry accessor', (t) => {
  const { state, track } = harness(t)
  const socket = socketOf({ relayKey: OTHER })
  track(socket)
  t.is(snapshotRelayedConnections().connections[0].displayName, null)
  t.is(describeConnection(socket).personKey, null)
  state.member = { profileKey: 'ab'.repeat(32), displayName: 'Lena' }
  t.is(snapshotRelayedConnections().connections[0].displayName, 'Lena')
  t.is(describeConnection(socket).personKey, 'ab'.repeat(32))
  t.is(describeConnection(socketOf()), null)
})

test('the digest changes with membership, via or name, and matches for equal frames', (t) => {
  const { state, track } = harness(t)
  const empty = snapshotRelayedConnections().digest
  track(socketOf({ relayKey: OWN }))
  const one = snapshotRelayedConnections().digest
  t.not(one, empty)
  t.is(snapshotRelayedConnections().digest, one)
  state.member = { profileKey: 'cd'.repeat(32), displayName: 'Jonas' }
  t.not(snapshotRelayedConnections().digest, one)
})

test('reset clears entries, counts and collaborators', (t) => {
  const { calls, track } = harness(t)
  track(socketOf({ relayKey: OWN }))
  track(socketOf())
  resetRelayedConnections()
  t.alike(snapshotWithoutSeen(), { connections: [], direct: { control: 0, content: 0 }, digest: '' })
  const before = calls.change
  track(socketOf())
  t.is(calls.change, before, 'the injected callbacks are gone')
})

test('a content-plane socket is tracked under its own plane and name lookup', (t) => {
  const { track } = harness(t)
  const relayed = socketOf({ relayKey: OWN })
  const direct = socketOf()
  track(relayed, { plane: 'content', memberOf: () => ({ profileKey: 'ef'.repeat(32), displayName: 'Jonas' }) })
  track(direct, { plane: 'content' })
  const snap = snapshotRelayedConnections()
  t.is(snap.connections[0].plane, 'content')
  t.is(snap.connections[0].displayName, 'Jonas')
  t.is(snap.connections[0].personKey, 'ef'.repeat(32))
  t.alike(snap.direct, { control: 0, content: 1 })
  t.is(describeConnection(relayed).plane, 'content')
  t.ok(snap.digest.includes(':content:'))
})

test('seen counts every connection observed relayed since start and survives close and direct upgrade', (t) => {
  const { track } = harness(t)
  const a = socketOf({ relayKey: OWN })
  const b = socketOf({ relayKey: OTHER })
  track(a)
  track(b)
  track(socketOf())
  t.is(snapshotRelayedConnections().seen, 2)
  a.emit('close')
  b.rawStream.remoteHost = '198.51.100.4'
  b.rawStream.emit('remote-changed')
  t.is(snapshotRelayedConnections().seen, 2)
  resetRelayedConnections()
  t.is(snapshotRelayedConnections().seen, 0)
})
