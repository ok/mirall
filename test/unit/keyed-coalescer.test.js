import test from 'brittle'
import { makeKeyedCoalescer } from '../../src/shared/state/coalesce.js'

function manualTimers () {
  const pending = []
  return {
    schedule: (fn) => { const id = { fn }; pending.push(id); return id },
    clear: (id) => { const i = pending.indexOf(id); if (i >= 0) pending.splice(i, 1) },
    flush: () => { for (const id of pending.splice(0)) id.fn() },
    size: () => pending.length,
  }
}

test('keyed coalescer: leading edge fires immediately, a burst coalesces to one trailing', (t) => {
  const fired = []
  const timers = manualTimers()
  const c = makeKeyedCoalescer((k) => fired.push(k), { schedule: timers.schedule, clear: timers.clear })
  c.poke('S1')
  c.poke('S1')
  c.poke('S1')
  t.alike(fired, ['S1'], 'only the leading edge has fired')
  timers.flush()
  t.alike(fired, ['S1', 'S1'], 'one trailing fire for the burst')
})

test('keyed coalescer: a lone poke fires once, no trailing', (t) => {
  const fired = []
  const timers = manualTimers()
  const c = makeKeyedCoalescer((k) => fired.push(k), { schedule: timers.schedule, clear: timers.clear })
  c.poke('S1')
  timers.flush()
  t.alike(fired, ['S1'])
})

test('keyed coalescer: distinct keys do not coalesce together', (t) => {
  const fired = []
  const timers = manualTimers()
  const c = makeKeyedCoalescer((k) => fired.push(k), { schedule: timers.schedule, clear: timers.clear })
  c.poke('S1')
  c.poke('S2')
  c.poke('S1')
  t.alike(fired, ['S1', 'S2'], 'each key fires its own leading edge; the repeat coalesces')
  timers.flush()
  t.alike(fired, ['S1', 'S2', 'S1'])
})

test('keyed coalescer: multi-arg keyOf carries the args through to fire', (t) => {
  const fired = []
  const timers = manualTimers()
  const c = makeKeyedCoalescer((spaceId, shareId) => fired.push(spaceId + '/' + shareId), {
    keyOf: (spaceId, shareId) => spaceId + '|' + shareId,
    schedule: timers.schedule,
    clear: timers.clear,
  })
  c.poke('S1', 'A')
  c.poke('S1', 'B')
  c.poke('S1', 'A')
  t.alike(fired, ['S1/A', 'S1/B'])
  timers.flush()
  t.alike(fired, ['S1/A', 'S1/B', 'S1/A'])
})

test('keyed coalescer: flush fires immediately and resets the open window', (t) => {
  const fired = []
  const timers = manualTimers()
  const c = makeKeyedCoalescer((k) => fired.push(k), { schedule: timers.schedule, clear: timers.clear })
  c.poke('S1')
  c.poke('S1')
  c.flush('S1')
  t.alike(fired, ['S1', 'S1'], 'flush fires despite the open window')
  timers.flush()
  t.alike(fired, ['S1', 'S1'], 'the cleared window leaves no trailing fire')
})

test('keyed coalescer: reset clears every open window without firing', (t) => {
  const fired = []
  const timers = manualTimers()
  const c = makeKeyedCoalescer((k) => fired.push(k), { schedule: timers.schedule, clear: timers.clear })
  c.poke('S1')
  c.poke('S2')
  c.poke('S1')
  c.reset()
  t.is(timers.size(), 0, 'timers cleared')
  timers.flush()
  t.alike(fired, ['S1', 'S2'], 'no trailing fires after reset')
  c.poke('S1')
  t.alike(fired, ['S1', 'S2', 'S1'], 'a poke after reset opens a fresh leading edge')
})

// The injected schedule is how a caller hands the trailing timer to an owner that can stop it, and
// an owner that has gone declines rather than arming something nothing will clear. The window must
// then not open at all: a key left open with no timer swallows every later poke for it, which is a
// far worse failure than the timer it was avoiding.
test('a declined schedule fires every poke instead of opening a window nothing can close', (t) => {
  const fired = []
  const engine = makeKeyedCoalescer((x) => fired.push(x), {
    intervalMs: 500,
    schedule: () => null,
    clear: () => {},
  })

  engine.poke('a')
  engine.poke('a')
  engine.poke('a')
  t.alike(fired, ['a', 'a', 'a'], 'no window opened, so nothing was collapsed into a fire that never comes')
})

test('a granted schedule still coalesces, and the handle is the one the owner returned', (t) => {
  const fired = []
  const armed = []
  const cleared = []
  const handle = { owned: true }
  const engine = makeKeyedCoalescer((x) => fired.push(x), {
    intervalMs: 500,
    schedule: (fn, ms) => { armed.push({ fn, ms }); return handle },
    clear: (h) => cleared.push(h),
  })

  engine.poke('a')
  engine.poke('a')
  t.alike(fired, ['a'], 'the second poke collapsed into the open window')
  t.is(armed.length, 1, 'one trailing timer, armed through the injected schedule')

  engine.reset()
  t.alike(cleared, [handle], 'and reset returned that same handle to the owner')
})
