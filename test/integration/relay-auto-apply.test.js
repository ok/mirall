import test from 'brittle'
import b4a from 'b4a'
import idEncoding from 'hypercore-id-encoding'
import EventEmitter from 'bare-events'
import { bootSwarms } from '../helpers/swarms.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { registerNetwork } from '../../src/worker/ipc/network.js'
import { trackConnection, resetRelayedConnections, snapshotRelayedConnections } from '../../src/shared/network/relayed-connections.js'
import { installRelayObserver, resetRelayObserver } from '../../src/shared/network/relay-observe.js'
import { socketMsgHandlers } from '../../src/shared/network/swarm-registries.js'
import { reconnectAll } from '../../src/shared/network/space-topics.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { ServeLedger, onServeStart } from '../../src/shared/transfer/serve-ledger.js'
import { waitFor } from '../helpers/bare-poll.js'

const KEY_A = idEncoding.encode(b4a.alloc(32, 11))
const SLOT = { publicKey: KEY_A, kind: 'open', enabled: true }
const SLOT_B = { publicKey: idEncoding.encode(b4a.alloc(32, 12)), kind: 'open', enabled: true }
const HASH = 'h'.repeat(64)
const PEER = 'p'.repeat(64)
const RELAY_ENDPOINT = { host: '203.0.113.9', port: 49737 }

class Stub extends EventEmitter { static from() { return new Stub() } }

// A socket with no relay pairing behind it: the direct count is what `always` contradicts.
function directSocket() {
  const rawStream = Object.assign(new EventEmitter(), { remoteHost: '198.51.100.7', remotePort: 4001 })
  return Object.assign(new EventEmitter(), { remotePublicKey: b4a.alloc(32, 9), rawStream, destroy() { this.emit('close') } })
}

// A socket paired through `relayKey`, the way hyperdht reports it: blind-relay's client emits 'pair'
// with the peer raw stream, and the observer records the relay behind it.
function relayedSocket(relayKey) {
  const rawStream = Object.assign(new EventEmitter(), { remoteHost: RELAY_ENDPOINT.host, remotePort: RELAY_ENDPOINT.port })
  const client = Stub.from({ remotePublicKey: relayKey, rawStream: { remoteHost: RELAY_ENDPOINT.host, remotePort: RELAY_ENDPOINT.port } }, {})
  client.emit('pair', true, b4a.alloc(32), rawStream, 1)
  return Object.assign(new EventEmitter(), { remotePublicKey: b4a.alloc(32, 8), rawStream, destroy() { this.emit('close') } })
}

async function setup(t, { relayMode = 'always', socket: kind = 'direct' } = {}) {
  const { ipcEvents } = await bootSwarms(t, { relayMode, relay: SLOT })
  const fake = createFakeIpc()
  registerNetwork(fake.ipc, { applyRelayConfig: () => ({ applied: 1 }) })
  if (kind === 'relayed') {
    resetRelayObserver()
    installRelayObserver({ Client: Stub })
    t.teardown(resetRelayObserver)
  }
  const socket = kind === 'relayed' ? relayedSocket(idEncoding.decode(KEY_A)) : directSocket()
  trackConnection(socket, { plane: 'control', memberOf: () => null })
  socketMsgHandlers.set(socket, {})
  // The real control socket unregisters itself on close (peer-connection.js); the fake has to do the
  // same or the registry would look untouched after a reconnect that did destroy it.
  socket.once('close', () => socketMsgHandlers.delete(socket))
  t.teardown(() => { socketMsgHandlers.clear(); resetRelayedConnections() })
  return { fake, socket, ipcEvents }
}

test('a mode change with nothing moving is applied to the live connections', async (t) => {
  const { fake } = await setup(t)

  const reply = await fake.call('network:set-relay', { mode: 'always', relay: SLOT })

  t.is(reply.mismatch, 'stale-direct', 'the connections disagree with the setting')
  t.is(reply.reconnected, true, 'and the worker did not leave it at that')
  t.is(socketMsgHandlers.size, 0, 'the connections the user was watching are gone')
})

async function moveATransfer(t, fake) {
  serveIndex.reset()
  const ledger = new ServeLedger('serve-ledger', { ipc: fake.ipc })
  t.teardown(async () => { await ledger.close(); serveIndex.reset() })
  await ledger.ready()
  serveIndex.add(HASH, 'space1', '__loose__', 'big.bin')
  onServeStart({ from: PEER, contentHash: HASH, total: 1000 })
}

test('a mode change while a transfer moves is left for the user', async (t) => {
  const { fake } = await setup(t)
  await moveATransfer(t, fake)

  const reply = await fake.call('network:set-relay', { mode: 'always', relay: SLOT })

  t.is(reply.mismatch, 'stale-direct')
  t.is(reply.reconnected, false, 'nothing is interrupted behind the user')
  t.is(socketMsgHandlers.size, 1, 'the transfer keeps its connection')
})

test('no mismatch means no reconnect', async (t) => {
  const { fake } = await setup(t, { relayMode: 'auto' })

  const reply = await fake.call('network:set-relay', { mode: 'auto', relay: SLOT })

  t.is(reply.mismatch, null, 'auto is satisfied by a direct connection')
  t.is(reply.reconnected, false)
  t.is(socketMsgHandlers.size, 1)
})

// A pinned identity is applied by a respawn, so churning the connections for it is noise.
test('deferApply suppresses the auto-reconnect', async (t) => {
  const { fake } = await setup(t)

  const reply = await fake.call('network:set-relay', { mode: 'always', relay: SLOT, deferApply: true })

  t.is(reply.mismatch, 'stale-direct', 'the mismatch is still reported')
  t.is(reply.reconnected, false)
  t.is(socketMsgHandlers.size, 1)
})

// Two changes inside the throttle window: the second cannot apply itself, and saying otherwise would
// leave the user with a setting that is not live and no notice offering to finish the job.
test('a throttled reconnect reports reconnected:false', async (t) => {
  const { fake } = await setup(t)
  await reconnectAll()
  // What a re-dial leaves behind on a network that punches: direct again, and the setting still
  // unapplied. The throttle is what stops the next change from fixing it on its own.
  trackConnection(directSocket(), { plane: 'control', memberOf: () => null })

  const reply = await fake.call('network:set-relay', { mode: 'always', relay: SLOT })

  t.is(reply.mismatch, 'stale-direct')
  t.is(reply.reconnected, false, 'a reconnect it did not get is not one it can claim')
})

// REGRESSION (FIX-411: `always` → `auto` found no mismatch, so the worker never reconnected and the
// connections `always` had relayed stayed on our relay until a restart.)
test('REGRESSION (FIX-411: always → auto reconnects what always relayed)', async (t) => {
  const { fake } = await setup(t, { relayMode: 'always', socket: 'relayed' })
  t.is(snapshotRelayedConnections().connections[0].relayMode, 'always', 'precondition: stamped under always')

  const reply = await fake.call('network:set-relay', { mode: 'auto', relay: SLOT })

  t.is(reply.mismatch, 'stale-relayed')
  t.is(reply.reconnected, true, 'nothing was moving, so the worker applied it itself')
  t.is(socketMsgHandlers.size, 0)
})

test('always → auto with a transfer moving is left for the user', async (t) => {
  const { fake } = await setup(t, { relayMode: 'always', socket: 'relayed' })
  await moveATransfer(t, fake)

  const reply = await fake.call('network:set-relay', { mode: 'auto', relay: SLOT })

  t.is(reply.mismatch, 'stale-relayed')
  t.is(reply.reconnected, false)
  t.is(socketMsgHandlers.size, 1)
})

test('auto with a connection auto relayed itself is not reconnected', async (t) => {
  const { fake } = await setup(t, { relayMode: 'auto', socket: 'relayed' })

  const reply = await fake.call('network:set-relay', { mode: 'auto', relay: SLOT })

  t.is(reply.mismatch, null)
  t.is(reply.reconnected, false)
  t.is(socketMsgHandlers.size, 1)
})

// REGRESSION (FIX-RELAY-SWAP: replacing an open relay kept the mode, so neither `always` nor `auto`
// saw a mismatch and every connection built through the old key stayed on it.)
test('REGRESSION (FIX-RELAY-SWAP: replacing the relay reconnects what ran through the old one)', async (t) => {
  const { fake } = await setup(t, { relayMode: 'always', socket: 'relayed' })

  const reply = await fake.call('network:set-relay', { mode: 'always', relay: SLOT_B })

  t.is(reply.mismatch, 'replaced-relay')
  t.is(reply.reconnected, true)
  t.is(socketMsgHandlers.size, 0)
})

// The flag follows the slot and no connection event reports a slot change, so without its own frame
// the renderer would keep one where nothing is replaced, and the armed notice would never show.
test('a replace while a transfer moves is left for the user, and the frame says why', async (t) => {
  const { fake, ipcEvents } = await setup(t, { relayMode: 'auto', socket: 'relayed' })
  await moveATransfer(t, fake)

  const reply = await fake.call('network:set-relay', { mode: 'auto', relay: SLOT_B })

  t.is(reply.mismatch, 'replaced-relay')
  t.is(reply.reconnected, false)
  const flipped = () => ipcEvents.some((e) => e.type === 'event:network-status' &&
    e.payload.relay.connections[0]?.replaced === true)
  await waitFor(flipped, 2000, { label: 'a frame carrying the flip' })
  t.pass('the renderer is told without waiting for a connection event')
})

test('re-saving the same relay is not a swap', async (t) => {
  const { fake } = await setup(t, { relayMode: 'always', socket: 'relayed' })

  const reply = await fake.call('network:set-relay', { mode: 'always', relay: SLOT })

  t.is(reply.mismatch, null)
  t.is(reply.reconnected, false)
})
