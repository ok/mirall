import test from 'brittle'
import { makeRespawnPolicy } from '../../src/renderer/workerRespawn.js'

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
