import test from 'brittle'
import { claimVerdict, isDetachedCopy } from '../../src/shared/transfer/download-claim.js'

const REC = { localPath: '/dl/a.txt', hash: 'h1', downloadedAt: 1 }

test('claimVerdict resolves every branch of the on-device decision', (t) => {
  t.alike(claimVerdict({ rec: null }), { downloaded: false, prune: false, reason: 'no-claim' })
  t.alike(
    claimVerdict({ rec: REC, exists: true, volumePresent: true, currentHash: 'h1' }),
    { downloaded: true, prune: false, reason: null },
    'present and current',
  )
  t.is(
    claimVerdict({ rec: REC, exists: true, volumePresent: true, currentHash: null }).downloaded, true,
    'no upstream hash to compare against does not invalidate a claim',
  )
  t.is(
    claimVerdict({ rec: { localPath: '/dl/a.txt' }, exists: true, volumePresent: true, currentHash: 'h9' }).downloaded, true,
    'a hashless claim is not pruned by an upstream hash — the comparison needs a hash on BOTH sides',
  )
})

// The ordering is the whole reason this decision is a function of its own: a rewrite that read the
// hash first would destroy the claim of a copy on an ejected drive.
test('REGRESSION (FIX-CLAIM-ORDER): a detached volume keeps the claim, a deletion prunes it', (t) => {
  t.alike(
    claimVerdict({ rec: REC, exists: false, volumePresent: false }),
    { downloaded: false, prune: false, reason: 'volume-unavailable' },
    'file gone AND volume gone = ejected drive: not downloaded, but the claim SURVIVES',
  )
  t.alike(
    claimVerdict({ rec: REC, exists: false, volumePresent: true }),
    { downloaded: false, prune: true, reason: 'local-file-gone' },
    'file gone, volume present = the user deleted it: prune',
  )
  t.alike(
    claimVerdict({ rec: REC, exists: true, volumePresent: true, currentHash: 'h2' }),
    { downloaded: false, prune: true, reason: 'content-changed-upstream' },
    'the owner replaced the file: prune',
  )
  t.alike(
    claimVerdict({ rec: REC, exists: false, volumePresent: false, currentHash: 'h2' }),
    { downloaded: false, prune: false, reason: 'volume-unavailable' },
    'an ejected drive keeps the claim even when the owner has since replaced the file',
  )
})

test('a copy counts wherever it was downloaded to', (t) => {
  t.alike(
    claimVerdict({ rec: { localPath: '/Volumes/Ext/a.txt', hash: 'h1' }, exists: true, volumePresent: true, currentHash: 'h1' }),
    { downloaded: true, prune: false, reason: null },
  )
})

// REGRESSION (FIX-DLTO-R9: claims are keyed by name, so another owner's same-named file — or this
// owner's replaced one — read "Drive not connected · Saved to …" for a copy it never had.)
test('REGRESSION (FIX-DLTO-R9: a kept claim is the row\'s copy on a missing drive only when it names the row\'s content)', (t) => {
  const away = claimVerdict({ rec: REC, exists: false, volumePresent: false })
  t.is(away.reason, 'volume-unavailable', 'precondition: the claim is kept for a volume that is away')
  t.ok(isDetachedCopy(away, REC, 'h1'), 'the content the claim names')
  t.absent(isDetachedCopy(away, REC, 'h2'), 'another owner\'s same-named file, or a replaced one')
  t.absent(isDetachedCopy(away, { ...REC, hash: null }, 'h1'), 'a claim that names no content')
  t.absent(isDetachedCopy(away, REC, null), 'an entry still being hashed')
  t.absent(isDetachedCopy(claimVerdict({ rec: REC, exists: false, volumePresent: true }), REC, 'h1'), 'a deleted copy')
  t.absent(isDetachedCopy(claimVerdict({ rec: REC, exists: true, volumePresent: true, currentHash: 'h1' }), REC, 'h1'), 'a copy on the device')
})
