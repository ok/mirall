import test from 'brittle'
import { createRequestMetrics } from '../../src/shared/core/request-metrics.js'

function clock (start = 0) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('a settled request is counted with its duration', (t) => {
  const c = clock()
  const m = createRequestMetrics({ now: c.now })
  const settle = m.begin('thing:do')
  c.advance(40)
  t.is(settle(true), 40, 'the settle reports the elapsed time')

  const row = m.snapshot()['thing:do']
  t.is(row.calls, 1)
  t.is(row.failures, 0)
  t.is(row.avgMs, 40)
  t.is(row.maxMs, 40)
  t.is(row.inFlight, 0, 'settled requests are not in flight')
})

test('avgMs is the mean and maxMs the peak', (t) => {
  const c = clock()
  const m = createRequestMetrics({ now: c.now })
  for (const ms of [10, 30, 200]) {
    const settle = m.begin('thing:do')
    c.advance(ms)
    settle(true)
  }
  const row = m.snapshot()['thing:do']
  t.is(row.calls, 3)
  t.is(row.avgMs, 80, '(10+30+200)/3 rounded')
  t.is(row.maxMs, 200)
})

test('a failure still counts as a call', (t) => {
  const m = createRequestMetrics({ now: clock().now })
  m.begin('thing:do')(false)
  const row = m.snapshot()['thing:do']
  t.is(row.calls, 1, 'a failed request is still a request')
  t.is(row.failures, 1)
})

test('inFlight rises on begin and falls on settle', (t) => {
  const m = createRequestMetrics({ now: clock().now })
  const a = m.begin('thing:do')
  const b = m.begin('thing:do')
  t.is(m.snapshot()['thing:do'].inFlight, 2, 'two concurrent requests are visible')
  a(true)
  t.is(m.snapshot()['thing:do'].inFlight, 1)
  b(true)
  t.is(m.snapshot()['thing:do'].inFlight, 0, 'back to zero once both settle')
})

// REGRESSION (FIX-METRICS-DOUBLE-SETTLE: a handler that resolves AND throws would settle twice,
// corrupting every number in the row — and hiding the handler bug that caused it.)
test('REGRESSION (FIX-METRICS-DOUBLE-SETTLE): settling twice counts once', (t) => {
  const c = clock()
  const m = createRequestMetrics({ now: c.now })
  const settle = m.begin('thing:do')
  c.advance(15)
  t.is(settle(true), 15)
  c.advance(100)
  t.is(settle(false), 0, 'the second settle is a no-op and says so')

  const row = m.snapshot()['thing:do']
  t.is(row.calls, 1, 'counted once')
  t.is(row.failures, 0, 'the second settle did not turn a success into a failure')
  t.is(row.inFlight, 0, 'and did not drive inFlight negative')
  t.is(row.maxMs, 15, 'nor inflate the peak')
})

test('slow counts requests at or past the threshold', (t) => {
  const c = clock()
  const m = createRequestMetrics({ now: c.now, slowMs: 100 })
  const under = m.begin('a'); c.advance(99); under(true)
  const exact = m.begin('a'); c.advance(100); exact(true)
  const over = m.begin('a'); c.advance(500); over(true)
  t.is(m.snapshot().a.slow, 2, 'the boundary is inclusive')
})

test('rows are created lazily and reset clears them', (t) => {
  const m = createRequestMetrics({ now: clock().now })
  t.alike(m.snapshot(), {}, 'an untouched sink reports nothing')
  m.begin('a')(true)
  t.is(Object.keys(m.snapshot()).length, 1)
  m.reset()
  t.alike(m.snapshot(), {}, 'reset clears every row')
})

test('each request type gets its own row', (t) => {
  const c = clock()
  const m = createRequestMetrics({ now: c.now })
  const a = m.begin('a'); c.advance(10); a(true)
  const b = m.begin('b'); c.advance(50); b(false)
  const snap = m.snapshot()
  t.is(snap.a.avgMs, 10)
  t.is(snap.b.avgMs, 50)
  t.is(snap.b.failures, 1)
  t.is(snap.a.failures, 0, 'a failure in one type does not leak into another')
})
