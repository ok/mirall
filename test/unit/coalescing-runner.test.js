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
