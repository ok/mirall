import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { waitFor } from '../helpers/bare-poll.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { createDirProbe, listDownloadClaimsForShare, verdictForClaim } from '../../src/shared/transfer/files.js'
import { getOverlay } from '../../src/shared/transfer/overlay/overlay-instance.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/overlay/overlay-download.js'
import { downloadChannel } from '../../src/shared/transfer/overlay/share-downloads.js'
import { LAYOUT } from '../../src/shared/transfer/overlay/download-job.js'

// The claim rule asks whether the VOLUME is there when a copy is missing. That question is about the
// folder the copy was downloaded into, which the claim names: a user who deleted a whole batch
// folder deleted copies, and the claim must be pruned rather than kept forever as "volume
// detached". A claim from before claims named their folder asks the download roots instead.

const rec = (localPath) => ({ downloadedAt: 1, localPath, hash: 'h' })
const recIn = (destDir, localPath) => ({ ...rec(localPath), destDir })

test('a copy whose batch subfolder was deleted under its present folder is pruned', async (t) => {
  const { tmpDir } = await freshPeer(t)
  const chosen = tmpDir('chosen')
  const batch = path.join(chosen, 'Vault', 'sub')
  const copy = path.join(batch, 'a.txt')
  fs.mkdirSync(batch, { recursive: true })
  fs.writeFileSync(copy, 'x')
  t.ok(verdictForClaim('s', '/Vault/sub/a.txt', recIn(chosen, copy), 'h').downloaded, 'present while the copy is there')

  fs.rmSync(path.join(chosen, 'Vault'), { recursive: true, force: true })
  const verdict = verdictForClaim('s', '/Vault/sub/a.txt', recIn(chosen, copy), 'h')
  t.ok(verdict.prune, 'a folder outside every space\'s current one still answers for its volume')
  t.is(verdict.reason, 'local-file-gone')
})

test('a copy whose own download folder is gone is kept as a detached volume when its claim recorded no device', async (t) => {
  const { downloads, tmpDir } = await freshPeer(t)
  const chosen = tmpDir('chosen')
  const copy = path.join(chosen, 'a.txt')
  fs.rmSync(chosen, { recursive: true, force: true })
  const verdict = verdictForClaim('s', '/a.txt', recIn(chosen, copy), 'h')
  t.absent(verdict.prune)
  t.is(verdict.reason, 'volume-unavailable')
  t.ok(fs.existsSync(downloads), 'though the space\'s folder is there')
})

test('a legacy claim deleted with its whole batch folder is pruned, not kept as a detached volume', async (t) => {
  const { downloads } = await freshPeer(t)
  const batch = path.join(downloads, 'Batch')
  const copy = path.join(batch, 'a.txt')
  fs.mkdirSync(batch, { recursive: true })
  fs.writeFileSync(copy, 'x')
  t.ok(verdictForClaim('s', '/Batch/a.txt', rec(copy), 'h').downloaded, 'present while the copy is there')

  fs.rmSync(batch, { recursive: true, force: true })
  const verdict = verdictForClaim('s', '/Batch/a.txt', rec(copy), 'h')
  t.absent(verdict.downloaded)
  t.ok(verdict.prune, 'the root is there, so the copy was deleted')
  t.is(verdict.reason, 'local-file-gone')
})

test('a legacy claim whose download root is gone is kept, as a detached volume', async (t) => {
  const { downloads, tmpDir } = await freshPeer(t)
  const detached = tmpDir('volume')
  const copy = path.join(detached, 'Batch', 'a.txt')
  fs.rmSync(detached, { recursive: true, force: true })
  // A copy outside every download root answers for its own folder.
  const outside = verdictForClaim('s', '/Batch/a.txt', rec(copy), 'h')
  t.absent(outside.prune)
  t.is(outside.reason, 'volume-unavailable')

  fs.rmSync(downloads, { recursive: true, force: true })
  const inRoot = verdictForClaim('s', '/Batch/b.txt', rec(path.join(downloads, 'Batch', 'b.txt')), 'h')
  t.absent(inRoot.prune, 'the root itself is gone: the volume, not the copy')
  t.is(inRoot.reason, 'volume-unavailable')
})

test('a legacy flat claim behaves as before', async (t) => {
  const { downloads } = await freshPeer(t)
  const copy = path.join(downloads, 'a.txt')
  const gone = verdictForClaim('s', '/a.txt', rec(copy), 'h')
  t.ok(gone.prune, 'a missing flat copy in a present root is pruned')
  fs.writeFileSync(copy, 'x')
  t.ok(verdictForClaim('s', '/a.txt', rec(copy), 'h').downloaded)
})

// A claim that records the device its folder was on tells a folder removed from a present volume
// from a volume that is gone: the nearest folder above the missing one that still exists sits on
// that device in the first case and on another in the second.
const recOn = (destDir, localPath) => ({ ...recIn(destDir, localPath), destDev: fs.statSync(destDir).dev })

// REGRESSION (FIX-DLTO-R9: a copy whose chosen folder was deleted or renamed on the system disk read
// "Drive not connected · Saved to …" until a folder existed there again; it is Available.)
test('REGRESSION (FIX-DLTO-R9: a copy whose folder was deleted on a present volume is pruned)', async (t) => {
  const { tmpDir } = await freshPeer(t)
  const chosen = tmpDir('chosen')
  const copy = path.join(chosen, 'a.txt')
  fs.writeFileSync(copy, 'x')
  const claim = recOn(chosen, copy)

  fs.rmSync(chosen, { recursive: true, force: true })
  const verdict = verdictForClaim('s', '/a.txt', claim, 'h')
  t.ok(verdict.prune, 'the folder went, the volume did not: the copy is gone')
  t.is(verdict.reason, 'local-file-gone')
  const probed = verdictForClaim('s', '/a.txt', claim, 'h', createDirProbe())
  t.is(probed.reason, 'local-file-gone', 'the listing\'s memoised probe reaches the same verdict')
})

test('a missing folder whose nearest surviving folder is on another device is a volume that is away', async (t) => {
  const { tmpDir } = await freshPeer(t)
  const chosen = tmpDir('chosen')
  const copy = path.join(chosen, 'a.txt')
  const claim = recOn(chosen, copy)
  fs.rmSync(chosen, { recursive: true, force: true })

  const asked = []
  const probe = createDirProbe({ deviceOf: (dir) => { asked.push(dir); return claim.destDev + 1 } })
  const verdict = verdictForClaim('s', '/a.txt', claim, 'h', probe)
  t.absent(verdict.prune, 'kept for the volume to come back to')
  t.is(verdict.reason, 'volume-unavailable')
  verdictForClaim('s', '/b.txt', recOn(tmpDir('other'), path.join(chosen, 'b.txt')), 'h', probe)
  verdictForClaim('s', '/c.txt', { ...claim, localPath: path.join(chosen, 'c.txt') }, 'h', probe)
  t.alike(asked, [chosen], 'the device is asked once per folder in a pass, and only for a missing one')
})

// The device is recorded where the claim is written: a completed download, through the engine and
// the production channel.
test('REGRESSION (FIX-DLTO-R9: a completed download records its folder\'s device, so deleting the folder reads Available)', async (t) => {
  const ctx = await freshPeer(t)
  const space = await createSpace('Aurora')
  const chosen = ctx.tmpDir('chosen')
  const finalPath = path.join(chosen, 'Brand Assets', 'logo.svg')
  fs.mkdirSync(path.dirname(finalPath), { recursive: true })
  fs.writeFileSync(finalPath, 'bytes')
  getOverlay().fetchFile = async () => ({ destPath: finalPath, local: false, size: 5 })
  const engine = createOverlayDownloadEngine({ ...downloadChannel, isOwnerOnline: () => true })
  await engine.start({
    spaceId: space.spaceId, pendingKey: '/Brand Assets/logo.svg', path: '/Brand Assets/logo.svg', relPath: 'logo.svg',
    shareId: 'sh1', folderName: 'Brand Assets', catalogKey: 'cat-hex', transferId: space.spaceId + '|sh1|logo.svg',
    contentHash: 'h', size: 5, ownerKey: 'p'.repeat(64), verifyKey: 'sh1|logo.svg', finalPath, destRoot: chosen, layout: LAYOUT.TREE,
  })
  const claimed = () => listDownloadClaimsForShare(space.spaceId, 'Brand Assets').then((claims) => claims.get('/Brand Assets/logo.svg') || null)
  await waitFor(async () => (await claimed()) !== null, 5000, { label: 'the download to settle' })

  const claim = await claimed()
  t.is(claim.destDir, chosen)
  t.is(claim.destDev, fs.statSync(chosen).dev, 'the folder\'s device rides the claim')
  fs.rmSync(chosen, { recursive: true, force: true })
  t.is(verdictForClaim(space.spaceId, '/Brand Assets/logo.svg', claim, 'h').reason, 'local-file-gone', 'a deleted folder on this disk is a deleted copy')
})
