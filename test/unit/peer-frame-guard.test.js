import test from 'brittle'
import { validFrameShape, createRateLimiter } from '../../src/shared/transfer/handshake-guard.js'

// REGRESSION (FIX-FRAME-NULL: JSON.parse('null') returns null, and the `msg.type` read that
// followed sat OUTSIDE the message handler's try — it reached protomux's _ondata, which
// _safeDestroy'd the socket. The mirall/handshake channel id is the public protocol string, so
// any peer on the topic could drop a connection with the four-character frame `null`.)
test('REGRESSION (FIX-FRAME-NULL): the shape guard rejects everything that would throw or misroute', (t) => {
  t.absent(validFrameShape(JSON.parse('null')), 'null — the socket-killer')
  t.absent(validFrameShape(undefined), 'undefined')
  t.absent(validFrameShape(42), 'a number')
  t.absent(validFrameShape('str'), 'a string')
  t.absent(validFrameShape(true), 'a boolean')
  t.absent(validFrameShape([]), 'an array')
  t.absent(validFrameShape([{ type: 'handshake' }]), 'an array carrying a frame')
  t.absent(validFrameShape({}), 'an object with no type')
  t.absent(validFrameShape({ type: 7 }), 'a non-string type')
  t.ok(validFrameShape({ type: 'presence' }), 'a well-formed frame passes')
})

// Sizing check: presence is the busiest honest source at one frame per (peer, space) per 5 s.
test('the general lane admits an honest presence cadence indefinitely', (t) => {
  let now = 0
  const limiter = createRateLimiter({ burst: 256, refillMs: 20, abuseThreshold: 512, now: () => now })
  const peer = 'a'.repeat(64)
  // 20 shared spaces => 20 frames every 5s, for 10 minutes.
  let denied = 0
  for (let tick = 0; tick < 120; tick++) {
    for (let i = 0; i < 20; i++) if (!limiter.take(peer).ok) denied += 1
    now += 5000
  }
  t.is(denied, 0, 'never rate-limited an honest peer')
})

test('the general lane bans a line-rate flood', (t) => {
  let now = 0
  const limiter = createRateLimiter({ burst: 256, refillMs: 20, abuseThreshold: 512, now: () => now })
  const peer = 'b'.repeat(64)
  let banned = false
  for (let i = 0; i < 5000 && !banned; i++) banned = limiter.take(peer).ban
  t.ok(banned, 'a sustained flood self-evicts')
})

test('a burst of zero switches the lane off', (t) => {
  const limiter = createRateLimiter({ burst: 0, refillMs: 20, abuseThreshold: 512 })
  const peer = 'c'.repeat(64)
  let denied = 0
  for (let i = 0; i < 10000; i++) if (!limiter.take(peer).ok) denied += 1
  t.is(denied, 0, 'the rollback path admits everything')
})
