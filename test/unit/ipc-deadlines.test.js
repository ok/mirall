import test from 'brittle'
import { EventEmitter } from 'events'
import { createIPC, getRequestFailureCounters, resetRequestFailureCounters } from '../../src/shared/core/ipc.js'
import { deadlineFor, enforcementFor, DEFAULT_DEADLINE_MS } from '../../src/shared/contract/request-deadlines.js'
import { REQUESTS } from '../../src/shared/contract/requests.js'
import { sayHello } from '../helpers/ipc-hello.js'

const TEST_REQUESTS = Object.freeze({
  'slowQuery': { kind: 'query', deadlineMs: 100, args: {} },
  'slowCommand': { kind: 'command', deadlineMs: 100, args: {} },
  'unbounded': { kind: 'query', deadlineMs: 0, args: {} },
  'plainQuery': { kind: 'query', args: {} },
})

function fakePipe() {
  const ee = new EventEmitter()
  ee.written = []
  ee.write = (s) => { ee.written.push(s); return true }
  ee.feed = (obj) => ee.emit('data', Buffer.from(JSON.stringify(obj) + '\n'))
  ee.frames = () => ee.written.map((l) => JSON.parse(l))
  return ee
}

// The clock is injected rather than slept through: a deadline test that waits out a real timeout is
// a slow test that also fails on a loaded machine.
function router(handlers = {}) {
  const clock = { t: 0 }
  const pipe = fakePipe()
  const ipc = createIPC(pipe, { requests: TEST_REQUESTS, now: () => clock.t })
  sayHello(pipe)
  for (const [name, fn] of Object.entries(handlers)) ipc.handle(name, fn)
  ipc.start()
  return { ipc, pipe, clock }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a bound comes from the row, then the kind, and 0 means unbounded', (t) => {
  t.is(deadlineFor({ kind: 'query', args: {} }), DEFAULT_DEADLINE_MS.query)
  t.is(deadlineFor({ kind: 'command', args: {} }), DEFAULT_DEADLINE_MS.command)
  t.is(deadlineFor({ kind: 'query', args: {}, deadlineMs: 0 }), 0, 'an explicit 0 beats the default')
  t.is(deadlineFor({ kind: 'query', args: {}, deadlineMs: 1500 }), 1500)
  t.is(deadlineFor(null), 0)
})

test('enforcement follows the contract’s own retry-safety axis', (t) => {
  t.is(enforcementFor({ kind: 'query', args: {} }), 'abort', 'a query is retry-safe')
  t.is(enforcementFor({ kind: 'command', args: {} }), 'warn', 'a command may have written already')
})

test('the rows that opt out of a bound say so explicitly', (t) => {
  for (const name of ['space:leave', 'files:add', 'owned-folder:preview', 'foreign-folder:preview', 'audit:export']) {
    t.is(REQUESTS[name].deadlineMs, 0, `${name} is deliberately unbounded`)
  }
  t.is(REQUESTS['share:list-files'].deadlineMs, 60000,
    'the one query that walks a real tree is widened rather than left at the default')
})

test('a query past its deadline is aborted', async (t) => {
  let signal = null
  const { ipc, pipe, clock } = router({
    slowQuery: (msg, ctx) => new Promise((resolve) => {
      signal = ctx.signal
      ctx.signal.onAbort((reason) => resolve({ stopped: reason.code }))
    }),
  })
  pipe.feed({ id: 1, type: 'slowQuery' })
  await tick()

  clock.t = 50
  ipc.sweepDeadlines()
  t.absent(signal.aborted, 'not yet')

  clock.t = 150
  ipc.sweepDeadlines()
  await tick()
  t.ok(signal.aborted)
  t.alike(pipe.frames().at(-1), { id: 1, type: 'response', data: { stopped: 'TIMEOUT' } })
})

test('a command past its deadline is reported, never aborted', async (t) => {
  let signal = null
  const { ipc, pipe, clock } = router({ slowCommand: (msg, ctx) => { signal = ctx.signal; return new Promise(() => {}) } })
  pipe.feed({ id: 1, type: 'slowCommand' })
  await tick()
  clock.t = 500
  const oldest = ipc.sweepDeadlines()
  t.absent(signal.aborted, 'a half-written command is not something to abort behind the caller')
  t.is(oldest.type, 'slowCommand', 'but it is reported')
})

test('an unbounded request is never swept', async (t) => {
  let signal = null
  const { ipc, pipe, clock } = router({ unbounded: (msg, ctx) => { signal = ctx.signal; return new Promise(() => {}) } })
  pipe.feed({ id: 1, type: 'unbounded' })
  await tick()
  clock.t = 10 ** 9
  ipc.sweepDeadlines()
  t.absent(signal.aborted)
})

test('the deadline fires at most once per request', async (t) => {
  const aborts = []
  const { ipc, pipe, clock } = router({
    slowCommand: (msg, ctx) => { ctx.signal.onAbort(() => aborts.push(1)); return new Promise(() => {}) },
  })
  pipe.feed({ id: 1, type: 'slowCommand' })
  await tick()
  clock.t = 500
  const first = ipc.sweepDeadlines()
  const second = ipc.sweepDeadlines()
  t.is(first.id, 1)
  t.is(second.id, 1, 'still the oldest, still reported')
  t.alike(aborts, [], 'and a command is still not aborted on either pass')
})

test('the oldest in-flight request is reportable while it is still running', async (t) => {
  const { ipc, pipe, clock } = router({ plainQuery: () => new Promise(() => {}) })
  pipe.feed({ id: 1, type: 'plainQuery' })
  await tick()
  clock.t = 5000
  t.alike(ipc.sweepDeadlines(), { type: 'plainQuery', id: 1, clientId: 1, ageMs: 5000 },
    'the age requestMetrics cannot give: it only records one on settle')
})

test('ages are sorted oldest first and span every client', async (t) => {
  const clock = { t: 0 }
  const a = fakePipe()
  const b = fakePipe()
  const ipc = createIPC(a, { requests: TEST_REQUESTS, now: () => clock.t })
  sayHello(a)
  ipc.handle('plainQuery', () => new Promise(() => {}))
  ipc.attach(b)
  sayHello(b)
  ipc.start()

  a.feed({ id: 1, type: 'plainQuery' })
  clock.t = 100
  b.feed({ id: 1, type: 'plainQuery' })
  await tick()

  clock.t = 300
  t.alike(ipc.inFlightAges(), [
    { type: 'plainQuery', id: 1, clientId: 1, ageMs: 300 },
    { type: 'plainQuery', id: 1, clientId: 2, ageMs: 200 },
  ])
})

test('a settled request leaves no age behind', async (t) => {
  const { ipc, pipe } = router({ plainQuery: async () => ({ ok: true }) })
  pipe.feed({ id: 1, type: 'plainQuery' })
  await tick()
  t.alike(ipc.inFlightAges(), [])
  t.is(ipc.sweepDeadlines(), null)
})

test('a deadline abort settles through the router’s ordinary failure path', async (t) => {
  resetRequestFailureCounters()
  const { ipc, pipe, clock } = router({
    slowQuery: async (msg, ctx) => {
      await new Promise((resolve) => ctx.signal.onAbort(resolve))
      throw Object.assign(new Error('gave up'), { code: 'TIMEOUT' })
    },
  })
  pipe.feed({ id: 1, type: 'slowQuery' })
  await tick()
  clock.t = 500
  ipc.sweepDeadlines()
  await tick()
  await tick()
  t.is(getRequestFailureCounters()['slowQuery:TIMEOUT'], 1, 'counted, not escaped')
  t.is(ipc.inFlightCount(), 0, 'and the entry is gone')
})

// REGRESSION (FIX-397-1: `warned` was set BEFORE the abort, so a log write that threw — a stdout
// going away during shutdown — retired the request from the sweep with the enforcement never
// applied, permanently. And with no per-flight isolation, that one throw skipped every request
// behind it and every other client in the same pass.)
test('REGRESSION (FIX-397-1): a throwing log neither retires the request nor skips the rest', async (t) => {
  const clock = { t: 0 }
  const a = fakePipe()
  const b = fakePipe()
  const signals = []
  const ipc = createIPC(a, { requests: TEST_REQUESTS, now: () => clock.t })
  sayHello(a)
  ipc.handle('slowQuery', (msg, ctx) => { signals.push(ctx.signal); return new Promise(() => {}) })
  ipc.attach(b)
  sayHello(b)
  ipc.start()
  a.feed({ id: 1, type: 'slowQuery' })
  b.feed({ id: 1, type: 'slowQuery' })
  await tick()

  const realWarn = console.warn
  let throws = 1
  console.warn = () => { if (throws-- > 0) throw new Error('stdout is gone') }
  t.teardown(() => { console.warn = realWarn })

  clock.t = 500
  t.execution(() => ipc.sweepDeadlines(), 'the pass survives')
  t.is(signals.filter((s) => s.aborted).length, 2,
    'both were aborted — the abort runs before the log, and the second client was still reached')
})
