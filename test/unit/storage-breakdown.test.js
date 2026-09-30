import test from 'brittle'
import { storageBreakdown } from '../../src/shared/storage/storage-breakdown.js'

const coreBytes = new Map([
  ['own-a', 5000], ['peer-a1', 3000], ['peer-a2', 1000],
  ['own-b', 200],
  ['audit', 400], ['downloads', 90], ['pending', 10],
  ['profile', 600],
])

function input(overrides = {}) {
  return {
    totalDiskUsage: 20_000,
    coreBytes,
    spaces: [
      { spaceId: 'b', name: 'Small', own: ['own-b'], members: [] },
      { spaceId: 'a', name: 'Busy', own: ['own-a'], members: ['peer-a1', 'peer-a2'] },
    ],
    indexBytes: 700,
    activityLog: ['audit'],
    downloadHistory: ['downloads', 'pending'],
    ...overrides,
  }
}

test('each space row carries its own and its members\' catalog cores', (t) => {
  const { spaces } = storageBreakdown(input())
  const busy = spaces.find((s) => s.spaceId === 'a')
  t.alike(busy, { spaceId: 'a', name: 'Busy', ownCatalogBytes: 5000, memberCatalogBytes: 4000 })
  t.is(spaces.find((s) => s.spaceId === 'b').memberCatalogBytes, 0, 'a space with no member catalog reports 0')
})

test('spaces are listed largest first', (t) => {
  t.alike(storageBreakdown(input()).spaces.map((s) => s.spaceId), ['a', 'b'])
})

test('a core not on disk counts zero', (t) => {
  const { spaces } = storageBreakdown(input({ spaces: [{ spaceId: 'c', name: 'Fresh', own: ['never-written'], members: [] }] }))
  t.is(spaces[0].ownCatalogBytes, 0)
})

test('the parts sum to the on-disk total; what no category claims is other', (t) => {
  const b = storageBreakdown(input())
  const spaceBytes = b.spaces.reduce((n, s) => n + s.ownCatalogBytes + s.memberCatalogBytes, 0)
  t.is(b.activityLogBytes, 400)
  t.is(b.downloadHistoryBytes, 100)
  t.is(spaceBytes + b.indexBytes + b.activityLogBytes + b.downloadHistoryBytes + b.otherBytes, 20_000)
  t.is(b.otherBytes, 20_000 - 9200 - 700 - 400 - 100, 'unclaimed cores (a profile) and engine files land in other')
})

test('other never goes negative when the estimates overshoot the total', (t) => {
  t.is(storageBreakdown(input({ totalDiskUsage: 1000 })).otherBytes, 0)
})

test('an empty store reports empty rows', (t) => {
  const b = storageBreakdown({ totalDiskUsage: 0, coreBytes: new Map(), spaces: [], indexBytes: 0, activityLog: [], downloadHistory: [] })
  t.alike(b, { spaces: [], indexBytes: 0, activityLogBytes: 0, downloadHistoryBytes: 0, otherBytes: 0 })
})
