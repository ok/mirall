import test from 'brittle'
import { createAttemptBudget, DEFAULT_ATTEMPT_LIMIT, DEFAULT_MAX_KEYS } from '../../src/shared/folders/fetch-attempts.js'

const M = 'space:share'

test('a claim is spent only after the limit is reached', (t) => {
  const b = createAttemptBudget({ limit: 3 })
  t.absent(b.exhausted(M, 'a.txt', 'h1'), 'never attempted')
  t.is(b.fail(M, 'a.txt', 'h1'), 1)
  t.absent(b.exhausted(M, 'a.txt', 'h1'), 'one bad holder is not a verdict')
  t.is(b.fail(M, 'a.txt', 'h1'), 2)
  t.absent(b.exhausted(M, 'a.txt', 'h1'))
  t.is(b.fail(M, 'a.txt', 'h1'), 3)
  t.ok(b.exhausted(M, 'a.txt', 'h1'), 'the budget is spent')
})

// The whole reason this is a budget and not a block: the overlay is multi-source, so the first
// holder serving corrupt bytes must not condemn content a second holder can serve.
test('a healthy holder still gets its turn after a bad one', (t) => {
  const b = createAttemptBudget({ limit: 3 })
  b.fail(M, 'a.txt', 'h1')
  t.absent(b.exhausted(M, 'a.txt', 'h1'), 'a retry is still allowed')
  b.succeed(M, 'a.txt', 'h1')
  b.fail(M, 'a.txt', 'h1')
  t.is(b.size(M), 1)
  t.absent(b.exhausted(M, 'a.txt', 'h1'), 'a landed file cleared the record')
})

test('a re-publish under a new hash is a fresh claim', (t) => {
  const b = createAttemptBudget({ limit: 1 })
  b.fail(M, 'a.txt', 'h1')
  t.ok(b.exhausted(M, 'a.txt', 'h1'))
  t.absent(b.exhausted(M, 'a.txt', 'h2'), 'different bytes, different claim')
})

test('mounts do not share budgets', (t) => {
  const b = createAttemptBudget({ limit: 1 })
  b.fail(M, 'a.txt', 'h1')
  t.absent(b.exhausted('other:share', 'a.txt', 'h1'))
  b.forget(M)
  t.absent(b.exhausted(M, 'a.txt', 'h1'), 'a remount forgives')
})

// The failure the reused audit memo had: at its cap it stopped RECORDING, so it silently stopped
// blocking and the unbounded loop came back. Eviction keeps the map bounded AND keeps blocking.
test('the map is bounded by eviction, and keeps blocking at the cap', (t) => {
  const b = createAttemptBudget({ limit: 1, maxKeys: 3 })
  for (const n of ['a', 'b', 'c']) b.fail(M, n, 'h')
  t.is(b.size(M), 3)
  b.fail(M, 'd', 'h')
  t.is(b.size(M), 3, 'still bounded')
  t.ok(b.exhausted(M, 'd', 'h'), 'the newest claim still blocks — the cap did not disable the rule')
  t.absent(b.exhausted(M, 'a', 'h'), 'the least recently failed was evicted and is retried')
})

test('a repeated failure refreshes recency, so a hot claim is not evicted first', (t) => {
  const b = createAttemptBudget({ limit: 5, maxKeys: 2 })
  b.fail(M, 'a', 'h')
  b.fail(M, 'b', 'h')
  b.fail(M, 'a', 'h')
  b.fail(M, 'c', 'h')
  t.is(b.size(M), 2)
  t.absent(b.exhausted(M, 'b', 'h'), 'b was the stalest and went')
  t.is(b.fail(M, 'a', 'h'), 3, 'a kept its count')
})

test('the defaults are the documented ones', (t) => {
  t.is(DEFAULT_ATTEMPT_LIMIT, 3)
  t.is(DEFAULT_MAX_KEYS, 512)
})
