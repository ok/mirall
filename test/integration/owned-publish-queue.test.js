import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare, listRelPaths } from '../helpers/owned.js'
import { onFsEvent, initialPublishScan, periodicReconcile, stopOwnedFolder } from '../../src/shared/folders/owned-folders.js'
import { saveOwnedMount, getOwnedMount } from '../../src/shared/folders/mount-store.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlaySweepPresence, overlayPublishAdd } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'
import { createCatalogBatch } from '../../src/shared/shares/catalog-writer.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// prepareForServe is the single choke point for the streaming read publishContent performs, so
// counting it counts real work. The sleep stands in for the multi-second hash of a large file.
function slowHash (t, ms) {
  const overlay = getOverlay()
  const orig = overlay.prepareForServe.bind(overlay)
  const calls = []
  let live = 0
  let peak = 0
  overlay.prepareForServe = async (diskPath, opts) => {
    calls.push(path.basename(diskPath))
    live += 1
    peak = Math.max(peak, live)
    try { await sleep(ms); return await orig(diskPath, opts) } finally { live -= 1 }
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
  t.ok(probe.peak() <= 2, 'never more than publishConcurrency hashes at once — peak ' + probe.peak())
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

// The sweep only ever removes; a path whose publish is queued but not started has no entry to
// protect it, so the sweep must consult the queue the way the loose sweep consults isPublishActive.
test('REGRESSION (FIX-SCAN-4): the presence sweep does not reclaim a path with a pending item', { timeout: 60000 }, async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  t.teardown(() => stopOwnedFolder(spaceId, share.id))
  fill(mountPath, ['a.bin', 'b.bin', 'c.bin'])
  slowHash(t, 800)
  const scan = initialPublishScan(spaceId, share.id, mountPath, [])
  await sleep(200)
  await overlaySweepPresence()
  await overlaySweepPresence()
  await scan
  t.ok(await settled(share, spaceId, 3), 'nothing was swept out from under the queue')
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
