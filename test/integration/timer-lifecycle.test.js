import test from 'brittle'
import { trackTimers } from '../helpers/timers.js'

// The shim must wrap the globals BEFORE the modules load, so everything under test comes in through
// a dynamic import (static ones are hoisted above it).
const timers = trackTimers()
const { freshPeer } = await import('../helpers/store.js')
const { initConvergenceTick, startConvergenceTick, resetConvergenceTick } = await import('../../src/shared/transfer/convergence-tick.js')
const { initPresenceBroadcast, startPresenceHeartbeat, stopPresenceHeartbeat } = await import('../../src/shared/transfer/presence-broadcast.js')
const { initConnectivity, scheduleStatusEmit, resetConnectivity } = await import('../../src/shared/transfer/connectivity.js')
const { initNetworkWatch, observeReachability, resetNetworkWatch } = await import('../../src/shared/audit/network-watch.js')

const silent = { debug () {}, info () {}, warn () {}, error () {} }
const noSwarm = () => null

// Eleven timer handles in the data layer live in module-scoped variables, armed inside a function
// with a bare setInterval/setTimeout. That is legal under eslint.config.mjs's
// moduleLevelTimerRestrictions, which forbids only a timer armed at IMPORT, and
// test/unit/module-scoped-timer-handles.test.js proves each has a matching clear in its own module.
// Neither can decide the property the lint MESSAGE used to imply — that a periodic call dies with
// the thing that armed it — because three of the owners are module singletons, not Subsystems, and
// deciding it statically needs interprocedural reachability. Measured directly instead: arm every
// handle these modules publish a way to arm, run the reset set destroySwarm() runs, and count what
// survives.
//
// Residual, stated so it is not later mistaken for more: this proves each module's reset disarms
// everything that module arms. That destroySwarm() is itself reached on the way out is covered at
// the root level by lifecycle-restart.test.js's LIFECYCLE-1a.
test('no timer armed by a module-scoped handle survives the swarm teardown', async (t) => {
  t.teardown(() => timers.restore())
  const ctx = await freshPeer(t)

  initConvergenceTick({ log: silent, sendSingleHandshake () {}, getStalledOwners: noSwarm, getSwarm: noSwarm, getIpc: noSwarm })
  initPresenceBroadcast({ presence: { prune () {}, clearAll () {} }, membersPoke () {}, log: silent, getSwarm: noSwarm, getIpc: noSwarm })
  initConnectivity({ log: silent, diag: silent, dhtVersion: '0', getDroppedFrameCounters: () => ({}), getSwarm: noSwarm, getIpc: noSwarm })
  initNetworkWatch({ emit: null, sessionId: 'timer-lifecycle', dwellMs: 60000, peerDwellMs: 60000 })

  startConvergenceTick()
  startPresenceHeartbeat()
  scheduleStatusEmit()
  observeReachability({ verdict: 'blocked', cause: 'dht-unreachable', confidence: 'measured', evidence: null })

  // A teardown assertion over an empty set proves nothing, so the arms are the first subject.
  await new Promise((resolve) => setTimeout(resolve, 50))
  const armedIntervals = timers.intervals().length
  const armedTimeouts = timers.timeouts().length
  t.ok(armedIntervals >= 2, `the periodic handles are armed (${armedIntervals} interval(s))`)
  t.ok(armedTimeouts >= 1, `the deferred handles are armed (${armedTimeouts} timeout(s))`)

  // Exactly what destroySwarm() calls, in its order, then the composition root itself — the
  // subsystems booted by boot() arm their own timers through src/shared/core/timers.js and those
  // are the root's to end.
  resetConnectivity()
  resetNetworkWatch()
  stopPresenceHeartbeat()
  resetConvergenceTick()
  await ctx.root.close()

  const intervals = timers.intervals()
  const timeouts = timers.timeouts()
  t.is(intervals.length, 0, 'no interval survives the teardown\n' + timers.describe(intervals))
  t.is(timeouts.length, 0, 'no timeout survives the teardown\n' + timers.describe(timeouts))
})
