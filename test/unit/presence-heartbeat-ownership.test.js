import test from 'brittle'
import {
  initPresenceBroadcast, startPresenceHeartbeat, stopPresenceHeartbeat, broadcastDeparture,
} from '../../src/shared/transfer/presence-broadcast.js'
import { createTimers } from '../../src/shared/core/timers.js'

// The heartbeat arms through the owning subsystem's timer set (Swarm hands it this.timers), so a
// test driving the module directly supplies one too — without an owner it declines to arm, which is
// the point: an interval nobody can stop is one nobody should start. The set still reaches the
// global setInterval underneath, so the shims below observe it exactly as before.
const ownedTimers = (t) => { const set = createTimers(); t.teardown(() => set.close()); return set }

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

  startPresenceHeartbeat(ownedTimers(t))
  t.is(started.length, 1, 'the heartbeat is armed by the module that holds the timer')

  broadcastDeparture()
  t.ok(cleared.includes(started[0]), 'and the departure clears that exact timer')

  // Not just the OS timer: the module's own handle has to be dropped too, or the next start is a
  // silent no-op and the peer never hears another heartbeat.
  startPresenceHeartbeat()
  t.is(started.length, 2, 'and a later start arms a fresh one')
})

// REGRESSION (REVIEW-5: the already-armed guard ran BEFORE the owner was adopted, so a handle left
// behind by a closed set could never be dropped. Subsystem.close() clears the set on every ending —
// including a failed _open and a _close that rejects, neither of which reaches destroySwarm's
// stopPresenceHeartbeat() — and the stale handle then latched the heartbeat off for good. A peer
// that never hears another beat reads us as offline for the rest of the session.)
test('REGRESSION (REVIEW-5): a heartbeat whose owner closed can be armed again', (t) => {
  const realSet = globalThis.setInterval
  const started = []
  globalThis.setInterval = (fn, ms) => { const h = realSet(fn, ms); started.push(h); return h }
  t.teardown(() => { globalThis.setInterval = realSet; stopPresenceHeartbeat() })

  initPresenceBroadcast({ presence: { prune () {} }, membersPoke: null, log: { debug () {} }, getSwarm: () => null, getIpc: () => null })

  const first = createTimers()
  startPresenceHeartbeat(first)
  t.is(started.length, 1, 'armed through the first owner')

  // What Subsystem.close()'s finally does on EVERY ending, without any of the module's own stops
  // having run — the one path a hand-written clear cannot reach.
  first.close()

  const second = ownedTimers(t)
  startPresenceHeartbeat(second)
  t.is(started.length, 2, 'the dead handle did not latch the heartbeat off')
})

test('starting the heartbeat twice arms one timer', (t) => {
  const realSet = globalThis.setInterval
  const started = []
  globalThis.setInterval = (fn, ms) => { const h = realSet(fn, ms); started.push(h); return h }
  t.teardown(() => { globalThis.setInterval = realSet; stopPresenceHeartbeat() })

  initPresenceBroadcast({ presence: { prune () {} }, membersPoke: null, log: { debug () {} }, getSwarm: () => null, getIpc: () => null })
  const set = ownedTimers(t)
  startPresenceHeartbeat(set)
  startPresenceHeartbeat(set)
  t.is(started.length, 1, 'a second start is a no-op, so a reconnect cannot double the beat rate')
})
