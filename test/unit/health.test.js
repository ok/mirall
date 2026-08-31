import test from 'brittle'
import { createHealthMonitor } from '../../src/shared/core/health.js'

// A fake clock and a fake timer, so lag is asserted structurally rather than by sleeping — which is
// also what keeps this file out of check-test-timing.sh.
function harness (startAt = 1000) {
  let t = startAt
  let armed = null
  const monitor = createHealthMonitor({
    now: () => t,
    setInterval: (fn) => { armed = fn; return { unref () {} } },
    clearInterval: () => { armed = null },
    intervalMs: 1000,
  })
  return {
    monitor,
    advance: (ms) => { t += ms },
    set: (v) => { t = v },
    fire: () => armed && armed(),
    armed: () => armed !== null,
  }
}

test('a punctual loop reports no lag', (t) => {
  const h = harness()
  h.monitor.start()
  h.advance(1000)
  h.fire()
  t.alike(h.monitor.snapshot(), { loopLagMs: 0, loopLagMaxMs: 0 })
})

test('a late tick records the drift past its deadline', (t) => {
  const h = harness()
  h.monitor.start()
  h.advance(1450)
  h.fire()
  t.is(h.monitor.snapshot().loopLagMs, 450, 'lag is measured against the expected deadline, not the interval')
})

test('the max is retained after the loop recovers', (t) => {
  const h = harness()
  h.monitor.start()
  h.advance(1900); h.fire()
  h.advance(1000); h.fire()
  const s = h.monitor.snapshot()
  t.is(s.loopLagMs, 0, 'the current reading recovers')
  t.is(s.loopLagMaxMs, 900, 'the worst reading is kept')
})

// A time correction must not make a wedged worker look fast, nor wipe the worst reading recorded
// so far — the two ways a naive `now() - expected` misreports.
test('REGRESSION (FIX-R09-7): a backwards clock step does not read as a healthy loop', (t) => {
  const h = harness()
  h.monitor.start()
  h.advance(1800); h.fire()
  t.is(h.monitor.snapshot().loopLagMaxMs, 800)
  h.set(500); h.fire()
  const s = h.monitor.snapshot()
  t.is(s.loopLagMs, 0, 'clamped, never negative')
  t.is(s.loopLagMaxMs, 800, 'and the max survives the correction')
})

test('snapshot merges caller counters without losing the lag fields', (t) => {
  const h = harness()
  h.monitor.start()
  h.advance(1200); h.fire()
  t.alike(h.monitor.snapshot({ queueDepth: 7 }), { loopLagMs: 200, loopLagMaxMs: 200, queueDepth: 7 })
})

test('stop() clears the timer so the monitor cannot outlive the worker', (t) => {
  const h = harness()
  h.monitor.start()
  t.ok(h.armed(), 'armed after start')
  h.monitor.stop()
  t.absent(h.armed(), 'disarmed after stop')
})

test('start() twice arms one timer, and stop() is idempotent', (t) => {
  const h = harness()
  h.monitor.start()
  h.monitor.start()
  h.monitor.stop()
  h.monitor.stop()
  t.absent(h.armed())
})

test('reset clears both readings', (t) => {
  const h = harness()
  h.monitor.start()
  h.advance(2000); h.fire()
  h.monitor.reset()
  t.alike(h.monitor.snapshot(), { loopLagMs: 0, loopLagMaxMs: 0 })
})
