import test from 'brittle'
import { createMirrorLoops } from '../../src/shared/folders/mirror-loop.js'

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
const settle = () => new Promise((r) => setImmediate(r))
const NEVER = () => ({ intervalMs: () => 1e9 })

test('a tick arriving mid-pass coalesces into exactly one follow-up', async (t) => {
  let started = 0
  const gate = deferred()
  const loops = createMirrorLoops({ ...NEVER(), runPass: async () => { started++; await gate.promise } })

  const first = loops.tick('k', {})
  loops.tick('k', {})
  loops.tick('k', {})
  loops.tick('k', {})
  t.is(started, 1, 'the three later requests joined the pass in flight')

  gate.resolve()
  await first
  await settle()
  t.is(started, 2, 'and produced exactly ONE follow-up, not three')
})

// REGRESSION (FIX-MIRROR-ADOPT: an adopted pass — the boot materialize scan — was tracked without a
// ctx, and the settle read `dirty.delete(key) && ctx`. That CONSUMED the coalesced follow-up and
// then dropped it, so a resume or a catalog change landing during the initial scan did nothing at
// all and the mirror sat idle until the next poll interval.)
test('REGRESSION (FIX-MIRROR-ADOPT): a tick arriving during an adopted pass still runs after it', async (t) => {
  let started = 0
  const gate = deferred()
  const loops = createMirrorLoops({ ...NEVER(), runPass: async () => { started++ } })

  const adopted = loops.adopt('k', gate.promise, { spaceId: 'sp', shareId: 'sh' })
  loops.tick('k', { spaceId: 'sp', shareId: 'sh' })
  t.is(started, 0, 'the request joined the adopted pass rather than starting a second one')

  gate.resolve()
  await adopted
  await settle()
  t.is(started, 1, 'and ran once the adopted pass settled')
})

test('a request arriving mid-pass gets the pass in flight, not a fresh one', async (t) => {
  const gate = deferred()
  const loops = createMirrorLoops({ ...NEVER(), runPass: async () => { await gate.promise } })
  const a = loops.tick('k', {})
  const b = loops.tick('k', {})
  t.is(a, b, 'the same promise — a caller that awaits observes the running pass')
  gate.resolve()
  await a
})

// The cancellation contract every long pass depends on.
test('a stop invalidates the pass in flight without waiting for it', async (t) => {
  const gate = deferred()
  let sawStopped = null
  const loops = createMirrorLoops({
    ...NEVER(),
    runPass: async (ctx) => { await gate.promise; sawStopped = loops.stopped('k', ctx.gen) },
  })
  const p = loops.tick('k', { gen: loops.generationOf('k') })
  loops.stop('k')
  gate.resolve()
  await p
  t.is(sawStopped, true, 'the pass can see it was cancelled and bail before writing')
})

test('the stop hook receives the key and its options', (t) => {
  const seen = []
  const loops = createMirrorLoops({ ...NEVER(), runPass: async () => {}, onStop: (key, opts) => seen.push([key, opts]) })
  loops.stop('k')
  loops.stop('k', { discardPartial: true })
  t.alike(seen, [['k', {}], ['k', { discardPartial: true }]], 'a pause and an unmount are distinguishable')
})

test('a stop does not clear the in-flight pass, so a bulk stop can await its tail', async (t) => {
  const gate = deferred()
  const loops = createMirrorLoops({ ...NEVER(), runPass: async () => { await gate.promise } })
  const p = loops.tick('k', {})
  loops.stop('k')
  const bulk = loops.stopAll({ settleMs: 5000 })
  gate.resolve()
  await t.execution(bulk, 'the bulk stop waited for the tail it could see')
  await p
})

test('stopAll returns at once when nothing is in flight', async (t) => {
  const loops = createMirrorLoops({ ...NEVER(), runPass: async () => {} })
  loops.start('k', { spaceId: 's', shareId: 'sh' })
  await t.execution(loops.stopAll({ settleMs: 5000 }))
  t.is(loops.entries().length, 0, 'and the loop is disarmed')
})

// The wedge the mirror recovery exists for: a pass that never settles must not capture every
// later tick.
test('restart abandons a hung pass instead of coalescing onto it', async (t) => {
  let started = 0
  const loops = createMirrorLoops({ ...NEVER(), runPass: async () => { started++; await new Promise(() => {}) } })
  loops.tick('k', {})
  t.is(started, 1)
  loops.tick('k', {})
  t.is(started, 1, 'the hung pass captured it — this is the wedge')
  loops.restart('k', { spaceId: 's', shareId: 'sh' })
  t.is(started, 2, 'restart dropped the dead promise and armed a fresh pass')
})

test('a stale pass settling after a restart does not disturb the live one', async (t) => {
  const first = deferred()
  const second = deferred()
  let n = 0
  const loops = createMirrorLoops({ ...NEVER(), runPass: async () => { await (n++ === 0 ? first : second).promise } })
  loops.tick('k', {})
  loops.restart('k', { spaceId: 's', shareId: 'sh' })
  first.resolve()
  await settle()
  loops.tick('k', {})
  t.is(n, 2, 'the live pass still owns the key — the stale settle deleted nothing')
  second.resolve()
})

test('the debounce collapses a burst into one delayed tick', async (t) => {
  let started = 0
  const loops = createMirrorLoops({ ...NEVER(), runPass: async () => { started++ } })
  for (let i = 0; i < 5; i++) loops.debounce('k', {}, 10)
  await new Promise((r) => setTimeout(r, 60))
  t.is(started, 1)
})

test('a stop disarms a debounced tick that has not fired', async (t) => {
  let started = 0
  const loops = createMirrorLoops({ ...NEVER(), runPass: async () => { started++ } })
  loops.debounce('k', {}, 20)
  loops.stop('k')
  await new Promise((r) => setTimeout(r, 60))
  t.is(started, 0, 'a pause between the append and its tick cancels the tick')
})

test('keys are independent', async (t) => {
  const seen = []
  const loops = createMirrorLoops({ ...NEVER(), runPass: async (ctx) => { seen.push(ctx.shareId) } })
  await Promise.all([loops.tick('a', { shareId: 'a' }), loops.tick('b', { shareId: 'b' })])
  t.alike(seen.sort(), ['a', 'b'])
})

test('a pass that rejects still releases the key', async (t) => {
  let started = 0
  const loops = createMirrorLoops({
    ...NEVER(),
    runPass: async () => { started++; throw new Error('boom') },
    onError: () => {},
  })
  await loops.tick('k', {}).catch(() => {})
  await loops.tick('k', {}).catch(() => {})
  t.is(started, 2, 'a rejected pass is not a permanent wedge')
})

test('a pass that throws synchronously is still a rejected promise, not a throw', async (t) => {
  const loops = createMirrorLoops({ ...NEVER(), runPass: () => { throw new Error('sync boom') }, onError: () => {} })
  let caught = null
  await t.execution(() => { loops.tick('k', {}).catch((e) => { caught = e }) }, 'the call itself does not throw')
  await settle()
  t.is(caught?.message, 'sync boom')
  await loops.tick('k', {}).catch(() => {})
  t.is(loops.liveness('k').startedAt, 0, 'and the key is released')
})

test('entries reports only mounts with a live loop', (t) => {
  const loops = createMirrorLoops({ ...NEVER(), runPass: async () => {} })
  loops.start('s:a', { spaceId: 's', shareId: 'a' })
  loops.start('s:b', { spaceId: 's', shareId: 'b' })
  t.alike(loops.entries().map((e) => e.shareId).sort(), ['a', 'b'])
  loops.stop('s:a')
  t.alike(loops.entries().map((e) => e.shareId), ['b'], 'a stopped mount is not reported')
})

test('start is idempotent for a key that already has a loop', (t) => {
  let armed = 0
  const loops = createMirrorLoops({ intervalMs: () => { armed++; return 1e9 }, runPass: async () => {} })
  loops.start('k', { spaceId: 's', shareId: 'sh' })
  loops.start('k', { spaceId: 's', shareId: 'sh' })
  t.is(armed, 1, 'a second start does not arm a second interval')
  t.is(loops.entries().length, 1)
})

test('the generation advances once per stop', (t) => {
  const loops = createMirrorLoops({ ...NEVER(), runPass: async () => {} })
  t.is(loops.generationOf('k'), 0, 'a key never stopped reads generation 0')
  t.is(loops.stopped('k', 0), false)
  loops.stop('k')
  t.is(loops.generationOf('k'), 1)
  t.is(loops.stopped('k', 0), true, 'a pass that captured 0 now knows to bail')
  t.is(loops.stopped('k', 1), false, 'while a pass started after the stop keeps running')
})
