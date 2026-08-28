import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare, listRelPaths } from '../helpers/owned.js'
import { onFsEvent, initialPublishScan, periodicReconcile, stopOwnedFolder, cancelIndex, getIndexStatus } from '../../src/shared/folders/owned-folders.js'
import { saveOwnedMount, getOwnedMount } from '../../src/shared/folders/mount-store.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlaySweepPresence, overlayPublishAdd, overlayHashFile } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { createCatalogBatch } from '../../src/shared/shares/catalog-writer.js'
import { advertise, listOwnShare, ownCatalog, ownCatalogKeyHex } from '../../src/shared/shares/share-catalog.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// prepareForServe is the single choke point for the streaming read publishContent performs, so
// counting it counts real work. The sleep stands in for the multi-second hash of a large file.
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
  return { calls, counts: () => calls.reduce((a, n) => (a[n] = (a[n] || 0) + 1, a), {}), peak: () => peak }
}

const fill = (dir, names, b = 'x') => { for (const n of names) fs.writeFileSync(path.join(dir, n), b.repeat(4096)) }

async function settled (share, spaceId, want, ms = 90000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await listRelPaths(share, spaceId)).length === want) return true
    await sleep(100)
  }
  return false
}

async function until (fn, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(100)
  }
  return false
}

async function entryFor (share, spaceId, relPath) {
  for await (const e of listOwnShare(spaceId, share.id)) if (e.relPath === relPath) return e
  return null
}

// Does this mount's volume fold case (APFS default, NTFS)? Decides whether the case-rename
// scenario can run here; the symlink scenario covers the same executor path everywhere.
function caseFolds (dir) {
  const probe = path.join(dir, 'CaseProbe.tmp')
  fs.writeFileSync(probe, 'x')
  const folded = fs.existsSync(path.join(dir, 'caseprobe.tmp'))
  fs.unlinkSync(probe)
  return folded
}

// REGRESSION (FIX-SCAN-1: overlayScan's tombstone pass ran against the walkDisk snapshot taken at
// the TOP of the scan. A file the user dropped in mid-scan — already published by the watcher —
// was absent from that snapshot, so the scan deleted it and the tombstone replicated to every
// peer. The rule now lives in the retire executor; this asserts the behavior, so it guards both.)
test('REGRESSION (FIX-SCAN-1): a file added mid-index is never tombstoned while it is on disk', { timeout: 120000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  fill(mountPath, ['seed-1.bin', 'seed-2.bin', 'seed-3.bin', 'seed-4.bin'])
  slowHash(t, 700)

  const first = initialPublishScan(spaceId, share.id, mountPath, [])
  await sleep(300)
  const abs = path.join(mountPath, 'late.bin')
  fs.writeFileSync(abs, 'y'.repeat(4096))
  await onFsEvent(spaceId, share.id, 'add', 'late.bin', abs)
  t.ok((await listRelPaths(share, spaceId)).includes('late.bin'), 'the watcher published it')

  await first
  t.ok((await listRelPaths(share, spaceId)).includes('late.bin'), 'the pass that started before it did not tombstone it')
  t.ok(await settled(share, spaceId, 5), 'all five publish')
  await sleep(6000)
  t.ok((await listRelPaths(share, spaceId)).includes('late.bin'), 'and the catch-up did not either')
})

// REGRESSION (FIX-SCAN-2/3: each watcher event scheduled its own full-folder scan with no
// interlock. Four additions during one index produced five overlapping passes — measured 68 hash
// passes for 24 files, individual files hashed 5x, 4 of 24 files silently unshared.)
test('REGRESSION (FIX-SCAN-2): additions during an index do not multiply the work', { timeout: 300000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const seeds = Array.from({ length: 20 }, (_, i) => 'big-' + String(i + 1).padStart(2, '0') + '.bin')
  fill(mountPath, seeds)
  const probe = slowHash(t, 700)

  const first = initialPublishScan(spaceId, share.id, mountPath, [])
  const drops = [1000, 3500, 6000, 8500].map((at, i) => (async () => {
    await sleep(at)
    const n = 'drop-' + i + '.bin'
    const abs = path.join(mountPath, n)
    fs.writeFileSync(abs, 'y'.repeat(4096))
    onFsEvent(spaceId, share.id, 'add', n, abs)
  })())
  await first
  await Promise.all(drops)

  t.ok(await settled(share, spaceId, 24, 180000), 'all 24 files publish')
  await sleep(8000)

  const counts = probe.counts()
  const worst = Math.max(...Object.values(counts))
  t.is(worst, 1, 'no file is read twice (was 5x) — worst ' + worst)
  t.is(probe.calls.length, 24, 'one read per file (was 68) — got ' + probe.calls.length)
  // publishConcurrency bulk slots plus the one express lane a watcher add may take while both are held.
  t.ok(probe.peak() <= 3, 'never more than publishConcurrency + 1 hashes at once — peak ' + probe.peak())
  t.is((await listRelPaths(share, spaceId)).length, 24, 'and nothing was lost')
})

test('REGRESSION (FIX-SCAN-3): concurrent watcher frames for one path read it once', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const abs = path.join(mountPath, 'dup.bin')
  fs.writeFileSync(abs, 'q'.repeat(4096))
  const probe = slowHash(t, 500)
  await Promise.all([
    onFsEvent(spaceId, share.id, 'add', 'dup.bin', abs),
    onFsEvent(spaceId, share.id, 'add', 'dup.bin', abs),
    onFsEvent(spaceId, share.id, 'add', 'dup.bin', abs),
  ])
  t.ok(await settled(share, spaceId, 1))
  t.is(probe.counts()['dup.bin'], 1, 'read once, not three times')
})

// An editor's rename-over fires a raw unlink for a path that is immediately back on disk. The
// re-check moved from onFsEvent into the retire executor and must still hold as a queued item.
test('REGRESSION (FIX-SCAN-1): an unlink for a path that is back on disk does not unshare it', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const abs = path.join(mountPath, 'doc.txt')
  fs.writeFileSync(abs, 'v1')
  await onFsEvent(spaceId, share.id, 'add', 'doc.txt', abs)
  t.ok(await settled(share, spaceId, 1))

  fs.writeFileSync(abs, 'v2')
  await onFsEvent(spaceId, share.id, 'unlink', 'doc.txt', abs)
  await sleep(3000)
  t.ok((await listRelPaths(share, spaceId)).includes('doc.txt'), 'the file survives the spurious unlink')
})

test('a real delete still retires the entry', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const abs = path.join(mountPath, 'gone.txt')
  fs.writeFileSync(abs, 'bye')
  await onFsEvent(spaceId, share.id, 'add', 'gone.txt', abs)
  t.ok(await settled(share, spaceId, 1))
  fs.unlinkSync(abs)
  await onFsEvent(spaceId, share.id, 'unlink', 'gone.txt', abs)
  t.ok(await settled(share, spaceId, 0), 'retired once it is genuinely absent')
})

// REGRESSION (ROOT-GONE): when a source root vanishes, chokidar emits one unlink PER FILE. Each
// becomes a retire item, and a retire that only re-stats its file says "gone" for all of them.
// A missing root pauses, never tombstones — at execution time, not only at enqueue time.
test('REGRESSION (ROOT-GONE): retires queued for a vanished root do not tombstone anything', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  fill(mountPath, ['a.bin', 'b.bin', 'c.bin'])
  slowHash(t, 10)
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.ok(await settled(share, spaceId, 3))

  fs.renameSync(mountPath, mountPath + '-unplugged')
  t.teardown(() => { try { fs.renameSync(mountPath + '-unplugged', mountPath) } catch {} })
  await Promise.all(['a.bin', 'b.bin', 'c.bin'].map((n) =>
    onFsEvent(spaceId, share.id, 'unlink', n, path.join(mountPath, n))))
  t.is((await listRelPaths(share, spaceId)).length, 3, 'nothing was tombstoned')
})

// REGRESSION (RELOCATE-STALE-PATH): a retire enqueued against the OLD mount path must not run
// against it after a relocate — the files are all present at the new path.
test('REGRESSION (RELOCATE-STALE-PATH): a stale retire re-resolves the mount at execution', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  fill(mountPath, ['keep.bin'])
  slowHash(t, 10)
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.ok(await settled(share, spaceId, 1))

  // A slow publish holds the single slot so the retire that follows is still queued when the
  // tree moves and the mount record is re-pointed.
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, publishConcurrency: 1 })
  t.teardown(() => setRuntimeConfig(cfg))
  slowHash(t, 1500)
  fs.writeFileSync(path.join(mountPath, 'hold.bin'), 'h'.repeat(4096))
  const holding = onFsEvent(spaceId, share.id, 'add', 'hold.bin', path.join(mountPath, 'hold.bin'))
  await sleep(50)
  const stale = onFsEvent(spaceId, share.id, 'unlink', 'keep.bin', path.join(mountPath, 'keep.bin'))
  const newPath = mountPath + '-moved'
  fs.renameSync(mountPath, newPath)
  t.teardown(() => { try { fs.renameSync(newPath, mountPath) } catch {} })
  const mount = await getOwnedMount(spaceId, share.id)
  await saveOwnedMount({ ...mount, mountPath: newPath })
  await Promise.all([holding, stale])
  t.ok((await listRelPaths(share, spaceId)).includes('keep.bin'), 'present at the current mount path → not retired')
})

// REGRESSION (CATCHUP-DEFER): the catch-up diff runs 2 s after the first event of a burst — mid-copy
// on a large file. It must leave a fresh, unpublished file to the watcher instead of reading it,
// having the mtime guard reject it, and reverting with a tombstone that peers see as add→remove→add.
test('REGRESSION (CATCHUP-DEFER): the catch-up diff leaves a still-settling file to the watcher', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  fs.writeFileSync(path.join(mountPath, 'settled.bin'), 'a'.repeat(4096))
  await sleep(2500)
  fs.writeFileSync(path.join(mountPath, 'copying.bin'), 'b'.repeat(4096))
  const probe = slowHash(t, 10)
  await periodicReconcile(spaceId, share.id, mountPath, [], { deferFresh: true })
  t.alike(await listRelPaths(share, spaceId), ['settled.bin'], 'the fresh file is deferred')
  t.absent(probe.calls.includes('copying.bin'), 'and was never read')

  fs.writeFileSync(path.join(mountPath, 'brand-new.bin'), 'c'.repeat(4096))
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.ok((await listRelPaths(share, spaceId)).includes('brand-new.bin'), 'an authoritative pass publishes a fresh file at once')
  t.ok((await listRelPaths(share, spaceId)).includes('copying.bin'), 'and picks up the deferred one')
})

test('REGRESSION (CATCHUP-DEFER): a future mtime is not treated as still-settling', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const abs = path.join(mountPath, 'future.bin')
  fs.writeFileSync(abs, 'f'.repeat(4096))
  const ahead = (Date.now() + 600000) / 1000
  fs.utimesSync(abs, ahead, ahead)
  slowHash(t, 10)
  await periodicReconcile(spaceId, share.id, mountPath, [], { deferFresh: true })
  t.ok((await listRelPaths(share, spaceId)).includes('future.bin'), 'published, not deferred')
})

// The sweep only ever removes, and a cataloged path whose re-publish is queued behind a running
// hash is exactly what it must leave alone: the file may be mid-replace (an editor's rename-over
// fired the change), and the queued item — not the sweep — owns its fate. Without the probe the
// two sweeps below tombstone x.txt while its publish is still waiting for the lane.
test('REGRESSION (FIX-SCAN-4): the presence sweep does not reclaim a path with a pending item', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, publishConcurrency: 1, publishOrder: 'largest-first' })
  t.teardown(() => setRuntimeConfig(cfg))
  const abs = path.join(mountPath, 'x.txt')
  fs.writeFileSync(abs, 'v1')
  slowHash(t, 10)
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.ok(await settled(share, spaceId, 1))

  // A large changed file holds the single lane; the re-publish of x.txt (changed too) queues behind it.
  fs.writeFileSync(path.join(mountPath, 'hold.bin'), 'h'.repeat(4096))
  await sleep(20)
  fs.writeFileSync(abs, 'v2-longer')
  slowHash(t, 1500)
  const scan = initialPublishScan(spaceId, share.id, mountPath, [])
  await until(() => getIndexStatus(spaceId, share.id).running === 1, 5000)
  t.is(getIndexStatus(spaceId, share.id).queued, 1, 'x.txt is queued behind the running hash')
  fs.unlinkSync(abs)
  await overlaySweepPresence()
  await overlaySweepPresence()
  t.ok((await listRelPaths(share, spaceId)).includes('x.txt'), 'the sweep deferred to the queue')
  await scan
})

// REGRESSION (FIX-133, preserved): a watcher add bypasses the space batch so a dropped-in file is
// visible immediately, while bulk publishes still land as few atomic heads.
test('REGRESSION (FIX-133): a watcher add is visible before the next batch flush', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, catalogFlushMs: 60000, catalogFlushMaxOps: 1000 })
  t.teardown(() => setRuntimeConfig(cfg))
  slowHash(t, 10)
  const abs = path.join(mountPath, 'now.bin')
  fs.writeFileSync(abs, 'n'.repeat(4096))
  await onFsEvent(spaceId, share.id, 'add', 'now.bin', abs)
  t.ok((await listRelPaths(share, spaceId)).includes('now.bin'), 'visible the moment the event settles')
})

// REGRESSION (READ-YOUR-WRITES): a bulk publish stages its catalog writes in the space batch. A
// second request for the same path arriving before the batch flushes — a catch-up diff whose
// catalog read predates the item's settle — must see those staged writes, or it re-hashes a file
// whose hash is already in hand (25 reads for 24 files on a slow CI runner).
test('REGRESSION (READ-YOUR-WRITES): a publish sees its own unflushed catalog writes', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, catalogFlushMs: 60000, catalogFlushMaxOps: 1000 })
  t.teardown(() => setRuntimeConfig(cfg))
  const abs = path.join(mountPath, 'once.bin')
  fs.writeFileSync(abs, 'o'.repeat(4096))
  const probe = slowHash(t, 10)
  const batch = createCatalogBatch(spaceId)
  await overlayPublishAdd(spaceId, share, 'once.bin', abs, { catalog: batch })
  await overlayPublishAdd(spaceId, share, 'once.bin', abs, { catalog: batch })
  t.is(probe.counts()['once.bin'], 1, 'the second publish fast-paths on the staged hash')
  await batch.close()
  t.ok((await listRelPaths(share, spaceId)).includes('once.bin'))
})

test('ordering is honored end to end', { timeout: 90000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, publishOrder: 'smallest-first', publishConcurrency: 1 })
  t.teardown(() => setRuntimeConfig(cfg))
  fs.writeFileSync(path.join(mountPath, 'big.bin'), 'x'.repeat(400_000))
  fs.writeFileSync(path.join(mountPath, 'mid.bin'), 'x'.repeat(40_000))
  fs.writeFileSync(path.join(mountPath, 'small.bin'), 'x'.repeat(400))
  const probe = slowHash(t, 50)
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.ok(await settled(share, spaceId, 3))
  t.alike(probe.calls, ['small.bin', 'mid.bin', 'big.bin'])
})

test('a deep pass re-points identical content at a new mtime without re-advertising', { timeout: 90000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  fill(mountPath, ['keep.bin'])
  const probe = slowHash(t, 20)
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.ok(await settled(share, spaceId, 1))
  const later = (Date.now() + 5000) / 1000
  fs.utimesSync(path.join(mountPath, 'keep.bin'), later, later)
  const r = await initialPublishScan(spaceId, share.id, mountPath, [], { deep: true })
  t.is(r.uploaded, 0, 'identical content, no re-advertise')
  t.is(probe.calls.length, 1, 'the deep pass compared by hash without a serve-prep read')
  t.alike(await listRelPaths(share, spaceId), ['keep.bin'])
})

// REGRESSION (FIX-RETIRE-EXACT: the retire executor's "still on disk" check was a following stat,
// which says "present" for a symlink and — on a case-folding volume — for a file that only changed
// case. The diff that proposed the retire compared exact readdir names, so the retire never ran
// and the stale key stayed advertised to every peer forever.)
test('REGRESSION (FIX-RETIRE-EXACT): a file replaced by a symlink is retired', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const abs = path.join(mountPath, 'doc.txt')
  const other = path.join(mountPath, 'other.txt')
  fs.writeFileSync(abs, 'doc')
  fs.writeFileSync(other, 'other')
  slowHash(t, 10)
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.ok(await settled(share, spaceId, 2))
  fs.unlinkSync(abs)
  fs.symlinkSync(other, abs)
  await onFsEvent(spaceId, share.id, 'unlink', 'doc.txt', abs)
  t.alike(await listRelPaths(share, spaceId), ['other.txt'], 'a link is not the file that was shared')
})

test('REGRESSION (FIX-RETIRE-EXACT): a case-only rename retires the old key', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  if (!caseFolds(mountPath)) { t.comment('case-sensitive volume — the symlink case above covers the executor'); return }
  fs.writeFileSync(path.join(mountPath, 'Report.txt'), 'r')
  slowHash(t, 10)
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.ok(await settled(share, spaceId, 1))
  fs.renameSync(path.join(mountPath, 'Report.txt'), path.join(mountPath, 'report.txt'))

  // The backstop sweep must see the old key as gone too (it confirms on the second consecutive miss).
  await overlaySweepPresence()
  await overlaySweepPresence()
  t.alike(await listRelPaths(share, spaceId), [], 'the sweep reclaimed the folded key')

  await periodicReconcile(spaceId, share.id, mountPath, [])
  t.ok(await settled(share, spaceId, 1, 10000))
  t.alike(await listRelPaths(share, spaceId), ['report.txt'], 'only the name on disk is advertised')
})

// REGRESSION (FIX-DIFF-POISON: the diff resolved a disk path for every catalog entry, and
// pathFromMount throws EPATH on a key that escapes the mount — one poisoned key an older release
// wrote aborted every reconcile, so nothing published or retired and the mount sat in paused-error.)
test('REGRESSION (FIX-DIFF-POISON): a catalog key that escapes the mount is reclaimed, not fatal', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  await advertise(spaceId, share.id, '../escape.txt', { size: 1, mtime: 1, contentHash: null })
  await advertise(spaceId, share.id, 'sub\\back.txt', { size: 1, mtime: 1, contentHash: null })
  fs.writeFileSync(path.join(mountPath, 'ok.txt'), 'ok')
  slowHash(t, 10)
  const r = await initialPublishScan(spaceId, share.id, mountPath, [])
  t.is(r.uploaded, 1, 'the diff ran')
  t.is(r.deleted, 2, 'both poison keys were reclaimed')
  t.alike(await listRelPaths(share, spaceId), ['ok.txt'])
})

// REGRESSION (FIX-CATCHUP-REARM: the catch-up diff left a <2 s-old unpublished file "to the
// watcher", but the catch-up exists because fsevents drops adds — and nothing re-armed it, so a
// deferred file whose add was dropped waited for the 6 h periodic pass.)
test('REGRESSION (FIX-CATCHUP-REARM): a deferred file is published by the re-armed catch-up', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  slowHash(t, 10)
  const seen = path.join(mountPath, 'seen.txt')
  fs.writeFileSync(seen, 's')
  await onFsEvent(spaceId, share.id, 'add', 'seen.txt', seen)
  // Lands inside the catch-up's settle window with NO watcher event — the dropped-add case.
  await sleep(1200)
  fs.writeFileSync(path.join(mountPath, 'dropped.txt'), 'd')
  t.ok(await until(async () => (await listRelPaths(share, spaceId)).includes('dropped.txt'), 20000), 'published without any event or periodic pass')
})

// REGRESSION (FIX-RESERVE-HEAL: the fast diff no longer enqueues unchanged files, so the publish
// path's makeServable — the promised self-heal for a transient registerFile failure — never ran
// on the 6 h pass; the catalog advertised a hash the serve gate did not hold until the deep pass.)
test('REGRESSION (FIX-RESERVE-HEAL): the fast reconcile re-registers an unchanged file the serve index lost', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  fs.writeFileSync(path.join(mountPath, 'a.txt'), 'a')
  const probe = slowHash(t, 10)
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.ok(await settled(share, spaceId, 1))
  const { contentHash } = await entryFor(share, spaceId, 'a.txt')
  const served = () => serveIndex.refsFor(contentHash).some((r) => r.spaceId === spaceId && r.shareId === share.id && r.relPath === 'a.txt')
  t.ok(served(), 'served after publish')
  serveIndex.remove(contentHash, spaceId, share.id, 'a.txt')
  const r = await periodicReconcile(spaceId, share.id, mountPath, [])
  t.is(r.uploaded, 0, 'nothing re-published')
  t.is(probe.calls.length, 1, 'and nothing re-read')
  t.ok(served(), 'but it is servable again')
})

// REGRESSION (FIX-RETIRE-BATCH: retires always wrote the bee directly while bulk publishes staged
// into the space batch — 2,000 files deleted while the app was closed became 2,000 catalog heads
// on boot, each fanning to every peer's append listener.)
test('REGRESSION (FIX-RETIRE-BATCH): bulk retires land as one head, not one per file', { timeout: 90000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const names = Array.from({ length: 6 }, (_, i) => 'f' + i + '.txt')
  for (const n of names) fs.writeFileSync(path.join(mountPath, n), n)
  slowHash(t, 10)
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.ok(await settled(share, spaceId, 6))
  const bee = await ownCatalog(spaceId)
  let appends = 0
  const onAppend = () => { appends += 1 }
  bee.core.on('append', onAppend)
  t.teardown(() => bee.core.off('append', onAppend))
  for (const n of names) fs.unlinkSync(path.join(mountPath, n))
  const r = await periodicReconcile(spaceId, share.id, mountPath, [])
  t.is(r.deleted, 6)
  t.alike(await listRelPaths(share, spaceId), [])
  t.ok(appends <= 2, 'six tombstones in one flush — ' + appends + ' head(s)')
  t.absent(await entryFor(share, spaceId, names[0]), 'the entries are tombstoned')
})

// REGRESSION (FIX-INTERACTIVE-SETTLE: a watcher item wrote the bee directly while the space batch
// still held staged ops for the same space; a staged put or tombstone for a path retired or
// re-added directly landed afterwards and undid it. An interactive item now lands the batch first.)
test('REGRESSION (FIX-INTERACTIVE-SETTLE): a watcher item lands the space batch before writing direct', { timeout: 90000 }, async (t) => {
  const { spaceId, share, mountPath, tmpDir } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, catalogFlushMs: 60000, catalogFlushMaxOps: 1000, publishConcurrency: 2 })
  t.teardown(() => setRuntimeConfig(cfg))
  // A second share in the same space keeps the batch open while its big file hashes; the other
  // bulk slot stays free so the watcher item below starts at once.
  const other = { id: generateShareId(), type: 'owned-folder', name: 'Other', owner: getLocalPublicKeyHex(), contentMode: 'overlay', catalogKey: await ownCatalogKeyHex(spaceId), createdAt: Date.now() }
  await publishShare(spaceId, other)
  const otherPath = tmpDir('other')
  await saveOwnedMount({ spaceId, shareId: other.id, mountPath: otherPath, ignore: [], createdAt: Date.now() })
  t.teardown(() => stopOwnedFolder(spaceId, other.id))
  fs.writeFileSync(path.join(otherPath, 'first.txt'), 'first')
  fs.writeFileSync(path.join(otherPath, 'slow.bin'), 's'.repeat(8192))
  slowHash(t, 2500, { only: ['slow.bin'] })
  const scan = initialPublishScan(spaceId, other.id, otherPath, [])
  await until(async () => getIndexStatus(spaceId, other.id).done === 1, 5000)
  t.is(getIndexStatus(spaceId, other.id).running, 1, 'slow.bin holds a slot; first.txt is staged, unflushed')
  const bee = await ownCatalog(spaceId)
  t.absent(await bee.get('file/' + other.id + '/first.txt'), 'not in the bee yet')

  const abs = path.join(mountPath, 'now.txt')
  fs.writeFileSync(abs, 'n')
  await onFsEvent(spaceId, share.id, 'add', 'now.txt', abs)
  t.ok(await bee.get('file/' + other.id + '/first.txt'), 'the interactive item flushed the batch before its own write')
  await scan
})

// REGRESSION (FIX-DRAIN-EMIT: the drained hook's catalog settle ran before the batch close was
// registered, so share-files-updated fired ahead of the closing flush — the owner's own list
// re-read the bee with the pass's last files missing or stuck 'preparing'.)
test('REGRESSION (FIX-DRAIN-EMIT): share-files-updated after a pass fires only once its writes landed', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath, fake } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, catalogFlushMs: 60000, catalogFlushMaxOps: 1000 })
  t.teardown(() => setRuntimeConfig(cfg))
  fill(mountPath, ['a.bin', 'b.bin', 'c.bin'])
  slowHash(t, 10)
  const bee = await ownCatalog(spaceId)
  const lengthsAtEmit = []
  const emit = fake.ipc.emit
  fake.ipc.emit = (type, payload) => { if (type === 'event:share-files-updated') lengthsAtEmit.push(bee.core.length); emit(type, payload) }
  t.teardown(() => { fake.ipc.emit = emit })
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.ok(await settled(share, spaceId, 3))
  const final = bee.core.length
  t.ok(lengthsAtEmit.length > 0, 'the pass announced itself')
  t.is(lengthsAtEmit[lengthsAtEmit.length - 1], final, 'the last announcement saw every write landed')
})

// REGRESSION (FIX-DEEP-FORCE: the deep pass hashed the file, saw the mismatch, and handed the
// publish to a fast path that compares size+mtime+hash-present — which called an in-place rewrite
// that preserved both "already published". The one case the deep pass exists for never republished.)
test('REGRESSION (FIX-DEEP-FORCE): the deep pass republishes a same-size rewrite that kept its mtime', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  const abs = path.join(mountPath, 'vault.bin')
  // A whole-second mtime, so restoring it after the rewrite is exact.
  const pinned = Math.floor(Date.now() / 1000) - 60
  fs.writeFileSync(abs, 'a'.repeat(4096))
  fs.utimesSync(abs, pinned, pinned)
  slowHash(t, 10)
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.ok(await settled(share, spaceId, 1))
  const before = await entryFor(share, spaceId, 'vault.bin')
  fs.writeFileSync(abs, 'b'.repeat(4096))
  fs.utimesSync(abs, pinned, pinned)
  const st = fs.statSync(abs)
  t.is(st.size, before.size)
  t.is(st.mtimeMs, before.mtime, 'precondition: the rewrite is invisible to size+mtime')
  t.is((await periodicReconcile(spaceId, share.id, mountPath, [])).uploaded, 0, 'the fast pass cannot see it')
  const r = await periodicReconcile(spaceId, share.id, mountPath, [], { deep: true })
  t.is(r.uploaded, 1, 'the deep pass republished it')
  const after = await entryFor(share, spaceId, 'vault.bin')
  t.not(after.contentHash, before.contentHash, 'peers verify against the new bytes')
})

// REGRESSION (FIX-SCAN-CANCELLED: a cancelled index resolved like a finished one — the worker
// recorded 'active', emitted scan-completed with partial counts and re-armed the reconcile it
// had just cancelled, racing a delete's mount removal back into a zombie record.)
test('REGRESSION (FIX-SCAN-CANCELLED): a cancelled index resolves as cancelled', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  fill(mountPath, ['a.bin', 'b.bin', 'c.bin'])
  slowHash(t, 700)
  const scan = initialPublishScan(spaceId, share.id, mountPath, [])
  await until(() => getIndexStatus(spaceId, share.id).running > 0, 5000)
  t.ok(cancelIndex(spaceId, share.id) > 0)
  const r = await scan
  t.ok(r.cancelled, 'marked, so no status is recorded for it')
  t.ok(await until(() => getIndexStatus(spaceId, share.id).running === 0, 5000), 'the running item honoured the abort')
})

test('a deep hash honours the abort signal', { timeout: 60000 }, async (t) => {
  const { mountPath } = await setupOwnedShare(t)
  const abs = path.join(mountPath, 'big.bin')
  fs.writeFileSync(abs, 'z'.repeat(1 << 20))
  await t.exception(overlayHashFile(abs, undefined, { aborted: true }), /aborted/)
  t.ok(await overlayHashFile(abs, undefined, { aborted: false }))
})
