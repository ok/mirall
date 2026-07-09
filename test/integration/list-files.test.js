import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { createSpace, getDrive } from '../../src/shared/spaces/space.js'
import { initDownloads, addFile, listFiles } from '../../src/shared/transfer/files.js'
import { initPendingTransfers } from '../../src/shared/transfer/pending-transfers.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { getStore, createBee } from '../../src/shared/core/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initContentBackendOverlay } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'

// listFiles is the source of truth for the space's loose-file list and each
// file's status. The single-peer-observable guarantees: own files show as
// 'mine' (owner "You"), and files that belong to an owned FOLDER share are
// excluded from the loose list (they're shown in the folder view instead — if
// the exclusion broke, owned-folder contents would be double-listed as loose
// files). Cross-peer hash-dedup / status-priority is a flow concern.
async function setup (t) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true })
  await initOverlay()
  initContentBackendOverlay(ctx.fake.ipc)
  t.teardown(async () => { await teardownOverlay() })
  await initDownloads()
  await initPendingTransfers()
  const space = await createSpace('Aurora')
  return { ...ctx, spaceId: space.spaceId, drive: getDrive(space.spaceId) }
}

test('own loose files are listed as "mine" (owner You)', async (t) => {
  const ctx = await setup(t)
  const src = path.join(ctx.tmpDir('src'), 'loose.txt')
  fs.writeFileSync(src, 'loose content')
  await addFile(ctx.spaceId, src, 'loose.txt', 13, null)

  const files = await listFiles(ctx.spaceId, [])
  const loose = files.find((f) => f.path === '/loose.txt')
  t.ok(loose, 'loose file is listed')
  t.is(loose.status, 'mine', 'status is mine')
  t.is(loose.owner.displayName, 'You', 'owner shown as You')
})

test('files inside an owned-folder share are excluded from the loose list', async (t) => {
  const ctx = await setup(t)
  // a loose file at the root
  const src = path.join(ctx.tmpDir('src'), 'loose.txt')
  fs.writeFileSync(src, 'at root')
  await addFile(ctx.spaceId, src, 'loose.txt', 7, null)
  // an owned folder share + a file living under its prefix on the drive
  await publishShare(ctx.spaceId, {
    id: generateShareId(), type: 'owned-folder', name: 'MyFolder', owner: getLocalPublicKeyHex(), createdAt: Date.now(),
  })
  await ctx.drive.put('/MyFolder/inside.txt', b4a.from('belongs to the folder'), { metadata: { hash: 'h-inside' } })

  const paths = (await listFiles(ctx.spaceId, [])).map((f) => f.path)
  t.ok(paths.includes('/loose.txt'), 'the loose file is listed')
  t.absent(paths.includes('/MyFolder/inside.txt'), 'a file inside an owned share is NOT a loose file')
})

test('distinct loose files are each listed', async (t) => {
  const ctx = await setup(t)
  const dir = ctx.tmpDir('src')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha')
  fs.writeFileSync(path.join(dir, 'b.txt'), 'bravo')
  await addFile(ctx.spaceId, path.join(dir, 'a.txt'), 'a.txt', 5, null)
  await addFile(ctx.spaceId, path.join(dir, 'b.txt'), 'b.txt', 5, null)

  const paths = (await listFiles(ctx.spaceId, [])).map((f) => f.path).sort()
  t.alike(paths, ['/a.txt', '/b.txt'], 'both distinct files listed')
})

// REGRESSION (FIX-127: files:list froze ~8s per un-replicated member). readSharePrefixes read
// each member's profile bee SERIALLY under the 8s peerReadTimeoutMs, so a peer that handshook
// with members whose share records hadn't replicated saw files:list block N × 8s with an empty
// file view (the Windows-joins-last symptom). The reads now run in PARALLEL under the short
// interactiveReadTimeoutMs, so local files surface immediately and the list self-heals via
// event:files-updated once a peer's bee lands.
test('REGRESSION (FIX-127): files:list bounds un-replicated members by the short interactive budget, in parallel', { timeout: 15000 }, async (t) => {
  const ctx = await setup(t)
  // The short interactive budget governs the list; peerReadTimeoutMs pinned high so a revert to
  // it (or to serial reads) blows the timing assertion below.
  setRuntimeConfig({ ...getRuntimeConfig(), peerReadTimeoutMs: 30000, interactiveReadTimeoutMs: 500 })

  // Own file must surface immediately regardless of the stalled peers.
  const src = path.join(ctx.tmpDir('src'), 'mine.txt')
  fs.writeFileSync(src, 'mine')
  await addFile(ctx.spaceId, src, 'mine.txt', 4, null)

  // Three ghost members: profile bees that advertise a share but never replicate it (length known,
  // blocks cleared, no serving peer), so each prefix read parks until the budget fires.
  const ghosts = []
  for (let i = 0; i < 3; i++) {
    const ghost = createBee('ghost-' + i)
    await ghost.ready()
    await ghost.put('caps/folder-shares', true)
    await ghost.put('share/' + ctx.spaceId + '/s' + i, { id: 's' + i, name: 'G' + i, owner: 'ghost', createdAt: Date.now() })
    const key = b4a.toString(ghost.core.key, 'hex')
    const len = ghost.core.length
    await ghost.close()
    const core = getStore().get(b4a.from(key, 'hex'))
    await core.ready()
    await core.clear(0, len)
    ghosts.push({ publicKey: key, driveKey: null, displayName: 'G' + i })
  }

  const t0 = Date.now()
  const files = await listFiles(ctx.spaceId, ghosts)
  const dt = Date.now() - t0

  // Parallel under the 500ms budget ≈ 500ms; serial would be 3 × 500 = 1500ms; the peer budget
  // (if it leaked back in) would be 30s. < 1200ms proves BOTH: the short budget AND parallel reads.
  t.ok(dt < 1200, 'bounded + parallel (' + dt + 'ms), not serial 3× or the 30s peer budget')
  t.ok(files.some((f) => f.path === '/mine.txt'), 'own file surfaces immediately despite stalled peers')
})
