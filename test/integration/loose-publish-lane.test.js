import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare } from '../helpers/owned.js'
import { initialPublishScan, stopOwnedFolder } from '../../src/shared/folders/owned-folders.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initDownloads, getOwnedSourcePath, markOwnedSource, clearOwnedSource } from '../../src/shared/transfer/files.js'
import { initPendingTransfers } from '../../src/shared/transfer/pending-transfers.js'
import {
  initLooseOverlay, looseShareFile, looseCancelPublish, looseSourceFor, looseSources,
  sweepLoosePresence, handleLooseFsEvent, looseUnshareFile, rehydrateLooseFiles, LOOSE_SHARE_ID,
} from '../../src/shared/transfer/loose-overlay.js'
import { getOwnEntry, advertise } from '../../src/shared/shares/share-catalog.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until (fn, ms = 10000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(10)
  }
  return false
}

// prepareForServe is the single choke point for the streaming read every publish performs — loose
// or folder — so counting it counts real work on the shared lane.
function slowHash (t, ms, { only = null } = {}) {
  const overlay = getOverlay()
  const orig = overlay.prepareForServe.bind(overlay)
  const calls = []
  let live = 0
  let peak = 0
  overlay.prepareForServe = async (diskPath, opts) => {
    const name = path.basename(diskPath)
    calls.push(name)
    live += 1
    peak = Math.max(peak, live)
    try { if (!only || only.includes(name)) await sleep(ms); return await orig(diskPath, opts) } finally { live -= 1 }
  }
  t.teardown(() => { overlay.prepareForServe = orig })
  return { calls, peak: () => peak }
}

// A folder share and loose files in the SAME space, so both producers feed one lane.
async function setup (t, { concurrency = 2 } = {}) {
  const ctx = await setupOwnedShare(t)
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, inPlaceFilesEnabled: true, publishConcurrency: concurrency })
  await initDownloads()
  await initPendingTransfers()
  looseSources.clear()
  initLooseOverlay(ctx.fake.ipc)
  t.teardown(() => { stopOwnedFolder(ctx.spaceId, ctx.share.id); setRuntimeConfig(cfg) })
  return ctx
}

const fill = (dir, names) => { for (const n of names) fs.writeFileSync(path.join(dir, n), 'x'.repeat(4096)) }
function writeSource (ctx, name, contents) {
  const abs = path.join(ctx.tmpDir('src'), name)
  fs.writeFileSync(abs, contents)
  return abs
}

// The point of the shared lane: a file the user drops in is INTERACTIVE and takes the express
// lane, while the folder backfill's BULK items hold every bulk slot. Before, the two were
// uncoordinated CPU consumers with no priority between them.
test('a loose drop starts at once while a folder backfill holds every bulk slot', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 1 })
  const seeds = ['s1.bin', 's2.bin', 's3.bin', 's4.bin']
  fill(ctx.mountPath, seeds)
  const probe = slowHash(t, 600, { only: seeds })

  const backfill = initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  await sleep(150)
  const abs = writeSource(ctx, 'drop.txt', 'dropped in')
  const t0 = Date.now()
  await looseShareFile(ctx.spaceId, abs, 'drop.txt')
  const took = Date.now() - t0
  t.ok(took < 500, 'published on the express lane, not after the backfill (' + took + 'ms)')
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'drop.txt'), 'and it is advertised')
  t.is(probe.calls.indexOf('drop.txt'), 1, 'the second read to start, right behind the file already in flight')
  await backfill
})

// withSpaceLock used to hold the whole hash, so three adds in one space ran one after another.
test('three files:add in one space no longer serialize behind each other\'s hash', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 2 })
  const probe = slowHash(t, 500)
  const names = ['a.txt', 'b.txt', 'c.txt']
  const files = names.map((n) => writeSource(ctx, n, n))
  const t0 = Date.now()
  await Promise.all(files.map((abs, i) => looseShareFile(ctx.spaceId, abs, names[i])))
  const took = Date.now() - t0
  t.ok(probe.peak() >= 2, 'at least two hashes overlapped — peak ' + probe.peak())
  t.ok(took < 1200, 'three 500 ms hashes finished well inside 1500 ms (' + took + 'ms)')
  for (const n of names) t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, n), n + ' advertised')
})

// A cancel of an item that never started runs no executor: the admission-time source link and
// tracking must still be dropped, or an unshared file keeps a dangling link forever.
test('cancelling a queued loose publish leaves no entry, no link and no tracking', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 1 })
  fill(ctx.mountPath, ['bulk.bin'])
  const probe = slowHash(t, 800, { only: ['bulk.bin', 'hold.txt'] })
  const backfill = initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])   // the bulk slot
  t.ok(await until(() => probe.calls.includes('bulk.bin')), 'precondition: the bulk slot is held')
  const hold = writeSource(ctx, 'hold.txt', 'h'.repeat(4096))
  const holding = looseShareFile(ctx.spaceId, hold, 'hold.txt')                       // the express lane
  t.ok(await until(() => probe.calls.includes('hold.txt')), 'precondition: the express lane is held')
  const second = writeSource(ctx, 'second.txt', 'queued behind both')
  const queued = looseShareFile(ctx.spaceId, second, 'second.txt')
  await sleep(30)
  t.ok(looseSourceFor(second, ctx.spaceId), 'precondition: admitted and tracked while queued')

  await looseCancelPublish(ctx.spaceId, '/second.txt')
  const outcome = await queued
  t.is(outcome.outcome, 'cancelled')
  t.absent(probe.calls.includes('second.txt'), 'never read')
  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'second.txt'), 'no entry')
  t.is(await getOwnedSourcePath(ctx.spaceId, '/second.txt'), null, 'no dangling source link')
  t.absent(looseSourceFor(second, ctx.spaceId), 'no tracking')
  await Promise.all([holding, backfill])
})

// A retire that is queued behind held slots is left to the queue: the sweep neither races it nor
// duplicates it, and the entry goes exactly once, when the slot frees.
test('the sweep leaves a path with a queued retire alone; the retire runs once the slot frees', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 1 })
  const abs = writeSource(ctx, 'gone.txt', 'bye')
  await looseShareFile(ctx.spaceId, abs, 'gone.txt')
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'gone.txt'), 'precondition: published')

  fill(ctx.mountPath, ['bulk.bin'])
  const probe = slowHash(t, 900, { only: ['bulk.bin', 'hold.txt'] })
  const backfill = initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  t.ok(await until(() => probe.calls.includes('bulk.bin')), 'precondition: the bulk slot is held')
  const hold = writeSource(ctx, 'hold.txt', 'h'.repeat(4096))
  const holding = looseShareFile(ctx.spaceId, hold, 'hold.txt')
  t.ok(await until(() => probe.calls.includes('hold.txt')), 'precondition: the express lane is held')
  fs.unlinkSync(abs)
  const retire = handleLooseFsEvent({ spaceId: ctx.spaceId, absPath: abs, action: 'unlink' })
  await sleep(30)
  await sweepLoosePresence()
  await sweepLoosePresence()
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'gone.txt'), 'two sweeps did not act on a path whose retire is queued')

  await retire
  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'gone.txt'), 'the queued retire removed it once it ran')
  t.is(await getOwnedSourcePath(ctx.spaceId, '/gone.txt'), null)
  await Promise.all([holding, backfill])
})

// Does this volume fold case (APFS default, NTFS)? Decides whether the case-rename scenario runs.
function caseFolds (dir) {
  const probe = path.join(dir, 'CaseProbe.tmp')
  fs.writeFileSync(probe, 'x')
  const folded = fs.existsSync(path.join(dir, 'caseprobe.tmp'))
  fs.unlinkSync(probe)
  return folded
}

// REGRESSION (FIX-LOOSE-QUEUED-CANCEL: cancelling an item that was still queued dropped the item
// but left the null-hash placeholder a boot resume had re-enqueued, so the first cancel click was
// a no-op and the row stayed "Adding".)
test('REGRESSION (FIX-LOOSE-QUEUED-CANCEL): cancelling a queued boot resume reverts its placeholder', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 1 })
  const abs = writeSource(ctx, 'big.bin', 'b'.repeat(4096))
  const st = fs.statSync(abs)
  await advertise(ctx.spaceId, LOOSE_SHARE_ID, 'big.bin', { size: st.size, mtime: st.mtimeMs, contentHash: null })
  await markOwnedSource(ctx.spaceId, '/big.bin', abs)

  fill(ctx.mountPath, ['bulk.bin'])
  const probe = slowHash(t, 900, { only: ['bulk.bin', 'hold.txt'] })
  const backfill = initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  t.ok(await until(() => probe.calls.includes('bulk.bin')), 'precondition: the bulk slot is held')
  const hold = writeSource(ctx, 'hold.txt', 'h'.repeat(4096))
  const holding = looseShareFile(ctx.spaceId, hold, 'hold.txt')
  t.ok(await until(() => probe.calls.includes('hold.txt')), 'precondition: the express lane is held')

  const resume = rehydrateLooseFiles()
  await sleep(50)
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'big.bin'), 'precondition: the placeholder waits behind both lanes')
  await looseCancelPublish(ctx.spaceId, '/big.bin')
  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'big.bin'), 'one cancel removes the placeholder')
  t.is(await getOwnedSourcePath(ctx.spaceId, '/big.bin'), null, 'and its link')
  t.absent(probe.calls.includes('big.bin'), 'it was never read')
  await Promise.all([holding, backfill, resume])
})

// REGRESSION (FIX-LOOSE-CANCEL-READD: a cancelled executor's cleanup deleted the source link a
// re-add of the same file had just written, the rerun resolved no path, and files:add returned
// ok with nothing shared.)
test('REGRESSION (FIX-LOOSE-CANCEL-READD): re-adding a file while its cancelled hash unwinds shares it', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 2 })
  const abs = writeSource(ctx, 'again.bin', 'a'.repeat(4096))
  const probe = slowHash(t, 700)
  const first = looseShareFile(ctx.spaceId, abs, 'again.bin')
  t.ok(await until(() => probe.calls.includes('again.bin')), 'precondition: the first hash is running')
  const cancel = looseCancelPublish(ctx.spaceId, '/again.bin')
  const second = looseShareFile(ctx.spaceId, abs, 'again.bin')
  const [, , outcome] = await Promise.all([first, cancel, second])
  t.is(outcome.result?.outcome, 'published', 'the re-add published')
  t.ok((await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'again.bin'))?.contentHash, 'entry carries a hash')
  t.is(await getOwnedSourcePath(ctx.spaceId, '/again.bin'), abs, 'the re-add kept its link')
  t.is(looseSourceFor(abs, ctx.spaceId), 'again.bin', 'and its tracking')
})

// REGRESSION (FIX-LOOSE-UNSHARE-RACE: the unshare cancelled before taking the lock, so an add
// admitted under the lock ran concurrently with the tombstone: an entry with its link deleted.)
test('REGRESSION (FIX-LOOSE-UNSHARE-RACE): an add racing an unshare leaves a consistent state', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 2 })
  slowHash(t, 200)
  for (let i = 0; i < 4; i++) {
    const abs = writeSource(ctx, 'race' + i + '.txt', 'r'.repeat(2048))
    const results = await Promise.allSettled([looseShareFile(ctx.spaceId, abs, 'race' + i + '.txt'), looseUnshareFile(ctx.spaceId, '/race' + i + '.txt')])
    for (const r of results) if (r.status === 'rejected') t.fail('unexpected rejection: ' + r.reason?.message)
    const entry = await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'race' + i + '.txt')
    const link = await getOwnedSourcePath(ctx.spaceId, '/race' + i + '.txt')
    if (entry) t.is(link, abs, 'round ' + i + ': a surviving entry keeps its link')
    else t.is(link, null, 'round ' + i + ': a gone entry leaves no link')
    t.is(!!looseSourceFor(abs, ctx.spaceId), !!entry, 'round ' + i + ': tracking agrees with the entry')
  }
})

// REGRESSION (FIX-LOOSE-CASE-RENAME: an exact-name presence check retired a loose share whose
// source was only renamed by case; a loose file's identity is its recorded path, which the
// volume still resolves.)
test('REGRESSION (FIX-LOOSE-CASE-RENAME): a case-only rename keeps a loose share', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 2 })
  const dir = ctx.tmpDir('src')
  if (!caseFolds(dir)) { t.comment('case-sensitive volume — scenario not applicable'); t.pass(); return }
  const abs = path.join(dir, 'Report.PDF')
  fs.writeFileSync(abs, 'r'.repeat(2048))
  slowHash(t, 10)
  await looseShareFile(ctx.spaceId, abs, 'Report.PDF')
  fs.renameSync(abs, path.join(dir, 'report.pdf'))
  await handleLooseFsEvent({ spaceId: ctx.spaceId, absPath: abs, action: 'unlink' })
  await sweepLoosePresence()
  await sweepLoosePresence()
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'Report.PDF'), 'still shared: the recorded path still opens')
})

// REGRESSION (FIX-LOOSE-UNSHARE-TAIL: the wait for a cancelled hash was a silent 5 s deadline;
// past it the unshare tombstoned while the executor was still running, and its later revert
// resurrected the entry. The unshare now waits for the executor's exit event.)
test('REGRESSION (FIX-LOOSE-UNSHARE-TAIL): an unshare during a slow hash waits for the executor', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 2 })
  const abs = writeSource(ctx, 'slow.bin', 's'.repeat(4096))
  slowHash(t, 10)
  await looseShareFile(ctx.spaceId, abs, 'slow.bin')
  fs.writeFileSync(abs, 's'.repeat(8192))
  const probe = slowHash(t, 1500)
  const republish = handleLooseFsEvent({ spaceId: ctx.spaceId, absPath: abs, action: 'change' })
  t.ok(await until(() => probe.calls.includes('slow.bin')), 'precondition: the re-hash is running')
  const t0 = Date.now()
  await looseUnshareFile(ctx.spaceId, '/slow.bin')
  t.ok(Date.now() - t0 >= 1000, 'the unshare waited for the executor to exit (' + (Date.now() - t0) + 'ms)')
  await republish
  await sleep(500)
  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'slow.bin'), 'no resurrection by the cancelled publish\'s revert')
  t.is(await getOwnedSourcePath(ctx.spaceId, '/slow.bin'), null)
  t.absent(looseSourceFor(abs, ctx.spaceId))
})

// REGRESSION (FIX-LOOSE-LINK-HEAL: a watcher change no longer re-recorded the source link, so a
// link lost to an earlier fault left every later change publishing nothing.)
test('REGRESSION (FIX-LOOSE-LINK-HEAL): a watcher change re-records a lost source link', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 2 })
  const abs = writeSource(ctx, 'heal.txt', 'v1')
  slowHash(t, 10)
  await looseShareFile(ctx.spaceId, abs, 'heal.txt')
  await clearOwnedSource(ctx.spaceId, '/heal.txt')
  fs.writeFileSync(abs, 'v2 is longer')
  await handleLooseFsEvent({ spaceId: ctx.spaceId, absPath: abs, action: 'change' })
  t.is(await getOwnedSourcePath(ctx.spaceId, '/heal.txt'), abs, 'link healed from the event\'s path')
  const entry = await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'heal.txt')
  t.is(entry?.size, fs.statSync(abs).size, 'and the new version is advertised')
})
