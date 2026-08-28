import test from 'brittle'
import { createPublishScheduler } from '../../src/shared/folders/publish-scheduler.js'
import { OP, PRIORITY } from '../../src/shared/folders/work-item.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A controllable executor: records start order and holds each item until released.
function gate () {
  const started = []
  const holds = new Map()
  let live = 0
  let peak = 0
  const execute = async (item) => {
    const id = item.spaceId + '/' + item.relPath
    started.push(id)
    live += 1
    peak = Math.max(peak, live)
    await new Promise((resolve) => holds.set(id, resolve))
    live -= 1
    return { outcome: item.op === OP.RETIRE ? 'retired' : 'published' }
  }
  return {
    execute,
    started,
    release: async (id) => { const r = holds.get(id); holds.delete(id); r?.(); await sleep(0) },
    releaseAll: async () => {
      for (const id of [...holds.keys()]) { holds.get(id)(); holds.delete(id) }
      await sleep(0)
    },
    peak: () => peak,
  }
}
const spec = (spaceId, relPath, over = {}) => ({ spaceId, shareId: 'sh', relPath, absPath: '/m/' + relPath, op: OP.PUBLISH, size: 100, ...over })

test('concurrency is bounded', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 2 })
  for (let i = 0; i < 6; i++) s.enqueue(spec('A', 'f' + i))
  await sleep(10)
  t.is(g.started.length, 2, 'only `concurrency` items ever start at once')
  t.is(g.peak(), 2)
  await g.releaseAll()
  await sleep(10)
  t.ok(g.started.length > 2, 'and the lane keeps pumping as slots free')
})

// REQUIREMENT: large-file work in one space must not starve another space.
test('one space cannot hold every slot while another has queued work', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 2 })
  s.enqueue(spec('A', 'huge-1', { size: 1e12 }))
  s.enqueue(spec('A', 'huge-2', { size: 1e12 }))
  await sleep(10)
  t.is(g.started.length, 2, 'A holds both slots while it is the only space with work')

  s.enqueue(spec('B', 'small', { size: 10 }))
  await g.release('A/huge-1')
  await sleep(10)
  t.ok(g.started.includes('B/small'), 'the freed slot goes to B, not to A\'s backlog')

  s.enqueue(spec('A', 'huge-3', { size: 1e12 }))
  await g.release('B/small')
  await sleep(10)
  t.ok(g.started.includes('A/huge-3'), 'and rotates back once B is empty')
})

test('spaces are served round-robin, not first-come', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 1 })
  for (let i = 0; i < 3; i++) s.enqueue(spec('A', 'a' + i))
  s.enqueue(spec('B', 'b0'))
  s.enqueue(spec('C', 'c0'))
  for (let i = 0; i < 4; i++) { await sleep(5); await g.releaseAll() }
  await sleep(10)
  t.alike(g.started.slice(0, 4), ['A/a0', 'B/b0', 'C/c0', 'A/a1'], 'B and C are not stuck behind A\'s backlog')
})

test('an interactive item is not made to wait for a bulk backfill to drain', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 2 })
  for (let i = 0; i < 20; i++) s.enqueue(spec('A', 'bulk' + i))
  await sleep(10)
  s.enqueue(spec('A', 'dropped-in', { priority: PRIORITY.INTERACTIVE }))
  await g.release('A/bulk0')
  await sleep(10)
  t.ok(g.started.includes('A/dropped-in'), 'it takes the very next slot')
})

test('the interactive reservation never idles the lane when nothing can use it', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 2 })
  for (let i = 0; i < 4; i++) s.enqueue(spec('A', 'bulk' + i))
  await sleep(10)
  t.is(g.started.length, 2, 'no interactive item exists, so both slots are used')
})

test('enqueue resolves when the item has settled, with the executor result', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 1 })
  const r = s.enqueue(spec('A', 'x'))
  let settled = false
  r.settled.then(() => { settled = true })
  await sleep(10)
  t.absent(settled)
  await g.release('A/x')
  const outcome = await r.settled
  t.is(outcome.outcome, 'done')
  t.is(outcome.result.outcome, 'published')
})

test('whenDrained resolves with the pass totals, and immediately when already idle', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 2 })
  t.is(await s.whenDrained('A', 'sh'), null, 'idle share resolves at once')

  s.beginShare('A', 'sh', 3)
  s.enqueue(spec('A', 'x'))
  s.enqueue(spec('A', 'y'))
  s.enqueue(spec('A', 'z', { op: OP.RETIRE }))
  const drained = s.whenDrained('A', 'sh')
  await sleep(5)
  await g.releaseAll()
  await sleep(5)
  await g.releaseAll()
  const t0 = await drained
  t.is(t0.uploaded, 2)
  t.is(t0.deleted, 1)
  t.is(t0.totalOnDisk, 3)
})

// The 2 s catch-up diff fires after any watcher event — i.e. routinely DURING a mount's drain —
// and calls beginShare again. It must merge, or the mount's whenDrained returns zeros.
test('beginShare during a drain keeps the running tally', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 1 })
  s.beginShare('A', 'sh', 2)
  s.enqueue(spec('A', 'x'))
  s.enqueue(spec('A', 'y'))
  const drained = s.whenDrained('A', 'sh')
  await sleep(5)
  await g.release('A/x')
  await sleep(5)
  s.beginShare('A', 'sh', 3)
  s.enqueue(spec('A', 'z'))
  await g.release('A/y')
  await sleep(5)
  await g.release('A/z')
  await sleep(5)
  const t0 = await drained
  t.is(t0.uploaded, 3, 'x was not forgotten')
  t.is(t0.totalOnDisk, 3, 'the newest denominator wins')
})

test('a throwing executor fails only its own item and keeps the lane pumping', async (t) => {
  let n = 0
  const s = createPublishScheduler({
    execute: async (item) => { n += 1; if (item.relPath === 'bad') throw new Error('boom'); return { outcome: 'published' } },
    concurrency: () => 1,
  })
  s.beginShare('A', 'sh', 3)
  s.enqueue(spec('A', 'ok1'))
  const bad = s.enqueue(spec('A', 'bad'))
  s.enqueue(spec('A', 'ok2'))
  const t0 = await s.whenDrained('A', 'sh')
  t.is(n, 3, 'every item ran; one failure did not abort the queue')
  t.is((await bad.settled).outcome, 'failed')
  t.is(t0.uploaded, 2)
  t.is(t0.failed, 1)
})

test('cancelShare signals the running item, drops the queued ones and releases whenDrained', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 1 })
  s.beginShare('A', 'sh', 5)
  for (let i = 0; i < 5; i++) s.enqueue(spec('A', 'f' + i))
  await sleep(10)
  const drained = s.whenDrained('A', 'sh')
  const runningItem = [...s._running][0]
  t.is(s.cancelShare('A', 'sh'), 5, 'one running + four queued')
  t.ok(runningItem.signal.aborted, 'the in-flight hash is signalled to abort')
  await drained
  await g.releaseAll()
  await sleep(10)
  t.is(s.statusFor('A', 'sh').queued, 0)
  t.is(s.statusFor('A', 'sh').running, 0)
})

test('cancelSpace resolves only once the running items have settled', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 1 })
  s.enqueue(spec('A', 'slow'))
  await sleep(5)
  let settled = false
  const p = s.cancelSpace('A').then(() => { settled = true })
  await sleep(30)
  t.absent(settled, 'still waiting on the running item')
  await g.release('A/slow')
  await p
  t.ok(settled, 'resolves once the item is out of the lane')
  t.ok(s.isSpaceIdle('A'))
})

test('a concurrency of 0 is clamped to 1, never a lane that never pumps', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 0 })
  s.enqueue(spec('A', 'x'))
  await sleep(10)
  t.is(g.started.length, 1)
})

test('onSpaceIdle fires once the whole space is idle, onShareDrained per reconciled share', async (t) => {
  const g = gate()
  const idle = []
  const drained = []
  const s = createPublishScheduler({
    execute: g.execute, concurrency: () => 2,
    onSpaceIdle: (spaceId) => idle.push(spaceId),
    onShareDrained: (spaceId, shareId, tally) => drained.push([shareId, tally.uploaded]),
  })
  s.beginShare('A', 'one', 1)
  s.enqueue(spec('A', 'x', { shareId: 'one' }))
  s.enqueue(spec('A', 'y', { shareId: 'two' }))
  await sleep(5)
  await g.release('A/x')
  await sleep(5)
  t.alike(drained, [['one', 1]])
  t.alike(idle, [], 'share two still runs')
  await g.release('A/y')
  await sleep(5)
  t.alike(idle, ['A'])
})
