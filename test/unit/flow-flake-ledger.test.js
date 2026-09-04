import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { evaluateLedger, describeLedger } from '../../scripts/flake-ledger.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const budgetPath = path.join(here, '..', 'flow-flake-budget.json')
const shard = (n, files) => ({ shard: n, files })

// A pass-on-retry used to leave a `::warning` and nothing else. An annotation is not a measurement:
// nothing aggregates it, so "is this suite getting flakier" had no answer, and the failed attempt's
// output — which the warning text itself told you to read — was never saved anywhere. These are the
// ledger's rules, exercised on fixtures so the gate is proven without spending a CI run on it.
test('the flake ledger fails a run that exceeds its budget', (t) => {
  const budget = { maxTotal: 1, perFile: {} }

  t.ok(evaluateLedger([shard(1, [])], budget).ok, 'a clean run passes')
  t.is(evaluateLedger([shard(1, [])], budget).total, 0, 'and counts nothing')

  const one = evaluateLedger([shard(3, [{ file: 'test/flow/a.test.js', attempts: 2, passedOnRetry: true }])], budget)
  t.ok(one.ok, 'a single flake is within the budget')
  t.is(one.total, 1, 'and is counted')
  t.alike(one.unbudgeted, ['test/flow/a.test.js'], 'and is named, so it can become a table entry')

  const two = evaluateLedger([
    shard(3, [{ file: 'test/flow/a.test.js', attempts: 2, passedOnRetry: true }]),
    shard(5, [{ file: 'test/flow/b.test.js', attempts: 2, passedOnRetry: true }]),
  ], budget)
  t.absent(two.ok, 'two flakes in one run exceed a budget of one')
  t.ok(two.overTotal, 'and the aggregate is what failed')
  t.ok(describeLedger(two).includes('FAIL: 2 pass-on-retry exceeds'), 'the summary says which rule failed')

  // A hard failure is the shard job's business, never the ledger's: the two must not be
  // confusable, or a broken change reads as a flaky suite.
  const hard = evaluateLedger([shard(2, [{ file: 'test/flow/c.test.js', attempts: 2, passedOnRetry: false }])], budget)
  t.ok(hard.ok, 'a file that failed BOTH attempts is not a flake')
  t.is(hard.total, 0, 'and is not counted as one')

  const named = { maxTotal: 3, perFile: { 'test/flow/a.test.js': { max: 1, why: 'known hyperdht bind race under a 2-vCPU runner' } } }
  t.ok(evaluateLedger([shard(1, [{ file: 'test/flow/a.test.js', attempts: 2, passedOnRetry: true }])], named).ok,
    'a named offender may flake up to its own cap')
  const repeat = evaluateLedger([
    shard(1, [{ file: 'test/flow/a.test.js', attempts: 2, passedOnRetry: true }]),
    shard(2, [{ file: 'test/flow/a.test.js', attempts: 2, passedOnRetry: true }]),
  ], named)
  t.absent(repeat.ok, 'a repeat offender cannot hide inside the aggregate')
  t.alike(repeat.over, ['test/flow/a.test.js flaked 2x, budget 1'], 'and the ledger names it')
})

// The committed budget is the ratchet. A number nobody can read the reason for is a snapshot.
test('the committed flake budget is well formed', (t) => {
  const budget = JSON.parse(readFileSync(budgetPath, 'utf8'))
  t.is(typeof budget.maxTotal, 'number', 'the aggregate ceiling is a number')
  t.ok(budget.maxTotal >= 0, 'and not negative')
  t.ok(budget._comment.length > 100, 'the file explains what the numbers mean and which way they move')
  for (const [file, entry] of Object.entries(budget.perFile)) {
    t.is(typeof entry.max, 'number', `${file} caps its flakes`)
    t.ok(typeof entry.why === 'string' && entry.why.length > 20, `${file} says why it is listed`)
  }
})
