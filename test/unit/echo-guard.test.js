import test from 'brittle'
import { ignorePathsFor, clearShareGuards } from '../../src/shared/folders/echo-guard.js'

// echo-guard reads Date.now() directly with a 30s TTL. Drive a fake clock so
// expiry is deterministic instead of waiting wall-clock time.
function withClock (t, fn) {
  const real = Date.now
  let now = 1_000_000
  Date.now = () => now
  t.teardown(() => { Date.now = real })
  return fn({ advance: (ms) => { now += ms }, set: (v) => { now = v } })
}

test('add → has within TTL, then delete', (t) => {
  const g = ignorePathsFor('share-a')
  t.absent(g.has('/x/file'), 'unknown path not guarded')
  g.add('/x/file')
  t.ok(g.has('/x/file'), 'guarded after add')
  g.delete('/x/file')
  t.absent(g.has('/x/file'), 'no longer guarded after delete')
  clearShareGuards('share-a')
})

test('entry auto-expires after the 30s TTL', (t) => {
  withClock(t, (clock) => {
    const g = ignorePathsFor('share-ttl')
    g.add('/y/file')
    t.ok(g.has('/y/file'))
    clock.advance(29_999)
    t.ok(g.has('/y/file'), 'still guarded just before TTL')
    clock.advance(2)            // now 30_001ms past add → expired
    t.absent(g.has('/y/file'), 'expired after TTL')
  })
  clearShareGuards('share-ttl')
})

test('guards are isolated per share id', (t) => {
  const a = ignorePathsFor('s1')
  const b = ignorePathsFor('s2')
  a.add('/shared/path')
  t.ok(a.has('/shared/path'))
  t.absent(b.has('/shared/path'), 'other share does not see it')
  clearShareGuards('s1'); clearShareGuards('s2')
})

test('clearShareGuards drops the whole bucket', (t) => {
  const g = ignorePathsFor('s3')
  g.add('/a'); g.add('/b')
  clearShareGuards('s3')
  const g2 = ignorePathsFor('s3') // fresh bucket
  t.absent(g2.has('/a'))
  t.absent(g2.has('/b'))
})
