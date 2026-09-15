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
