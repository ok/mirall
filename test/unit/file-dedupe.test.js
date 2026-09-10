import test from 'brittle'
import { dedupeFileRows, STATUS_RANK } from '../../src/shared/transfer/file-dedupe.js'
import { FILE_STATUS } from '../../src/shared/contract/statuses.js'

const candidate = (over = {}) => ({
  path: '/a.txt', size: 1, hash: 'h-a', inPlace: true, status: 'remote',
  owner: { displayName: 'Peer', publicKey: 'pk' }, ...over,
})

test('every file status has a rank and every rank names a file status', (t) => {
  const ranked = Object.keys(STATUS_RANK).sort()
  t.alike(ranked, [...FILE_STATUS].sort(), 'the rank table and FILE_STATUS name the same statuses')
  for (const status of FILE_STATUS) t.is(typeof STATUS_RANK[status], 'number', status + ' has a numeric rank')
})

test('the same content held by several peers folds into one row with a sharedByCount', (t) => {
  const rows = dedupeFileRows([
    candidate({ status: 'remote', owner: { displayName: 'A', publicKey: 'a' } }),
    candidate({ status: 'downloaded', owner: { displayName: 'B', publicKey: 'b' } }),
  ])
  t.is(rows.length, 1, 'one row per content hash')
  t.is(rows[0].status, 'downloaded', 'the most-progressed copy wins')
  t.is(rows[0].sharedByCount, 1, 'the rest become a sharedByCount')
})

// REGRESSION (FIX-1: unhashed rows all carry hash '', so grouping on the hash alone collapsed
// every simultaneously-prepared file into one row with a bogus sharedByCount).
test('files still being prepared stay one row each', (t) => {
  const rows = dedupeFileRows([
    candidate({ path: '/a.txt', hash: '', status: 'publishing' }),
    candidate({ path: '/b.txt', hash: '', status: 'publishing' }),
    candidate({ path: '/c.txt', hash: '', status: 'preparing' }),
  ])
  t.alike(rows.map((r) => r.path).sort(), ['/a.txt', '/b.txt', '/c.txt'], 'three prepared files, three rows')
  for (const row of rows) t.absent(row.sharedByCount, 'no phantom co-sharer')
})

// Two owners preparing the same NAME are not the same file until their hashes say so.
test('two peers preparing the same path stay separate rows', (t) => {
  const rows = dedupeFileRows([
    candidate({ path: '/a.txt', hash: '', status: 'preparing', owner: { displayName: 'A', publicKey: 'a' } }),
    candidate({ path: '/a.txt', hash: '', status: 'preparing', owner: { displayName: 'B', publicKey: 'b' } }),
  ])
  t.is(rows.length, 2, 'a name is not an identity')
  t.alike(rows.map((r) => r.owner.publicKey).sort(), ['a', 'b'], 'both owners keep a row')

  const folded = dedupeFileRows(rows.map((r) => ({ ...r, hash: 'h-a' })))
  t.is(folded.length, 1, 'once both hashes land the rows fold across owners')
  t.is(folded[0].sharedByCount, 1)
})

// REGRESSION (FIX-1: 'preparing' was absent from the rank table, so the comparator returned NaN
// and the group's winner fell back to insertion order).
test('a preparing copy loses to a downloadable one whichever way round they arrive', (t) => {
  const preparing = candidate({ status: 'preparing', owner: { displayName: 'A', publicKey: 'a' } })
  const remote = candidate({ status: 'remote', owner: { displayName: 'B', publicKey: 'b' } })

  t.is(dedupeFileRows([preparing, remote])[0].status, 'remote', 'preparing first')
  t.is(dedupeFileRows([remote, preparing])[0].status, 'remote', 'remote first')
})

test('a verifying copy outranks one still downloading', (t) => {
  const verifying = candidate({ status: 'verifying', owner: { displayName: 'A', publicKey: 'a' } })
  const downloading = candidate({ status: 'downloading', owner: { displayName: 'B', publicKey: 'b' } })

  t.is(dedupeFileRows([downloading, verifying])[0].status, 'verifying')
  t.is(dedupeFileRows([verifying, downloading])[0].status, 'verifying')
})
