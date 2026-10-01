import test from 'brittle'
import { keepSet, referencedIds, RETENTION } from '../../src/shared/storage/backup/retention.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 9, 1, 12)
const snap = (name, ago, suspect = false) => ({ name, createdAt: NOW - ago, suspect })

test('the three newest healthy snapshots stay, however old', (t) => {
  const keep = keepSet([snap('a', 400 * DAY), snap('b', 401 * DAY), snap('c', 402 * DAY), snap('d', 403 * DAY)], NOW)
  t.ok(keep.has('a') && keep.has('b') && keep.has('c'))
})

test('a burst of suspect snapshots after a wipe never pushes out the healthy ones', (t) => {
  const suspect = Array.from({ length: 48 }, (_, i) => snap('s' + i, i * HOUR, true))
  const healthy = [snap('h1', 49 * HOUR), snap('h2', 50 * HOUR), snap('h3', 51 * HOUR)]
  const keep = keepSet([...suspect, ...healthy], NOW)
  for (const s of healthy) t.ok(keep.has(s.name), s.name)
})

test('suspect snapshots are kept a month as evidence, then go', (t) => {
  const keep = keepSet([snap('h', HOUR), snap('recent', 2 * DAY, true), snap('old', RETENTION.suspectFor + DAY, true)], NOW)
  t.ok(keep.has('recent'))
  t.absent(keep.has('old'))
})

test('the newest per hour, day and week bucket is kept, the rest go', (t) => {
  const snaps = [
    snap('h-new', 10 * 60 * 1000), snap('h-old', 20 * 60 * 1000),
    snap('d-new', 5 * DAY), snap('d-old', 5 * DAY + 60 * 1000),
    snap('w-new', 60 * DAY), snap('w-old', 60 * DAY + 60 * 1000),
    snap('x', 3 * HOUR), snap('y', 4 * HOUR), snap('z', 5 * HOUR),
  ]
  const keep = keepSet(snaps, NOW)
  for (const name of ['h-new', 'd-new', 'w-new']) t.ok(keep.has(name), name)
  for (const name of ['d-old', 'w-old']) t.absent(keep.has(name), name)
})

test('every part and file a manifest names is referenced', (t) => {
  const manifest = { cores: [{ segments: [{ parts: ['a', 'b'] }, { parts: ['c'] }] }], files: { spaceKeys: 'd', config: null } }
  t.alike([...referencedIds(manifest)].sort(), ['a', 'b', 'c', 'd'])
})
