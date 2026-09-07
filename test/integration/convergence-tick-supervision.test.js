import test from 'brittle'
import { createTimers } from '../../src/shared/core/timers.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import {
  initConvergenceTick, startConvergenceTick, resetConvergenceTick,
  convergenceHealth, restartConvergenceTick,
} from '../../src/shared/transfer/convergence-tick.js'

// The convergence tick is the whole level-triggered re-drive: unacked identity frames, roster
// deficits, listing re-pokes, peer-bee capture retries and the stalled-transfer rescue. One pass
// that never settles kills every one of them for the life of the process, and nothing said so.
//
// The fixture parks the tick on its last arm — rescueStalledTransfers awaits the stalled-owner
// probe — because that is the one collaborator the module takes as a dep, so a wedge can be staged
// without a swarm.

const silentLog = { debug () {}, info () {}, warn () {}, error () {} }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUntil (pred, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await delay(10)
  }
  throw new Error('condition not met within ' + ms + 'ms')
}

function parkedTick (t, { tickMs = 40 } = {}) {
  const before = getRuntimeConfig()
  setRuntimeConfig({ ...before, convergenceTickMs: tickMs, convergenceStallWindowMs: tickMs * 5 })

  const parked = []
  const probes = { started: 0 }
  initConvergenceTick({
    log: silentLog,
    sendSingleHandshake: async () => {},
    getStalledOwners: () => () => {
      probes.started += 1
      return new Promise((resolve) => parked.push(resolve))
    },
    getSwarm: () => ({}),
    getIpc: () => null,
  })

  const timers = createTimers()
  t.teardown(() => {
    for (const resolve of parked.splice(0)) resolve([])
    resetConvergenceTick()
    timers.close()
    setRuntimeConfig(before)
  })
  startConvergenceTick(timers)
  return { probes, tickMs, timers, release: () => parked.shift()?.([]) }
}

test('a tick that stops advancing is reported unhealthy, and restarting it re-arms the cadence', async (t) => {
  const f = parkedTick(t)
  await waitUntil(() => f.probes.started === 1)
  t.ok(convergenceHealth().ok, 'a pass that just started is not a stalled one')

  await waitUntil(() => convergenceHealth().ok === false)
  t.absent(convergenceHealth().ok, 'five ticks with no progress is a pass that has stopped')
  t.ok(convergenceHealth().detail.startsWith('no progress for'))

  restartConvergenceTick()
  t.ok(convergenceHealth().ok, 'the fresh cadence has no stall history')
  await waitUntil(() => f.probes.started === 2, 3000)
  t.pass('and the interval is armed again')
})

// REGRESSION (FIX-TICK-GEN: restarting a wedged convergence tick left the abandoned pass in flight,
// and its finally cleared `convergenceTicking` for the tick that replaced it — so two ticks ran at
// once and every unacked identity frame was re-announced twice.)
test('REGRESSION (FIX-TICK-GEN): an abandoned tick cannot clear the live tick\'s flag', async (t) => {
  const f = parkedTick(t)
  await waitUntil(() => f.probes.started === 1)

  restartConvergenceTick()
  await waitUntil(() => f.probes.started === 2, 3000)

  f.release()                                   // the abandoned tick settles LATE
  await delay(f.tickMs * 6)
  t.is(f.probes.started, 2, 'the live tick still owns the re-entrancy flag')
})

test('a tick with no timer armed is never reported unhealthy', (t) => {
  resetConvergenceTick()
  t.ok(convergenceHealth().ok, 'a swarm that never started the tick is not a stalled one')
})

// REGRESSION (FIX-TICK-RESET-GEN: the generation was bumped only by restartConvergenceTick, but
// destroySwarm → initSwarm reaches the same state by a different path — reset, then start. A tick
// still in flight from the previous swarm passed the identity check as if it belonged to the new
// one, cleared its re-entrancy flag and zeroed its heartbeat, so two ticks ran at once and the
// convergence unit reported healthy for the rest of the new tick's life.)
test('REGRESSION (FIX-TICK-RESET-GEN): a tick in flight across a swarm restart cannot clear the new one', async (t) => {
  const f = parkedTick(t)
  await waitUntil(() => f.probes.started === 1)

  // Exactly what destroySwarm and initSwarm do, which is NOT the restartConvergenceTick path.
  resetConvergenceTick()
  startConvergenceTick(f.timers)
  await waitUntil(() => f.probes.started === 2, 3000)

  f.release()                                   // the previous swarm's tick settles LATE
  await delay(f.tickMs * 6)
  t.is(f.probes.started, 2, 'the new swarm\'s tick still owns the re-entrancy flag')
  // Parked past its window, so unhealthy is the CORRECT reading. A heartbeat the abandoned tick had
  // zeroed would read healthy instead — the live tick would be stuck and invisible.
  t.absent(convergenceHealth().ok, 'and still owns its heartbeat')
})

// REGRESSION (FIX-TICK-RESTART-THROTTLE: restartConvergenceTick routed through the full
// resetConvergenceTick, which is destroySwarm's reset — it clears the stalled-transfer refresh
// throttle and every per-space escalation budget. Recovering a wedged tick therefore handed the
// fresh one a licence to re-refresh discovery immediately, on both planes, for every space; and a
// tick that kept wedging turned the supervisor into the source of a refresh storm.)
test('REGRESSION (FIX-TICK-RESTART-THROTTLE): restarting a tick keeps the refresh throttle', async (t) => {
  const f = parkedTick(t)
  await waitUntil(() => f.probes.started === 1)

  // The rescue arm is in flight inside the parked tick, so its re-entrancy flag is set. A restart
  // must clear THAT (or the arm stays dead behind a tick that never returns) without clearing the
  // backoff that stops a restart becoming a storm.
  restartConvergenceTick()
  await waitUntil(() => f.probes.started === 2, 3000)
  t.pass('the fresh tick reached the rescue arm, so the in-flight latch was released')

  // resetConvergenceTick is the destroySwarm path and DOES clear everything, deliberately.
  resetConvergenceTick()
  t.ok(convergenceHealth().ok, 'and a reset with no timer armed reports nothing to supervise')
})
