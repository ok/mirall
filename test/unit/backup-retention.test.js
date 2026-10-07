import test from 'brittle'
import { keepSet, referencedIds, RETENTION } from '../../src/shared/storage/backup/retention.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 1, 12)
const snap = (name, ago, suspect = false) => ({ name, createdAt: NOW - ago, suspect })

test('a long hourly history thins to the newest and one per age step, seven at most', (t) => {
  const hourly = Array.from({ length: 24 * 180 }, (_, i) => snap('s' + i, i * HOUR))
  const keep = keepSet(hourly, NOW)
  t.is(keep.size, RETENTION.ages.length)
  t.alike([...keep].sort(), ['s0', 's24', 's48', 's168', 's336', 's720', 's1440'].sort(), 'newest, 1 and 2 days, 1 and 2 weeks, 1 and 2 months')
})

test('an age step with nothing old enough keeps nothing extra, and one snapshot may fill several', (t) => {
  t.alike([...keepSet([snap('a', HOUR), snap('b', 2 * HOUR)], NOW)], ['a'])
  const keep = keepSet([snap('new', HOUR), snap('mid', 2 * HOUR), snap('old', 20 * DAY)], NOW)
  t.alike([...keep].sort(), ['new', 'old'], 'the twenty-day-old snapshot is the newest at least 1 day, 2 days, 1 and 2 weeks old')
})

test('the newest snapshot stays even when it is flagged', (t) => {
  const keep = keepSet([snap('flagged', HOUR, true), snap('healthy', 3 * HOUR)], NOW)
  t.ok(keep.has('flagged'))
  t.ok(keep.has('healthy'))
})

test('a loss keeps its first flagged snapshot and the last healthy one before it, for a month', (t) => {
  const snaps = [
    snap('f3', HOUR, true), snap('f2', 2 * HOUR, true), snap('f1', 3 * HOUR, true),
    snap('before', 4 * HOUR), snap('older', 5 * HOUR),
  ]
  const keep = keepSet(snaps, NOW)
  t.alike([...keep].sort(), ['before', 'f1', 'f3'].sort(), 'newest, first flagged, last healthy before it')
  const later = keepSet(snaps, NOW + RETENTION.pinFor + 2 * DAY)
  t.absent(later.has('f1'), 'a month on, the flagged snapshot goes')
})

test('a burst of flagged snapshots never pushes out the healthy ones', (t) => {
  const flagged = Array.from({ length: 48 }, (_, i) => snap('f' + i, i * HOUR, true))
  const keep = keepSet([...flagged, snap('h1', 49 * HOUR), snap('h2', 50 * HOUR)], NOW)
  t.ok(keep.has('h1'), 'the last healthy one stays')
  t.ok(keep.size <= 4, 'and the burst itself does not: ' + keep.size)
})

test('the snapshot from before a space was left stays for a month', (t) => {
  const snaps = [snap('after', HOUR), snap('before', 2 * HOUR), snap('x', 3 * HOUR)]
  const departures = [{ before: 'before', at: new Date(NOW - HOUR).toISOString(), spaces: ['Holiday'] }]
  t.ok(keepSet(snaps, NOW, departures).has('before'))
  t.absent(keepSet(snaps, NOW + RETENTION.pinFor + DAY, departures).has('before'))
})

test('every part and file a manifest names is referenced', (t) => {
  const manifest = { cores: [{ segments: [{ parts: ['a', 'b'] }, { parts: ['c'] }] }], files: { spaceKeys: 'd', config: null } }
  t.alike([...referencedIds(manifest)].sort(), ['a', 'b', 'c', 'd'])
})
