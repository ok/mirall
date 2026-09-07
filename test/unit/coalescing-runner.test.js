import test from 'brittle'
import { createCoalescingRunner } from '../../src/shared/core/coalescing-runner.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// REGRESSION (FIX-SCAN-2: every watcher event started its own full-folder diff. Requests arriving
// while one runs must collapse into exactly ONE follow-up.)
test('REGRESSION (FIX-SCAN-2): requests during a run collapse into one rerun', async (t) => {
  const run = createCoalescingRunner()
  let runs = 0
  const fn = async () => { runs += 1; await sleep(50); return runs }

  const first = run('k', {}, fn)
  await sleep(10)
  const a = run('k', {}, fn)
  const b = run('k', {}, fn)
  const c = run('k', {}, fn)

  t.is(await first, 1, 'the in-flight pass resolves with its own result')
  const [ra, rb, rc] = await Promise.all([a, b, c])
  t.is(runs, 2, 'three queued requests produced exactly one rerun')
  t.alike([ra, rb, rc], [2, 2, 2], 'queued callers settle with the RERUN, not the pass that predates them')
  t.absent(run.isRunning('k'), 'state is released once the chain drains')
})

test('a request arriving during the rerun queues another one', async (t) => {
  const run = createCoalescingRunner()
  let runs = 0
  const fn = async () => { runs += 1; await sleep(40); return runs }
  const first = run('k', {}, fn)
  await sleep(10)
  const queued = run('k', {}, fn)
  await first
  await sleep(10)
  const later = run('k', {}, fn)
  t.is(await queued, 2)
  t.is(await later, 3)
  t.is(runs, 3, 'no pass was skipped and none overlapped')
})

test('distinct keys do not interlock', async (t) => {
  const run = createCoalescingRunner()
  let peak = 0
  let live = 0
  const fn = async () => { live += 1; peak = Math.max(peak, live); await sleep(30); live -= 1 }
  await Promise.all([run('a', {}, fn), run('b', {}, fn), run('c', {}, fn)])
  t.is(peak, 3, 'per-key, not global')
})

test('merge() folds a newly arriving request into the queued one', async (t) => {
  const run = createCoalescingRunner({ merge: (q, n) => ({ ...n, deep: q.deep || n.deep }) })
  const seen = []
  const fn = async (opts) => { seen.push(opts); await sleep(30) }
  const first = run('k', { mountPath: '/old', deep: false }, fn)
  await sleep(5)
  run('k', { mountPath: '/old', deep: true }, fn)
  const last = run('k', { mountPath: '/new', deep: false }, fn)
  await first
  await last
  t.is(seen.length, 2)
  t.alike(seen[1], { mountPath: '/new', deep: true }, 'newest path wins, deep survives the fold')
})

test('a throwing pass rejects only its own caller and does not stall the queue', async (t) => {
  const run = createCoalescingRunner()
  let runs = 0
  const fn = async () => { runs += 1; await sleep(20); if (runs === 1) throw new Error('boom'); return runs }
  const first = run('k', {}, fn)
  await sleep(5)
  const queued = run('k', {}, fn)
  await t.exception(first, /boom/)
  t.is(await queued, 2, 'the rerun still runs and resolves')
  t.absent(run.isRunning('k'))
})

test('a throwing rerun rejects its waiters without an unhandled rejection', async (t) => {
  const run = createCoalescingRunner()
  let runs = 0
  const fn = async () => { runs += 1; await sleep(20); if (runs === 2) throw new Error('rerun-boom'); return runs }
  const first = run('k', {}, fn)
  await sleep(5)
  const queued = run('k', {}, fn)
  t.is(await first, 1)
  await t.exception(queued, /rerun-boom/)
  t.absent(run.isRunning('k'))
})

// REGRESSION (FIX-COALESCE-GEN: a run abandoned by cancel() still cleared the entry that replaced
// it and started that entry's queued rerun, so a recovery could leave two passes running over one
// mount — the same latent defect the derived-view fold had to fix before it could be supervised.)
test('REGRESSION (FIX-COALESCE-GEN): an abandoned run cannot clear or rerun the live entry', async (t) => {
  const run = createCoalescingRunner({ cancelledValue: { cancelled: true } })
  const starts = []
  let release = null
  const slow = () => new Promise((resolve) => { release = resolve })

  const first = run('k', {}, () => { starts.push('first'); return slow() })
  const releaseFirst = release
  run('k', {}, () => { starts.push('queued'); return slow() })
  t.is(run.isRunning('k'), true)
  t.is(run.cancel('k'), true)
  t.is(run.isRunning('k'), false, 'the key is free the instant the run is abandoned')

  const second = run('k', {}, () => { starts.push('second'); return slow() })
  const releaseSecond = release
  releaseFirst('done')
  await first
  await sleep(5)

  t.alike(starts, ['first', 'second'], 'the abandoned run did not start the queued rerun')
  t.is(run.isRunning('k'), true, 'and did not clear the live entry')
  releaseSecond('done')
  await second
})

test('a caller queued behind an abandoned run settles with the cancelled value', async (t) => {
  const run = createCoalescingRunner({ cancelledValue: { cancelled: true, totalOnDisk: 0 } })
  let release = null
  const first = run('k', {}, () => new Promise((resolve) => { release = resolve }))
  const queued = run('k', {}, () => {})
  run.cancel('k')
  t.alike(await queued, { cancelled: true, totalOnDisk: 0 }, 'resolved, not rejected')
  release(null)
  await first
})

test('cancel on a key with nothing in flight is a no-op', (t) => {
  const run = createCoalescingRunner()
  t.is(run.cancel('nope'), false)
})

test('a cancelled key runs again from scratch', async (t) => {
  const run = createCoalescingRunner()
  let runs = 0
  let release = null
  const fn = async () => { runs += 1; await new Promise((resolve) => { release = resolve }) }
  const first = run('k', {}, fn)
  const releaseFirst = release
  run.cancel('k')

  const second = run('k', {}, fn)
  t.is(runs, 2, 'the next request started a fresh run rather than coalescing onto the abandoned one')
  release()
  await second
  releaseFirst()
  await first
  t.absent(run.isRunning('k'))
})

// REGRESSION (FIX-CANCEL-ORPHANS: cancel() reached only the callers still queued behind the run.
// The caller that STARTED it was held in a local closure, and callers already promoted into a rerun
// were held in another — so abandoning a wedged pass left exactly the callers who were waiting on
// it parked forever. On the owner side that is initialPublishScan: its entry in catchupInFlight
// never cleared, so every later close burned its whole bounded wait on a promise that could not
// settle.)
test('REGRESSION (FIX-CANCEL-ORPHANS): abandoning a run settles the caller that started it', async (t) => {
  const run = createCoalescingRunner({ cancelledValue: { cancelled: true } })
  const first = run('k', {}, () => new Promise(() => {}))
  run.cancel('k')
  t.alike(await first, { cancelled: true }, 'the originator is settled, not left parked')
})

test('REGRESSION (FIX-CANCEL-ORPHANS): abandoning a RERUN settles the callers it carries', async (t) => {
  const run = createCoalescingRunner({ cancelledValue: { cancelled: true } })
  let release = null
  const fn = () => new Promise((resolve) => { release = resolve })
  const first = run('k', {}, fn)
  const releaseFirst = release
  const promoted = run('k', {}, fn)      // queued behind the first run

  releaseFirst('done')
  t.is(await first, 'done')
  await sleep(5)                          // the queued caller is now carried by the rerun

  run.cancel('k')
  t.alike(await promoted, { cancelled: true }, 'a caller already promoted into the rerun settles too')
})
