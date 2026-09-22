import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare, setupSelfMirror } from '../helpers/owned.js'
import { waitFor } from '../helpers/bare-poll.js'
import { initialMaterializeScan, runMaterializeTick } from '../../src/shared/folders/mirror-pass.js'
import { startForeignLoop, stopForeignLoop } from '../../src/shared/folders/foreign-verbs.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { consumerFilePath, listOverlayShareFiles } from '../../src/shared/shares/share-listing.js'
import { initDownloads, markDownloaded, markVerified } from '../../src/shared/transfer/files.js'
import { entryRef } from '../../src/shared/contract/entry-ref.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

// A self-mirror's share is owned by this peer, and an owner listing never reads the mirror. Listing
// it under another owner key takes the consumer branch against the same mount and records.
const PEER = 'f'.repeat(64)

async function mirrorRow(ctx, relPath) {
  const res = await listOverlayShareFiles(ctx.spaceId, { ...ctx.share, owner: PEER }, overlayBackend)
  return res.entries.find((e) => e.relPath === relPath)
}

// Rewrites a file in place with the same length and moves its mtime off the verified record's.
function editSameSize(abs, body) {
  fs.writeFileSync(abs, body)
  const future = new Date(Date.now() + 60000)
  fs.utimesSync(abs, future, future)
}

// A catalog version the tick can converge against, so a converged mirror skips its ticks.
function fixCatalogVersion(t, version = 1) {
  const state = { version }
  const orig = overlayBackend.catalogVersion
  overlayBackend.catalogVersion = async () => state.version
  t.teardown(() => { overlayBackend.catalogVersion = orig })
  return state
}

// REGRESSION (FIX-267-DISPLAY: the listing decided 'synced' by size and 'verified' by hash alone,
// so a same-size local edit of a mirrored file kept listing as synced and verified while the next
// pass was about to move it aside as a conflicted copy.)
test('REGRESSION (FIX-267-DISPLAY): a same-size local edit lists a mirrored file as modified, not synced and verified', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  await initDownloads()
  await initialMaterializeScan(ctx.mount)

  const before = await mirrorRow(ctx, 'a.txt')
  t.is(before.status, 'synced', 'baseline: the mirrored file lists as synced')
  t.is(before.verified, true, 'baseline: and verified')

  const abs = path.join(ctx.mirrorPath, 'a.txt')
  editSameSize(abs, 'bbbb')

  const row = await mirrorRow(ctx, 'a.txt')
  t.is(row.status, 'modified', 'the edited file lists as modified')
  t.is(row.verified, false, 'and is no longer vouched for')
  t.is(row.localPath, abs, 'the row still points at the edited file, so it can be revealed')
  t.is(row.mirrored, true, 'and says it came from the live mirror, which is what the hint reads')
})

// A download is never re-hashed, so only a changed size is taken as an edit there: a same-size
// write drops the verified check and stays on the device.
test('a browse-mode download: a same-size write drops the check, a resize lists as modified', async (t) => {
  const ctx = await setupOwnedShare(t)
  await initDownloads()
  const entry = { relPath: 'a.txt', size: 4, contentHash: 'h1', mtime: 0 }
  const backend = { listPeerWithMeta: async () => ({ entries: [entry], total: 1, totalBytes: 4, complete: true }) }
  const share = { ...ctx.share, owner: PEER }
  const landed = path.join(ctx.tmpDir('dl'), 'a.txt')
  fs.writeFileSync(landed, 'aaaa')
  await markDownloaded(ctx.spaceId, '/' + share.name + '/a.txt', landed, { hash: 'h1' })
  await markVerified(ctx.spaceId, entryRef(share.id, 'a.txt'), 'h1', { local: landed, stat: fs.statSync(landed) })
  const row = async () => (await listOverlayShareFiles(ctx.spaceId, share, backend)).entries[0]

  const before = await row()
  t.is(before.status, 'downloaded', 'baseline: downloaded')
  t.is(before.verified, true, 'baseline: and verified')
  t.is(before.mirrored, false, 'a browse row is not a mirror row')

  editSameSize(landed, 'bbbb')
  const drifted = await row()
  t.is(drifted.status, 'downloaded', 'a same-size write is not proof of an edit')
  t.is(drifted.verified, false, 'but nothing vouches for it any more')

  fs.writeFileSync(landed, 'bbbbb')
  const resized = await row()
  t.is(resized.status, 'modified', 'a resized download lists as modified')
  t.is(resized.verified, false)
  t.is(resized.localPath, landed, 'the row still points at the edited file')
})

// Both writers key their record by the owner's path; only `local` says which file the hash
// describes. A download landing in the downloads folder must not vouch for the mirror's copy.
test('a manual download of the same share path does not vouch for the mirror row', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  await initDownloads()
  await initialMaterializeScan(ctx.mount)
  const { entries: [entry] } = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)

  const landed = path.join(ctx.tmpDir('dl'), 'a.txt')
  fs.writeFileSync(landed, 'aaaa')
  await markVerified(ctx.spaceId, entryRef(ctx.share.id, 'a.txt'), entry.contentHash, { local: landed, stat: fs.statSync(landed) })

  const row = await mirrorRow(ctx, 'a.txt')
  t.is(row.status, 'synced', 'the untouched mirror copy still lists as on the device')
  t.is(row.verified, false, 'but the download record does not vouch for it')
})

test('a listed edit makes the next tick walk, which keeps the edit as a conflicted copy', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  fixCatalogVersion(t)
  await initDownloads()
  await initialMaterializeScan(ctx.mount)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  const abs = path.join(ctx.mirrorPath, 'a.txt')
  const conflicted = path.join(ctx.mirrorPath, 'a (conflicted copy).txt')
  editSameSize(abs, 'bbbb')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(fs.readFileSync(abs, 'utf8'), 'bbbb', 'a converged mirror skips the tick: the edit is invisible to the catalog version')

  t.is((await mirrorRow(ctx, 'a.txt')).status, 'modified', 'the listing sees the edit')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.ok(fs.existsSync(conflicted), 'the walk the listing asked for kept the edit aside')
  t.is(fs.existsSync(conflicted) && fs.readFileSync(conflicted, 'utf8'), 'bbbb', 'with the edited bytes')
  t.is(fs.readFileSync(abs, 'utf8'), 'aaaa', 'and restored the owner’s version')

  const row = await mirrorRow(ctx, 'a.txt')
  t.is(row.status, 'synced', 'the restored file lists as synced')
  t.is(row.verified, true, 'and verified again')
})

// The same bytes at a new inode — a copy, a restore, a remount — are not an edit. The row stays on
// the device unverified, and the walk it asks for re-hashes the file and vouches for it again.
test('the same bytes at a new inode stay synced, and the walk re-verifies them', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  await initDownloads()
  await initialMaterializeScan(ctx.mount)

  // A whole-second mtime, re-recorded, so the copy below can carry exactly the same one.
  const abs = path.join(ctx.mirrorPath, 'a.txt')
  const second = Math.floor(Date.now() / 1000) - 60
  fs.utimesSync(abs, second, second)
  const { entries: [entry] } = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)
  await markVerified(ctx.spaceId, entryRef(ctx.share.id, 'a.txt'), entry.contentHash, { local: 'a.txt', stat: fs.statSync(abs) })
  const before = fs.statSync(abs)
  const copy = path.join(ctx.tmpDir('restore'), 'a.txt')
  fs.copyFileSync(abs, copy)
  fs.utimesSync(copy, second, second)
  fs.rmSync(abs)
  fs.renameSync(copy, abs)
  t.not(Number(fs.statSync(abs).ino), Number(before.ino), 'precondition: a new inode')
  t.is(Math.floor(fs.statSync(abs).mtimeMs), Math.floor(before.mtimeMs), 'precondition: the same mtime')

  const moved = await mirrorRow(ctx, 'a.txt')
  t.is(moved.status, 'synced', 'not an edit')
  t.is(moved.verified, false, 'but not vouched for until it is re-hashed')

  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  const after = await mirrorRow(ctx, 'a.txt')
  t.is(after.status, 'synced')
  t.is(after.verified, true, 'the walk re-hashed the unchanged bytes and vouches for them again')
  t.is(fs.readFileSync(abs, 'utf8'), 'aaaa', 'and left them in place')
})

// A record written before records named their landing path is taken as this file's, as the engine's
// fast path takes it.
test('a verified record that names no landing path still vouches for the mirror row', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  await initDownloads()
  await initialMaterializeScan(ctx.mount)
  const { entries: [entry] } = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)
  const abs = path.join(ctx.mirrorPath, 'a.txt')
  await markVerified(ctx.spaceId, entryRef(ctx.share.id, 'a.txt'), entry.contentHash, { stat: fs.statSync(abs) })

  const row = await mirrorRow(ctx, 'a.txt')
  t.is(row.status, 'synced')
  t.is(row.verified, true)
})

// The request must survive a walk that is already past the file: that walk converging would let
// every later tick skip, and the edit would wait for the backstop.
test('an edit listed while a walk is in flight is walked by the next tick', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa', 'b.txt': 'bbbb' } })
  const catalog = fixCatalogVersion(t)
  await initDownloads()
  await initialMaterializeScan(ctx.mount)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  const abs = path.join(ctx.mirrorPath, 'a.txt')
  const conflicted = path.join(ctx.mirrorPath, 'a (conflicted copy).txt')
  fs.rmSync(path.join(ctx.mirrorPath, 'b.txt'))
  const overlay = getOverlay()
  const fetchFile = overlay.fetchFile
  let listedMidWalk = null
  overlay.fetchFile = async (...args) => {
    if (listedMidWalk === null) {
      editSameSize(abs, 'cccc')
      listedMidWalk = (await mirrorRow(ctx, 'a.txt')).status
    }
    return await fetchFile(...args)
  }
  t.teardown(() => { overlay.fetchFile = fetchFile })

  catalog.version = 2
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(listedMidWalk, 'modified', 'the edit landed after the walk had passed the file, and was listed')
  t.is(fs.readFileSync(abs, 'utf8'), 'cccc', 'that walk did not see it')

  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.ok(fs.existsSync(conflicted), 'the next tick walked instead of skipping, and kept the edit aside')
  t.is(fs.readFileSync(abs, 'utf8'), 'aaaa', 'and restored the owner’s version')
})

test('a listed edit on a live, converged mirror is walked without waiting for the poll', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  fixCatalogVersion(t)
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, foreignPollIntervalMs: 600_000 })
  t.teardown(() => setRuntimeConfig(cfg))
  await initDownloads()
  await startForeignLoop({ spaceId: ctx.spaceId, shareId: ctx.share.id })
  t.teardown(() => stopForeignLoop(ctx.spaceId, ctx.share.id))
  await initialMaterializeScan(ctx.mount)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  const abs = path.join(ctx.mirrorPath, 'a.txt')
  editSameSize(abs, 'cccc')
  t.is((await mirrorRow(ctx, 'a.txt')).status, 'modified')
  await waitFor(() => fs.existsSync(path.join(ctx.mirrorPath, 'a (conflicted copy).txt')), 5000, { label: 'the poked walk' })
  t.is(fs.readFileSync(abs, 'utf8'), 'aaaa', 'the owner’s version is back long before the next poll')
})

// The landing re-derives the row only once its record describes the new file: listed earlier, the
// fresh bytes would be judged against the replaced file's fingerprint and read as an edit. Only the
// re-lists raised once the landed file is on disk are the landing's; the one raised as the fetch
// starts, with the edit already moved aside, is not.
test('every re-list a mirror landing triggers sees the landed file verified, never modified', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  await initDownloads()
  await initialMaterializeScan(ctx.mount)
  const abs = path.join(ctx.mirrorPath, 'a.txt')
  editSameSize(abs, 'cccc')

  const listings = []
  const off = ctx.fake.onEmit((frame) => {
    if (frame.type !== 'event:share-files-updated' || frame.payload.shareId !== ctx.share.id) return
    if (fs.existsSync(abs)) listings.push(mirrorRow(ctx, 'a.txt'))
  })
  t.teardown(off)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  const rows = await Promise.all(listings)

  t.is(fs.readFileSync(abs, 'utf8'), 'aaaa', 'precondition: the pass restored the owner’s version')
  t.ok(rows.length > 0, 'the landing re-listed the share')
  t.alike(rows.map((r) => r.status).filter((s) => s === 'modified'), [], 'no re-list saw the landed file as an edit')
  t.is(rows.at(-1).status, 'synced')
  t.is(rows.at(-1).verified, true, 'the last one sees it verified')
})

test('reveal targets the collision sibling a mirror wrote, not the user file at the natural name', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  await initDownloads()
  fs.writeFileSync(path.join(ctx.mirrorPath, 'a.txt'), 'the user’s own, unrelated file')
  await initialMaterializeScan(ctx.mount)

  const sibling = path.join(ctx.mirrorPath, 'a (1).txt')
  t.is(fs.readFileSync(sibling, 'utf8'), 'aaaa', 'precondition: the mirror wrote a sibling')
  t.is(await consumerFilePath(ctx.spaceId, ctx.share, 'a.txt'), sibling)
  t.is((await mirrorRow(ctx, 'a.txt')).localPath, sibling, 'the same file the row points at')
})
