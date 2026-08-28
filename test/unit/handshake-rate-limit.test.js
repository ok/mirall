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

// The shipped matched-lane constants, as literals. runtime-config.test.js asserts
// getHandshakeRateLimit() returns exactly these, so this file never reads the process-global
// config — a sibling unit file mutating it cannot silently change the numbers asserted here.
const SHIPPED_MATCHED = { burst: 8, burstPerTopic: 3, refillMs: 1000, abuseThreshold: 24 }
const SHIPPED_UNMATCHED = { burst: 32, refillMs: 250, abuseThreshold: 256 }
// A distinct 64-hex topic per shared space, the shape swarm.js charges the lane with.
const TOPIC = (i) => i.toString(16).padStart(64, '0')

function shippedLanes (topicCount, c) {
  return createDualRateLimiter({ matched: SHIPPED_MATCHED, unmatched: SHIPPED_UNMATCHED, now: c.now, topics: () => topicCount })
}

// REGRESSION (FIX-HANDSHAKE-BURST: a reconnect between peers sharing K spaces puts K + K
// back-to-back matched frames on the lane — their opening burst plus their reciprocals to
// ours. With a fixed burst of 8 the lane admitted 8, dropped 24 in a row and evicted the
// peer's Noise key for the process lifetime. K = 24 is exactly the cliff.)
test('REGRESSION (FIX-HANDSHAKE-BURST): a 24-space reconnect is admitted whole, nobody is banned', (t) => {
  const c = clock()
  const rl = shippedLanes(24, c)
  for (let i = 0; i < 24; i++) {
    const r = rl.take(K, true, TOPIC(i))
    t.ok(r.ok, `opening frame for space ${i + 1} of 24 admitted`)
    t.is(r.ban, false, `no ban on opening frame ${i + 1}`)
  }
  for (let i = 0; i < 24; i++) {
    const r = rl.take(K, true, TOPIC(i))
    t.ok(r.ok, `reciprocal for space ${i + 1} of 24 admitted`)
    t.is(r.ban, false, `no ban on reciprocal ${i + 1}`)
  }
})

// REGRESSION (FIX-HANDSHAKE-BURST: below the cliff, frames 9+ were dropped and only the
// announce ledger re-sent them, 10-60 s later. Twelve shared spaces must land in one round.)
test('REGRESSION (FIX-HANDSHAKE-BURST): twelve shared spaces do not wait for the ledger', (t) => {
  const c = clock()
  const rl = shippedLanes(12, c)
  for (let i = 0; i < 12; i++) t.ok(rl.take(K, true, TOPIC(i)).ok, `opening frame ${i + 1} of 12 admitted`)
  for (let i = 0; i < 12; i++) t.ok(rl.take(K, true, TOPIC(i)).ok, `reciprocal ${i + 1} of 12 admitted`)
})

// The cap follows what THIS socket proved it shares, so holding many spaces does not hand a
// peer that matched one topic a large allowance — the amplification a global count would give.
test('the cap scales with the topics this socket matched, not with our own space count', (t) => {
  const c = clock()
  const rl = shippedLanes(100, c)             // we are in 100 spaces
  let admitted = 0
  let bannedAt = -1
  for (let i = 0; i < 200 && bannedAt < 0; i++) {
    const r = rl.take(K, true, TOPIC(0))      // ... but this peer only ever matches one
    if (r.ok) admitted++
    if (r.ban) bannedAt = i
  }
  t.is(admitted, 11, 'one shared topic buys 8 + 3, not 8 + 3 x 100')
  t.is(bannedAt, 11 + 24 - 1, 'and a flood on that one topic still evicts')
})

// The anti-spam property survives: past the topic-scaled cap the lane drops, and 24
// consecutive drops still evict — one socket, however many topics it legitimately shares.
test('a matched flood past the topic-scaled cap still bans', (t) => {
  const c = clock()
  const rl = shippedLanes(10, c)
  let admitted = 0
  let bannedAt = -1
  for (let i = 0; i < 200 && bannedAt < 0; i++) {
    const r = rl.take(K, true, TOPIC(i % 10)) // all ten shared topics: cap = 8 + 3 x 10 = 38
    if (r.ok) admitted++
    if (r.ban) bannedAt = i
  }
  t.is(admitted, 38, 'exactly cap frames admitted')
  t.is(bannedAt, 38 + 24 - 1, 'ban on the 24th consecutive drop, not before')
})

// A peer that backs off to the refill rate is never banned, however long it stays connected:
// the drop counter decays with the debt, so drops must be CONSECUTIVE in time, not merely
// consecutive in sequence across a long-lived socket.
test('drops decay with the bucket, so a slow peer never accumulates a ban', (t) => {
  const c = clock()
  const rl = shippedLanes(1, c)
  for (let i = 0; i < 11; i++) t.ok(rl.take(K, true, TOPIC(0)).ok, `filling the cap (${i + 1})`)
  for (let i = 0; i < 60; i++) {
    const r = rl.take(K, true, TOPIC(0))      // one frame, then wait a whole refill: never banned
    t.is(r.ban, false, `no ban on a peer pacing itself (${i + 1})`)
    c.advance(1000)
  }
})

test('the unmatched lane ignores the topic count entirely', (t) => {
  const c = clock()
  const rl = shippedLanes(100, c)
  for (let i = 0; i < 32; i++) t.ok(rl.take(K, false).ok, `unmatched burst ${i + 1} of 32`)
  let bannedAt = -1
  for (let i = 32; i < 400 && bannedAt < 0; i++) if (rl.take(K, false).ban) bannedAt = i
  t.is(bannedAt, 32 + 256 - 1, 'unmatched lane bans after its own 256 consecutive drops')
})

test('handshakeBurst 0 keeps the matched lane off regardless of topics', (t) => {
  const c = clock()
  const rl = createDualRateLimiter({
    matched: { burst: 0, burstPerTopic: 3, refillMs: 1000, abuseThreshold: 24 },
    unmatched: { burst: 1, refillMs: 250, abuseThreshold: 256 },
    now: c.now,
    topics: () => 50,
  })
  for (let i = 0; i < 300; i++) t.ok(rl.take(K, true, TOPIC(i)).ok, `disabled matched lane never throttles (${i + 1})`)
})

test('a cap getter applies to existing buckets: growth admits at once, shrink tightens at once', (t) => {
  const c = clock()
  let cap = 2
  const rl = createRateLimiter({ burst: () => cap, refillMs: 1000, abuseThreshold: 24, now: c.now })
  t.ok(rl.take(K).ok); t.ok(rl.take(K).ok)
  t.absent(rl.take(K).ok, 'cap 2 exhausted')
  cap = 5
  t.ok(rl.take(K).ok, 'a larger cap grants headroom without waiting for refill')
  t.ok(rl.take(K).ok); t.ok(rl.take(K).ok)
  t.absent(rl.take(K).ok, 'cap 5 exhausted')
  cap = 1
  c.advance(1000)
  t.absent(rl.take(K).ok, 'one token refilled but the debt (4) still exceeds the smaller cap')
  c.advance(4000)
  t.ok(rl.take(K).ok, 'debt decayed to zero: one token under cap 1')
})
