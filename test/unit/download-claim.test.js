import test from 'brittle'
import { claimVerdict } from '../../src/shared/transfer/download-claim.js'

const REC = { localPath: '/dl/a.txt', hash: 'h1', downloadedAt: 1 }

test('claimVerdict resolves every branch of the on-device decision', (t) => {
  t.alike(claimVerdict({ rec: null }), { downloaded: false, prune: false, reason: 'no-claim' })
  t.alike(
    claimVerdict({ rec: REC, exists: true, dirExists: true, currentHash: 'h1' }),
    { downloaded: true, prune: false, reason: null },
    'present and current',
  )
  t.is(
    claimVerdict({ rec: REC, exists: true, dirExists: true, currentHash: null }).downloaded, true,
    'no upstream hash to compare against does not invalidate a claim',
  )
  t.is(
    claimVerdict({ rec: { localPath: '/dl/a.txt' }, exists: true, dirExists: true, currentHash: 'h9' }).downloaded, true,
    'a hashless claim is not pruned by an upstream hash — the comparison needs a hash on BOTH sides',
  )
})

// The ordering is the whole reason this decision is a function of its own: a rewrite that checked
// the pinned folder first would destroy the claim of a file that is merely in the wrong place, and
// re-pointing the space at the old folder would then no longer restore it.
test('REGRESSION (FIX-CLAIM-ORDER): a detached volume keeps the claim, a deletion prunes it', (t) => {
  t.alike(
    claimVerdict({ rec: REC, exists: false, dirExists: false }),
    { downloaded: false, prune: false, reason: 'volume-unavailable' },
    'file gone AND folder gone = ejected drive: not downloaded, but the claim SURVIVES',
  )
  t.alike(
    claimVerdict({ rec: REC, exists: false, dirExists: true }),
    { downloaded: false, prune: true, reason: 'local-file-gone' },
    'file gone, folder present = the user deleted it: prune',
  )
  t.alike(
    claimVerdict({ rec: REC, exists: true, dirExists: true, currentHash: 'h2' }),
    { downloaded: false, prune: true, reason: 'content-changed-upstream' },
    'the owner replaced the file: prune',
  )
  t.alike(
    claimVerdict({ rec: REC, exists: true, dirExists: true, currentHash: 'h1', pinned: '/other', insidePinned: false }),
    { downloaded: false, prune: false, reason: 'outside-space-folder' },
    'outside the pinned folder is NON-destructive: reports not-downloaded, keeps the record',
  )
  t.is(
    claimVerdict({ rec: REC, exists: false, dirExists: true, pinned: '/other', insidePinned: false }).prune, true,
    'prune wins over scope — a deleted file is pruned even when it was out of scope',
  )
})
