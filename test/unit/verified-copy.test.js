import test from 'brittle'
import { fingerprintMatches, verifiedCopyVerdict, COPY_VERDICT } from '../../src/shared/transfer/verified-copy.js'

const AT = 1_700_000_000_000
const rec = (o = {}) => ({ hash: 'h1', at: AT, local: 'a.txt', mtime: AT - 5000, ino: 42, ...o })
const stat = (o = {}) => ({ size: 4, mtimeMs: AT - 5000 + 0.7, ino: 42, ...o })

test('fingerprintMatches: the file the record fingerprinted, unchanged, matches', (t) => {
  t.ok(fingerprintMatches(rec(), stat(), 4, { expectLocal: 'a.txt' }), 'sub-millisecond mtime is floored like the record')
  t.ok(fingerprintMatches(rec(), stat(), 4), 'no path asked for: the fingerprint alone decides')
})

test('fingerprintMatches: a moved mtime, a swapped inode or another size does not', (t) => {
  t.absent(fingerprintMatches(rec(), stat({ mtimeMs: AT + 60000 }), 4), 'a later mtime')
  t.absent(fingerprintMatches(rec(), stat({ mtimeMs: AT - 60000 }), 4), 'an earlier, preserved mtime')
  t.absent(fingerprintMatches(rec(), stat({ ino: 43 }), 4), 'a different inode')
  t.absent(fingerprintMatches(rec(), stat({ size: 5 }), 4), 'a different size')
})

test('fingerprintMatches: an inode of 0 on either side is not compared', (t) => {
  t.ok(fingerprintMatches(rec({ ino: 0 }), stat({ ino: 43 }), 4), 'the record has none')
  t.ok(fingerprintMatches(rec(), stat({ ino: 0 }), 4), 'the filesystem reports none')
})

test('fingerprintMatches: a record without a fingerprint keeps the no-newer-than rule', (t) => {
  const legacy = rec({ mtime: undefined, ino: undefined })
  t.ok(fingerprintMatches(legacy, stat({ mtimeMs: AT }), 4), 'as old as the record')
  t.ok(fingerprintMatches(legacy, stat({ mtimeMs: AT - 60000 }), 4), 'older than the record')
  t.absent(fingerprintMatches(legacy, stat({ mtimeMs: AT + 1 }), 4), 'newer than the record')
})

test('fingerprintMatches: a record for another path vouches for nothing', (t) => {
  t.absent(fingerprintMatches(rec(), stat(), 4, { expectLocal: 'b.txt' }))
  t.absent(fingerprintMatches(rec({ local: null }), stat(), 4, { expectLocal: 'a.txt' }), 'nor does one that names no path')
})

test('fingerprintMatches: no record or no stat is never a match', (t) => {
  t.absent(fingerprintMatches(null, stat(), 4))
  t.absent(fingerprintMatches(rec(), null, 4))
})

const verdict = (r, s, o = {}) => verifiedCopyVerdict(r, s, { contentHash: 'h1', expectedSize: 4, expectLocal: 'a.txt', ...o })
const mirror = (r, s) => verdict(r, s, { rehashed: true })

test('verifiedCopyVerdict: the fingerprinted file at the current content is verified', (t) => {
  t.is(verdict(rec(), stat()), COPY_VERDICT.VERIFIED)
  t.is(mirror(rec(), stat()), COPY_VERDICT.VERIFIED)
})

test('verifiedCopyVerdict: a changed size is an edit on every kind of row', (t) => {
  t.is(verdict(rec(), stat({ size: 5 })), COPY_VERDICT.MODIFIED, 'a download')
  t.is(mirror(rec(), stat({ size: 5 })), COPY_VERDICT.MODIFIED, 'a mirror')
  t.is(verdict(rec(), stat({ size: 5, mtimeMs: AT - 60000 })), COPY_VERDICT.MODIFIED, 'even with the mtime carried over')
})

test('verifiedCopyVerdict: a moved mtime is an edit only where a re-hash can take it back', (t) => {
  t.is(mirror(rec(), stat({ mtimeMs: AT + 60000 })), COPY_VERDICT.MODIFIED, 'a mirror: its next pass re-hashes')
  t.is(verdict(rec(), stat({ mtimeMs: AT + 60000 })), COPY_VERDICT.DRIFTED, 'a download: on the device, no longer vouched for')
  const legacy = rec({ mtime: undefined, ino: undefined })
  t.is(mirror(legacy, stat({ mtimeMs: AT + 1 })), COPY_VERDICT.MODIFIED, 'an unfingerprinted record: newer than it')
  t.is(mirror(legacy, stat({ mtimeMs: AT - 1 })), COPY_VERDICT.VERIFIED, 'and no newer is still verified')
})

test('verifiedCopyVerdict: an inode that moved alone is drift, never an edit', (t) => {
  t.is(mirror(rec(), stat({ ino: 43 })), COPY_VERDICT.DRIFTED, 'a copy, a restore or a remount with the same bytes')
  t.is(verdict(rec(), stat({ ino: 43 })), COPY_VERDICT.DRIFTED)
})

test('verifiedCopyVerdict: a record that names no landing path is taken as this file, as the engine takes it', (t) => {
  t.is(verdict(rec({ local: null }), stat()), COPY_VERDICT.VERIFIED)
  t.is(verdict(rec({ local: undefined }), stat({ size: 5 })), COPY_VERDICT.MODIFIED)
})

test('verifiedCopyVerdict: a record that does not describe this file at this content proves nothing', (t) => {
  t.is(mirror(rec({ hash: 'h0' }), stat({ size: 5 })), COPY_VERDICT.UNPROVEN, 'an older content hash')
  t.is(mirror(rec({ local: '/Downloads/a.txt' }), stat({ size: 5 })), COPY_VERDICT.UNPROVEN, 'another path')
  t.is(verdict(null, stat()), COPY_VERDICT.UNPROVEN, 'no record')
  t.is(verdict(rec(), null), COPY_VERDICT.UNPROVEN, 'no file')
  t.is(verdict(rec(), stat(), { contentHash: null }), COPY_VERDICT.UNPROVEN, 'the owner has not hashed it')
})
