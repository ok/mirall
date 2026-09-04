import test from 'brittle'
import { createPresenceSweeper } from '../../src/shared/transfer/presence-sweeper.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import nodePath from 'path'

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

// REGRESSION: both call sites collect their retire promises the same way, but they do not settle the
// same way. The loose one goes through settledWithTail, which rethrows, so .catch is meaningful
// there. The folder one pushes the publish lane's raw ticket, and that deferred (work-item.js) is
// built with a resolve and no reject — so its copied .catch could never fire and a failed retire
// vanished with no log at all. The failure has to be read off the settlement outcome.
test('the folder retire reads its settlement instead of catching a rejection that cannot happen', (t) => {
  const here = nodePath.dirname(fileURLToPath(import.meta.url))
  const read = (rel) => readFileSync(nodePath.resolve(here, '../../src', rel), 'utf8')

  const deferredSrc = read('shared/folders/work-item.js')
  t.absent(/new Promise\(\(resolve, reject\)/.test(deferredSrc), 'the lane ticket still has no reject path')

  const backend = read('shared/transfer/backends/overlay/overlay-backend.js')
  const retire = backend.match(/retire: \(\{ spaceId, shareId, retires \}[\s\S]*?\n  \},/)?.[0] || ''
  t.ok(retire.length > 0, 'found the folder sweep retire')
  t.absent(/settled\.catch\(/.test(retire), 'no catch on a promise that never rejects')
  t.ok(/outcome === 'failed'/.test(retire), 'a failed retire is read off the outcome and logged')
})
