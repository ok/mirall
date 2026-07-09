import test from 'brittle'
import { makeCaptureScheduler } from '../../src/shared/spaces/bee-capture.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

function harness ({ retryMinMs = 1000 } = {}) {
  const calls = []
  let clock = 0
  let length = 3
  let result = { complete: true, capped: false, contiguous: 3, length: 3 }
  let release = null
  const sched = makeCaptureScheduler({
    capture: (key) => {
      calls.push(key)
      return new Promise((resolve) => { release = () => resolve(result) })
    },
    coreLength: async () => length,
    retryMinMs,
    now: () => clock,
  })
  return {
    sched,
    calls,
    // capture is invoked on a microtask after schedule() — wait for it to arm
    release: async () => { while (!release) await tick(); const r = release; release = null; r() },
    setClock: (v) => { clock = v },
    setLength: (v) => { length = v },
    setResult: (v) => { result = v },
  }
}

test('single-flight: a second schedule during a pending capture is a no-op', async (t) => {
  const h = harness()
  t.ok(h.sched.schedule('k'))
  t.absent(h.sched.schedule('k'), 'in-flight dedup')
  await h.release()
  await tick()
  t.is(h.calls.length, 1)
  t.absent((await h.sched.incomplete()).includes('k'), 'complete capture leaves no deficit')
})

test('throttle: an incomplete capture retries only after retryMinMs (unless the core grew)', async (t) => {
  const h = harness({ retryMinMs: 1000 })
  h.setResult({ complete: false, capped: false, contiguous: 1, length: 3 })
  t.ok(h.sched.schedule('k'))
  await h.release()
  await tick()
  t.ok((await h.sched.incomplete()).includes('k'), 'incomplete capture stays a deficit')

  h.setClock(500)
  t.absent(h.sched.schedule('k'), 'throttled inside the window')
  h.setLength(9)
  await h.sched.incomplete()                       // refreshes knownLength
  t.ok(h.sched.schedule('k'), 'growth bypasses the throttle')
  h.setResult({ complete: false, capped: false, contiguous: 9, length: 9 })
  await h.release()
  await tick()

  h.setClock(600)
  await h.sched.incomplete()
  t.absent(h.sched.schedule('k'), 'still throttled with no further growth')
  h.setClock(2000)
  t.ok(h.sched.schedule('k'), 'retries after the window')
  await h.release()
  await tick()
  t.is(h.calls.length, 3)
})

test('a completed capture re-arms when the core grows', async (t) => {
  const h = harness()
  t.ok(h.sched.schedule('k'))
  await h.release()
  await tick()
  t.absent(h.sched.schedule('k'), 'complete + unchanged → no-op')

  h.setLength(10)
  t.ok((await h.sched.incomplete()).includes('k'), 'growth surfaces as a deficit')
  t.ok(h.sched.schedule('k'), 'growth re-arms the capture')
})

// A bee larger than the sweep cap is as captured as it will ever be: it must retire like a
// complete one, or the tick re-sweeps it every window for the worker's lifetime.
test('a capped capture retires — no permanent deficit, but growth still re-arms', async (t) => {
  const h = harness({ retryMinMs: 1000 })
  h.setResult({ complete: false, capped: true, contiguous: 4096, length: 5000 })
  h.setLength(5000)
  t.ok(h.sched.schedule('k'))
  await h.release()
  await tick()

  t.alike(await h.sched.incomplete(), [], 'capped key is retired, not a standing deficit')
  h.setClock(5000)
  t.absent(h.sched.schedule('k'), 'never retried on the tick')

  h.setLength(5100)
  t.ok((await h.sched.incomplete()).includes('k'), 'a grown capped bee is worth another sweep')
})

test('a never-replicated bee (length 0) stays a throttled deficit', async (t) => {
  const h = harness({ retryMinMs: 1000 })
  h.setResult({ complete: false, capped: false, contiguous: 0, length: 0 })
  h.setLength(0)
  t.ok(h.sched.schedule('k'))
  await h.release()
  await tick()
  t.ok((await h.sched.incomplete()).includes('k'), 'still worth retrying — the bee may yet replicate')
  h.setClock(500)
  t.absent(h.sched.schedule('k'), 'but only under the throttle')
})

test('forget(key) drops one key; clear() drops all state', async (t) => {
  const h = harness({ retryMinMs: 1000 })
  h.setResult({ complete: false, capped: false, contiguous: 0, length: 0 })
  t.ok(h.sched.schedule('a'))
  await h.release()
  await tick()
  t.ok((await h.sched.incomplete()).includes('a'))

  h.sched.forget('a')
  t.alike(await h.sched.incomplete(), [], 'forgotten key no longer tracked')

  t.ok(h.sched.schedule('b'))
  await h.release()
  await tick()
  h.sched.clear()
  t.alike(await h.sched.incomplete(), [], 'no deficits after clear')
})

test('a throwing capture is recorded via onError and stays a deficit', async (t) => {
  const errors = []
  let clock = 0
  const sched = makeCaptureScheduler({
    capture: async () => { throw new Error('boom') },
    coreLength: async () => 3,
    retryMinMs: 100,
    now: () => clock,
    onError: (key, err) => errors.push([key, err.message]),
  })
  t.ok(sched.schedule('k'))
  await tick()
  t.alike(errors, [['k', 'boom']])
  t.ok((await sched.incomplete()).includes('k'))
  clock = 200
  t.ok(sched.schedule('k'), 'failed capture retries after the window')
})
