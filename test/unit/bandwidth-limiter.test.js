import test from 'brittle'
import { createBandwidthLimiter, MIN_BYTES_PER_SECOND } from '../../src/shared/transfer/bandwidth-limiter.js'

// A manual clock so refill is deterministic — drive the bucket, never sleep.
function clock (start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

const KB = 1024

test('0 is unlimited: every take passes and no bucket is consulted', (t) => {
  const c = clock()
  const l = createBandwidthLimiter(() => 0, { now: c.now })
  t.ok(l.isUnlimited(), 'reports unlimited')
  for (let i = 0; i < 100; i++) t.ok(l.tryTake(64 * KB), `take ${i + 1} passes`)
})

test('a full bucket grants one second of budget, then throttles', (t) => {
  const c = clock()
  const l = createBandwidthLimiter(() => 100 * KB, { now: c.now })
  c.advance(1000) // fill
  t.ok(l.tryTake(100 * KB), 'one second of budget passes')
  t.absent(l.tryTake(1 * KB), 'bucket is now empty')
})

test('refill is proportional to elapsed time', (t) => {
  const c = clock()
  const l = createBandwidthLimiter(() => 100 * KB, { now: c.now })
  c.advance(1000)
  t.ok(l.tryTake(100 * KB), 'drain the bucket')
  c.advance(500)
  t.ok(l.tryTake(50 * KB), 'half a second refills half the budget')
  t.absent(l.tryTake(1 * KB), 'and no more')
})

test('the bucket never accumulates more than one second of burst', (t) => {
  const c = clock()
  const l = createBandwidthLimiter(() => 100 * KB, { now: c.now })
  c.advance(60_000) // idle for a minute
  t.ok(l.tryTake(100 * KB), 'one second of budget is available')
  t.absent(l.tryTake(1 * KB), 'the other 59 seconds did NOT bank')
})

// The starvation guard: a chunk can exceed one second of budget (tier-3 chunks reach 4 MB
// while a cap may be 64 KB/s). Refusing it forever would stall the transfer.
test('a chunk larger than the bucket is released on a full bucket and repaid', (t) => {
  const c = clock()
  const l = createBandwidthLimiter(() => 64 * KB, { now: c.now })
  c.advance(1000)
  t.ok(l.tryTake(4 * 1024 * KB), 'oversized chunk passes rather than starving')
  c.advance(1000)
  t.absent(l.tryTake(1 * KB), 'the deficit is still being repaid a second later')
  c.advance(70_000)
  t.ok(l.tryTake(1 * KB), 'once repaid, normal service resumes')
})

test('rate is re-read on every call, so a live change applies immediately', (t) => {
  const c = clock()
  let kbps = 0
  const l = createBandwidthLimiter(() => kbps, { now: c.now })
  t.ok(l.tryTake(10 * 1024 * KB), 'unlimited while the cap is 0')
  kbps = 100 * KB
  t.absent(l.tryTake(100 * KB), 'the new cap binds without rebuilding the limiter')
})

test('a cap below the floor is clamped, not honoured', (t) => {
  const c = clock()
  const l = createBandwidthLimiter(() => 1, { now: c.now })
  c.advance(1000)
  t.ok(l.tryTake(MIN_BYTES_PER_SECOND), 'the floor is granted despite a 1 B/s request')
  t.absent(l.isUnlimited(), 'still a limit, just not an unusable one')
})

// Fail-safe polarity: a corrupt value must return to UNLIMITED, never throttle to a crawl.
for (const bad of [-1, NaN, Infinity, '5000', null, undefined]) {
  test(`a non-positive or non-numeric rate (${String(bad)}) falls back to unlimited`, (t) => {
    const c = clock()
    const l = createBandwidthLimiter(() => bad, { now: c.now })
    t.ok(l.isUnlimited(), 'treated as unlimited')
    t.ok(l.tryTake(100 * 1024 * KB), 'nothing is throttled')
  })
}

test('take() resolves once the bytes are paid for', async (t) => {
  const l = createBandwidthLimiter(() => 256 * KB)
  await l.take(256 * KB)
  const startedAt = Date.now()
  await l.take(64 * KB)
  t.ok(Date.now() - startedAt >= 100, 'the second take waited for a refill')
  l.destroy()
})

test('whenAvailable waits only as long as the requested bytes need', async (t) => {
  const l = createBandwidthLimiter(() => 128 * KB)
  l.tryTake(128 * KB)
  const startedAt = Date.now()
  await new Promise((resolve) => l.whenAvailable(8 * KB, resolve))
  const waited = Date.now() - startedAt
  t.ok(l.tryTake(8 * KB), 'budget is available by the time the callback runs')
  t.ok(waited < 500, `waited ${waited}ms for 1/16th of a second of budget, not a full second`)
  l.destroy()
})
