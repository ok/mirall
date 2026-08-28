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
  const t0 = await drained
  t.ok(t0.cancelled, 'the pass reports itself cancelled, never finished')
  t.is(s.statusFor('A', 'sh').queued, 0)
  t.is(s.statusFor('A', 'sh').running, 1, 'the running item holds its slot until the executor honours the abort')
  await g.releaseAll()
  await sleep(10)
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

// REGRESSION (FIX-SCHED-CANCEL-SUCCESS: cancelShare resolved whenDrained with the plain partial
// tally, so a mount-time index cancelled by delete/relocate resolved as a SUCCESSFUL pass — the
// worker wrote 'active' (racing the delete's mount removal back into a zombie record), emitted
// scan-completed, and re-armed the periodic reconcile it had just cancelled.)
test('REGRESSION (FIX-SCHED-CANCEL-SUCCESS): whenDrained marks a cancelled pass', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 1 })
  s.beginShare('A', 'sh', 2)
  s.enqueue(spec('A', 'x'))
  s.enqueue(spec('A', 'y'))
  const drained = s.whenDrained('A', 'sh')
  await sleep(5)
  s.cancelShare('A', 'sh')
  const t0 = await drained
  t.ok(t0.cancelled)
  t.is(t0.totalOnDisk, 2, 'the tally is still carried')
  await g.releaseAll()
  t.absent((await s.whenDrained('A', 'sh'))?.cancelled, 'a later idle read is a plain idle')
})

test('cancelSpace marks every pass of the space cancelled', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 1 })
  s.beginShare('A', 'one', 1)
  s.enqueue(spec('A', 'x', { shareId: 'one' }))
  s.enqueue(spec('A', 'y', { shareId: 'two' }))
  const one = s.whenDrained('A', 'one')
  const two = s.whenDrained('A', 'two')
  await sleep(5)
  const done = s.cancelSpace('A', { settleMs: 200 })
  t.ok((await one).cancelled)
  t.ok((await two).cancelled)
  await g.releaseAll()
  await done
})

// REGRESSION (FIX-SCHED-EXPRESS: scheduling is non-preemptive and a single space may hold every
// slot, so a watcher unlink/add — a stat and one catalog write — waited for a running
// multi-gigabyte bulk hash to finish. The docs' "visible within milliseconds" held only against
// QUEUED bulk work.)
test('REGRESSION (FIX-SCHED-EXPRESS): an interactive item starts while every bulk slot is held', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 2 })
  s.enqueue(spec('A', 'huge-1', { size: 1e12 }))
  s.enqueue(spec('A', 'huge-2', { size: 1e12 }))
  s.enqueue(spec('A', 'bulk-3'))
  await sleep(5)
  t.alike(g.started, ['A/huge-1', 'A/huge-2'])
  s.enqueue(spec('A', 'gone', { op: OP.RETIRE, priority: PRIORITY.INTERACTIVE }))
  await sleep(5)
  t.ok(g.started.includes('A/gone'), 'the retire did not wait for a hash to finish')
  t.is(g.peak(), 3, 'one express lane past the bulk slots')
  s.enqueue(spec('A', 'dropped', { priority: PRIORITY.INTERACTIVE }))
  await sleep(5)
  t.absent(g.started.includes('A/dropped'), 'the express lane is one deep')
  await g.release('A/gone')
  await sleep(5)
  t.ok(g.started.includes('A/dropped'), 'the freed lane goes to the next interactive item')
  t.absent(g.started.includes('A/bulk-3'), 'bulk never runs past its own bound')
  await g.release('A/huge-1')
  await sleep(5)
  t.absent(g.started.includes('A/bulk-3'), 'two bulk-sized slots are still held (huge-2 + dropped)')
  await g.releaseAll()
  await sleep(5)
  t.ok(g.started.includes('A/bulk-3'))
})

test('the express lane also serves a second space', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 2 })
  s.enqueue(spec('A', 'huge-1', { size: 1e12 }))
  s.enqueue(spec('A', 'huge-2', { size: 1e12 }))
  await sleep(5)
  s.enqueue(spec('B', 'gone', { op: OP.RETIRE, priority: PRIORITY.INTERACTIVE }))
  await sleep(5)
  t.ok(g.started.includes('B/gone'))
  await g.releaseAll()
})

// REGRESSION (FIX-SCHED-CANCEL-BATCH: cancel zeroed the queue's running counters for a still-
// executing item, so the space read as idle and its catalog batch closed under the item; the
// abort's revert then threw 'catalog batch is closed' into a swallowed catch and the file stayed
// advertised as 'preparing' to every peer.)
test('REGRESSION (FIX-SCHED-CANCEL-BATCH): the space is not idle until a cancelled item settles', async (t) => {
  const g = gate()
  const idle = []
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 1, onSpaceIdle: (id) => idle.push(id) })
  s.enqueue(spec('A', 'x'))
  await sleep(5)
  s.cancelShare('A', 'sh')
  await sleep(5)
  t.alike(idle, [], 'the batch stays open for the revert')
  t.absent(s.isSpaceIdle('A'))
  await g.release('A/x')
  await sleep(5)
  t.alike(idle, ['A'])
  t.ok(s.isSpaceIdle('A'))
})

test('a cancelled share still gets its drained hook when the running item settles', async (t) => {
  const g = gate()
  const drained = []
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 1, onShareDrained: (sp, sh, tally) => drained.push([sh, tally]) })
  s.beginShare('A', 'sh', 1)
  s.enqueue(spec('A', 'x'))
  await sleep(5)
  s.cancelShare('A', 'sh')
  t.alike(drained, [], 'not yet — nothing settled')
  await g.release('A/x')
  await sleep(5)
  t.is(drained.length, 1, 'fires once the executor is out, so the revert is flushed and announced')
  t.is(drained[0][0], 'sh')
  t.ok(drained[0][1].cancelled, 'with the cancelled pass\'s tally')
})

test('a cancelled item that ran to completion counts for nobody', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 1 })
  s.beginShare('A', 'sh', 1)
  s.enqueue(spec('A', 'x'))
  await sleep(5)
  s.cancelShare('A', 'sh')
  s.beginShare('A', 'sh', 1)
  s.enqueue(spec('A', 'y'))
  const drained = s.whenDrained('A', 'sh')
  await g.release('A/x')
  await sleep(5)
  await g.release('A/y')
  const t0 = await drained
  t.is(t0.uploaded, 1, 'only y — x belonged to the cancelled pass')
})

// REGRESSION (FIX-SCHED-TERMINAL-ZEROS: settleDrain deleted the tally before onShareDrained, whose
// progress flush read statusFor → done: 0, failed: 0 on every completion event.)
test('REGRESSION (FIX-SCHED-TERMINAL-ZEROS): statusFor inside onShareDrained still carries the counts', async (t) => {
  const g = gate()
  let seen = null
  const s = createPublishScheduler({
    execute: g.execute, concurrency: () => 2,
    onShareDrained: (sp, sh) => { seen = s.statusFor(sp, sh) },
  })
  s.beginShare('A', 'sh', 3)
  s.enqueue(spec('A', 'x'))
  s.enqueue(spec('A', 'y'))
  s.enqueue(spec('A', 'z', { op: OP.RETIRE }))
  await sleep(5)
  await g.releaseAll()
  await sleep(5)
  await g.releaseAll()
  await sleep(5)
  t.is(seen.done, 3)
  t.is(seen.totalOnDisk, 3, 'the denominator rides along')
  t.is(seen.queued + seen.running, 0)
})

test('statusFor reports the share\'s own queued bytes, not the space\'s', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 1 })
  s.enqueue(spec('A', 'hold', { shareId: 'one', size: 1 }))
  await sleep(5)
  s.enqueue(spec('A', 'a', { shareId: 'one', size: 100 }))
  s.enqueue(spec('A', 'b', { shareId: 'two', size: 5000 }))
  t.is(s.statusFor('A', 'one').bytesQueued, 100)
  t.is(s.statusFor('A', 'two').bytesQueued, 5000)
  await g.releaseAll()
  await sleep(5)
  await g.releaseAll()
})

// REGRESSION (FIX-SCHED-IDLE-ORDER: onShareDrained ran before onSpaceIdle, so the drained hook's
// catalog settle looked for a batch close that had not been registered yet and announced the
// share before the closing flush landed — the owner's own list showed the last files missing.)
test('REGRESSION (FIX-SCHED-IDLE-ORDER): the space goes idle before the share is reported drained', async (t) => {
  const g = gate()
  const order = []
  const s = createPublishScheduler({
    execute: g.execute, concurrency: () => 1,
    onSpaceIdle: () => order.push('idle'),
    onShareDrained: () => order.push('drained'),
  })
  s.beginShare('A', 'sh', 1)
  s.enqueue(spec('A', 'x'))
  await sleep(5)
  await g.release('A/x')
  await sleep(5)
  t.alike(order, ['idle', 'drained'])
})

// A loose file's cancel: one path, no pass semantics. A queued item leaves at once; a running one
// is signalled and settles CANCELLED when its executor returns.
test('cancelPath drops a queued item and signals a running one', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 1 })
  const running = s.enqueue(spec('A', 'slow'))
  const waiting = s.enqueue(spec('A', 'later'))
  await sleep(5)
  t.is(s.cancelPath('A', 'sh', 'later'), 1)
  t.is((await waiting.settled).outcome, 'cancelled')
  t.absent(s.isPending('A', 'sh', 'later'))
  t.is(s.cancelPath('A', 'sh', 'slow'), 1)
  const item = [...s._running][0]
  t.ok(item.signal.aborted, 'the running hash is told to stop')
  t.ok(s.isPending('A', 'sh', 'slow'), 'and keeps its place until the executor returns')
  t.is((await running.settled).outcome, 'cancelled')
  await g.release('A/slow')
  await sleep(5)
  t.absent(s.isPending('A', 'sh', 'slow'))
  t.is(s.cancelPath('A', 'sh', 'slow'), 0, 'nothing live → nothing cancelled')
})

test('pendingRelPaths lists queued and running paths for a share', async (t) => {
  const g = gate()
  const s = createPublishScheduler({ execute: g.execute, concurrency: () => 1 })
  s.enqueue(spec('A', 'one'))
  s.enqueue(spec('A', 'two'))
  s.enqueue(spec('A', 'other', { shareId: 'else' }))
  await sleep(5)
  t.alike(s.pendingRelPaths('A', 'sh').sort(), ['one', 'two'])
  t.alike(s.pendingRelPaths('A', 'else'), ['other'])
  t.alike(s.pendingRelPaths('B', 'sh'), [])
  await g.releaseAll()
})
