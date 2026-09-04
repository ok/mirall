import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupSelfMirror } from '../helpers/owned.js'
import { getForeignMount, saveForeignMount } from '../../src/shared/folders/mount-store.js'
import { createLocalBee } from '../../src/shared/core/store.js'
import { initialMaterializeScan, runMaterializeTick, unmountForeignFolder } from '../../src/shared/folders/foreign-folders.js'

// Count Array.prototype.includes calls for the duration of a pass. A subclassed array cannot be
// used here: the record round-trips through the bee's JSON encoding, which hands the loop a plain
// array — a counting wrapper would silently never be consulted and the test would pass either way.
function countIncludes (t) {
  const real = Array.prototype.includes
  const counter = { n: 0 }
  Array.prototype.includes = function (...a) { counter.n++; return real.apply(this, a) }
  t.teardown(() => { Array.prototype.includes = real })
  return counter
}

// The mounts bee is append-only, so its block count is what a redundant per-tick record write
// actually costs. A second handle reads the same underlying core.
async function mountsBeeLength () {
  const bee = createLocalBee('mounts-meta')
  await bee.ready()
  const len = bee.core.length
  await bee.close()
  return len
}

const files = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => ['f' + i + '.txt', 'x' + i]))

// REGRESSION (FIX-MIRROR-SET: membership of an already-mirrored entry was an Array.includes over
// the persisted syncedPaths, run once per catalog entry per tick — N(N+1)/2 string compares for a
// converged mirror, on every 30 s poll and every owner append. The in-memory Set makes it O(1).)
test('REGRESSION (FIX-MIRROR-SET): a converged tick does not scan the persisted path list', async (t) => {
  const N = 60
  const ctx = await setupSelfMirror(t, { name: 'Bulk', files: files(N) })
  await initialMaterializeScan(ctx.mount)

  const stored = await getForeignMount(ctx.spaceId, ctx.share.id)
  t.is(stored.syncedPaths.length, N, 'the initial scan recorded every file')

  const includes = countIncludes(t)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  // Two converged ticks over N files: the old membership check alone was 2N array scans (and
  // N(N+1)/2 element compares). A handful of unrelated `includes` calls elsewhere is fine; N is
  // not. The bound is far below 2N and far above the incidental traffic.
  t.ok(includes.n < N / 2, 'membership is answered from the Set, not by scanning the array (' + includes.n + ' scans for N=' + N + ')')
})

// The persist was unconditional on every owner-online tick — about 36 B per path, so a converged
// 5k-file mirror appended ~180 KB to the mounts bee every 30 s, forever.
test('REGRESSION (FIX-MIRROR-SET): a converged tick with nothing to do writes nothing', async (t) => {
  const ctx = await setupSelfMirror(t, { name: 'Quiet', files: files(8) })
  await initialMaterializeScan(ctx.mount)

  // The record's CONTENT is identical either way, so content cannot detect the redundant write —
  // the append-only bee's block count can. Before the fix the owner-online branch rewrote the
  // whole record on every tick whether or not anything had moved.
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  const before = await mountsBeeLength()
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(await mountsBeeLength(), before, 'two further converged ticks appended no blocks')
})

// Ownership is recorded BEFORE the write lands, so a pass interrupted after a file landed still
// owns it — otherwise the owner's later delete of that file is never applied to the mirror.
test('REGRESSION (FIX-MIRROR-SET): a file is owned before its bytes land', async (t) => {
  const ctx = await setupSelfMirror(t, { name: 'Order', files: { 'a.txt': 'a', 'b.txt': 'b' } })
  await initialMaterializeScan(ctx.mount)
  const stored = await getForeignMount(ctx.spaceId, ctx.share.id)
  t.ok(stored.syncedPaths.includes('a.txt') && stored.syncedPaths.includes('b.txt'), 'both files are owned')
  for (const rel of ['a.txt', 'b.txt']) {
    t.ok(fs.existsSync(path.join(ctx.mirrorPath, rel)), rel + ' materialized')
  }
})

// The Set's lifetime is the record's: an unmount drops it so a re-mount starts from the persisted
// array again instead of inheriting the previous mount's ownership.
test('unmount drops the in-memory ownership with the record', async (t) => {
  const ctx = await setupSelfMirror(t, { name: 'Remount', files: { 'k.txt': 'k' } })
  await initialMaterializeScan(ctx.mount)
  await unmountForeignFolder(ctx.spaceId, ctx.share.id)
  t.absent(await getForeignMount(ctx.spaceId, ctx.share.id), 'the record is gone')

  await saveForeignMount({ ...ctx.mount, syncedPaths: [], status: 'scanning' })
  await initialMaterializeScan({ ...ctx.mount, syncedPaths: [] })
  const again = await getForeignMount(ctx.spaceId, ctx.share.id)
  t.ok(again.syncedPaths.includes('k.txt'), 'the re-mount rebuilt ownership from its own scan')
})

// Ownership is recorded before the write lands, but the collision check must still treat such a
// path as NOT-yet-ours: a pre-existing user file at the natural name has to get a sibling, not be
// adopted. Unifying "what we own" with "what we owned before this pass" broke exactly this, and
// only the two-peer foreign-sync test caught it — this pins it at the cheaper layer.
test('REGRESSION (FIX-MIRROR-SET): a pre-existing user file at the natural name still gets a sibling', async (t) => {
  const ctx = await setupSelfMirror(t, { name: 'Collide', files: { 'report.pdf': 'OWNER CONTENT' } })
  // The user already has an unrelated file at that name in the mirror folder.
  fs.mkdirSync(ctx.mirrorPath, { recursive: true })
  fs.writeFileSync(path.join(ctx.mirrorPath, 'report.pdf'), 'THE USER OWN FILE')

  await initialMaterializeScan(ctx.mount)

  t.is(fs.readFileSync(path.join(ctx.mirrorPath, 'report.pdf'), 'utf8'), 'THE USER OWN FILE', 'the user file is untouched')
  t.ok(fs.existsSync(path.join(ctx.mirrorPath, 'report (1).pdf')), 'the owner copy landed beside it as a sibling')
})

// The listing half of this lives in share-listing-batch.test.js (the renamed matrix dimension);
// this is the half that proves the mirror really does mint the sibling and record the mapping.
test('a pre-existing user file forces a sibling, and the mapping is recorded', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'report.pdf': 'owner-bytes' } })
  fs.writeFileSync(path.join(ctx.mirrorPath, 'report.pdf'), 'the users own file')

  await initialMaterializeScan(ctx.mount)

  const mount = await getForeignMount(ctx.spaceId, ctx.share.id)
  const localRel = mount.renamedPaths?.['report.pdf']
  t.ok(localRel && localRel !== 'report.pdf', 'a sibling was minted: ' + localRel)
  t.is(fs.readFileSync(path.join(ctx.mirrorPath, localRel), 'utf8'), 'owner-bytes', 'owner bytes landed there')
  t.is(fs.readFileSync(path.join(ctx.mirrorPath, 'report.pdf'), 'utf8'), 'the users own file', "and the user's file is untouched")
})
