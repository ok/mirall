import test from 'brittle'
import { makeRespawnPolicy } from '../../src/renderer/workerRespawn.js'
import { WORKER_EXIT_UNSTABLE } from '../../src/shared/contract/exit-codes.js'

// REGRESSION (FIX-140): a worker that dies (crash / OOM on a very large folder) must be
// respawned instead of leaving the app permanently dead — but a worker that re-crashes ON BOOT
// (never reaching ready) must not respawn forever. The streak resets only after the worker
// actually became ready since the last exit, so a boot loop is capped while a worker that boots
// + works + dies earns a fresh budget.
test('REGRESSION (FIX-140): boot-crash loop backs off then gives up; ready-then-die resets the budget', (t) => {
  const p = makeRespawnPolicy({ maxRetries: 3, baseDelayMs: 500, maxDelayMs: 5000 })

  // Crashes BEFORE ever becoming ready accumulate.
  let r = p.onExit(); t.is(r.respawn, true); t.is(r.delayMs, 500, 'first respawn after 500ms')
  r = p.onExit(); t.is(r.respawn, true); t.is(r.delayMs, 1000, 'backs off to 1000ms')
  r = p.onExit(); t.is(r.respawn, true); t.is(r.delayMs, 2000, 'backs off to 2000ms')
  r = p.onExit(); t.is(r.respawn, false, 'gives up after maxRetries boot crashes (no infinite loop)')

  // A worker that reached ready, then died, gets a fresh budget.
  p.recordReady()
  t.is(p.onExit().respawn, true, 'ready-then-die resets the streak → respawns again')
})

test('FIX-140: backoff delay is clamped at maxDelayMs', (t) => {
  const p = makeRespawnPolicy({ maxRetries: 20, baseDelayMs: 1000, maxDelayMs: 4000 })
  const delays = []
  for (let i = 0; i < 6; i++) delays.push(p.onExit().delayMs)
  t.alike(delays, [1000, 2000, 4000, 4000, 4000, 4000], 'exponential, then clamped')
})

test('FIX-140: a worker that boots + works each generation keeps recovering (never gives up)', (t) => {
  const p = makeRespawnPolicy({ maxRetries: 2 })
  for (let i = 0; i < 5; i++) {
    p.recordReady() // this generation booted + became ready
    t.is(p.onExit().respawn, true, `cycle ${i}: ready-then-die always respawns`)
  }
})

// REGRESSION (FIX-R09-1): the worker can now exit BECAUSE it decided its own fault rate makes it
// unstable. Such a worker has always reached ready first — so the ready-then-die reset above
// hands it an unlimited budget and it respawns forever, and because each recovery reloads the
// window (ipc.ts markReady) the user watches the app restart itself every minute. The test above
// ("boots + works each generation keeps recovering") is the behaviour that makes this possible,
// and it is CORRECT for an OOM; the exit code is what separates the two.
test('REGRESSION (FIX-R09-1: an unstable worker respawned forever because ready reset its budget)', (t) => {
  const p = makeRespawnPolicy({ maxUnstable: 3, now: () => 1_000_000 })
  for (let i = 0; i < 3; i++) {
    p.recordReady() // every unstable generation DID reach ready — that is the whole problem
    t.is(p.onExit(WORKER_EXIT_UNSTABLE).respawn, true, `unstable exit ${i + 1} still respawns`)
  }
  p.recordReady()
  t.is(p.onExit(WORKER_EXIT_UNSTABLE).respawn, false, 'gives up after maxUnstable — recordReady does NOT clear the unstable budget')
})

// An unstable exit an hour after the last one is an incident, not a loop.
test('FIX-R09-1: quiet time clears the unstable budget', (t) => {
  let t0 = 1_000_000
  const p = makeRespawnPolicy({ maxUnstable: 2, unstableWindowMs: 600_000, now: () => t0 })
  p.recordReady(); t.is(p.onExit(WORKER_EXIT_UNSTABLE).respawn, true, 'first unstable exit')
  p.recordReady(); t.is(p.onExit(WORKER_EXIT_UNSTABLE).respawn, true, 'second unstable exit')
  p.recordReady(); t.is(p.onExit(WORKER_EXIT_UNSTABLE).respawn, false, 'third in the window gives up')

  t0 += 3_600_000 // an hour of a healthy worker
  p.recordReady()
  t.is(p.onExit(WORKER_EXIT_UNSTABLE).respawn, true, 'a generation that ran clean past the window earns a fresh unstable budget')
})

// The unstable budget must not leak into the ordinary crash path: an OOM on a very large folder
// still gets the full ready-then-die recovery it always had.
test('FIX-R09-1: a non-unstable exit never spends the unstable budget', (t) => {
  const p = makeRespawnPolicy({ maxUnstable: 1, now: () => 1_000_000 })
  for (let i = 0; i < 10; i++) {
    p.recordReady()
    t.is(p.onExit(0).respawn, true, `OOM-style exit ${i + 1} recovers as before`)
  }
  p.recordReady()
  t.is(p.onExit(WORKER_EXIT_UNSTABLE).respawn, true, 'the unstable budget is still untouched and intact')
})

// A spawn that never produced a worker reports code 0 from ipc.ts — it must fall through to the
// boot-loop cap, not the unstable one.
test('FIX-R09-1: a failed spawn falls through to the boot-crash cap', (t) => {
  const p = makeRespawnPolicy({ maxRetries: 2, maxUnstable: 5, now: () => 1_000_000 })
  t.is(p.onExit(0).respawn, true)
  t.is(p.onExit(0).respawn, true)
  t.is(p.onExit(0).respawn, false, 'never-ready spawns still give up at maxRetries')
})
