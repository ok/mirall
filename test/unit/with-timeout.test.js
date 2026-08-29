import test from 'brittle'
import { remainingMs, withReadTimeout } from '../../src/shared/core/with-timeout.js'

// REGRESSION (FIX-LIST-DEADLINE: two reads in sequence each charged the caller's full budget.
// The remaining budget is derived from one deadline and can never go negative, so a second
// read after an exhausted first one gets 0 — a fast fallback, never a negative or full timer.)
test('remainingMs derives the leftover budget from one deadline and clamps at zero', (t) => {
  t.is(remainingMs(1000, 400), 600, 'what is left after the first read')
  t.is(remainingMs(1000, 1000), 0, 'exactly spent')
  t.is(remainingMs(1000, 1500), 0, 'overspent clamps to zero, never negative')
})

test('remainingMs defaults `now` to the wall clock', (t) => {
  t.is(remainingMs(Date.now() - 5), 0, 'a deadline already past leaves nothing')
  t.ok(remainingMs(Date.now() + 5000) > 4000, 'a future deadline leaves roughly its distance')
})

test('withReadTimeout still resolves to the fallback on timeout and passes values through', async (t) => {
  const slow = new Promise(() => {})
  t.is(await withReadTimeout(slow, 20, 'FALLBACK'), 'FALLBACK', 'a read that never settles yields the fallback')
  t.is(await withReadTimeout(Promise.resolve('value'), 1000, 'FALLBACK'), 'value', 'a fast read passes through')
})
