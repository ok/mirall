import test from 'brittle'
import { createPassLiveness } from '../../src/shared/core/pass-liveness.js'

// A controllable clock: the rule is about elapsed progress, so a real one makes the test a race.
function clockAt (t0) {
  let n = t0
  return { now: () => n, advance: (ms) => { n += ms } }
}

test('an unknown key is healthy — nothing is in flight', (t) => {
  const l = createPassLiveness()
  t.is(l.verdict('missing', { now: 1e9, windowMs: 1000 }).ok, true)
  t.is(l.peek('missing'), null)
})

test('a pass in flight and advancing stays healthy past the window', (t) => {
  const c = clockAt(1000)
  const l = createPassLiveness({ now: c.now })
  l.started('k')
  for (let i = 0; i < 10; i++) { c.advance(900); l.progress('k') }
  t.is(l.verdict('k', { now: c.now(), windowMs: 1000 }).ok, true, 'ten windows of elapsed time, none of them stalled')
})

test('a pass in flight and NOT advancing is stalled once the window passes', (t) => {
  const c = clockAt(1000)
  const l = createPassLiveness({ now: c.now })
  l.started('k')
  c.advance(1000)
  t.is(l.verdict('k', { now: c.now(), windowMs: 1000 }).ok, true, 'exactly at the bound is not yet stalled')
  c.advance(1)
  const v = l.verdict('k', { now: c.now(), windowMs: 1000 })
  t.is(v.ok, false)
  t.ok(/no progress for/.test(v.detail), 'and it says how long')
})

// The bug this shape exists to prevent: an abandoned pass's late callback re-arming a heartbeat.
test('progress on an ended pass is a no-op', (t) => {
  const c = clockAt(1000)
  const l = createPassLiveness({ now: c.now })
  l.started('k')
  l.ended('k')
  c.advance(5000)
  l.progress('k')
  t.is(l.peek('k').progressAt, 0, 'a late heartbeat did not resurrect the pass')
  t.is(l.verdict('k', { now: c.now(), windowMs: 10 }).ok, true, 'and an ended pass is never stalled')
})

test('progress on an unknown key does not create one', (t) => {
  const l = createPassLiveness()
  l.progress('never-started')
  t.is(l.peek('never-started'), null)
})

test('ended stamps a completion; started re-stamps rather than stacking', (t) => {
  const c = clockAt(1000)
  const l = createPassLiveness({ now: c.now })
  l.started('k')
  c.advance(50)
  l.ended('k')
  t.is(l.peek('k').completedAt, 1050)
  c.advance(10)
  l.started('k')
  t.is(l.peek('k').startedAt, 1060)
  t.is(l.peek('k').progressAt, 1060, 'a fresh pass starts its heartbeat at its start')
})

test('ended on an unknown key is a no-op', (t) => {
  const l = createPassLiveness()
  l.ended('nope')
  t.is(l.peek('nope'), null)
})

// The clock never starts at 0: stallVerdict treats a falsy startedAt as "no pass in flight", so a
// zero epoch would read every started key as idle.
test('keys are independent, and forget/clear drop them', (t) => {
  const c = clockAt(1000)
  const l = createPassLiveness({ now: c.now })
  l.started('a')
  l.started('b')
  c.advance(100)
  l.progress('a')
  t.is(l.verdict('a', { now: c.now(), windowMs: 50 }).ok, true)
  t.is(l.verdict('b', { now: c.now(), windowMs: 50 }).ok, false, 'b stalled while a advanced')
  l.forget('b')
  t.is(l.peek('b'), null)
  t.is(l.verdict('b', { now: c.now(), windowMs: 50 }).ok, true, 'a forgotten key reads healthy again')
  l.clear()
  t.is(l.peek('a'), null)
})

test('peek returns a copy', (t) => {
  const l = createPassLiveness()
  l.started('k')
  l.peek('k').progressAt = 0
  t.ok(l.peek('k').progressAt > 0, 'mutating the copy did not reach the heartbeat')
})

test('stalled() reports only the keys whose pass is in flight and not advancing', (t) => {
  const c = clockAt(1000)
  const l = createPassLiveness({ now: c.now })
  l.started('advancing')
  l.started('wedged')
  l.started('finished')
  l.ended('finished')

  c.advance(5000)
  l.progress('advancing')

  const rows = l.stalled({ now: c.now(), windowMs: 1000 })
  t.alike(rows.map((r) => r.key), ['wedged'], 'the settled and the advancing passes are not reported')
  t.is(rows[0].ok, false)
  t.ok(/no progress for/.test(rows[0].detail))
})

test('stalled() is empty when nothing is in flight', (t) => {
  const l = createPassLiveness()
  t.alike(l.stalled({ windowMs: 1 }), [])
  l.started('k')
  l.ended('k')
  t.alike(l.stalled({ windowMs: 1 }), [], 'a completed pass is not a wedge')
})
