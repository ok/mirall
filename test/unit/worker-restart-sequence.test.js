import test from 'brittle'
import { RESTART_STEPS, createWorkerRestart } from '../../src/main/lifecycle.js'

const SPEC = '/src/worker/main.js'

function recorder({ quitting = false, stopFails = false } = {}) {
  const calls = []
  let quit = quitting
  let release = null
  const restart = createWorkerRestart({
    stopWorker: (spec) => {
      calls.push('stop-worker:' + spec)
      if (stopFails) return Promise.reject(new Error('stop failed'))
      return new Promise((resolve) => { release = resolve })
    },
    spawnWorker: (spec) => { calls.push('spawn-worker:' + spec) },
    isQuitting: () => quit,
  })
  return { restart, calls, finishStop: () => release?.(), setQuitting: (v) => { quit = v } }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('RESTART_STEPS is the declared order', (t) => {
  t.alike([...RESTART_STEPS], ['stop-worker', 'spawn-worker'])
})

test('the spawn waits for the stop', async (t) => {
  const { restart, calls, finishStop } = recorder()
  const running = restart(SPEC)
  await tick()
  t.alike(calls, ['stop-worker:' + SPEC], 'two workers on one store is a lock error at best')
  finishStop()
  t.is(await running, true)
  t.alike(calls, ['stop-worker:' + SPEC, 'spawn-worker:' + SPEC])
})

test('a second request joins the first rather than racing it', async (t) => {
  const { restart, calls, finishStop } = recorder()
  const a = restart(SPEC)
  const b = restart(SPEC)
  t.is(a, b, 'the same promise — two restarts would stop the worker the other just spawned')
  finishStop()
  t.alike(await Promise.all([a, b]), [true, true])
  t.is(calls.filter((c) => c.startsWith('spawn')).length, 1)
})

test('a restart after the previous one finished runs again', async (t) => {
  const { restart, calls, finishStop } = recorder()
  const first = restart(SPEC)
  finishStop()
  await first
  const second = restart(SPEC)
  finishStop()
  await second
  t.is(calls.filter((c) => c.startsWith('stop')).length, 2, 'the in-flight entry was released')
})

test('a quit refuses the restart outright', async (t) => {
  const { restart, calls } = recorder({ quitting: true })
  t.is(await restart(SPEC), false)
  t.alike(calls, [], 'neither step runs')
})

test('a quit that begins mid-restart prevents the spawn', async (t) => {
  const { restart, calls, finishStop, setQuitting } = recorder()
  const running = restart(SPEC)
  await tick()
  setQuitting(true)
  finishStop()
  t.is(await running, false)
  t.alike(calls, ['stop-worker:' + SPEC], 'spawning into a quit leaves the orphan stop-workers prevents')
})

test('a failed stop clears the in-flight entry so a later attempt runs', async (t) => {
  const { restart, calls } = recorder({ stopFails: true })
  await t.exception(restart(SPEC))
  await t.exception(restart(SPEC))
  t.is(calls.length, 2, 'not wedged on a promise that already rejected')
})
