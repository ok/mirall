import test from 'brittle'
import { createReplayRing } from '../../src/shared/core/replay-ring.js'

const line = (n, pad = 0) => JSON.stringify({ seq: n, pad: 'x'.repeat(pad) }) + '\n'

test('frames after the cursor come back oldest first', (t) => {
  const ring = createReplayRing()
  for (let n = 1; n <= 5; n++) ring.push(n, line(n))
  t.alike(ring.since(2), [line(3), line(4), line(5)])
})

test('a cursor at the head is caught up, not a gap', (t) => {
  const ring = createReplayRing()
  ring.push(1, line(1))
  t.alike(ring.since(1), [], 'nothing missed is not the same as cannot be answered')
})

test('a cursor of 0 on an unevicted ring gets everything', (t) => {
  const ring = createReplayRing()
  ring.push(1, line(1))
  ring.push(2, line(2))
  t.alike(ring.since(0), [line(1), line(2)])
})

test('count eviction raises the floor, and a cursor below it is a gap', (t) => {
  const ring = createReplayRing({ maxFrames: 3 })
  for (let n = 1; n <= 5; n++) ring.push(n, line(n))
  t.is(ring.stats().floor, 2, 'seq 2 was the newest frame dropped')
  t.is(ring.since(1), null, 'a cursor the ring can no longer answer for')
  t.alike(ring.since(2), [line(3), line(4), line(5)], 'one at the floor is still answerable')
})

test('byte eviction raises the floor too', (t) => {
  const ring = createReplayRing({ maxBytes: 200 })
  for (let n = 1; n <= 10; n++) ring.push(n, line(n, 40))
  t.ok(ring.stats().bytes <= 200)
  t.ok(ring.stats().floor > 0, 'a count-only bound is not a memory bound')
  t.is(ring.since(0), null)
})

test('sparse sequences are not gaps', (t) => {
  // The numbers ephemeral frames consumed are simply absent; that is not something missed.
  const ring = createReplayRing()
  ring.push(2, line(2))
  ring.push(5, line(5))
  ring.push(9, line(9))
  t.alike(ring.since(3), [line(5), line(9)])
  t.alike(ring.since(0), [line(2), line(5), line(9)])
})

test('a frame larger than the whole cap is not retained, and counts as missed', (t) => {
  const ring = createReplayRing({ maxBytes: 50 })
  ring.push(1, line(1))
  ring.push(2, line(2, 500))
  t.is(ring.since(1), null, 'resuming across it must resync — it genuinely missed something')
})

test('the ring never grows past its bounds', (t) => {
  const ring = createReplayRing({ maxFrames: 4, maxBytes: 10_000 })
  for (let n = 1; n <= 100; n++) ring.push(n, line(n))
  t.is(ring.stats().frames, 4)
})
