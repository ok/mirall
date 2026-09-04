import test from 'brittle'
import { createPresenceSweeper } from '../../src/shared/transfer/presence-sweeper.js'

function build ({ present = () => false, pending = () => false } = {}) {
  const retired = []
  const sweeper = createPresenceSweeper({
    keyOf: (ctx, e) => ctx.spaceId + '\0' + e.relPath,
    isPending: (ctx, e) => pending(ctx, e),
    presentAt: async (ctx, e) => present(ctx, e),
    retire: (ctx, e) => { retired.push(e.relPath) },
  })
  return { sweeper, retired }
}

const CTX = { spaceId: 'S' }
const ENTRY = { relPath: 'a.txt' }

test('a single miss only arms — the reclaim needs a second consecutive one', async (t) => {
  const { sweeper, retired } = build()
  t.absent(await sweeper.consider(CTX, ENTRY), 'first miss arms')
  t.alike(retired, [], 'nothing retired yet')
  t.ok(await sweeper.consider(CTX, ENTRY), 'second consecutive miss reclaims')
  t.alike(retired, ['a.txt'], 'retired once')
})

test('REGRESSION (FIX-PI1-4: a file that returns between two passes is never retired)', async (t) => {
  // An editor's atomic save (rename-over, delete+recreate) makes a healthy file briefly absent.
  // Retiring on that single miss would tombstone it and cascade the deletion to every mirror peer.
  let there = false
  const { sweeper, retired } = build({ present: () => there })
  await sweeper.consider(CTX, ENTRY)
  there = true
  t.absent(await sweeper.consider(CTX, ENTRY), 'presence disarms')
  there = false
  t.absent(await sweeper.consider(CTX, ENTRY), 'the next miss starts over rather than completing the old pair')
  t.alike(retired, [], 'never retired')
})

test('an entry whose publish is queued is skipped, and its arming is dropped', async (t) => {
  let pending = false
  const { sweeper, retired } = build({ pending: () => pending })
  await sweeper.consider(CTX, ENTRY)
  t.is(sweeper.size(), 1, 'armed')
  pending = true
  t.absent(await sweeper.consider(CTX, ENTRY), 'skipped while its publish is in the queue')
  t.is(sweeper.size(), 0, 'and disarmed — disk presence decides only for settled entries')
  t.alike(retired, [])
})

test('an entry with no recorded source is never reclaimed, however many passes miss it', async (t) => {
  const { sweeper, retired } = build({ present: () => null })
  for (let i = 0; i < 5; i++) t.absent(await sweeper.consider(CTX, ENTRY), 'pass ' + i)
  t.alike(retired, [], 'not ours to reclaim')
})

test('the arming is per key, so one gone file does not reclaim its neighbour', async (t) => {
  const { sweeper, retired } = build()
  await sweeper.consider(CTX, { relPath: 'a.txt' })
  await sweeper.consider(CTX, { relPath: 'b.txt' })
  t.alike(retired, [], 'both only armed')
  await sweeper.consider(CTX, { relPath: 'a.txt' })
  t.alike(retired, ['a.txt'], 'only the one that missed twice')
})

test('the same path in two spaces arms independently', async (t) => {
  const { sweeper, retired } = build()
  await sweeper.consider({ spaceId: 'S1' }, ENTRY)
  t.absent(await sweeper.consider({ spaceId: 'S2' }, ENTRY), 'a miss in another space is not the second miss here')
  t.alike(retired, [])
})

test('reset() forgets every arming', async (t) => {
  const { sweeper, retired } = build()
  await sweeper.consider(CTX, ENTRY)
  sweeper.reset()
  t.absent(await sweeper.consider(CTX, ENTRY), 'starts over')
  t.alike(retired, [])
})
