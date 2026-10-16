import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { initDownloads, markDownloaded, isDownloadedFile, getDownloadedPath } from '../../src/shared/transfer/files.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { setSpaceDownloadRoot } from '../../src/shared/core/paths.js'

// A copy counts as downloaded wherever it was downloaded to: switching a space's folder never
// moves, deletes or un-downloads a copy. Only the copy itself going away, or the owner replacing
// the file, prunes the claim; an unplugged drive keeps it.

async function setup(t) {
  const ctx = await freshPeer(t)
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, downloadFolder: ctx.downloads })
  t.teardown(() => setRuntimeConfig(prev))
  await initDownloads()
  const space = await createSpace('Aurora')
  setSpaceDownloadRoot(space.spaceId, space.downloadFolder)
  return { ...ctx, spaceId: space.spaceId }
}

function land(dir, name, body = 'bytes') {
  const p = path.join(dir, name)
  fs.writeFileSync(p, body)
  return p
}

test('a new space downloads into the folder new spaces start in', async (t) => {
  const { spaceId, downloads } = await setup(t)
  const landed = land(downloads, 'g.txt')
  await markDownloaded(spaceId, '/g.txt', landed, { hash: 'h1', destDir: downloads })
  t.ok(await isDownloadedFile(spaceId, '/g.txt', 'h1'))
})

test('REGRESSION: switching folders leaves every earlier copy downloaded and in place', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const oldDir = tmpDir('dl-old')
  setSpaceDownloadRoot(spaceId, oldDir)
  const landed = land(oldDir, 'r.txt')
  await markDownloaded(spaceId, '/r.txt', landed, { hash: 'h1', destDir: oldDir })

  setSpaceDownloadRoot(spaceId, tmpDir('dl-new'))
  t.ok(await isDownloadedFile(spaceId, '/r.txt', 'h1'), 'still downloaded after the switch')
  t.is(await getDownloadedPath(spaceId, '/r.txt'), landed, 'the claim still points at the old path')
  t.ok(fs.existsSync(landed), 'and the file itself was never moved or deleted')
})

// REGRESSION (DL-1): changing the app folder flipped every file of every space following it to
// 'remote' while the files sat untouched on disk, and every re-download landed a duplicate.
test('REGRESSION: changing the app folder never un-downloads a space', async (t) => {
  const { spaceId, downloads, tmpDir } = await setup(t)
  const other = await createSpace('Borealis')
  await markDownloaded(spaceId, '/g.txt', land(downloads, 'g.txt'), { hash: 'h1', destDir: downloads })
  await markDownloaded(other.spaceId, '/h.txt', land(downloads, 'h.txt'), { hash: 'h2', destDir: downloads })

  setRuntimeConfig({ ...getRuntimeConfig(), downloadFolder: tmpDir('dl-moved') })

  t.ok(await isDownloadedFile(spaceId, '/g.txt', 'h1'), 'still downloaded after the app folder moved')
  t.ok(await isDownloadedFile(other.spaceId, '/h.txt', 'h2'), 'and so is every sibling space')
})

// REGRESSION (DL-2): an ejected volume made every file under it look deleted, and the prune ran
// FIRST — so the claims were destroyed permanently and re-attaching restored nothing.
test('REGRESSION: an unavailable download folder keeps its claims instead of pruning them', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const volume = tmpDir('dl-volume')
  const landed = land(volume, 'v.txt')
  await markDownloaded(spaceId, '/v.txt', landed, { hash: 'h1', destDir: volume })
  t.ok(await isDownloadedFile(spaceId, '/v.txt', 'h1'), 'baseline: downloaded')

  fs.unlinkSync(landed)
  fs.rmdirSync(volume)   // the whole folder is gone, as on an eject
  t.absent(await isDownloadedFile(spaceId, '/v.txt', 'h1'), 'reported not-downloaded while detached')
  t.is(await getDownloadedPath(spaceId, '/v.txt'), landed, 'but the claim survives the outage')

  fs.mkdirSync(volume)
  land(volume, 'v.txt')  // re-attached, file back in place
  t.ok(await isDownloadedFile(spaceId, '/v.txt', 'h1'), 'and it is downloaded again once re-attached')
})

test('a deleted copy still prunes its claim after the space switched folders', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const oldDir = tmpDir('dl-old')
  const landed = land(oldDir, 'r.txt')
  await markDownloaded(spaceId, '/r.txt', landed, { hash: 'h1', destDir: oldDir })

  setSpaceDownloadRoot(spaceId, tmpDir('dl-new'))
  fs.unlinkSync(landed)
  t.absent(await isDownloadedFile(spaceId, '/r.txt', 'h1'), 'gone → not downloaded')
  t.is(await getDownloadedPath(spaceId, '/r.txt'), null, 'and the claim is pruned')
})

test('an upstream content change still prunes the claim after the space switched folders', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const oldDir = tmpDir('dl-old')
  await markDownloaded(spaceId, '/s.txt', land(oldDir, 's.txt'), { hash: 'old', destDir: oldDir })

  setSpaceDownloadRoot(spaceId, tmpDir('dl-new'))
  t.absent(await isDownloadedFile(spaceId, '/s.txt', 'new'), 'hash mismatch → not downloaded')
  t.is(await getDownloadedPath(spaceId, '/s.txt'), null, 'stale claim pruned')
})

// Claims written before localPath existed carry no path. Those files can only ever have landed
// under the app folder, so a space's own folder never answers for them.
test('a legacy claim with no localPath resolves against the folder new spaces start in', async (t) => {
  const { spaceId, downloads, tmpDir } = await setup(t)
  land(downloads, 'legacy.txt')
  await markDownloaded(spaceId, '/legacy.txt', null, { hash: 'h1' })
  t.ok(await isDownloadedFile(spaceId, '/legacy.txt', 'h1'), 'found under the app folder')

  setSpaceDownloadRoot(spaceId, tmpDir('dl-space'))
  t.ok(await isDownloadedFile(spaceId, '/legacy.txt', 'h1'), 'and still after the space switched folders')
})

test('two spaces sharing one download folder both resolve their own claims', async (t) => {
  const { spaceId, tmpDir } = await setup(t)
  const other = await createSpace('Borealis')
  const shared = tmpDir('dl-shared')
  setSpaceDownloadRoot(spaceId, shared)
  setSpaceDownloadRoot(other.spaceId, shared)

  await markDownloaded(spaceId, '/x.txt', land(shared, 'x.txt'), { hash: 'h1', destDir: shared })
  await markDownloaded(other.spaceId, '/x.txt', land(shared, 'x (1).txt'), { hash: 'h2', destDir: shared })

  t.ok(await isDownloadedFile(spaceId, '/x.txt', 'h1'))
  t.ok(await isDownloadedFile(other.spaceId, '/x.txt', 'h2'))
})
