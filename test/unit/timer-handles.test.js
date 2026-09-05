import test from 'brittle'
import { createTimers, liveHandle, ownedScheduler } from '../../src/shared/core/timers.js'

// REGRESSION (REVIEW-5: three modules keep a long-lived timer handle in a binding that outlives the
// subsystem owning the set — presenceTimer, convergenceTimer, announceTimer. Each guards its start
// with `if (handle) return`, and Subsystem.close() clears the SET without being able to reach those
// bindings. So after any ending the set closes on — a failed _open, a _close that rejects — the
// binding still held a disarmed handle, the guard read it as "already armed", and the work was off
// for the rest of the process with no error and no log.)
test('REGRESSION (REVIEW-5): a handle whose owning set has closed reads as not armed', (t) => {
  const set = createTimers()
  const handle = set.setInterval(() => {}, 1000)

  t.is(liveHandle(set, handle), handle, 'while the owner is open the handle stands')
  set.close()
  t.is(liveHandle(set, handle), null, 'once it closes the handle is dead, so the guard cannot latch')
  t.is(liveHandle(null, handle), null, 'and no owner at all is the same answer')
  t.is(liveHandle(createTimers(), null), null, 'nothing armed stays nothing armed')
})

// REGRESSION (REVIEW-2: the owner-side coalescer's injected schedule guarded only the SUBSYSTEM
// POINTER — `subsystem?.timers.setTimeout(...) ?? null`. A _close that rejects never reaches its
// `subsystem = null`, so the pointer stayed live while the base's finally had already closed the
// timers underneath it. Arming against a closed set throws by design, and this one is called from
// inside a coalescer callback during the post-close publish drain, where nothing catches it.)
test('REGRESSION (REVIEW-2): an owned scheduler declines against a closed set instead of throwing', (t) => {
  let set = createTimers()
  const { schedule, clear } = ownedScheduler(() => set)

  const handle = schedule(() => {}, 1000)
  t.ok(handle, 'a live owner arms')
  clear(handle)

  // Exactly the state a rejecting _close leaves: the pointer is still there, the set is not.
  set.close()
  t.is(schedule(() => {}, 1000), null, 'a closed owner declines')
  t.execution(() => clear(handle), 'and clearing against it is inert rather than an error')

  set = null
  t.is(schedule(() => {}, 1000), null, 'no owner at all declines too — this runs before _open')
  t.execution(() => clear(handle), 'and clear stays safe with nothing to clear through')
})

// Non-vacuous by construction: if arming against a closed set did NOT throw, the guard above would
// be measuring nothing.
test('the timer set itself still refuses to arm after close', (t) => {
  const set = createTimers()
  set.close()
  t.exception(() => set.setTimeout(() => {}, 1), /scheduling after close/)
})
