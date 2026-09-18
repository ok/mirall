import test from 'brittle'
import b4a from 'b4a'
import idEncoding from 'hypercore-id-encoding'
import { bootSwarms } from '../helpers/swarms.js'
import { initSpaceTopics, reconnectAll } from '../../src/shared/network/space-topics.js'
import { getContentSwarm } from '../../src/shared/network/content-swarm.js'
import { socketMsgHandlers } from '../../src/shared/network/swarm-registries.js'

const KEY_A = idEncoding.encode(b4a.alloc(32, 11))

// The throttle is shared module state, so every test picks its own clock rather than racing the
// one before it.
let clock = 1_000_000
const nextNow = () => (clock += 60_000)

function fakeControlSocket(dropped) {
  return { destroy: () => dropped.push('control') }
}

// REGRESSION (FIX-RELAY-APPLY: refreshing discovery left every open connection on the relay it was
// built with, so a relay setting the user changed reached nothing they were watching until the app
// restarted.)
test('REGRESSION (FIX-RELAY-APPLY: a reconnect ends the live connections, not just the announce)', async (t) => {
  await bootSwarms(t, { relayMode: 'always', relay: { publicKey: KEY_A, enabled: true } })
  const dropped = []
  socketMsgHandlers.set(fakeControlSocket(dropped), {})
  socketMsgHandlers.set(fakeControlSocket(dropped), {})

  const res = await reconnectAll({ now: nextNow() })

  t.is(res.ok, true)
  t.is(res.control, 2, 'every control socket that opened a handshake channel is dropped')
  t.is(dropped.length, 2)
  socketMsgHandlers.clear()
})

// A socket mid-close must not abort the sweep: the connections after it would keep the setting the
// user just left.
test('a socket that throws on destroy does not strand the ones behind it', async (t) => {
  await bootSwarms(t)
  const dropped = []
  socketMsgHandlers.set({ destroy: () => { throw new Error('already closed') } }, {})
  socketMsgHandlers.set(fakeControlSocket(dropped), {})

  const res = await reconnectAll({ now: nextNow() })

  t.is(res.control, 2)
  t.is(dropped.length, 1, 'the survivor was still reached')
  socketMsgHandlers.clear()
})

// Without this the reconnect rebuilds the state the user asked us to leave: hyperswarm latches
// forceRelaying on a dial error and never clears it, so the peer goes straight back to the relay.
test('a reconnect clears the sticky forceRelaying latch on both swarms', async (t) => {
  await bootSwarms(t, { relayMode: 'always', relay: { publicKey: KEY_A, enabled: true } })
  const control = { forceRelaying: true }
  const content = { forceRelaying: true }
  // The control Hyperswarm is reached through the collaborator accessor, the way every module here
  // reads it; the next bootSwarms re-points it at the real one.
  initSpaceTopics({ getSwarm: () => ({ peers: new Map([['aa'.repeat(32), control]]) }) })
  getContentSwarm().peers.set('bb'.repeat(32), content)

  await reconnectAll({ now: nextNow() })

  t.is(control.forceRelaying, false, 'control plane')
  t.is(content.forceRelaying, false, 'content plane')
})

test('a reconnect keeps its throttle', async (t) => {
  await bootSwarms(t)
  const now = nextNow()
  t.is((await reconnectAll({ now })).ok, true)
  t.is((await reconnectAll({ now: now + 1000 })).throttled, true, 'a second press inside the window is refused')
  t.is((await reconnectAll({ now: now + 6000 })).ok, true)
})

test('a reconnect during teardown does not throw', async (t) => {
  const { swarm, content } = await bootSwarms(t)
  await content.close()
  await swarm.close()
  const res = await reconnectAll({ now: nextNow() })
  t.is(res.ok, true, 'no swarm left to drop is not a failure')
})
