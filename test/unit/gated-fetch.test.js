import test from 'brittle'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { acquireFetchSlot, drainFetchSlots, fetchSlotStats, resetFetchSlots } from '../../src/shared/transfer/overlay/fetch-gate.js'
import { runGatedFetch } from '../../src/shared/transfer/overlay/fetch-run.js'

// runGatedFetch against the real process-wide gate: the download engine and the mirror both hold
// their fetch slot through it, so what it guarantees here is what each of them relies on.

function withCap(t, cap) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, downloadConcurrency: cap })
  t.teardown(() => { setRuntimeConfig(prev); resetFetchSlots() })
  resetFetchSlots()
}

// Lets every resolved acquire run its continuation, without waiting on a task that a broken
// bracket would leave parked for good.
const settle = () => new Promise((resolve) => setImmediate(resolve))

// A task that records which of its hooks ran. `stop` is read by the re-check at the time it runs.
function recorder(extra = {}) {
  const seen = { rechecks: 0, abandoned: null, fetched: 0, heldInside: null, stop: null }
  const task = {
    recheck: () => { seen.rechecks += 1; return seen.stop },
    abandon: (reason) => { seen.abandoned = reason; return 'abandoned' },
    holding: async () => { seen.fetched += 1; seen.heldInside = fetchSlotStats().held; return 'fetched' },
    ...extra,
  }
  return { seen, task }
}

test('the re-check runs after the wait, so a change while parked abandons the fetch', async (t) => {
  withCap(t, 1)
  const hog = await acquireFetchSlot({})
  const { seen, task } = recorder()
  const run = runGatedFetch(task)
  t.is(fetchSlotStats().queued, 1, 'the task is parked behind the held slot')

  seen.stop = 'stopped'
  hog()
  t.is(await run, 'abandoned', 'the task resolves to what abandon returned')
  t.is(seen.abandoned, 'stopped', 'abandon got the reason the re-check found')
  t.is(seen.fetched, 0, 'and the fetch never ran')
  t.is(fetchSlotStats().held, 0, 'the slot was released')
})

test('the fetch runs holding the slot, and its value is the task\'s', async (t) => {
  withCap(t, 1)
  const { seen, task } = recorder()
  t.is(await runGatedFetch(task), 'fetched')
  t.is(seen.rechecks, 1, 'the re-check ran once')
  t.is(seen.heldInside, 1, 'the slot was held while the fetch ran')
  t.is(fetchSlotStats().held, 0, 'and released after it')
})

test('a throw from any hook reaches the caller unchanged and releases the slot', async (t) => {
  withCap(t, 4)
  const thrower = (boom) => () => { throw boom }
  const legs = {
    recheck: (boom) => ({ recheck: thrower(boom) }),
    abandon: (boom) => ({ recheck: () => 'stopped', abandon: thrower(boom) }),
    holding: (boom) => ({ holding: async () => { throw boom } }),
    // After its acquire resolved: the slot the wait was handed is the bracket's to free.
    wait: (boom) => ({ wait: async (acquire) => { await acquire(); throw boom } }),
  }
  for (const [hook, leg] of Object.entries(legs)) {
    const boom = new Error(`${hook} failed`)
    const { task } = recorder(leg(boom))
    let caught = null
    try { await runGatedFetch(task) } catch (err) { caught = err }
    t.is(caught, boom, `a throw from ${hook} is the caller's rejection`)
    t.is(fetchSlotStats().held, 0, `and the slot is released after ${hook} throws`)
  }
})

test('express passes through: a click runs past a held slot', async (t) => {
  withCap(t, 1)
  const hog = await acquireFetchSlot({})
  const { seen, task } = recorder({ express: true })
  const run = runGatedFetch(task)
  t.is(fetchSlotStats().queued, 0, 'the express task did not queue')
  await settle()
  t.is(seen.heldInside, 2, 'it ran beside the held slot')
  hog()
  await run
})

test('owner passes through: a scoped drain resumes only that owner\'s waiter', async (t) => {
  withCap(t, 1)
  const hog = await acquireFetchSlot({})
  const a = recorder({ owner: 'a' })
  const b = recorder({ owner: 'b' })
  a.seen.stop = 'stopped'
  const runs = [runGatedFetch(a.task), runGatedFetch(b.task)]
  t.is(fetchSlotStats().queued, 2, 'both tasks are parked')

  drainFetchSlots('a')
  await settle()
  t.is(a.seen.rechecks, 1, 'the drained owner resumed into its re-check')
  t.is(a.seen.abandoned, 'stopped', 'and abandoned')
  t.is(b.seen.rechecks, 0, 'the other owner did not resume')
  t.is(fetchSlotStats().queued, 1, 'and is still queued')

  hog()
  await Promise.all(runs)
  t.is(b.seen.fetched, 1, 'it runs once a slot frees')
})

test('wait wraps exactly the acquire, before the re-check', async (t) => {
  withCap(t, 1)
  const order = []
  let waits = 0
  let releasedThroughWait = false
  const { task } = recorder({
    wait: async (acquire) => {
      waits += 1
      order.push('wait')
      const release = await acquire()
      return () => { releasedThroughWait = true; release() }
    },
    recheck: () => { order.push('recheck'); return null },
    holding: async () => { order.push('holding') },
  })
  await runGatedFetch(task)
  t.is(waits, 1, 'wait was called once')
  t.alike(order, ['wait', 'recheck', 'holding'], 'around the acquire, ahead of the re-check')
  t.ok(releasedThroughWait, 'the release wait returned is the one the bracket calls')
  t.is(fetchSlotStats().held, 0, 'and it freed the slot')
})

test('a drained waiter still reaches its re-check', async (t) => {
  withCap(t, 1)
  await acquireFetchSlot({})
  const { seen, task } = recorder()
  const run = runGatedFetch(task)
  t.is(fetchSlotStats().queued, 1, 'the task is parked')

  // A closing subsystem drains the gate and sets its stop condition in the same turn.
  drainFetchSlots()
  seen.stop = 'stopped'
  t.is(await run, 'abandoned', 'the drained task abandons')
  t.is(seen.fetched, 0, 'and never fetches')
  t.is(fetchSlotStats().queued, 0, 'nothing stays queued')
})
