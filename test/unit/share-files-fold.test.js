import test from 'brittle'
import { foldListing, emptyFold, resetFold } from '../../src/renderer/shareFilesFold.js'

// The hook's mapper, reduced to what the fold needs. Rows arrive sorted by relPath — the catalog
// read stream is key-ordered — which is what reconcileFiles' two-pointer merge relies on.
const toEntry = (e) => ({
  relPath: e.relPath, size: e.size ?? 0, hash: e.hash ?? '', mtime: e.mtime ?? 0,
  status: e.status ?? 'remote', localPath: e.localPath ?? undefined,
})
const entry = (relPath, over = {}) => ({ relPath, size: 1, hash: 'h-' + relPath, mtime: 1, status: 'remote', ...over })
const res = (entries, over = {}) => ({ entries, complete: true, ...over })

test('a complete response is adopted wholesale, removals included', (t) => {
  const first = foldListing(emptyFold, res([entry('a'), entry('b')]), toEntry)
  t.alike(first.rows.map((r) => r.relPath), ['a', 'b'])

  const second = foldListing(first, res([entry('a')]), toEntry)
  t.alike(second.rows.map((r) => r.relPath), ['a'], 'an authoritative read may delete rows')
})

// REGRESSION (FIX-NEVER-BLANK-STORE: a peer read can return empty simply because the owner is
// mid-index or briefly unreachable. Adopting that response would empty a folder the user is looking
// at, and it is the specific failure that kept these two hooks off the query store.)
test('REGRESSION (FIX-NEVER-BLANK-STORE): an incomplete empty response keeps every row', (t) => {
  const seeded = foldListing(emptyFold, res([entry('a'), entry('b')]), toEntry)
  const after = foldListing(seeded, res([], { complete: false }), toEntry)

  t.alike(after.rows.map((r) => r.relPath), ['a', 'b'], 'the rows on screen survive')
  t.is(after.rows, seeded.rows, 'and keep their identity, so React does not re-render the list')
})

test('an incomplete partial response unions by relPath, preferring the fresh row', (t) => {
  const seeded = foldListing(emptyFold, res([entry('a', { size: 1 }), entry('b')]), toEntry)
  const after = foldListing(seeded, res([entry('a', { size: 99 })], { complete: false }), toEntry)

  t.alike(after.rows.map((r) => r.relPath), ['a', 'b'], 'the unseen row is kept')
  t.is(after.rows.find((r) => r.relPath === 'a').size, 99, 'the fresh row wins where they overlap')
})

test('an unchanged listing returns the same rows reference', (t) => {
  const seeded = foldListing(emptyFold, res([entry('a'), entry('b')]), toEntry)
  const again = foldListing(seeded, res([entry('a'), entry('b')], { complete: false }), toEntry)
  t.is(again.rows, seeded.rows, 'row identity is preserved when nothing moved')
})

test('the same response object folds once', (t) => {
  const first = foldListing(emptyFold, res([entry('a')]), toEntry)
  const same = foldListing(first, first.res, toEntry)
  t.is(same, first, 're-rendering with the same response is a no-op, not a re-fold')
})

test('a null response leaves the fold alone', (t) => {
  const seeded = foldListing(emptyFold, res([entry('a')]), toEntry)
  t.is(foldListing(seeded, null, toEntry), seeded, 'nothing to fold before the first read lands')
})

// FolderView is reused rather than keyed per share.
test('resetting clears the fold so one share cannot bleed into the next', (t) => {
  const seeded = foldListing(emptyFold, res([entry('a')]), toEntry)
  const cleared = resetFold()
  t.alike(cleared.rows, [], 'no rows carry over')
  t.is(cleared.res, null)
  const next = foldListing(cleared, res([entry('z')]), toEntry)
  t.alike(next.rows.map((r) => r.relPath), ['z'], 'the new share starts from its own read')
  t.absent(next.rows.some((r) => r.relPath === 'a'), 'the previous share is gone')
  t.ok(seeded.rows.length === 1, 'and the old fold was not mutated')
})

test('the header never reports fewer files than are on screen', (t) => {
  const seeded = foldListing(emptyFold, res([entry('a'), entry('b')], { total: 2, totalBytes: 2 }), toEntry)
  t.is(seeded.info.fileCount, 2)

  // An incomplete read saw only one file, but two are rendered — a header reading 1 over a list of
  // 2 is always wrong.
  const after = foldListing(seeded, res([entry('a')], { complete: false, total: 1, totalBytes: 1 }), toEntry)
  t.is(after.rows.length, 2)
  t.is(after.info.fileCount, 2, 'the count may only rise above the visible rows')
  t.ok(after.info.totalBytes >= 2, 'and so may the size')
})

test('a complete read trusts the worker totals over the row count', (t) => {
  // Rows are capped at listFilesCap; total is the real figure the over-limit banner reports.
  const folded = foldListing(emptyFold, res([entry('a')], { total: 5000, totalBytes: 99, truncated: true, fileLimit: 1 }), toEntry)
  t.is(folded.info.fileCount, 5000, 'the true total, not the capped row count')
  t.ok(folded.info.truncated, 'and truncation is reported, never inferred')
  t.is(folded.info.fileLimit, 1)
})
