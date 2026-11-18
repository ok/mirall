import test from 'brittle'
import { timedJob, setJobObserver } from '../../src/shared/core/job-timing.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Holds the thread, as a job that never awaits does.
function block(ms) {
  const end = performance.now() + ms
  while (performance.now() < end) { /* busy */ }
}

function observed(t) {
  const seen = []
  setJobObserver((job, ms) => seen.push([job, ms]))
  t.teardown(() => setJobObserver(null))
  return seen
}

test('with nobody listening a job runs untouched', async (t) => {
  t.is(timedJob('presence-sweep', () => 7), 7)
  const pending = Promise.resolve(8)
  t.is(timedJob('presence-sweep', () => pending), pending, 'the very promise, not a wrapper')
})

test('a job that ran long is reported with its name and its time, a quick one is not', async (t) => {
  const seen = observed(t)
  t.is(timedJob('echo-purge', () => 1), 1)
  t.is(await timedJob('mount-probe', () => Promise.resolve(2)), 2)
  t.alike(seen, [], 'neither took long')

  t.is(await timedJob('presence-sweep', async () => { await sleep(80); return 3 }), 3)
  t.is(seen.length, 1)
  t.is(seen[0][0], 'presence-sweep')
  t.ok(seen[0][1] >= 70, 'the time from start to settlement')

  timedJob('download-root-probe', () => block(70))
  t.is(seen[1][0], 'download-root-probe', 'a job that blocked without ever awaiting')
})

test('a failing job still fails the same way, and is still reported', async (t) => {
  const seen = observed(t)
  await t.exception(() => timedJob('index-maintain', async () => { await sleep(80); throw new Error('disk gone') }), /disk gone/)
  t.exception(() => timedJob('echo-purge', () => { block(70); throw new Error('boom') }), /boom/)
  t.alike(seen.map(([job]) => job), ['index-maintain', 'echo-purge'])
})

test('an observer that throws does not fail the job', async (t) => {
  setJobObserver(() => { throw new Error('trace file gone') })
  t.teardown(() => setJobObserver(null))
  t.is(await timedJob('presence-sweep', async () => { await sleep(80); return 4 }), 4)
})
