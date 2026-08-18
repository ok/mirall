import test from 'brittle'
import { createSessionStore, sessionKey } from '../../src/shared/audit/audit-sessions.js'

test('a start/progress/end cycle yields one session with summed bytes and a duration', (t) => {
  const s = createSessionStore()
  s.start('k', { now: 1000, total: 500 })
  s.progress('k', { now: 1200, bytes: 200 })
  s.progress('k', { now: 1400, bytes: 500 })
  const done = s.end('k', { now: 1500 })
  t.is(done.bytes, 500)
  t.is(done.total, 500)
  t.is(done.durationMs, 500)
  t.is(s.size(), 0, 'the session is released on end')
})

test('a reconnect inside the join window resumes rather than starting a second session', (t) => {
  const s = createSessionStore({ joinWindowMs: 5000 })
  s.start('k', { now: 1000 })
  s.progress('k', { now: 2000, bytes: 100 })
  s.start('k', { now: 3000 })
  const done = s.end('k', { now: 4000 })
  t.is(done.startedAt, 1000, 'the original start is kept — a flapping peer is still one row')
  t.is(done.resumes, 1)
  t.is(done.bytes, 100, 'bytes accumulated across the flap')
})

test('a restart beyond the join window is genuinely a new session', (t) => {
  const s = createSessionStore({ joinWindowMs: 1000 })
  s.start('k', { now: 1000 })
  s.progress('k', { now: 1500, bytes: 100 })
  s.start('k', { now: 9000 })
  const done = s.end('k', { now: 9500 })
  t.is(done.startedAt, 9000)
  t.is(done.bytes, 0, 'the stale session did not carry its bytes into the new one')
})

test('progress never moves bytes backwards', (t) => {
  const s = createSessionStore()
  s.start('k', { now: 0 })
  s.progress('k', { now: 1, bytes: 900 })
  s.progress('k', { now: 2, bytes: 100 })
  t.is(s.end('k', { now: 3 }).bytes, 900)
})

test('an end without a start is tolerated', (t) => {
  const s = createSessionStore()
  t.is(s.end('nothing', { now: 1 }), null, 'a serve torn down before it produced bytes must not throw')
})

test('progress on an unknown key is a no-op', (t) => {
  const s = createSessionStore()
  t.is(s.progress('nothing', { now: 1, bytes: 5 }), null)
})

test('reap releases sessions whose peer vanished, and returns what was served', (t) => {
  const s = createSessionStore()
  s.start('a', { now: 1000 })
  s.progress('a', { now: 1100, bytes: 50 })
  s.start('b', { now: 9000 })
  const dropped = s.reap(10000, 5000)
  t.is(dropped.length, 1, 'only the idle one is reaped')
  t.is(dropped[0].key, 'a')
  t.is(dropped[0].bytes, 50, 'the reaped session still reports what it served')
  t.ok(s.has('b'), 'the live session survives')
})

test('sessionKey is collision-free across component boundaries', (t) => {
  t.not(sessionKey('ab', 'cd'), sessionKey('abc', 'd'))
})

test('advance accumulates per-chunk deltas', (t) => {
  const s = createSessionStore()
  s.start('k', { now: 0 })
  s.advance('k', { now: 1, delta: 100 })
  s.advance('k', { now: 2, delta: 250 })
  s.advance('k', { now: 3, delta: -5 })
  t.is(s.end('k', { now: 4 }).bytes, 350, 'a negative delta is ignored rather than rewinding')
})

test('advance on an unknown key is a no-op', (t) => {
  const s = createSessionStore()
  t.is(s.advance('nothing', { now: 1, delta: 5 }), null)
})

test('a session that never reaches its total is still reaped and reported', (t) => {
  const s = createSessionStore()
  s.start('k', { now: 0, total: 1000 })
  s.advance('k', { now: 100, delta: 300 })
  const dropped = s.reap(400000, 300000)
  t.is(dropped.length, 1, 'a partial serve must not sit open forever unrecorded')
  t.is(dropped[0].bytes, 300, 'it reports the bytes that actually left the device')
  t.is(dropped[0].total, 1000, 'alongside what was asked for, so the row can read as partial')
})

test('clear drops every open session', (t) => {
  const s = createSessionStore()
  s.start('a', { now: 0 })
  s.start('b', { now: 0 })
  s.clear()
  t.is(s.size(), 0)
})
