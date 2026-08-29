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
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'
import { takeIncompleteListSpaces } from '../../src/shared/transfer/list-deficits.js'

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

// A member whose loose catalog we replicated once (length known) but whose blocks are gone and
// whom nobody serves — an owner that went offline before we read its rows. createBee gives a
// writable core; clearing its blocks reproduces "length known, data missing", and the member
// carries the catalog key, so collectLooseInPlace admits it and the read really happens.
async function ghostCatalogMember (i) {
  const ghost = createBee('ghost-catalog-' + i)
  await ghost.ready()
  await ghost.put('file/' + LOOSE_SHARE_ID + '/g' + i + '.bin', { size: 10, mtime: 1, contentHash: 'g'.repeat(63) + i })
  const key = b4a.toString(ghost.core.key, 'hex')
  const len = ghost.core.length
  await ghost.close()
  const core = getStore().get(b4a.from(key, 'hex'))
  await core.ready()
  await core.clear(0, len)
  return { publicKey: 'ghost' + i + 'pub', driveKey: null, displayName: 'G' + i, looseCatalogKey: key }
}

// REGRESSION (FIX-127: files:list froze ~8s per un-replicated member) — the members are read
// under the short interactiveReadTimeoutMs, in PARALLEL, so local files surface immediately and
// the list self-heals via event:files-updated once a peer's catalog lands. The fixture carries a
// looseCatalogKey because collectLooseInPlace filters members without one BEFORE any read: a
// keyless ghost is never read, which made the original version of this test vacuous.
test('REGRESSION (FIX-127): files:list bounds un-replicated members by the short interactive budget, in parallel', { timeout: 15000 }, async (t) => {
  const ctx = await setup(t)
  // The short interactive budget governs the list; peerReadTimeoutMs pinned high so a revert to
  // it (or to serial reads) blows the timing assertion below.
  setRuntimeConfig({ ...getRuntimeConfig(), peerReadTimeoutMs: 30000, interactiveReadTimeoutMs: 500 })

  // Own file must surface immediately regardless of the stalled peers.
  const src = path.join(ctx.tmpDir('src'), 'mine.txt')
  fs.writeFileSync(src, 'mine')
  await addFile(ctx.spaceId, src, 'mine.txt', 4, null)

  const ghosts = []
  for (let i = 0; i < 3; i++) ghosts.push(await ghostCatalogMember(i))

  const t0 = Date.now()
  const files = await listFiles(ctx.spaceId, ghosts)
  const dt = Date.now() - t0

  t.ok(takeIncompleteListSpaces().includes(ctx.spaceId), 'the ghosts were actually read (and stalled) — not filtered out')
  // Parallel under the 500ms budget ≈ 500ms; serial would be 3 × 500 = 1500ms; the peer budget
  // (if it leaked back in) would be 30s. < 1200ms proves BOTH: the short budget AND parallel reads.
  t.ok(dt < 1200, 'bounded + parallel (' + dt + 'ms), not serial 3× or the 30s peer budget')
  t.ok(files.some((f) => f.path === '/mine.txt'), 'own file surfaces immediately despite stalled peers')
})

// REGRESSION (FIX-LIST-DEADLINE: files:list awaited each member's catalog SERIALLY, so every
// unreachable member added a full interactive budget — six offline owners were six budgets, and
// at the production 1.5 s budget ten of them crossed the renderer's 30 s IPC timeout. The reads
// now fan out at once, like share:list, so the listing costs ≈ one budget however many members
// are unreachable; the rows we can read still surface and the space is flagged for the
// convergence re-poke.)
test('REGRESSION (FIX-LIST-DEADLINE): six unreachable members cost one budget, not six', { timeout: 20000 }, async (t) => {
  const ctx = await setup(t)
  const BUDGET = 300
  setRuntimeConfig({ ...getRuntimeConfig(), peerReadTimeoutMs: 30000, interactiveReadTimeoutMs: BUDGET })

  const src = path.join(ctx.tmpDir('src'), 'mine.txt')
  fs.writeFileSync(src, 'mine')
  await addFile(ctx.spaceId, src, 'mine.txt', 4, null)

  const ghosts = []
  for (let i = 0; i < 6; i++) ghosts.push(await ghostCatalogMember(10 + i))

  const t0 = Date.now()
  const files = await listFiles(ctx.spaceId, ghosts)
  const dt = Date.now() - t0

  t.ok(takeIncompleteListSpaces().includes(ctx.spaceId), 'every ghost was read and stalled')
  // Serial: 6 × 300 = 1800 ms. Parallel: ≈ 300 ms. The bound leaves room for a slow CI box while
  // staying far below two budgets, so a revert to serial (or a second budget per peer) fails.
  t.ok(dt < 2 * BUDGET, 'six stalled members cost about one budget (' + dt + 'ms)')
  t.ok(files.some((f) => f.path === '/mine.txt'), 'own file listed despite six stalled peers')
  t.is(files.filter((f) => f.path.startsWith('/g')).length, 0, 'no rows for catalogs whose blocks never arrived')
})
