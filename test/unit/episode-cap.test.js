import test from 'brittle'
import { createEpisodeCap } from '../../src/shared/audit/episode-cap.js'

const T0 = 1700000000000
const W = 1000

test('records up to the cap, then one first suppression, then silent suppression', (t) => {
  const cap = createEpisodeCap({ cap: 2, windowMs: W })
  t.is(cap.admit('a', T0), 'record')
  t.is(cap.admit('a', T0 + 1), 'record')
  t.is(cap.admit('a', T0 + 2), 'suppress-first')
  t.is(cap.admit('a', T0 + 3), 'suppress')
})

test('the window slides: an old stamp stops counting', (t) => {
  const cap = createEpisodeCap({ cap: 1, windowMs: W })
  t.is(cap.admit('a', T0), 'record')
  t.is(cap.admit('a', T0 + W - 1), 'suppress-first')
  t.is(cap.admit('a', T0 + W), 'record')
  t.is(cap.admit('a', T0 + W + 1), 'suppress-first', 'a fresh transition into the cap marks again')
})

test('keys are capped independently', (t) => {
  const cap = createEpisodeCap({ cap: 1, windowMs: W })
  t.is(cap.admit('a', T0), 'record')
  t.is(cap.admit('b', T0), 'record')
  t.is(cap.admit('a', T0 + 1), 'suppress-first')
})

test('forget drops every key whose window has passed', (t) => {
  const cap = createEpisodeCap({ cap: 1, windowMs: W })
  cap.admit('marked', T0)
  cap.admit('marked', T0 + 1)
  cap.forget(T0 + W + 10)
  t.is(cap.admit('marked', T0 + W + 11), 'record', 'a forgotten key starts fresh')
  t.is(cap.admit('marked', T0 + W + 12), 'suppress-first', 'and marks its next transition')
})

test('refund undoes the last admission, stamp or marker', (t) => {
  const cap = createEpisodeCap({ cap: 1, windowMs: W })
  t.is(cap.admit('a', T0), 'record')
  cap.refund('a')
  t.is(cap.admit('a', T0 + 1), 'record', 'the refunded stamp no longer counts')
  t.is(cap.admit('a', T0 + 2), 'suppress-first')
  cap.refund('a')
  t.is(cap.admit('a', T0 + 3), 'suppress-first', 'a refunded marker is offered again')
  cap.refund('unknown')
})

test('reset forgets every key', (t) => {
  const cap = createEpisodeCap({ cap: 1, windowMs: W })
  cap.admit('a', T0)
  cap.reset()
  t.is(cap.admit('a', T0 + 1), 'record')
})
