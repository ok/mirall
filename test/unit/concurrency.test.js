import test from 'brittle'
import { mapLimit, someWithin } from '../../src/shared/core/concurrency.js'

test('mapLimit preserves input order and caps concurrency', async (t) => {
  let inFlight = 0
  let peak = 0
  const out = await mapLimit([10, 20, 30, 40, 50], 2, async (x) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, 5))
    inFlight -= 1
    return x * 2
  })
  t.alike(out, [20, 40, 60, 80, 100], 'results returned in input order')
  t.ok(peak <= 2, 'never more than `limit` tasks in flight')
})

test('mapLimit on an empty list resolves to an empty array', async (t) => {
  const out = await mapLimit([], 4, async () => t.fail('should not run'))
  t.alike(out, [], 'no work, empty result')
})

test('mapLimit passes the index to fn', async (t) => {
  const out = await mapLimit(['a', 'b', 'c'], 8, async (x, i) => `${x}${i}`)
  t.alike(out, ['a0', 'b1', 'c2'])
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A check that records concurrency and the budget it was handed. A match answers after 5 ms, a
// miss after `ms`.
function probe({ verdict = () => false, ms = 20 } = {}) {
  const rec = { started: [], budgets: [], inFlight: 0, peak: 0 }
  rec.check = async (item, budgetMs) => {
    rec.started.push(item)
    rec.budgets.push(budgetMs)
    rec.inFlight++
    rec.peak = Math.max(rec.peak, rec.inFlight)
    const matched = verdict(item)
    await sleep(matched ? 5 : ms)
    rec.inFlight--
    return matched
  }
  return rec
}

test('someWithin runs at most `limit` checks at once and asks every item on no match', async (t) => {
  const p = probe()
  const items = Array.from({ length: 20 }, (_, i) => i)
  t.absent(await someWithin(items, { limit: 8, deadlineAt: Date.now() + 5000, check: p.check }))
  t.is(p.started.length, 20, 'every item checked')
  t.is(p.peak, 8, 'never more than the limit in flight')
})

test('someWithin resolves on the first match and starts nothing after it', async (t) => {
  const p = probe({ verdict: (i) => i === 1, ms: 50 })
  const items = Array.from({ length: 20 }, (_, i) => i)
  t.ok(await someWithin(items, { limit: 8, deadlineAt: Date.now() + 5000, check: p.check }))
  await sleep(120)
  t.is(p.started.length, 8, 'only the first window ever started')
})

test('someWithin hands each check only the budget left when it starts', async (t) => {
  const p = probe({ ms: 100 })
  const deadlineAt = Date.now() + 1000
  await someWithin([0, 1, 2, 3], { limit: 2, deadlineAt, check: p.check })
  t.ok(p.budgets[0] > 900 && p.budgets[1] > 900, 'the first window gets nearly the whole budget (' + p.budgets.slice(0, 2) + ')')
  t.ok(p.budgets[2] <= 920 && p.budgets[3] <= 920, 'a queued check gets what remains, not the full budget (' + p.budgets.slice(2) + ')')
})

test('someWithin resolves false at the deadline even if a check never settles', async (t) => {
  const t0 = Date.now()
  const verdict = await someWithin([0, 1], { limit: 2, deadlineAt: Date.now() + 150, check: () => new Promise(() => {}) })
  const dt = Date.now() - t0
  t.absent(verdict)
  t.ok(dt >= 140 && dt < 1000, 'answered at the deadline (' + dt + 'ms)')
})

test('someWithin starts no check once the deadline has passed', async (t) => {
  const p = probe({ ms: 200 })
  const items = Array.from({ length: 6 }, (_, i) => i)
  t.absent(await someWithin(items, { limit: 2, deadlineAt: Date.now() + 100, check: p.check }))
  await sleep(500)
  t.is(p.started.length, 2, 'only the checks started before the deadline ran')
  t.ok(p.budgets.every((ms) => ms >= 1), 'no check was handed a budget under 1 ms')
})

test('someWithin with no items or no budget answers false without a check', async (t) => {
  const p = probe()
  t.absent(await someWithin([], { limit: 8, deadlineAt: Date.now() + 1000, check: p.check }))
  t.absent(await someWithin([0, 1], { limit: 8, deadlineAt: Date.now(), check: p.check }))
  t.is(p.started.length, 0)
})
