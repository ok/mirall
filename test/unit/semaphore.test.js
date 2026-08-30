import test from 'brittle'
import { createSemaphore } from '../../src/shared/core/concurrency.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

// REGRESSION (FIX-DL-ADMIT: runReconcile started every pending row at once — 200 rows meant 200
// chunk schedulers, watchdog timers, fds and progress tickers alive together.)
test('REGRESSION (FIX-DL-ADMIT): concurrency never exceeds the limit', async (t) => {
  const sem = createSemaphore({ limit: 3, expressLanes: 0 })
  let live = 0
  let peak = 0
  const releases = []

  const jobs = Array.from({ length: 20 }, async () => {
    const release = await sem.acquire()
    live += 1
    peak = Math.max(peak, live)
    releases.push(() => { live -= 1; release() })
  })

  // Drain in waves so every job gets its turn.
  for (let i = 0; i < 20; i++) {
    await tick()
    releases.shift()?.()
  }
  await Promise.all(jobs)
  t.is(peak, 3, 'never more than three at once')
})

test('the express lane may exceed the limit by exactly expressLanes', async (t) => {
  const sem = createSemaphore({ limit: 2, expressLanes: 1 })
  await sem.acquire()
  await sem.acquire()
  t.is(sem.stats().held, 2, 'both bulk slots taken')

  let expressAdmitted = false
  sem.acquire({ express: true }).then(() => { expressAdmitted = true })
  await tick()
  t.ok(expressAdmitted, 'the express job started anyway')

  let secondExpress = false
  sem.acquire({ express: true }).then(() => { secondExpress = true })
  await tick()
  t.absent(secondExpress, 'but only one express lane exists')
})

test('bulk waiters are admitted in acquire order', async (t) => {
  const sem = createSemaphore({ limit: 1, expressLanes: 0 })
  const first = await sem.acquire()
  const order = []
  const waits = [1, 2, 3].map((n) => sem.acquire().then((rel) => { order.push(n); return rel }))

  first()
  const r1 = await waits[0]
  r1()
  const r2 = await waits[1]
  r2()
  await waits[2]
  t.alike(order, [1, 2, 3], 'FIFO')
})

test('an express acquire jumps a queue of bulk waiters', async (t) => {
  const sem = createSemaphore({ limit: 1, expressLanes: 1 })
  const held = await sem.acquire()
  const order = []
  sem.acquire().then(() => order.push('bulk'))
  sem.acquire({ express: true }).then(() => order.push('express'))
  await tick()
  t.alike(order, ['express'], 'express started while the bulk slot was still held')
  held()
  await tick()
  t.alike(order, ['express', 'bulk'], 'bulk followed when the slot freed')
})

test('a limit of zero admits everything (the rollback path)', async (t) => {
  const sem = createSemaphore({ limit: 0 })
  for (let i = 0; i < 50; i++) await sem.acquire()
  t.is(sem.stats().queued, 0, 'nothing ever queued')
  t.is(sem.stats().held, 50)
})

test('the limit is re-read per acquire', async (t) => {
  let cap = 1
  const sem = createSemaphore({ limit: () => cap, expressLanes: 0 })
  await sem.acquire()
  let second = false
  sem.acquire().then(() => { second = true })
  await tick()
  t.absent(second, 'blocked at cap 1')
  cap = 5
  // The pump only runs on release, so a raised cap takes effect on the next admission event.
  const third = await sem.acquire()
  t.ok(third, 'the raised cap admits a fresh acquire immediately')
})

test('drain resolves every queued waiter and their releases are inert', async (t) => {
  const sem = createSemaphore({ limit: 1, expressLanes: 0 })
  await sem.acquire()
  const parked = [sem.acquire(), sem.acquire()]
  t.is(sem.stats().queued, 2)
  sem.drain()
  const releases = await Promise.all(parked)
  t.is(sem.stats().queued, 0, 'nothing left parked')
  for (const rel of releases) rel()
  t.is(sem.stats().held, 1, 'the drained releases did not decrement the real holder')
})

test('releasing twice does not double-decrement', async (t) => {
  const sem = createSemaphore({ limit: 2, expressLanes: 0 })
  const a = await sem.acquire()
  await sem.acquire()
  t.is(sem.stats().held, 2)
  a()
  a()
  a()
  t.is(sem.stats().held, 1, 'only the first release counted')
})
