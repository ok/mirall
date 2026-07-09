import test from 'brittle'
import { createRateLimiter, createDualRateLimiter } from '../../src/shared/transfer/handshake-guard.js'

// A manual clock so refill is deterministic — drive the bucket, never sleep.
function clock (start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

const K = 'a'.repeat(64)

test('REGRESSION (MIR-04): burst tokens pass, then identity frames are throttled', (t) => {
  const c = clock()
  const rl = createRateLimiter({ burst: 4, refillMs: 1000, abuseThreshold: 24, now: c.now })
  for (let i = 0; i < 4; i++) t.ok(rl.take(K).ok, `burst frame ${i + 1} passes`)
  t.absent(rl.take(K).ok, '5th frame in the same instant is throttled')
})

test('a refill interval re-grants exactly one token', (t) => {
  const c = clock()
  const rl = createRateLimiter({ burst: 2, refillMs: 1000, abuseThreshold: 24, now: c.now })
  t.ok(rl.take(K).ok)
  t.ok(rl.take(K).ok)
  t.absent(rl.take(K).ok, 'bucket empty')
  c.advance(1000)
  t.ok(rl.take(K).ok, 'one token refilled after refillMs')
  t.absent(rl.take(K).ok, 'only one, not two')
})

test('ban fires after abuseThreshold CONSECUTIVE drops', (t) => {
  const c = clock()
  const rl = createRateLimiter({ burst: 1, refillMs: 1000, abuseThreshold: 3, now: c.now })
  t.ok(rl.take(K).ok, 'first token granted')
  t.is(rl.take(K).ban, false, 'drop 1 — under threshold')
  t.is(rl.take(K).ban, false, 'drop 2 — under threshold')
  t.is(rl.take(K).ban, true, 'drop 3 reaches the threshold → evict')
})

test('a successful take resets the consecutive-drop counter (honest peer never banned)', (t) => {
  const c = clock()
  const rl = createRateLimiter({ burst: 1, refillMs: 1000, abuseThreshold: 3, now: c.now })
  t.ok(rl.take(K).ok)
  rl.take(K); rl.take(K)                 // 2 consecutive drops
  c.advance(1000)
  t.ok(rl.take(K).ok, 'a refilled grant lands between drops')
  t.is(rl.take(K).ban, false, 'drop counter restarted from zero — no ban')
})

test('buckets are per-key; forget/clear prune; burst 0 is the disabled escape hatch', (t) => {
  const c = clock()
  const rl = createRateLimiter({ burst: 1, refillMs: 1000, abuseThreshold: 3, now: c.now })
  t.ok(rl.take('k1').ok)
  t.absent(rl.take('k1').ok, 'k1 drained')
  t.ok(rl.take('k2').ok, 'k2 has its own independent bucket')
  t.is(rl.size(), 2)
  rl.forget('k1')
  t.is(rl.size(), 1, 'forget drops one bucket')
  rl.clear()
  t.is(rl.size(), 0, 'clear empties all')

  const off = createRateLimiter({ burst: 0, refillMs: 1000, abuseThreshold: 3, now: c.now })
  t.ok(off.take(K).ok)
  t.ok(off.take(K).ok)
  t.is(off.take(K).ban, false, 'disabled limiter never throttles or bans')
})

test('REGRESSION (FIX-1: starvation): an unmatched-frame burst never consumes matched tokens', (t) => {
  const c = clock()
  const rl = createDualRateLimiter({
    matched: { burst: 4, refillMs: 1000, abuseThreshold: 24 },
    unmatched: { burst: 8, refillMs: 250, abuseThreshold: 256 },
    now: c.now,
  })
  for (let i = 0; i < 8; i++) t.ok(rl.take(K, false).ok, `unmatched frame ${i + 1} admitted on its own lane`)
  t.ok(rl.take(K, true).ok, 'matched frame still admitted after the unmatched burst')
  t.absent(rl.take(K, false).ok, 'unmatched lane itself is exhausted')
  t.ok(rl.take(K, true).ok, 'matched lane unaffected by unmatched exhaustion')
})

test('dual lanes ban independently and forget() clears both', (t) => {
  const c = clock()
  const rl = createDualRateLimiter({
    matched: { burst: 1, refillMs: 1000, abuseThreshold: 3 },
    unmatched: { burst: 1, refillMs: 1000, abuseThreshold: 3 },
    now: c.now,
  })
  t.ok(rl.take(K, true).ok)
  t.ok(rl.take(K, false).ok, 'matched exhaustion leaves the unmatched lane untouched')
  rl.take(K, false); rl.take(K, false)
  t.is(rl.take(K, false).ban, true, 'unmatched lane reaches its own ban threshold')
  rl.forget(K)
  t.ok(rl.take(K, true).ok, 'forget resets the matched lane')
  t.ok(rl.take(K, false).ok, 'forget resets the unmatched lane')
})

test('dual limiter honors per-lane refill and the burst-0 disabled escape hatch', (t) => {
  const c = clock()
  const rl = createDualRateLimiter({
    matched: { burst: 1, refillMs: 1000, abuseThreshold: 24 },
    unmatched: { burst: 0, refillMs: 250, abuseThreshold: 256 },
    now: c.now,
  })
  t.ok(rl.take(K, true).ok)
  t.absent(rl.take(K, true).ok, 'matched drained')
  c.advance(1000)
  t.ok(rl.take(K, true).ok, 'matched refills on its own cadence')
  for (let i = 0; i < 20; i++) t.ok(rl.take(K, false).ok, `disabled unmatched lane never throttles (${i + 1})`)
})
