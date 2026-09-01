import test from 'brittle'
import {
  initPresenceBroadcast, startPresenceHeartbeat, stopPresenceHeartbeat, broadcastDeparture,
} from '../../src/shared/transfer/presence-broadcast.js'

// REGRESSION (SWARM-DECOMP-1: moving broadcastDeparture out of swarm.js left the heartbeat
// interval behind. presence-broadcast declared its own presenceTimer, which nothing ever assigned,
// so the departure's first line — clear the heartbeat before announcing offline — cleared null. A
// beat landing in the shutdown teardown window then re-marked us online on the receiver and undid
// the departure, which is the whole reason that line exists. Nothing went red: the flow test still
// passed on the socket close, and no-undef cannot see two modules each holding their own null.)
test('REGRESSION (SWARM-DECOMP-1): the departure stops the heartbeat it races', (t) => {
  const realSet = globalThis.setInterval
  const realClear = globalThis.clearInterval
  const started = []
  const cleared = []
  globalThis.setInterval = (fn, ms) => { const h = realSet(fn, ms); started.push(h); return h }
  globalThis.clearInterval = (h) => { cleared.push(h); return realClear(h) }
  t.teardown(() => {
    globalThis.setInterval = realSet
    globalThis.clearInterval = realClear
    stopPresenceHeartbeat()
  })

  initPresenceBroadcast({
    presence: { prune () {} },
    membersPoke: null,
    log: { debug () {} },
    getSwarm: () => null,     // departure returns right after the clear — no frames needed here
    getIpc: () => null,
  })

  startPresenceHeartbeat()
  t.is(started.length, 1, 'the heartbeat is armed by the module that holds the timer')

  broadcastDeparture()
  t.ok(cleared.includes(started[0]), 'and the departure clears that exact timer')

  // Not just the OS timer: the module's own handle has to be dropped too, or the next start is a
  // silent no-op and the peer never hears another heartbeat.
  startPresenceHeartbeat()
  t.is(started.length, 2, 'and a later start arms a fresh one')
})

test('starting the heartbeat twice arms one timer', (t) => {
  const realSet = globalThis.setInterval
  const started = []
  globalThis.setInterval = (fn, ms) => { const h = realSet(fn, ms); started.push(h); return h }
  t.teardown(() => { globalThis.setInterval = realSet; stopPresenceHeartbeat() })

  initPresenceBroadcast({ presence: { prune () {} }, membersPoke: null, log: { debug () {} }, getSwarm: () => null, getIpc: () => null })
  startPresenceHeartbeat()
  startPresenceHeartbeat()
  t.is(started.length, 1, 'a second start is a no-op, so a reconnect cannot double the beat rate')
})
