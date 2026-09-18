import test from 'brittle'
import b4a from 'b4a'
import idEncoding from 'hypercore-id-encoding'
import EventEmitter from 'bare-events'
import { bootSwarms } from '../helpers/swarms.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { registerNetwork } from '../../src/worker/ipc/network.js'
import { trackConnection, resetRelayedConnections } from '../../src/shared/network/relayed-connections.js'
import { socketMsgHandlers } from '../../src/shared/network/swarm-registries.js'
import { reconnectAll } from '../../src/shared/network/space-topics.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { ServeLedger, onServeStart } from '../../src/shared/transfer/serve-ledger.js'

const KEY_A = idEncoding.encode(b4a.alloc(32, 11))
const SLOT = { publicKey: KEY_A, kind: 'open', enabled: true }
const HASH = 'h'.repeat(64)
const PEER = 'p'.repeat(64)

// A socket with no relay pairing behind it: the direct count is what `always` contradicts.
function directSocket() {
  const rawStream = Object.assign(new EventEmitter(), { remoteHost: '198.51.100.7', remotePort: 4001 })
  return Object.assign(new EventEmitter(), { remotePublicKey: b4a.alloc(32, 9), rawStream, destroy() { this.emit('close') } })
}

async function setup(t, { relayMode = 'always' } = {}) {
  await bootSwarms(t, { relayMode, relay: SLOT })
  const fake = createFakeIpc()
  registerNetwork(fake.ipc, { applyRelayConfig: () => ({ applied: 1 }) })
  const socket = directSocket()
  trackConnection(socket, { plane: 'control', memberOf: () => null })
  socketMsgHandlers.set(socket, {})
  // The real control socket unregisters itself on close (peer-connection.js); the fake has to do the
  // same or the registry would look untouched after a reconnect that did destroy it.
  socket.once('close', () => socketMsgHandlers.delete(socket))
  t.teardown(() => { socketMsgHandlers.clear(); resetRelayedConnections() })
  return { fake, socket }
}

test('a mode change with nothing moving is applied to the live connections', async (t) => {
  const { fake } = await setup(t)

  const reply = await fake.call('network:set-relay', { mode: 'always', relay: SLOT })

  t.is(reply.mismatch, 'stale-direct', 'the connections disagree with the setting')
  t.is(reply.reconnected, true, 'and the worker did not leave it at that')
  t.is(socketMsgHandlers.size, 0, 'the connections the user was watching are gone')
})

test('a mode change while a transfer moves is left for the user', async (t) => {
  const { fake } = await setup(t)
  serveIndex.reset()
  const ledger = new ServeLedger('serve-ledger', { ipc: fake.ipc })
  t.teardown(async () => { await ledger.close(); serveIndex.reset() })
  await ledger.ready()
  serveIndex.add(HASH, 'space1', '__loose__', 'big.bin')
  onServeStart({ from: PEER, contentHash: HASH, total: 1000 })

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
