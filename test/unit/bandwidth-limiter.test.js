import test from 'brittle'
import { createBandwidthLimiter, MIN_BYTES_PER_SECOND } from '../../src/shared/transfer/bandwidth-limiter.js'
import { scaled } from '../helpers/timing.js'

// A manual clock so refill is deterministic — drive the bucket, never sleep.
function clock (start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

const KB = 1024
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// `stream()` is the only way to consume budget: a handle carries its own credit and its own
// place in the queue. There is deliberately no shortcut on the limiter itself — two
// consumers sharing one implicit handle would overwrite each other's pending request.
function oneStream (bps, now) {
  const l = createBandwidthLimiter(() => bps, now ? { now } : undefined)
  return { l, s: l.stream() }
}

test('0 is unlimited: every take passes and no bucket is consulted', (t) => {
  const c = clock()
  const { l, s } = oneStream(0, c.now)
  t.ok(l.isUnlimited(), 'reports unlimited')
  for (let i = 0; i < 100; i++) t.ok(s.tryTake(64 * KB), `take ${i + 1} passes`)
})

test('a full bucket grants one second of budget, then throttles', (t) => {
  const c = clock()
  const { s } = oneStream(100 * KB, c.now)
  c.advance(1000) // fill
  t.ok(s.tryTake(100 * KB), 'one second of budget passes')
  t.absent(s.tryTake(1 * KB), 'bucket is now empty')
})

test('refill is proportional to elapsed time', (t) => {
  const c = clock()
  const { s } = oneStream(100 * KB, c.now)
  c.advance(1000)
  t.ok(s.tryTake(100 * KB), 'drain the bucket')
  c.advance(500)
  t.ok(s.tryTake(50 * KB), 'half a second refills half the budget')
  t.absent(s.tryTake(1 * KB), 'and no more')
})

test('the bucket never accumulates more than one second of burst', (t) => {
  const c = clock()
  const { s } = oneStream(100 * KB, c.now)
  c.advance(60_000) // idle for a minute
  t.ok(s.tryTake(100 * KB), 'one second of budget is available')
  t.absent(s.tryTake(1 * KB), 'the other 59 seconds did NOT bank')
})

// The starvation guard: a chunk can exceed one second of budget (tier-3 chunks reach 4 MB
// while a cap may be 64 KB/s). Refusing it forever would stall the transfer.
test('a chunk larger than the bucket is released on a full bucket and repaid', (t) => {
  const c = clock()
  const { s } = oneStream(64 * KB, c.now)
  c.advance(1000)
  t.ok(s.tryTake(4 * 1024 * KB), 'oversized chunk passes rather than starving')
  c.advance(1000)
  t.absent(s.tryTake(1 * KB), 'the deficit is still being repaid a second later')
  c.advance(70_000)
  t.ok(s.tryTake(1 * KB), 'once repaid, normal service resumes')
})

test('rate is re-read on every call, so a live change applies immediately', (t) => {
  const c = clock()
  let kbps = 0
  const l = createBandwidthLimiter(() => kbps, { now: c.now })
  const s = l.stream()
  t.ok(s.tryTake(10 * 1024 * KB), 'unlimited while the cap is 0')
  kbps = 100 * KB
  t.absent(s.tryTake(100 * KB), 'the new cap binds without rebuilding the limiter')
})

test('a cap below the floor is clamped, not honoured', (t) => {
  const c = clock()
  const { l, s } = oneStream(1, c.now)
  c.advance(1000)
  t.ok(s.tryTake(MIN_BYTES_PER_SECOND), 'the floor is granted despite a 1 B/s request')
  t.absent(l.isUnlimited(), 'still a limit, just not an unusable one')
})

// Fail-safe polarity: a corrupt value must return to UNLIMITED, never throttle to a crawl.
for (const bad of [-1, NaN, Infinity, '5000', null, undefined]) {
  test(`a non-positive or non-numeric rate (${String(bad)}) falls back to unlimited`, (t) => {
    const c = clock()
    const { l, s } = oneStream(bad, c.now)
    t.ok(l.isUnlimited(), 'treated as unlimited')
    t.ok(s.tryTake(100 * 1024 * KB), 'nothing is throttled')
  })
}

// The getter runs inside a timer callback, so a throw there would both crash the worker and
// leave the queue with nothing to re-arm it. Fail open, like a corrupt value.
test('a rate getter that throws falls back to unlimited instead of escaping', (t) => {
  const c = clock()
  const l = createBandwidthLimiter(() => { throw new Error('config read failed') }, { now: c.now })
  const s = l.stream()
  t.ok(l.isUnlimited(), 'treated as unlimited')
  t.ok(s.tryTake(100 * 1024 * KB), 'nothing is throttled, and nothing throws')
})

test('a queued stream survives a getter that throws transiently', async (t) => {
  let boom = false
  let bps = 64 * KB
  const l = createBandwidthLimiter(() => { if (boom) throw new Error('nope'); return bps })
  const s = l.stream()
  const woken = new Promise((resolve) => s.whenAvailable(8 * KB, resolve))
  boom = true
  await wait(scaled(120))
  boom = false
  await woken
  t.pass('the queue recovered and the waiter was still served')
  l.destroy()
})

test('take() resolves once the bytes are paid for', async (t) => {
  const { l, s } = oneStream(256 * KB)
  await s.take(256 * KB)
  const startedAt = Date.now()
  await s.take(64 * KB)
  t.ok(Date.now() - startedAt >= scaled(100), 'the second take waited for a refill')
  l.destroy()
})

// take() reports what it actually paid for. An aborted wait must be distinguishable from a
// paid one, or the serve loop resumes and puts unmetered bytes on the wire.
test('take() resolves with the bytes paid for, and 0 when the wait is aborted', async (t) => {
  // An oversized ask is released on any positive balance, so to get a wait that actually
  // parks we first borrow a minute of budget and leave the bucket deep in debt.
  const { l, s } = oneStream(64 * KB)
  t.is(await s.take(4 * 1024 * KB), 4 * 1024 * KB, 'the oversized ask is paid in full')
  const pending = s.take(8 * KB)          // unaffordable until the debt clears (~64s)
  await wait(scaled(50))
  l.destroy()
  t.is(await pending, 0, 'a destroy mid-wait resolves 0, not the byte count')

  const other = oneStream(64 * KB)
  await other.s.take(4 * 1024 * KB)
  const dangling = other.s.take(8 * KB)
  await wait(scaled(50))
  other.s.detach()
  t.is(await dangling, 0, 'detaching the handle resolves 0 too')
  other.l.destroy()
})

test('whenAvailable waits only as long as the requested bytes need', async (t) => {
  const { l, s } = oneStream(128 * KB)
  s.tryTake(128 * KB)
  const startedAt = Date.now()
  await new Promise((resolve) => s.whenAvailable(8 * KB, resolve))
  const waited = Date.now() - startedAt
  t.ok(s.tryTake(8 * KB), 'budget is available by the time the callback runs')
  t.ok(waited < scaled(500), `waited ${waited}ms for 1/16th of a second of budget, not a full second`)
  l.destroy()
})

test('give() refunds bytes charged for work that never happened', (t) => {
  let now = 0
  const { s } = oneStream(64 * KB, () => now)
  now += 1000
  t.ok(s.tryTake(64 * KB), 'a full second of budget is affordable')
  t.absent(s.tryTake(1 * KB), 'and then the bucket is empty')

  s.give(64 * KB)
  t.ok(s.tryTake(64 * KB), 'a refund makes the same bytes affordable again')
})

test('give() cannot bank credit beyond one second of budget', (t) => {
  let now = 0
  const { s } = oneStream(64 * KB, () => now)
  now += 1000
  s.give(64 * KB * 10)
  t.ok(s.tryTake(64 * KB), 'one second is available')
  t.absent(s.tryTake(64 * KB), 'a burst of cancellations does not overshoot the cap')
})

test('give() is inert when unlimited or handed a non-positive size', (t) => {
  const unlimited = createBandwidthLimiter(() => 0).stream()
  t.execution(() => unlimited.give(1024), 'no-op when unthrottled')

  let now = 0
  const { s } = oneStream(64 * KB, () => now)
  now += 1000
  s.tryTake(64 * KB)
  s.give(0)
  s.give(-5)
  t.absent(s.tryTake(1), 'a zero or negative refund adds nothing')
})

// --- sharing one cap between concurrent consumers ----------------------------
//
// FIX-BW1: the bucket had no queue discipline. `tryTake` was an unsynchronized grab, and a
// transfer with chunks already in flight re-enters its assign loop on EVERY arrival — so it
// consumed each refill increment microseconds after it accrued, while a transfer with
// nothing in flight could only retry on a timer and always found the bucket empty. Measured
// against that code: a 1 MB/s cap with three transfers gave the first 19.9 MB and the other
// two exactly 0 bytes. The aggregate cap was honoured perfectly; only the split was wrong.

test('REGRESSION (FIX-BW1): tryTake does not barge past a stream already queued', (t) => {
  const c = clock()
  const l = createBandwidthLimiter(() => 100 * KB, { now: c.now })
  const a = l.stream()
  const b = l.stream()
  c.advance(1000)
  t.ok(a.tryTake(100 * KB), 'A drains the bucket')
  t.absent(b.tryTake(50 * KB), 'B cannot afford its chunk yet')
  b.whenAvailable(50 * KB, () => {})   // B takes a place in the queue
  c.advance(1000)                       // a full second of budget accrues
  t.absent(a.tryTake(50 * KB), 'A must not grab the refill B is queued for')
  l.destroy()
})

test('REGRESSION (FIX-BW1): a woken stream is handed the credit it queued for', async (t) => {
  const l = createBandwidthLimiter(() => 200 * KB)
  const a = l.stream()
  const b = l.stream()
  await new Promise((resolve) => b.whenAvailable(50 * KB, resolve))
  t.ok(b.tryTake(50 * KB), 'the wakeup carries a grant, so the retry cannot lose the race')
  t.absent(a.tryTake(50 * KB), 'the grant was charged to B, not left in the shared bucket')
  l.destroy()
})

test('REGRESSION (FIX-BW1): three competing streams all make progress', async (t) => {
  const CAP = 400 * KB
  const CHUNK = 20 * KB
  const l = createBandwidthLimiter(() => CAP)
  const streams = [l.stream(), l.stream(), l.stream()]
  const got = [0, 0, 0]
  let stopped = false

  const drive = (i) => {
    const pump = () => {
      if (stopped) return
      while (streams[i].tryTake(CHUNK)) got[i] += CHUNK
      streams[i].whenAvailable(CHUNK, pump)
    }
    pump()
  }

  drive(0)
  await wait(scaled(100))  // let stream 0 become the incumbent
  drive(1)
  drive(2)
  await wait(scaled(800))
  stopped = true
  l.destroy()

  t.ok(got[1] > 0, `the second stream received bytes (${got[1]})`)
  t.ok(got[2] > 0, `the third stream received bytes (${got[2]})`)
  const total = got[0] + got[1] + got[2]
  t.ok(Math.min(...got) >= total * 0.1, `no stream was squeezed below 10% of the total (${got.join(' / ')})`)
})

// REGRESSION (FIX-BW3): the queue must arbitrate BYTES, not turns. An earlier revision
// served tickets in strict FIFO, which looks fair only while every transfer happens to use
// the same chunk size. Chunk size comes from the file-size tier (chunker.js TIERS: 64 KB at
// tier 0, 4 MB at tier 3), so a big archive syncing beside a small document differs 64x —
// and measured against that revision the large-chunk stream took 100.0% and the small one
// exactly 0.0%, the very symptom FIX-BW1 exists to remove.
// The window must span several grants of the LARGE chunk, or the measurement says nothing:
// one 1 MB chunk at a 4 MB/s cap is a quarter-second of the whole cap, and whichever stream
// happens to hold the borrow when the clock stops looks like it took everything.
async function splitBetween (cap, sizes, ms) {
  const l = createBandwidthLimiter(() => cap)
  const got = sizes.map(() => 0)
  let stopped = false
  sizes.forEach((bytes, i) => {
    const s = l.stream()
    const step = () => {
      if (stopped) return
      while (s.tryTake(bytes)) got[i] += bytes
      s.whenAvailable(bytes, step)
    }
    step()
  })
  await wait(ms)
  stopped = true
  l.destroy()
  return got
}

test('REGRESSION (FIX-BW3): streams with very different chunk sizes split the cap by bytes', async (t) => {
  // A tier-2 max chunk against a tier-0 one: a 32x difference, and routine — chunk size is
  // derived from file size, so a big archive beside a small document looks exactly like this.
  const got = await splitBetween(4 * 1024 * KB, [1024 * KB, 32 * KB], scaled(2000))
  const total = got[0] + got[1]
  t.ok(got[0] > 0, `the large-chunk stream ran (${Math.round(got[0] / KB)} KB)`)
  t.ok(got[1] > 0, `the small-chunk stream ran (${Math.round(got[1] / KB)} KB)`)
  t.ok(Math.min(...got) >= total * 0.25,
    `and the split is by BYTES, not by turns — big=${Math.round(got[0] / KB)}KB small=${Math.round(got[1] / KB)}KB`)
})

test('REGRESSION (FIX-BW3): a chunk bigger than the whole bucket still gets its share', async (t) => {
  // 2 MB asks against a 1 MB/s cap: every grant is a two-second borrow, the case where
  // requiring a full bucket before releasing it starved the large stream completely.
  const got = await splitBetween(1024 * KB, [2048 * KB, 16 * KB], scaled(6000))
  const total = got[0] + got[1]
  t.ok(got[0] > 0, `the oversized-chunk stream was served (${Math.round(got[0] / KB)} KB)`)
  t.ok(Math.min(...got) >= total * 0.2,
    `neither side was starved — big=${Math.round(got[0] / KB)}KB small=${Math.round(got[1] / KB)}KB`)
})

test('the aggregate cap still binds once sharing is fair', async (t) => {
  const CAP = 400 * KB
  const CHUNK = 20 * KB
  const l = createBandwidthLimiter(() => CAP)
  const streams = [l.stream(), l.stream(), l.stream(), l.stream()]
  let total = 0
  let stopped = false
  for (const s of streams) {
    const pump = () => {
      if (stopped) return
      while (s.tryTake(CHUNK)) total += CHUNK
      s.whenAvailable(CHUNK, pump)
    }
    pump()
  }
  const startedAt = Date.now()
  await wait(scaled(1000))
  stopped = true
  const elapsed = (Date.now() - startedAt) / 1000
  l.destroy()
  // One second of burst is allowed on top of the steady rate (the bucket depth).
  t.ok(total <= CAP * (elapsed + 1.5), `four streams together stayed under the cap (${Math.round(total / KB)} KB in ${elapsed.toFixed(2)}s)`)
})

test('wouldBlock separates a structural refusal from one about size', (t) => {
  const c = clock()
  const l = createBandwidthLimiter(() => 100 * KB, { now: c.now })
  const a = l.stream()
  const b = l.stream()
  c.advance(1000)
  a.tryTake(100 * KB)                      // drain
  c.advance(200)                            // 20 KB back
  t.absent(a.tryTake(50 * KB), '50 KB does not fit yet')
  t.absent(a.wouldBlock(), 'but a smaller chunk might — keep scanning')
  b.whenAvailable(10 * KB, () => {})       // someone is now queued
  t.ok(a.wouldBlock(), 'with a stream queued no size can be taken — stop scanning')
  l.destroy()
})

test('detach() returns unspent credit to the bucket', async (t) => {
  const l = createBandwidthLimiter(() => 200 * KB)
  const a = l.stream()
  const b = l.stream()
  await new Promise((resolve) => a.whenAvailable(100 * KB, resolve))
  t.absent(b.tryTake(100 * KB), 'the grant was charged to A, so B cannot see it')
  a.detach()               // A ends without ever spending its grant
  t.ok(b.tryTake(100 * KB), 'detaching A returns the unspent bytes to the bucket')
  l.destroy()
})

test('detach() is idempotent and makes the handle inert', (t) => {
  const c = clock()
  const l = createBandwidthLimiter(() => 100 * KB, { now: c.now })
  const s = l.stream()
  c.advance(1000)
  s.detach()
  t.execution(() => s.detach(), 'a second detach is a no-op')
  t.absent(s.tryTake(1 * KB), 'a detached handle takes nothing')
  t.execution(() => s.whenAvailable(1 * KB, () => {}), 'and queues nothing')
  l.destroy()
})

// Teardown must not leave a consumer waiting on a callback that can never come, and must not
// leave the queue non-empty either — anti-barge keys off queue occupancy, so a stranded
// entry would refuse every stream on the limiter forever.
test('destroy() settles waiters and cannot be re-queued into', async (t) => {
  const l = createBandwidthLimiter(() => 64 * KB)
  // Put the bucket in debt so the waiter below genuinely parks.
  await l.stream().take(4 * 1024 * KB)

  const s = l.stream()
  let requeued = 0
  const settled = new Promise((resolve) => {
    const again = () => {
      requeued++
      s.whenAvailable(8 * KB, again)   // a callback that re-queues itself
      resolve()
    }
    s.whenAvailable(8 * KB, again)
  })
  await wait(scaled(50))
  l.destroy()
  await settled
  await wait(scaled(80))
  t.is(requeued, 1, 'the parked waiter was settled exactly once and did not re-queue')

  const other = l.stream()
  t.absent(other.tryTake(1 * KB), 'a fresh stream is inert rather than wedged behind a stranded entry')
})

test('raising the cap to unlimited releases streams already queued', async (t) => {
  let bps = 64 * KB
  const l = createBandwidthLimiter(() => bps)
  const s = l.stream()
  const woken = new Promise((resolve) => s.whenAvailable(10 * 1024 * KB, resolve))
  bps = 0
  await woken
  t.ok(s.tryTake(10 * 1024 * KB), 'the queued stream is released when the cap is lifted')
  l.destroy()
})

// A clock that steps backwards (NTP correction, suspend/resume) must cost one round, not
// freeze the bucket until wall-clock catches up.
test('a backwards clock step does not freeze the bucket', (t) => {
  let now = 1_000_000
  const l = createBandwidthLimiter(() => 100 * KB, { now: () => now })
  const s = l.stream()
  now += 1000
  t.ok(s.tryTake(100 * KB), 'normal service')
  now -= 5000                       // clock jumps backwards
  t.absent(s.tryTake(10 * KB), 'nothing is credited for negative elapsed time')
  now += 1000                       // one second forward from the NEW baseline
  t.ok(s.tryTake(100 * KB), 'the very next second refills normally')
})
