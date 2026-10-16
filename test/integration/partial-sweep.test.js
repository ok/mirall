import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer, rebootPeer } from '../helpers/store.js'
import { until } from '../helpers/bare-poll.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { initDownloads, markDownloaded } from '../../src/shared/transfer/files.js'
import { listCurrentDownloadFolders, listDownloadRoots } from '../../src/shared/core/paths.js'
import { initPendingTransfers, recordPending, forgetStaleFailures, getPendingFor, _pendingBeeForTests, FAILED_ROW_MAX_AGE_MS } from '../../src/shared/transfer/pending-transfers.js'
import { cleanupOrphanedPartials, discardRowPartials } from '../../src/shared/transfer/partial-sweep.js'

test('cleanupOrphanedPartials sweeps an orphan, keeps one referenced by a pending finalPath', async (t) => {
  const { downloads } = await freshPeer(t)
  await initPendingTransfers()
  const keptFinal = path.join(downloads, 'keep.bin')
  const kept = keptFinal + '.mirall.part'
  const orphan = path.join(downloads, 'orphan.bin.mirall.part')
  for (const f of [kept, orphan]) fs.writeFileSync(f, 'half')
  // The overlay/loose engine records finalPath (not localPath) — the partial is
  // <finalPath>.mirall.part, so the row's finalPath protects it.
  await recordPending('s', '/keep.bin', { finalPath: keptFinal, inPlace: true })

  await cleanupOrphanedPartials(downloads)

  t.ok(fs.existsSync(kept), 'partial referenced by a pending finalPath survives')
  t.absent(fs.existsSync(orphan), 'orphaned partial swept')
})

// REGRESSION (PART-1): the sweep unlinks every match it cannot attribute to a pending row
// or a journal, and it scans the user's real Downloads folder. Firefox and KDE name their
// in-progress downloads `<name>.part` there, IE/Edge use `<name>.partial`. Our suffix must
// carry an ownership token or a boot would destroy a stranger's download. This test fails
// if PARTIAL_SUFFIX is ever loosened to a bare '.part'.
test("cleanupOrphanedPartials leaves other apps' in-progress downloads alone", async (t) => {
  const { downloads } = await freshPeer(t)
  await initPendingTransfers()
  const firefox = path.join(downloads, 'bigvideo.mp4.part')
  const edge = path.join(downloads, 'legacy.txt.partial')
  const real = path.join(downloads, 'done.txt')
  const ours = path.join(downloads, 'gone.bin.mirall.part')
  for (const f of [firefox, edge, real, ours]) fs.writeFileSync(f, 'x')

  await cleanupOrphanedPartials(downloads)

  t.ok(fs.existsSync(firefox), "another app's in-progress .part download survives")
  t.ok(fs.existsSync(edge), "another app's in-progress .partial download survives")
  t.ok(fs.existsSync(real), 'non-partial file untouched')
  t.absent(fs.existsSync(ours), 'our own orphaned partial swept')
})

test('cleanupOrphanedPartials is a no-op on a missing downloads dir', async (t) => {
  await freshPeer(t)
  await initPendingTransfers()
  await cleanupOrphanedPartials(path.join('/nonexistent', 'dl-' + Date.now()))
  t.pass('returns without throwing when the dir does not exist')
})

// Per-space download folders mean there is no longer a single downloads dir. A root
// the sweep skips leaks crash-orphaned partials forever, so every root must be walked
// and one missing root must not abort the rest.
test('cleanupOrphanedPartials walks every download root and skips missing ones', async (t) => {
  const { downloads, tmpDir } = await freshPeer(t)
  await initPendingTransfers()
  const second = tmpDir('dl-space')
  const inGlobal = path.join(downloads, 'a.bin.mirall.part')
  const inSecond = path.join(second, 'b.bin.mirall.part')
  for (const f of [inGlobal, inSecond]) fs.writeFileSync(f, 'half')

  const missing = path.join('/nonexistent', 'dl-' + Date.now())
  await cleanupOrphanedPartials([downloads, missing, second])

  t.absent(fs.existsSync(inGlobal), 'orphan in the global root swept')
  t.absent(fs.existsSync(inSecond), 'orphan in a per-space root swept')
})

test('cleanupOrphanedPartials deduplicates repeated roots', async (t) => {
  const { downloads } = await freshPeer(t)
  await initPendingTransfers()
  const orphan = path.join(downloads, 'dup.bin.mirall.part')
  fs.writeFileSync(orphan, 'half')

  const res = await cleanupOrphanedPartials([downloads, downloads, downloads])

  // Asserting only that the orphan is gone passes with or without the dedup — the repeat
  // passes would simply find nothing left. The scan count is what actually proves it.
  t.is(res.rootsScanned, 1, 'three copies of one root are walked once')
  t.absent(fs.existsSync(orphan), 'and the orphan is swept')
})

// REGRESSION (PART-2): only ENOENT was tolerated, so any other readdir failure was rethrown —
// abandoning every remaining root AND the foreign-mount sweep in the same call, with the sole
// caller swallowing it as one log line. Per-space roots multiply the exposure to N user-chosen
// folders that are validated when they are set and never again.
test('cleanupOrphanedPartials skips an unreadable root and still sweeps the rest', async (t) => {
  const { downloads, tmpDir } = await freshPeer(t)
  await initPendingTransfers()
  const second = tmpDir('dl-space')
  const orphan = path.join(second, 'late.bin.mirall.part')
  fs.writeFileSync(orphan, 'half')
  // A root that is a FILE, not a directory: readdir fails with ENOTDIR, standing in for the
  // EACCES / EIO / ENOTCONN an ejected volume or a stale network mount produces.
  const notADir = path.join(downloads, 'not-a-folder')
  fs.writeFileSync(notADir, 'x')

  const res = await cleanupOrphanedPartials([notADir, second])

  t.is(res.failed, 1, 'the bad root is counted, not thrown')
  t.absent(fs.existsSync(orphan), 'a root listed after it is still swept')
})

// A failed row keeps its partial for the Failed list; past the age cap both go, while a newer
// failure, an error-free row (possibly a pause) and a fault that clears on its own keep theirs.
test('REGRESSION (FIX-499-PARTIAL): a failed download ages out with its partial', async (t) => {
  const { downloads } = await freshPeer(t)
  await initPendingTransfers()
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const rows = {
    '/old-failed.bin': { errorCode: 'TRANSFER_CHECKSUM', erroredAt: now - FAILED_ROW_MAX_AGE_MS - day },
    '/new-failed.bin': { errorCode: 'TRANSFER_CHECKSUM', erroredAt: now - FAILED_ROW_MAX_AGE_MS + day },
    '/old-paused.bin': { updatedAt: now - 3 * FAILED_ROW_MAX_AGE_MS },
    '/old-unplugged.bin': { errorCode: 'TRANSFER_DEST_UNAVAILABLE', erroredAt: now - 3 * FAILED_ROW_MAX_AGE_MS },
  }
  for (const [filePath, extra] of Object.entries(rows)) {
    const finalPath = path.join(downloads, filePath.slice(1))
    fs.writeFileSync(finalPath + '.mirall.part', 'half')
    await _pendingBeeForTests().put('s:' + filePath, { finalPath, ...extra })
  }

  const forgotten = await forgetStaleFailures(now)
  t.is(forgotten.length, 1, 'one row aged out')
  t.is(forgotten[0].finalPath, path.join(downloads, 'old-failed.bin'), 'the forgotten row names where its partial sits')
  await cleanupOrphanedPartials(downloads)

  t.is(await getPendingFor('s', '/old-failed.bin'), null, 'the old failure is forgotten')
  t.absent(fs.existsSync(path.join(downloads, 'old-failed.bin.mirall.part')), 'and its partial reclaimed')
  t.ok(await getPendingFor('s', '/new-failed.bin'), 'a newer failure stays')
  t.ok(fs.existsSync(path.join(downloads, 'new-failed.bin.mirall.part')), 'with its partial')
  t.ok(await getPendingFor('s', '/old-paused.bin'), 'an error-free row never ages out')
  t.ok(fs.existsSync(path.join(downloads, 'old-paused.bin.mirall.part')), 'with its partial')
  t.ok(await getPendingFor('s', '/old-unplugged.bin'), 'a fault that clears when the folder is back never ages out')
})

// A forgotten row is the only record of where its partial is — a TREE partial sits below the root,
// where the shallow root sweep never looks — so the partial goes with the row, flat or nested,
// unless a remaining row or a live transfer still holds the same path.
test('discardRowPartials unlinks each forgotten row\'s partial unless another row or a live transfer holds it', async (t) => {
  const { downloads } = await freshPeer(t)
  await initPendingTransfers()
  const nested = path.join(downloads, 'Handover', 'sub', 'a.txt')
  const flat = path.join(downloads, 'b.txt')
  const named = path.join(downloads, 'c.txt')
  const live = path.join(downloads, 'd.txt')
  fs.mkdirSync(path.dirname(nested), { recursive: true })
  for (const finalPath of [nested, flat, named, live]) fs.writeFileSync(finalPath + '.mirall.part', 'half')
  await recordPending('other', '/c.txt', { finalPath: named, inPlace: true })

  const rows = [{ finalPath: nested, layout: 'tree' }, { finalPath: flat }, { finalPath: named }, { finalPath: live }, { finalPath: null }]
  const discarded = await discardRowPartials(rows, { live: [live] })

  t.is(discarded, 2)
  t.absent(fs.existsSync(nested + '.mirall.part'), 'the nested partial is gone')
  t.absent(fs.existsSync(flat + '.mirall.part'), 'and so is the flat one')
  t.ok(fs.existsSync(named + '.mirall.part'), 'a partial a remaining row names is kept')
  t.ok(fs.existsSync(live + '.mirall.part'), 'and so is one a live transfer holds')
})

test('discardRowPartials tolerates a partial that is already gone', async (t) => {
  const { downloads } = await freshPeer(t)
  const discarded = await discardRowPartials([{ finalPath: path.join(downloads, 'Batch', 'gone.txt') }])
  t.is(discarded, 0)
})

// A download may land in any folder, so the boot sweep reads every folder a pending row or a claim
// names, not only the ones downloads go to next.
test('the boot sweep reaches a folder only a download landed in, and keeps a partial its row still names', async (t) => {
  const ctx = await freshPeer(t)
  await initPendingTransfers()
  await initDownloads()
  const rowFolder = ctx.tmpDir('dl-row')
  const claimFolder = ctx.tmpDir('dl-claim')
  const keptFinal = path.join(rowFolder, 'keep.bin')
  const kept = keptFinal + '.mirall.part'
  const rowOrphan = path.join(rowFolder, 'orphan.bin.mirall.part')
  const claimOrphan = path.join(claimFolder, 'orphan.bin.mirall.part')
  for (const f of [kept, rowOrphan, claimOrphan]) fs.writeFileSync(f, 'half')
  await recordPending('s', '/keep.bin', { finalPath: keptFinal, destDir: rowFolder, inPlace: true })
  fs.writeFileSync(path.join(claimFolder, 'done.bin'), 'whole')
  const space = await createSpace('Aurora')
  await markDownloaded(space.spaceId, '/done.bin', path.join(claimFolder, 'done.bin'), { hash: 'h', destDir: claimFolder })

  await rebootPeer(t, ctx)

  t.absent(listCurrentDownloadFolders().includes(rowFolder), 'precondition: no download goes to the row\'s folder next')
  t.ok(listDownloadRoots().includes(rowFolder) && listDownloadRoots().includes(claimFolder), 'both folders are download roots after boot')
  t.ok(fs.existsSync(kept), 'the partial a row names survives')
  t.absent(fs.existsSync(rowOrphan), 'an orphan beside it is swept')
  t.absent(fs.existsSync(claimOrphan), 'and so is one in a folder only a claim names')
})

// REGRESSION (FIX-DLTO-R31: the boot sweep read the download roots one after another with no bound,
// before the topic joins — and the roots now include every recent and landed folder — so one root
// on a network mount that stopped answering held the whole boot.)
test('REGRESSION (FIX-DLTO-R31: a download root that does not answer is skipped, and the rest are swept)', async (t) => {
  const { downloads, tmpDir } = await freshPeer(t)
  await initPendingTransfers()
  const hanging = tmpDir('dl-hanging')
  const untouched = path.join(hanging, 'k.bin.mirall.part')
  const orphan = path.join(downloads, 'o.bin.mirall.part')
  for (const f of [untouched, orphan]) fs.writeFileSync(f, 'half')
  const readdir = (dir) => (dir === hanging ? new Promise(() => {}) : fs.promises.readdir(dir))

  const res = await cleanupOrphanedPartials([hanging, downloads], [], { readdir, readTimeoutMs: 100 })

  t.is(res.failed, 1, 'the root that did not answer is counted, not waited for')
  t.ok(fs.existsSync(untouched), 'and nothing in it is touched')
  t.absent(fs.existsSync(orphan), 'the root after it is still swept')
})

test('the download roots are read at once, not one after another', async (t) => {
  await freshPeer(t)
  await initPendingTransfers()
  const started = []
  const answers = []
  const readdir = (dir) => { started.push(dir); return new Promise((resolve) => answers.push(() => resolve([]))) }

  const sweep = cleanupOrphanedPartials(['/a', '/b', '/c'], [], { readdir, readTimeoutMs: 60000 })
  t.ok(await until(() => started.length === 3, 5000), 'every root is asked before any has answered')
  for (const answer of answers) answer()
  t.is((await sweep).rootsScanned, 3)
})
