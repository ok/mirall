import test from 'brittle'
import { createRateGuard } from '../../src/shared/audit/audit-rate-guard.js'

function guard({ max = 3, windowMs = 1000 } = {}) {
  let clock = 0
  const suppressed = []
  const g = createRateGuard({ windowMs, max, now: () => clock, onSuppressed: (kind, count) => suppressed.push([kind, count]) })
  return { g, suppressed, tick: (ms) => { clock += ms } }
}

test('admits up to max per kind per window, then refuses', (t) => {
  const { g } = guard()
  t.alike([g.admit('a'), g.admit('a'), g.admit('a'), g.admit('a')], [true, true, true, false])
  t.ok(g.admit('b'), 'kinds have separate buckets')
})

test('the suppressed count is reported once when the next window opens', (t) => {
  const { g, suppressed, tick } = guard()
  for (let i = 0; i < 5; i++) g.admit('a')
  t.alike(suppressed, [], 'nothing reported inside the window')
  tick(1000)
  t.ok(g.admit('a'), 'the new window admits again')
  t.alike(suppressed, [['a', 2]])
  tick(1000)
  g.admit('a')
  t.alike(suppressed, [['a', 2]], 'a window without overflow reports nothing')
})

test('reset forgets every bucket', (t) => {
  const { g, suppressed } = guard()
  for (let i = 0; i < 5; i++) g.admit('a')
  g.reset()
  t.ok(g.admit('a'))
  t.alike(suppressed, [], 'a reset drops the pending count with the bucket')
})

test('flush reports every pending count and forgets it', (t) => {
  const reported = []
  const guard = createRateGuard({ windowMs: 1000, max: 1, now: () => 0, onSuppressed: (kind, count) => reported.push([kind, count]) })
  guard.admit('a')
  guard.admit('a')
  guard.admit('a')
  guard.admit('b')
  guard.flush()
  t.alike(reported, [['a', 2]], 'a burst that stops still reports its count; a key with none says nothing')
  t.ok(guard.admit('a'), 'and the bucket starts fresh')
})
