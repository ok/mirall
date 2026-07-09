import test from 'brittle'
import { shouldHonorDeletions } from '../../src/shared/folders/foreign-folders.js'

// E6 / FIX-6 — the materialize tick deletes any on-disk file not in the owner's
// drive listing. A transiently EMPTY listing (owner drive re-replicating, or a
// stale read) would then wipe the entire mirror from the user's disk. The tick
// must only honor deletions when the owner's listing is trustworthy: owner
// online AND a non-empty drive listing. (Symmetric with the owner-side
// mount-gone guard — never mass-delete on a suspect signal.)
test('REGRESSION (E6): deletions honored only with a trustworthy owner listing', (t) => {
  t.ok(shouldHonorDeletions({ ownerOnline: true, driveCount: 3 }), 'online + non-empty → honor per-file deletes')

  // The catastrophic case: an empty listing while files exist on disk must NOT
  // be treated as "owner deleted everything".
  t.absent(shouldHonorDeletions({ ownerOnline: true, driveCount: 0 }), 'empty listing → do NOT delete')

  // An offline owner's cached/stale listing is not authoritative for removals.
  t.absent(shouldHonorDeletions({ ownerOnline: false, driveCount: 3 }), 'owner offline → do NOT delete')
  t.absent(shouldHonorDeletions({ ownerOnline: false, driveCount: 0 }), 'offline + empty → do NOT delete')
})
