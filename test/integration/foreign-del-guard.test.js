import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { shouldHonorDeletions } from '../../src/shared/folders/path-keys.js'
import { initialMaterializeScan } from '../../src/shared/folders/foreign-folders.js'
import { getForeignMount } from '../../src/shared/folders/mount-store.js'
import { setupSelfMirror } from '../helpers/owned.js'

// E6 / FIX-6 — the materialize tick deletes any on-disk file not in the owner's
// drive listing. A transiently EMPTY listing (owner drive re-replicating, or a
// stale read) would then wipe the entire mirror from the user's disk. The tick
// must only honor deletions when the owner's listing is trustworthy: owner
// online AND a non-empty drive listing. (Symmetric with the owner-side
// mount-gone guard — never mass-delete on a suspect signal.)
test('REGRESSION (E6): deletions honored only with a trustworthy owner listing', (t) => {
  t.ok(shouldHonorDeletions({ ownerOnline: true, driveCount: 3, listingComplete: true }), 'online + non-empty + complete → honor per-file deletes')

  // The catastrophic case: an empty listing while files exist on disk must NOT
  // be treated as "owner deleted everything".
  t.absent(shouldHonorDeletions({ ownerOnline: true, driveCount: 0, listingComplete: true }), 'empty listing → do NOT delete')

  // An offline owner's cached/stale listing is not authoritative for removals.
  t.absent(shouldHonorDeletions({ ownerOnline: false, driveCount: 3, listingComplete: true }), 'owner offline → do NOT delete')
  t.absent(shouldHonorDeletions({ ownerOnline: false, driveCount: 0, listingComplete: true }), 'offline + empty → do NOT delete')
})

// REGRESSION (FIX-359) — E6 guarded the EMPTY listing and left the nastier shape wide open: a
// catalog drain that times out mid-tree returns a PARTIAL, NON-EMPTY listing (say 4,200 of 6,000
// entries). That sailed straight through `driveCount > 0` and was then treated as authoritative, so
// every already-synced file missing from the truncated view was deleted off the user's disk and
// pruned from syncedPaths — a network timeout deleting files the owner still has. The read's
// `complete` flag existed all along; listPeerShare threw it away before the guard could see it. The
// odds of such a drain grow with the file count, so the bigger the folder, the likelier the wrong
// delete.
test('REGRESSION (FIX-359): a truncated, non-empty listing must NOT authorize deletions', (t) => {
  t.absent(
    shouldHonorDeletions({ ownerOnline: true, driveCount: 4200, listingComplete: false }),
    'a partial drain is not evidence of deletion, however many entries it returned',
  )
  t.absent(
    shouldHonorDeletions({ ownerOnline: true, driveCount: 1, listingComplete: false }),
    'not even a single-entry partial read',
  )
})

// The same fix one layer up, and observable without a live owner: an incomplete read may not shrink
// the mirror's record of what it already holds. If it did, a mirror holding 6 files would forget 4
// of them on a single truncated re-scan — losing the very evidence a later deletion is judged
// against, and reporting a half-empty mirror as fully synced.
test('REGRESSION (FIX-359): a truncated re-scan does not shrink the mirror\'s synced record', async (t) => {
  const files = {}
  for (let i = 0; i < 6; i++) files['f' + i + '.txt'] = 'body-' + i
  const ctx = await setupSelfMirror(t, { files })
  const onDisk = (i) => fs.existsSync(path.join(ctx.mirrorPath, 'f' + i + '.txt'))

  await initialMaterializeScan(ctx.mount)
  const full = await getForeignMount(ctx.spaceId, ctx.share.id)
  t.is(full.syncedPaths.length, 6, 'baseline: the mirror knows it holds all 6')
  t.ok(full.initialScanCompletedAt, 'and a complete scan is stamped done')
  for (let i = 0; i < 6; i++) t.ok(onDisk(i), 'baseline: f' + i + '.txt is on disk')

  // The owner's catalog now reads short AND incomplete — a drain cut off mid-tree.
  ctx.listing.truncateAfter = 2
  ctx.listing.complete = false
  await initialMaterializeScan(ctx.mount)

  const after = await getForeignMount(ctx.spaceId, ctx.share.id)
  t.is(after.syncedPaths.length, 6, 'the synced record survives — a partial view never replaces it')
  for (let i = 0; i < 6; i++) t.ok(onDisk(i), 'f' + i + '.txt still on disk after the truncated read')
})
