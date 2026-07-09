import test from 'brittle'
import { makeCoalescer } from '../../src/renderer/coalesce.js'

function fakeClock() {
  let now = 0
  const timers = new Map()
  let id = 1
  const schedule = (fn, ms) => { const tid = id++; timers.set(tid, { fn, at: now + ms }); return tid }
  const clear = (tid) => timers.delete(tid)
  const advance = (ms) => {
    now += ms
    for (const [tid, tmr] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (tmr.at <= now) { timers.delete(tid); tmr.fn() }
    }
  }
  return { schedule, clear, advance }
}

// REGRESSION (FIX-131: every catalog append fired an un-debounced full re-list, a storm during a
// large index. The coalescer collapses a burst into a leading + single trailing call.)
test('REGRESSION (FIX-131): per-append listing refresh is coalesced — leading + one trailing per burst', (t) => {
  const clk = fakeClock()
  let calls = 0
  const c = makeCoalescer(() => { calls++ }, { intervalMs: 750, schedule: clk.schedule, clear: clk.clear })

  c.trigger()
  t.is(calls, 1, 'leading edge fires immediately')
  c.trigger(); c.trigger(); c.trigger()
  t.is(calls, 1, 'burst within the window collapses')
  clk.advance(750)
  t.is(calls, 2, 'one trailing fire after the window')
  clk.advance(750)
  t.is(calls, 2, 'no extra fire when idle')

  c.trigger()
  t.is(calls, 3, 'next trigger after idle is a fresh leading edge')
})

test('cancel() stops a pending trailing fire', (t) => {
  const clk = fakeClock()
  let calls = 0
  const c = makeCoalescer(() => { calls++ }, { intervalMs: 750, schedule: clk.schedule, clear: clk.clear })
  c.trigger(); c.trigger(); c.cancel()
  clk.advance(750)
  t.is(calls, 1, 'cancelled trailing never fires')
})
