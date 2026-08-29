import test from 'brittle'
import { createTimers } from '../../src/shared/core/timers.js'
import { Subsystem, createLifecycle } from '../../src/shared/core/subsystem.js'

const quiet = { debug () {}, info () {}, warn () {}, error () {} }
const tick = () => new Promise((r) => setImmediate(r))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('createTimers: close() clears everything, is idempotent, and rejects scheduling afterwards', async (t) => {
  const timers = createTimers()
  let fired = 0
  const done = timers.setTimeout(() => {}, 1)
  await sleep(15)
  t.is(timers.size, 0, 'a timeout that fired is no longer tracked')
  timers.clear(done)                    // clearing a fired handle is harmless

  // clear() on a LIVE handle actually cancels it — the case the fired-handle line above cannot
  // prove, and the one every caller relies on.
  const live = timers.setInterval(() => fired++, 1)
  t.is(timers.size, 1)
  timers.clear(live)
  t.is(timers.size, 0)
  await sleep(15)
  t.is(fired, 0, 'a cleared interval never fired')

  timers.setInterval(() => fired++, 1)
  timers.setTimeout(() => fired++, 1)
  t.is(timers.size, 2)
  timers.close()
  t.is(timers.size, 0)
  await sleep(20)
  t.is(fired, 0, 'nothing fired after close')
  timers.close()
  t.ok(timers.closed, 'second close is a no-op')
  t.exception(() => timers.setTimeout(() => {}, 1), /after close/)
  t.exception(() => timers.setInterval(() => {}, 1), /after close/)
})

class Probe extends Subsystem {
  constructor (name, deps, trace) { super(name, deps); this.trace = trace }
  async _open () { this.trace.push('open:' + this.name); this.timers.setInterval(() => {}, 1) }
  async _close () { this.trace.push('close:' + this.name) }
}

test('Subsystem: close() twice is safe, flips stopping synchronously, and clears its timers', async (t) => {
  const trace = []
  const s = new Probe('a', {}, trace)
  await s.ready()
  t.is(s.timers.size, 1)
  t.absent(s.stopping)
  const first = s.close()
  t.ok(s.stopping, 'true synchronously after close() — the flag async continuations check')
  await Promise.all([first, s.close()])
  t.alike(trace, ['open:a', 'close:a'], '_close ran once')
  t.is(s.timers.size, 0)
  t.ok(s.timers.closed)
})

// This is the whole reason the base clears on the 'close' EVENT and not in _close: ReadyResource
// starts close() in the background after a failed _open but never runs _close, so anything armed
// before the throw would otherwise be unreachable forever.
test('Subsystem: a failed _open still clears the timers it armed', async (t) => {
  class Broken extends Subsystem {
    async _open () { this.timers.setInterval(() => {}, 1); throw new Error('boom') }
  }
  const s = new Broken('broken')
  await t.exception(s.ready(), /boom/)
  await tick()
  t.ok(s.closed, 'ReadyResource closed it in the background')
  t.is(s.timers.size, 0, 'the interval armed before the throw is gone even though _close never ran')
})

test('Subsystem: ready() after close() is a no-op — a closed subsystem is never reopened', async (t) => {
  const trace = []
  const s = new Probe('once', {}, trace)
  await s.ready()
  await s.close()
  await s.ready()
  t.alike(trace, ['open:once', 'close:once'], '_open did not run a second time')
  t.ok(s.closed, 'it stays closed — a restart constructs a new instance')
})

test('Subsystem: close() while opening waits for _open, then runs _close', async (t) => {
  const trace = []
  class Slow extends Probe { async _open () { await sleep(20); return super._open() } }
  const s = new Slow('slow', {}, trace)
  const opening = s.ready()
  await s.close()
  await opening
  t.alike(trace, ['open:slow', 'close:slow'], 'no close-before-open window')
})

// The budget exists because several real _closes wait (bounded) for in-flight work; without it a
// single slow drain starves everything after it in the reverse-order sequence.
test('createLifecycle: a slow close is abandoned so the rest of the sequence still runs', async (t) => {
  const trace = []
  class Slow extends Probe { async _close () { trace.push('close:' + this.name); await sleep(5000) } }
  const life = createLifecycle({ log: quiet })
  await life.start(new Probe('a', {}, trace))
  await life.start(new Slow('slow', {}, trace))
  await life.start(new Probe('c', {}, trace))
  const t0 = Date.now()
  await life.close({ deadlineAt: Date.now() + 150 })
  t.ok(Date.now() - t0 < 1000, 'the sequence did not wait out the slow close (' + (Date.now() - t0) + 'ms)')
  t.alike(trace, ['open:a', 'open:slow', 'open:c', 'close:c', 'close:slow'],
    'the slow one was entered and abandoned; "a" is past the spent budget and skipped')
})

test('Subsystem: require() names the missing collaborator', (t) => {
  class Needs extends Subsystem { constructor (deps) { super('needs', deps); this.require('ipc', 'store') } }
  t.exception(() => new Needs({ ipc: {} }), /needs: missing dep "store"/)
  t.execution(() => new Needs({ ipc: {}, store: {} }))
  t.exception(() => new Subsystem(''), /name is required/)
})

// A _close that REJECTS short-circuits ReadyResource's `closed = true` and its 'close' emit, so
// the event handler never runs. Without close()'s own finally the subsystem would come back from
// life.close() with its interval still firing and nothing but a warn line to say so.
test('Subsystem: a _close that throws still clears the timers', async (t) => {
  class Throws extends Subsystem {
    async _open () { this.timers.setInterval(() => {}, 1) }
    async _close () { throw new Error('nope') }
  }
  const s = new Throws('throws')
  await s.ready()
  t.is(s.timers.size, 1)
  await t.exception(s.close(), /nope/)
  t.ok(s.timers.closed, 'the timer set is closed even though the close rejected')
  t.is(s.timers.size, 0)
})

test('createLifecycle: closes in the reverse of start order and survives one failure', async (t) => {
  const trace = []
  class Bad extends Probe { async _close () { trace.push('close:' + this.name); throw new Error('nope') } }
  const life = createLifecycle({ log: quiet })
  await life.start(new Probe('a', {}, trace))
  const bad = await life.start(new Bad('b', {}, trace))
  await life.start(new Probe('c', {}, trace))
  t.is(life.started.length, 3)
  await life.close()
  t.ok(bad.timers.closed, 'the failing subsystem still had its timers cleared')
  t.alike(trace, ['open:a', 'open:b', 'open:c', 'close:c', 'close:b', 'close:a'])
  t.is(life.started.length, 0)
  await life.close()
  t.is(trace.length, 6, 'a second close() closes nothing twice')
})
