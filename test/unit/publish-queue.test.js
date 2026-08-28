import test from 'brittle'
import { createPublishQueue } from '../../src/shared/folders/publish-queue.js'
import { OP, PRIORITY, STATE } from '../../src/shared/folders/work-item.js'

const pub = (relPath, over = {}) => ({ spaceId: 'S', shareId: 'sh', relPath, absPath: '/m/' + relPath, op: OP.PUBLISH, size: 100, mtime: 1, ...over })
const done = { outcome: 'done', result: { outcome: 'published' } }

// REGRESSION (FIX-SCAN-3: publishContent's fast path skips only when a hash already exists, so
// "already being hashed" was unrepresentable and a second pass re-read the same file. One live
// item per path makes that structurally impossible.)
test('REGRESSION (FIX-SCAN-3): a second enqueue for a queued path folds in, it does not duplicate', (t) => {
  const q = createPublishQueue()
  t.is(q.enqueue(pub('a.bin')).status, 'queued')
  t.is(q.enqueue(pub('a.bin', { size: 999, mtime: 2 })).status, 'deduped')
  t.is(q.stats().queued, 1, 'one item, not two')
  const item = q.take()
  t.is(item.size, 999, 'carries the latest facts')
  t.is(item.mtime, 2)
  t.is(q.take(), null, 'nothing stale left behind in the heap')
})

test('REGRESSION (FIX-SCAN-3): enqueueing a RUNNING path supersedes — exactly one rerun', async (t) => {
  const q = createPublishQueue()
  const first = q.enqueue(pub('a.bin'))
  const item = q.take()
  const a = q.enqueue(pub('a.bin', { size: 5 }))
  const b = q.enqueue(pub('a.bin', { size: 7 }))
  const c = q.enqueue(pub('a.bin', { size: 9 }))
  t.alike([a.status, b.status, c.status], ['superseded', 'superseded', 'superseded'])
  t.is(q.settle(item, done), 'requeued', 'three requests during the run produce ONE rerun')
  t.alike(await first.settled, done, 'the original caller settles with the first run')
  const again = q.take()
  t.is(again.size, 9, 'the rerun carries the newest facts')
  const rerunDone = { outcome: 'done', result: { outcome: 'published', rerun: true } }
  t.is(q.settle(again, rerunDone), STATE.DONE)
  t.alike(await Promise.all([a.settled, b.settled, c.settled]), [rerunDone, rerunDone, rerunDone],
    'callers that arrived during the run settle with the RERUN, never the pass that predates them')
  t.is(q.stats().queued + q.stats().running, 0)
})

// A catch-up diff re-finds a file that is mid-hash with the same size+mtime. That must join the
// run in flight, not force a second read of a file whose current version is already being hashed.
test('identical facts for a running path join the run instead of forcing a rerun', async (t) => {
  const q = createPublishQueue()
  q.enqueue(pub('a.bin', { size: 100, mtime: 1 }))
  const item = q.take()
  const again = q.enqueue(pub('a.bin', { size: 100, mtime: 1 }))
  t.is(again.status, 'deduped')
  t.is(q.settle(item, done), STATE.DONE, 'no rerun')
  t.alike(await again.settled, done, 'the joiner settles with the run it joined')
  t.is(q.take(), null)
})

test('a supersede can change the op: added then deleted during the hash reruns as a retire', (t) => {
  const q = createPublishQueue()
  q.enqueue(pub('a.bin'))
  const item = q.take()
  q.enqueue(pub('a.bin', { op: OP.RETIRE }))
  q.settle(item, done)
  t.is(q.take().op, OP.RETIRE)
})

test('a cancelled running item is not requeued even if it was dirty', async (t) => {
  const q = createPublishQueue()
  const first = q.enqueue(pub('a.bin'))
  const item = q.take()
  const later = q.enqueue(pub('a.bin', { size: 5 }))
  q.cancel((i) => i.relPath === 'a.bin')
  t.ok(item.signal.aborted, 'the running item is signalled')
  t.is((await first.settled).outcome, 'cancelled')
  t.is((await later.settled).outcome, 'cancelled', 'the superseding caller is released too')
  t.is(q.settle(item, done), STATE.CANCELLED, 'settle after cancel is a no-op')
  t.is(q.stats().queued, 0)
  t.is(q.stats().running, 0)
})

test('ordering: fifo / smallest-first / largest-first', (t) => {
  const order = (name) => {
    const q = createPublishQueue({ order: name })
    q.enqueue(pub('mid', { size: 50 }))
    q.enqueue(pub('big', { size: 900 }))
    q.enqueue(pub('small', { size: 5 }))
    return [q.take().relPath, q.take().relPath, q.take().relPath]
  }
  t.alike(order('fifo'), ['mid', 'big', 'small'], 'insertion order')
  t.alike(order('smallest-first'), ['small', 'mid', 'big'])
  t.alike(order('largest-first'), ['big', 'mid', 'small'])
})

test('priority outranks the size policy, and a retire outranks a publish', (t) => {
  const q = createPublishQueue({ order: 'largest-first' })
  q.enqueue(pub('huge', { size: 10_000 }))
  q.enqueue(pub('gone', { size: 1, op: OP.RETIRE }))
  q.enqueue(pub('dropped', { size: 2, priority: PRIORITY.INTERACTIVE }))
  t.is(q.take().relPath, 'dropped', 'the file the user just added goes first')
  t.is(q.take().relPath, 'gone', 'then the cheap retire')
  t.is(q.take().relPath, 'huge')
})

test('a re-enqueue may only raise priority, never lower it', (t) => {
  const q = createPublishQueue()
  q.enqueue(pub('a.bin', { priority: PRIORITY.INTERACTIVE }))
  q.enqueue(pub('a.bin', { priority: PRIORITY.BULK }))
  t.is(q.take().priority, PRIORITY.INTERACTIVE)
})

test('pendingForShare and isPending track both queued and running', (t) => {
  const q = createPublishQueue()
  q.enqueue(pub('a.bin'))
  q.enqueue({ ...pub('b.bin'), shareId: 'other' })
  t.is(q.pendingForShare('sh'), 1)
  const item = q.take()
  t.ok(q.isPending(item.shareId, item.relPath))
  t.is(q.pendingForShare(item.shareId), 1, 'still pending while RUNNING — the sweep must not reclaim it')
  q.settle(item, done)
  t.is(q.pendingForShare(item.shareId), 0)
  t.absent(q.isPending(item.shareId, item.relPath))
})

test('bytes accounting survives a fold and a take', (t) => {
  const q = createPublishQueue()
  q.enqueue(pub('a.bin', { size: 100 }))
  t.is(q.stats().queuedBytes, 100)
  q.enqueue(pub('a.bin', { size: 250 }))
  t.is(q.stats().queuedBytes, 250, 'the fold adjusts, it does not double-count')
  q.take()
  t.is(q.stats().queuedBytes, 0)
})

// REGRESSION (FIX-QUEUE-FOLD: a fold mutated the queued item's sort keys and pushed a second heap
// entry while the stale one was still in the heap. The comparator read the item, so the two
// entries compared equal and sift-up stopped early — the heap invariant broke and peek() handed
// the scheduler a BULK head while an INTERACTIVE item sat below it.)
test('REGRESSION (FIX-QUEUE-FOLD): raising a queued item to interactive moves it to the head', (t) => {
  const q = createPublishQueue()
  for (const n of ['a', 'b', 'c', 'd']) q.enqueue(pub(n))
  t.is(q.enqueue(pub('b', { priority: PRIORITY.INTERACTIVE })).status, 'deduped')
  t.is(q.peek().relPath, 'b', 'peek sees the interactive item')
  t.alike([q.take(), q.take(), q.take(), q.take()].map((i) => i.relPath), ['b', 'a', 'c', 'd'])
  t.is(q.take(), null)
})

test('a size change on a queued item re-sorts under smallest-first', (t) => {
  const q = createPublishQueue({ order: 'smallest-first' })
  q.enqueue(pub('x', { size: 10 }))
  q.enqueue(pub('y', { size: 20 }))
  q.enqueue(pub('z', { size: 30 }))
  q.enqueue(pub('z', { size: 1 }))
  t.alike([q.take(), q.take(), q.take()].map((i) => i.relPath), ['z', 'x', 'y'])
})

// REGRESSION (FIX-QUEUE-DEEP: a fold copied every fact, so a non-deep catch-up spec arriving for
// a queued deep item (relocate) turned it into a plain publish — a full re-advertise with a null
// hash instead of the hash-compare skip relocate exists for.)
test('REGRESSION (FIX-QUEUE-DEEP): deep is sticky across a fold', (t) => {
  const q = createPublishQueue()
  q.enqueue(pub('a.bin', { deep: true }))
  q.enqueue(pub('a.bin', { deep: false, mtime: 7 }))
  const item = q.take()
  t.ok(item.deep, 'still deep')
  t.is(item.mtime, 7, 'other facts are the newest')
})

// REGRESSION (FIX-QUEUE-CANCEL-RUNNING: cancel() dropped a RUNNING item from byKey at once while
// its executor was still on the file, so a re-enqueue in that window created a second live item
// for the path — two executors, and the stale one's revert landing on the new one's advertise.)
test('REGRESSION (FIX-QUEUE-CANCEL-RUNNING): a cancelled running item stays the path\'s one live item until it settles', async (t) => {
  const q = createPublishQueue()
  const first = q.enqueue(pub('a.bin'))
  const item = q.take()
  q.cancel(() => true)
  t.is((await first.settled).outcome, 'cancelled', 'the caller is released at once')
  t.ok(item.signal.aborted)
  t.is(q.stats().running, 1, 'still running until the executor returns')
  t.ok(q.isPending('sh', 'a.bin'), 'still pending — the sweep must not reclaim it')

  const again = q.enqueue(pub('a.bin', { mtime: 9 }))
  t.is(again.status, 'superseded', 'a fresh request reruns, it does not start a second executor')
  t.is(q.take(), null, 'nothing runnable while the cancelled run is still out')

  t.is(q.settle(item, { outcome: 'cancelled' }), 'requeued')
  const rerun = q.take()
  t.is(rerun, item, 'the same item, one live per path')
  t.is(rerun.mtime, 9)
  t.absent(rerun.signal.aborted, 'the rerun has its own signal')
  t.absent(rerun.cancelled)
  const doneRerun = { outcome: 'done', result: { outcome: 'published' } }
  t.is(q.settle(rerun, doneRerun), STATE.DONE)
  t.alike(await again.settled, doneRerun)
  t.is(q.stats().queued + q.stats().running, 0)
})

test('a cancelled running item with no later request settles as cancelled and leaves', (t) => {
  const q = createPublishQueue()
  q.enqueue(pub('a.bin'))
  const item = q.take()
  q.cancel(() => true)
  t.is(q.settle(item, { outcome: 'done', result: { outcome: 'published' } }), STATE.CANCELLED, 'however the executor returned')
  t.absent(q.isPending('sh', 'a.bin'))
  t.is(q.stats().running, 0)
})

test('identical facts never join a cancelled run', (t) => {
  const q = createPublishQueue()
  q.enqueue(pub('a.bin'))
  q.take()
  q.cancel(() => true)
  t.is(q.enqueue(pub('a.bin')).status, 'superseded')
})

test('settled is shared per run: no waiter per call, and a late read still sees the value', async (t) => {
  const q = createPublishQueue()
  const a = q.enqueue(pub('a.bin'))
  const b = q.enqueue(pub('a.bin'))
  const item = q.take()
  t.is(q.settle(item, done), STATE.DONE)
  t.alike(await a.settled, done, 'read after the settlement')
  t.alike(await b.settled, done)
  t.is(await a.settled, await b.settled, 'one promise per run')
})

test('bytesForShare tracks the share\'s own queued bytes', (t) => {
  const q = createPublishQueue()
  q.enqueue(pub('a.bin', { size: 100 }))
  q.enqueue({ ...pub('b.bin', { size: 50 }), shareId: 'other' })
  t.is(q.bytesForShare('sh'), 100)
  t.is(q.bytesForShare('other'), 50)
  q.enqueue(pub('a.bin', { size: 300 }))
  t.is(q.bytesForShare('sh'), 300, 'a fold adjusts')
  t.is(q.take().relPath, 'a.bin')
  t.is(q.bytesForShare('sh'), 0)
  t.is(q.bytesForShare('other'), 50)
})
