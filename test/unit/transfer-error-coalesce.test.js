import test from 'brittle'
import { createCoalescer } from '../../src/renderer/notifications/coalesce.js'

const WINDOW = 3000
const CAP = 10_000

function fakeTimers() {
  let t = 0
  let nextId = 1
  const timers = new Map()
  return {
    now: () => t,
    setTimer: (fn, ms) => { timers.set(nextId, { at: t + ms, fn }); return nextId++ },
    clearTimer: (id) => { timers.delete(id) },
    pending: () => timers.size,
    advance(ms) {
      const end = t + ms
      for (;;) {
        let due = null
        for (const [id, timer] of timers) if (timer.at <= end && (!due || timer.at < due[1].at)) due = [id, timer]
        if (!due) break
        timers.delete(due[0])
        t = due[1].at
        due[1].fn()
      }
      t = end
    },
  }
}

function setup() {
  const clock = fakeTimers()
  const events = []
  const coalescer = createCoalescer({
    windowMs: WINDOW,
    capMs: CAP,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onLeading: (ep) => events.push(['leading', ep.seq, ep.count, ep.data]),
    onSummary: (ep) => events.push(['summary', ep.seq, ep.count, ep.data]),
  })
  return { coalescer, clock, events }
}

// REGRESSION (FIX-447: one OS notification per file). A folder download into a read-only folder
// raised one critical notification per file; a burst of the same fault in one space is one
// notification, re-shown once with the count.
test('a burst of one fault in one space leads once, then summarises its count at quiet', (t) => {
  const { coalescer, clock, events } = setup()
  for (let i = 0; i < 20; i++) {
    coalescer.hit('s1:PERM', 'file' + i, i)
    clock.advance(100)
  }
  t.alike(events, [['leading', 1, 1, 0]], 'only the first failure is reported at once')
  clock.advance(WINDOW)
  t.alike(events, [['leading', 1, 1, 0], ['summary', 1, 20, 19]])
  t.is(clock.pending(), 0, 'the ended episode holds no timer')
})

test('a retry of the same transfer is not another file', (t) => {
  const { coalescer, clock, events } = setup()
  for (let i = 0; i < 5; i++) coalescer.hit('s1:PERM', 'same', i)
  clock.advance(WINDOW)
  t.alike(events, [['leading', 1, 1, 0]], 'nothing to summarise')
})

test('another fault or another space is its own episode', (t) => {
  const { coalescer, events } = setup()
  coalescer.hit('s1:PERM', 'a', 'x')
  coalescer.hit('s1:DISK', 'a', 'y')
  coalescer.hit('s2:PERM', 'a', 'z')
  coalescer.hit('s1:PERM', 'b', 'w')
  t.alike(events.map(([kind, seq]) => [kind, seq]), [['leading', 1], ['leading', 2], ['leading', 3]])
})

test('a failure after a quiet gap opens a new episode', (t) => {
  const { coalescer, clock, events } = setup()
  coalescer.hit('s1:PERM', 'a', 1)
  clock.advance(WINDOW)
  coalescer.hit('s1:PERM', 'b', 2)
  t.alike(events, [['leading', 1, 1, 1], ['leading', 2, 1, 2]])
})

test('a stream longer than the cap reports cumulatively, never as a new episode', (t) => {
  const { coalescer, clock, events } = setup()
  for (let i = 0; i < 25; i++) {
    coalescer.hit('s1:PERM', 'file' + i, i)
    clock.advance(1000)
  }
  clock.advance(WINDOW)
  t.alike(events.map(([kind, seq, count]) => [kind, seq, count]), [
    ['leading', 1, 1],
    ['summary', 1, 10],
    ['summary', 1, 20],
    ['summary', 1, 25],
  ])
  t.is(clock.pending(), 0)
})

test('close drops every pending summary', (t) => {
  const { coalescer, clock, events } = setup()
  coalescer.hit('s1:PERM', 'a', 1)
  coalescer.hit('s1:PERM', 'b', 2)
  coalescer.close()
  t.is(clock.pending(), 0)
  clock.advance(CAP)
  t.is(events.length, 1)
})
