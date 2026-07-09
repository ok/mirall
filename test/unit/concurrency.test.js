import test from 'brittle'
import { mapLimit } from '../../src/shared/core/concurrency.js'

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
