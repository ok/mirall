import test from 'brittle'
import { listingTruncated } from '../../src/shared/folders/share-limits.js'

// The `truncated` fact the worker ships to the renderer (FIX-358). It replaces the old
// (total > rows.length) inference, which silently went false on the one read where it mattered.
test('listingTruncated: a folder sitting exactly ON the cap is fully listed, not truncated', (t) => {
  // The off-by-one a bare `rowCount >= cap` would get wrong: every row IS listed, so a banner
  // announcing a truncation would be a lie.
  t.absent(listingTruncated({ rowCount: 5000, total: 5000, cap: 5000, complete: true }))
  t.absent(listingTruncated({ rowCount: 12, total: 12, cap: 5000, complete: true }), 'well under the cap')
})

test('listingTruncated: a complete read that counted more than it returned IS truncated', (t) => {
  t.ok(listingTruncated({ rowCount: 5000, total: 6214, cap: 5000, complete: true }))
})

test('REGRESSION (FIX-358): a capped INCOMPLETE read is truncated even when its own total says otherwise', (t) => {
  // The silent-truncation shape. The drain was cut short, so `total` is partial and can equal the
  // row count — the old (total > rows) inference then reported "not truncated" for a listing that
  // was demonstrably capped, and the banner vanished. An incomplete read cannot prove nothing is
  // missing, so assume it is.
  t.ok(listingTruncated({ rowCount: 5000, total: 5000, cap: 5000, complete: false }))
})

test('listingTruncated: a partial read that never reached the cap is not a truncation', (t) => {
  // Rows are missing because the read stalled, not because the cap withheld them — reconcileFiles
  // keeps the last good list, and a truncation banner would misattribute the cause.
  t.absent(listingTruncated({ rowCount: 200, total: 200, cap: 5000, complete: false }))
})

test('listingTruncated: an uncapped listing is never truncated', (t) => {
  t.absent(listingTruncated({ rowCount: 150000, total: 150000, cap: Infinity, complete: true }))
})
