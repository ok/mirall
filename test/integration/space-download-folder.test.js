import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { initDownloads, markDownloaded, isDownloadedFile, getDownloadedPath } from '../../src/shared/transfer/files.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { setSpaceDownloadRoot } from '../../src/shared/core/paths.js'

// Switching a space's download folder must never move or delete a file, and must never
// destroy the claim for a file that merely sits outside the new folder — otherwise
// pointing the space back at the old folder would not restore its downloaded status.

async function setup (t) {
  const ctx = await freshPeer(t)
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, downloadFolder: ctx.downloads })
  t.teardown(() => setRuntimeConfig(prev))
  await initDownloads()
  const space = await createSpace('Aurora')
  return { ...ctx, spaceId: space.spaceId }
}

function land (dir, name, body = 'bytes') {
  const p = path.join(dir, name)
  fs.writeFileSync(p, body)
  return p
}

test('a space with no override lands in and reads from the global root', async (t) => {
  const { spaceId, downloads } = await setup(t)
  const landed = land(downloads, 'g.txt')
  await markDownloaded(spaceId, '/g.txt', landed, { hash: 'h1' })
  t.ok(await isDownloadedFile(spaceId, '/g.txt', 'h1'), 'in the global root → downloaded')
})

test('an override scopes the claim to that space only', async (t) => {
  const { spaceId, downloads, tmpDir } = await setup(t)
  const other = await createSpace('Borealis')
  const dir = tmpDir('space-dl')
  setSpaceDownloadRoot(spaceId, dir)

  const landed = land(dir, 'o.txt')
  await markDownloaded(spaceId, '/o.txt', landed, { hash: 'h1' })
  t.ok(await isDownloadedFile(spaceId, '/o.txt', 'h1'), 'inside its own override → downloaded')

  const globalLanded = land(downloads, 'p.txt')
  await markDownloaded(other.spaceId, '/p.txt', globalLanded, { hash: 'h2' })
  t.ok(await isDownloadedFile(other.spaceId, '/p.txt', 'h2'), 'a sibling space still uses the global root')
})

// The load-bearing test of this feature. If someone folds the scope check into the
// pruning branch, this fails — and folder switching becomes silently destructive.
test('REGRESSION: switching folders reports not-downloaded but KEEPS the claim', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const oldDir = tmpDir('dl-old')
  const newDir = tmpDir('dl-new')
  setSpaceDownloadRoot(spaceId, oldDir)

  const landed = land(oldDir, 'r.txt')
  await markDownloaded(spaceId, '/r.txt', landed, { hash: 'h1' })
  t.ok(await isDownloadedFile(spaceId, '/r.txt', 'h1'), 'baseline: downloaded')

  setSpaceDownloadRoot(spaceId, newDir)
  t.absent(await isDownloadedFile(spaceId, '/r.txt', 'h1'), 'out of scope → not downloaded')
  t.is(await getDownloadedPath(spaceId, '/r.txt'), landed, 'the claim survives, still pointing at the old path')
  t.ok(fs.existsSync(landed), 'the file itself was never moved or deleted')
})

test('REGRESSION: switching back restores the downloaded status without re-downloading', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const oldDir = tmpDir('dl-old')
  const newDir = tmpDir('dl-new')
  setSpaceDownloadRoot(spaceId, oldDir)

  const landed = land(oldDir, 'r.txt')
  await markDownloaded(spaceId, '/r.txt', landed, { hash: 'h1' })

  setSpaceDownloadRoot(spaceId, newDir)
  t.absent(await isDownloadedFile(spaceId, '/r.txt', 'h1'), 'out of scope')

  setSpaceDownloadRoot(spaceId, oldDir)
  t.ok(await isDownloadedFile(spaceId, '/r.txt', 'h1'), 'back in scope → downloaded again')
})

// Scope is keyed on the space's OVERRIDE, not on its effective root: an override is a promise
// that this space's downloads live in one named folder, and dropping it withdraws the promise
// rather than making a different one. New downloads go to the global root from here on.
test('clearing the override stops scoping the space at all', async (t) => {
  const { spaceId, downloads, tmpDir } = await setup(t)
  const dir = tmpDir('dl-space')
  setSpaceDownloadRoot(spaceId, dir)
  const inOverride = land(dir, 'a.txt')
  await markDownloaded(spaceId, '/a.txt', inOverride, { hash: 'h1' })
  t.ok(await isDownloadedFile(spaceId, '/a.txt', 'h1'))

  setSpaceDownloadRoot(spaceId, null)
  t.ok(await isDownloadedFile(spaceId, '/a.txt', 'h1'), 'the copy is still on disk, so it still counts')

  const inGlobal = land(downloads, 'b.txt')
  await markDownloaded(spaceId, '/b.txt', inGlobal, { hash: 'h2' })
  t.ok(await isDownloadedFile(spaceId, '/b.txt', 'h2'), 'and the global root applies to new downloads')
})

// REGRESSION (DL-1): the scope check must never key on the EFFECTIVE root. It did, and
// getDownloadDir falls back to the global one — so changing the global folder in Storage
// Settings flipped every file of every space without an override to 'remote' while the files
// sat untouched on disk, and every re-download landed a duplicate next to the original.
test('REGRESSION: changing the GLOBAL folder never un-downloads a space that has no override', async (t) => {
  const { spaceId, downloads, tmpDir } = await setup(t)
  const other = await createSpace('Borealis')
  await markDownloaded(spaceId, '/g.txt', land(downloads, 'g.txt'), { hash: 'h1' })
  await markDownloaded(other.spaceId, '/h.txt', land(downloads, 'h.txt'), { hash: 'h2' })

  setRuntimeConfig({ ...getRuntimeConfig(), downloadFolder: tmpDir('dl-moved') })

  t.ok(await isDownloadedFile(spaceId, '/g.txt', 'h1'), 'still downloaded after the global move')
  t.ok(await isDownloadedFile(other.spaceId, '/h.txt', 'h2'), 'and so is every sibling space')
})

// REGRESSION (DL-2): a per-space root on a removable or network volume is exactly what this
// feature invites. An ejected volume made every file under it look deleted, and the prune ran
// FIRST — so the claims were destroyed permanently and re-attaching restored nothing.
test('REGRESSION: an unavailable download folder keeps its claims instead of pruning them', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const volume = tmpDir('dl-volume')
  const landed = land(volume, 'v.txt')
  setSpaceDownloadRoot(spaceId, volume)
  await markDownloaded(spaceId, '/v.txt', landed, { hash: 'h1' })
  t.ok(await isDownloadedFile(spaceId, '/v.txt', 'h1'), 'baseline: downloaded')

  fs.unlinkSync(landed)
  fs.rmdirSync(volume)   // the whole root is gone, as on an eject
  t.absent(await isDownloadedFile(spaceId, '/v.txt', 'h1'), 'reported not-downloaded while detached')
  t.is(await getDownloadedPath(spaceId, '/v.txt'), landed, 'but the claim survives the outage')

  fs.mkdirSync(volume)
  land(volume, 'v.txt')  // re-attached, file back in place
  t.ok(await isDownloadedFile(spaceId, '/v.txt', 'h1'), 'and it is downloaded again once re-attached')
})

// Destructive checks must run BEFORE the scope check, so a worthless claim is still
// pruned even while it is out of scope.
test('a deleted file still prunes its claim, in scope or out', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const oldDir = tmpDir('dl-old')
  setSpaceDownloadRoot(spaceId, oldDir)
  const landed = land(oldDir, 'r.txt')
  await markDownloaded(spaceId, '/r.txt', landed, { hash: 'h1' })

  setSpaceDownloadRoot(spaceId, tmpDir('dl-new'))
  fs.unlinkSync(landed)
  t.absent(await isDownloadedFile(spaceId, '/r.txt', 'h1'), 'gone → not downloaded')
  t.is(await getDownloadedPath(spaceId, '/r.txt'), null, 'and the claim is pruned even though it was out of scope')
})

test('an upstream content change prunes the claim even while out of scope', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const oldDir = tmpDir('dl-old')
  setSpaceDownloadRoot(spaceId, oldDir)
  await markDownloaded(spaceId, '/s.txt', land(oldDir, 's.txt'), { hash: 'old' })

  setSpaceDownloadRoot(spaceId, tmpDir('dl-new'))
  t.absent(await isDownloadedFile(spaceId, '/s.txt', 'new'), 'hash mismatch → not downloaded')
  t.is(await getDownloadedPath(spaceId, '/s.txt'), null, 'stale claim pruned')
})

// Claims written before localPath existed carry no path. Those files can only ever have
// landed under the global root, so they must not be resolved against a per-space override.
test('a legacy claim with no localPath resolves against the global root', async (t) => {
  const { spaceId, downloads, tmpDir } = await setup(t)
  const legacy = land(downloads, 'legacy.txt')
  t.ok(fs.existsSync(legacy))
  await markDownloaded(spaceId, '/legacy.txt', null, { hash: 'h1' })
  t.ok(await isDownloadedFile(spaceId, '/legacy.txt', 'h1'), 'found under the global root')

  setSpaceDownloadRoot(spaceId, tmpDir('dl-space'))
  t.absent(await isDownloadedFile(spaceId, '/legacy.txt', 'h1'), 'out of scope once the space overrides')

  // The survival check has to read the CLAIM back, not the file: verifyOnDevice only ever
  // deletes bee rows, so asserting the file still exists passes even if the scope check is
  // folded into the pruning branch — the regression this whole file exists to catch. A legacy
  // row has no localPath to read via getDownloadedPath, so re-scope and re-ask instead.
  setSpaceDownloadRoot(spaceId, null)
  t.ok(await isDownloadedFile(spaceId, '/legacy.txt', 'h1'), 'the claim survived being out of scope')
})

test('two spaces sharing one download folder both resolve their own claims', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const other = await createSpace('Borealis')
  const shared = tmpDir('dl-shared')
  setSpaceDownloadRoot(spaceId, shared)
  setSpaceDownloadRoot(other.spaceId, shared)

  await markDownloaded(spaceId, '/x.txt', land(shared, 'x.txt'), { hash: 'h1' })
  await markDownloaded(other.spaceId, '/x.txt', land(shared, 'x (1).txt'), { hash: 'h2' })

  t.ok(await isDownloadedFile(spaceId, '/x.txt', 'h1'))
  t.ok(await isDownloadedFile(other.spaceId, '/x.txt', 'h2'))
})
