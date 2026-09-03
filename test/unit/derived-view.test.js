import test from 'brittle'
import { createDerivedView } from '../../src/shared/state/derived-view.js'

// Flush microtasks + timers so a scheduled/trailing fold has run.
const tick = () => new Promise((r) => setTimeout(r, 10))

// A fake hyperbee whose watch() returns a closable async-iterable that never yields on
// its own — lets us exercise track()/close() wiring without a real store.
function fakeBee (onClose) {
  return {
    watch () {
      let release
      const until = new Promise((r) => { release = r })
      return {
        async * [Symbol.asyncIterator] () { await until }, // ends only on close
        async close () { release(); onClose?.() },
      }
    },
  }
}

test('requires fold and onChange', (t) => {
  t.exception(() => createDerivedView({ onChange: () => {} }), /fold is required/)
  t.exception(() => createDerivedView({ fold: () => {} }), /onChange is required/)
})

test('coalesces a synchronous burst into one fold', async (t) => {
  let folds = 0
  let last = null
  const dv = createDerivedView({ fold: async () => `v${++folds}`, onChange: (v) => { last = v } })

  dv.recompute(); dv.recompute(); dv.recompute()
  await tick()

  t.is(folds, 1, 'three signals in one tick → one fold')
  t.is(last, 'v1', 'onChange got the fold result')
})

test('a change mid-fold triggers exactly one trailing fold', async (t) => {
  let folds = 0
  let last = null
  let release
  const gate = new Promise((r) => { release = r })
  const dv = createDerivedView({
    fold: async () => { const n = ++folds; if (n === 1) await gate; return n },
    onChange: (v) => { last = v },
  })

  dv.recompute()
  await tick()                 // fold #1 starts, parks on the gate
  t.is(folds, 1, 'first fold in flight')

  dv.recompute(); dv.recompute() // two changes while folding → coalesce to one trailing
  release()
  await tick()

  t.is(folds, 2, 'one trailing fold, not two')
  t.is(last, 2, 'view reflects the latest state')
})

test('does not run overlapping folds (serialized)', async (t) => {
  let inFlight = 0
  let maxConcurrent = 0
  let release
  const gate = new Promise((r) => { release = r })
  const dv = createDerivedView({
    fold: async () => {
      inFlight++; maxConcurrent = Math.max(maxConcurrent, inFlight)
      await gate
      inFlight--
    },
    onChange: () => {},
  })

  dv.recompute()
  await tick()
  dv.recompute()               // would overlap if not serialized
  await tick()
  release()
  await tick(); await tick()

  t.is(maxConcurrent, 1, 'never two folds at once')
})

test('close() stops further recomputes', async (t) => {
  let calls = 0
  const dv = createDerivedView({ fold: async () => 'x', onChange: () => { calls++ } })
  await dv.close()
  dv.recompute()
  await tick()
  t.is(calls, 0, 'no fold/onChange after close')
})

test('a fold error is routed to onError, not thrown', async (t) => {
  let errs = 0
  let changes = 0
  const dv = createDerivedView({
    fold: async () => { throw new Error('boom') },
    onChange: () => { changes++ },
    onError: () => { errs++ },
  })
  dv.recompute()
  await tick()
  t.is(errs, 1, 'onError saw the failure')
  t.is(changes, 0, 'onChange not called on failure')
})

test('track is idempotent per key and close() closes every watcher', async (t) => {
  let closes = 0
  const dv = createDerivedView({ fold: async () => null, onChange: () => {} })
  const bee = fakeBee(() => { closes++ })

  dv.track('a', bee)
  dv.track('a', bee)           // duplicate key → no second watcher
  dv.track('b', bee)
  t.ok(dv.tracking('a'))
  t.is(dv.size(), 2, 'one watcher per distinct key')

  await dv.close()
  t.is(closes, 2, 'every watcher closed')
})

test('debounceMs collapses a burst spread across ticks into one fold', async (t) => {
  let folds = 0
  const dv = createDerivedView({ fold: async () => { folds++ }, onChange: () => {}, debounceMs: 30 })

  dv.recompute()
  await tick()                 // +10ms — inside the 30ms window
  dv.recompute()
  await tick()                 // +20ms — still inside
  dv.recompute()
  t.is(folds, 0, 'no fold yet — three signals coalesced within the debounce window')

  await new Promise((r) => setTimeout(r, 40))
  t.is(folds, 1, 'exactly one fold after the window, despite three signals across ticks')
  await dv.close()
})

test('debounceMs > 0 still runs exactly one trailing fold after a mid-fold change', async (t) => {
  let folds = 0
  let release
  const gate = new Promise((r) => { release = r })
  const dv = createDerivedView({
    fold: async () => { const n = ++folds; if (n === 1) await gate },
    onChange: () => {},
    debounceMs: 10,
  })

  dv.recompute()
  await new Promise((r) => setTimeout(r, 30))   // fold #1 fired and parked on the gate
  t.is(folds, 1, 'first fold in flight')
  dv.recompute(); dv.recompute()                // two changes while folding → one trailing
  release()
  await new Promise((r) => setTimeout(r, 40))
  t.is(folds, 2, 'one trailing fold, not two')
  await dv.close()
})

test('close() cancels a pending debounce timer', async (t) => {
  let folds = 0
  const dv = createDerivedView({ fold: async () => { folds++ }, onChange: () => {}, debounceMs: 30 })
  dv.recompute()
  await dv.close()
  await new Promise((r) => setTimeout(r, 50))
  t.is(folds, 0, 'no fold after close, even though a debounce timer was pending')
})

test('a watched bee change schedules a coalesced recompute', async (t) => {
  // Drive recompute via the watch loop rather than calling recompute() directly.
  let folds = 0
  let fire
  const bee = {
    watch () {
      return {
        async * [Symbol.asyncIterator] () {
          // yield once when the test fires, then end
          await new Promise((r) => { fire = r })
          yield 1
        },
        async close () {},
      }
    },
  }
  const dv = createDerivedView({ fold: async () => { folds++ }, onChange: () => {} })
  dv.track('a', bee)
  await tick()
  t.is(folds, 0, 'no fold until the bee changes')
  fire()
  await tick()
  t.is(folds, 1, 'a replicated/local change triggers a fold')
  await dv.close()
})

// A recovery abandons the fold in flight rather than awaiting it (close() awaits `inFlight`, so a
// fold that is not settling can never be closed). Without a generation guard the abandoned fold
// still runs to completion and then clears the LIVE fold's `running` flag and publishes its own
// superseded result — un-serialising two folds, which is what the flag exists to prevent.
test('REGRESSION (FIX-SUP-2a: an abandoned fold cleared the live fold\'s running flag)', async (t) => {
  let releaseFirst = null
  let folds = 0
  const view = createDerivedView({
    fold: () => {
      folds += 1
      if (folds === 1) return new Promise((resolve) => { releaseFirst = () => resolve('stale') })
      return new Promise(() => {})
    },
    onChange: () => {},
  })

  view.recompute()
  await tick()
  t.is(folds, 1)

  view.abandon()
  view.recompute()
  await tick()
  t.is(folds, 2, 'a fresh fold started')

  releaseFirst()
  await tick()

  view.recompute()
  await tick()
  t.is(folds, 2, 'the live fold still holds the lane — the stale settle did not release it')
  // close() awaits the fold in flight, and this one never settles — abandoning first is exactly
  // what the recovery path does.
  view.abandon()
  await view.close()
})

test('REGRESSION (FIX-SUP-2b: an abandoned fold published a stale view after the fresh one)', async (t) => {
  const seen = []
  let releaseFirst = null
  let folds = 0
  const view = createDerivedView({
    fold: () => {
      folds += 1
      if (folds === 1) return new Promise((resolve) => { releaseFirst = () => resolve('stale') })
      return Promise.resolve('fresh')
    },
    onChange: (v) => seen.push(v),
  })

  view.recompute()
  await tick()
  view.abandon()
  view.recompute()
  await tick()
  t.alike(seen, ['fresh'])

  releaseFirst()
  await tick()
  t.alike(seen, ['fresh'], 'the abandoned fold published nothing after the fold that replaced it')
  await view.close()
})

test('abandon() does not await the fold in flight', async (t) => {
  const view = createDerivedView({ fold: () => new Promise(() => {}), onChange: () => {} })
  view.recompute()
  await tick()
  view.abandon()
  t.pass('returned against a promise that never settles')
  await view.close()
})

test('an abandoned fold does not fire the trailing recompute it queued', async (t) => {
  let releaseFirst = null
  let folds = 0
  const view = createDerivedView({
    fold: () => {
      folds += 1
      if (folds === 1) return new Promise((resolve) => { releaseFirst = () => resolve(null) })
      return new Promise(() => {})
    },
    onChange: () => {},
  })

  view.recompute()
  await tick()
  view.recompute()
  t.is(folds, 1, 'the second change is queued as a trailing fold')

  view.abandon()
  releaseFirst()
  await tick()
  t.is(folds, 1, 'the abandoned fold ran no trailing fold of its own')
  await view.close()
})

test('health reports idle, advancing and stalled folds', async (t) => {
  let release = null
  const view = createDerivedView({
    fold: () => new Promise((resolve) => { release = resolve }),
    onChange: () => {},
  })
  t.is(view.health({ now: Date.now(), windowMs: 1000 }).ok, true, 'idle between folds')

  view.recompute()
  await tick()
  const now = Date.now()
  t.is(view.health({ now, windowMs: 1000 }).ok, true, 'a fold that just started is healthy')
  t.is(view.health({ now: now + 5000, windowMs: 1000 }).ok, false, 'no progress past the window is stalled')

  view.noteProgress()
  t.is(view.health({ now: Date.now() + 500, windowMs: 1000 }).ok, true, 'progress resets the stall clock')

  release(null)
  await tick()
  t.is(view.health({ now: Date.now() + 5000, windowMs: 1000 }).ok, true, 'and a settled fold is idle again')
  await view.close()
})

test('noteProgress does nothing while no fold is in flight', async (t) => {
  const view = createDerivedView({ fold: async () => null, onChange: () => {} })
  view.noteProgress()
  t.is(view.health({ now: Date.now(), windowMs: 1000 }).ok, true)
  await view.close()
})
