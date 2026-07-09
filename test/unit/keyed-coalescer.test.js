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
