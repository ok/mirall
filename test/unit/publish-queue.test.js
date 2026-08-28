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

test('setOrder re-sorts the live items and drops stale heap entries', (t) => {
  const q = createPublishQueue({ order: 'fifo' })
  q.enqueue(pub('mid', { size: 50 }))
  q.enqueue(pub('big', { size: 900 }))
  q.enqueue(pub('small', { size: 5 }))
  q.enqueue(pub('big', { size: 900 }))
  q.setOrder('smallest-first')
  t.alike([q.take().relPath, q.take().relPath, q.take().relPath], ['small', 'mid', 'big'])
  t.is(q.take(), null, 'the stale generation did not survive the rebuild')
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
