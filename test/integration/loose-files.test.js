import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { createSpace, getDrive } from '../../src/shared/spaces/space.js'
import { advertise, getOwnEntry, ownCatalogKeyHex, dropCatalog } from '../../src/shared/shares/share-catalog.js'
import { getProfileBee } from '../../src/shared/spaces/profile.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import {
  initDownloads, addFile, removeFile, listFiles,
  markOwnedSource, getOwnedSourcePath,
} from '../../src/shared/transfer/files.js'
import { initPendingTransfers } from '../../src/shared/transfer/pending-transfers.js'
import {
  initLooseOverlay, sweepLoosePresence, LOOSE_SHARE_ID, MAX_LOOSE_FILES_PER_SPACE,
} from '../../src/shared/transfer/loose-overlay.js'

// Exercise the files.js integration (addFile/listFiles/removeFile) with the
// in-place flag ON — the production entry points the renderer drives. These are
// the CI-runnable layer for routing the flow test covers end-to-end.
async function setup (t) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true, inPlaceFilesEnabled: true })
  await initDownloads()
  await initPendingTransfers()
  serveIndex.reset()
  await initOverlay()
  initLooseOverlay(ctx.fake.ipc)
  const space = await createSpace('Aurora')
  t.teardown(async () => {
    serveIndex.reset()
    await teardownOverlay()
    setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: false, inPlaceFilesEnabled: false })
  })
  return { ...ctx, spaceId: space.spaceId }
}

function writeSource (ctx, name, contents) {
  const abs = path.join(ctx.tmpDir('src'), name)
  fs.writeFileSync(abs, contents)
  return abs
}

test('addFile (flag on) shares in place — loose-catalog entry, no drive write', async (t) => {
  const ctx = await setup(t)
  const abs = writeSource(ctx, 'a.txt', 'in place')
  await addFile(ctx.spaceId, abs, 'a.txt', 8, ctx.fake.ipc)

  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'a.txt'), 'loose catalog entry created')
  const driveEntry = await getDrive(ctx.spaceId).entry('/a.txt')
  t.absent(driveEntry, 'no drive entry written for the loose file (zero copy)')
})

test('listFiles surfaces own in-place files as inPlace + mine', async (t) => {
  const ctx = await setup(t)
  await addFile(ctx.spaceId, writeSource(ctx, 'a.txt', 'x'), 'a.txt', 1, ctx.fake.ipc)
  const files = await listFiles(ctx.spaceId, [])
  const row = files.find((f) => f.path === '/a.txt')
  t.ok(row, 'in-place file appears in the flat list')
  t.ok(row.inPlace, 'row flagged inPlace')
  t.is(row.status, 'mine', 'own in-place file is mine')
})

test('removeFile routes an own in-place file to unshare (tombstone, no drive del)', async (t) => {
  const ctx = await setup(t)
  await addFile(ctx.spaceId, writeSource(ctx, 'a.txt', 'x'), 'a.txt', 1, ctx.fake.ipc)
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'a.txt'), 'precondition: shared')

  await removeFile(ctx.spaceId, '/a.txt')
  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'a.txt'), 'in-place entry tombstoned via removeFile')
  t.absent(await listFiles(ctx.spaceId, []).then((f) => f.find((x) => x.path === '/a.txt')), 'no longer listed')
})

test('addFile enforces the per-space cap and surfaces LOOSE_FILE_LIMIT', async (t) => {
  const ctx = await setup(t)
  for (let i = 0; i < MAX_LOOSE_FILES_PER_SPACE; i++) {
    await advertise(ctx.spaceId, LOOSE_SHARE_ID, `f${i}.txt`, { size: 1, mtime: i, contentHash: 'h' + i })
  }
  const abs = writeSource(ctx, 'over.txt', 'one too many')
  await t.exception(() => addFile(ctx.spaceId, abs, 'over.txt', 12, ctx.fake.ipc), /Limit of 100/,
    'addFile throws LOOSE_FILE_LIMIT at the cap (propagates to the IPC caller → toast)')
})

// Eager and in-place both write `src:<space>:<path>` owned-source markers. The
// loose sweep must tombstone a gone LOOSE entry but never touch an eager file's marker.
test('sweep tombstones a gone loose file but leaves a non-loose owned-source marker intact', async (t) => {
  const ctx = await setup(t)
  await markOwnedSource(ctx.spaceId, '/eager.txt', '/somewhere/eager.txt')
  const abs = writeSource(ctx, 'loose.txt', 'temp')
  await addFile(ctx.spaceId, abs, 'loose.txt', 4, ctx.fake.ipc)
  fs.unlinkSync(abs)

  await sweepLoosePresence() // confirm-gone-twice: first pass defers
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'loose.txt'), 'first sweep defers (atomic-save guard)')
  await sweepLoosePresence() // second pass tombstones
  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'loose.txt'), 'gone loose entry tombstoned')
  t.is(await getOwnedSourcePath(ctx.spaceId, '/eager.txt'), '/somewhere/eager.txt', 'eager owned-source untouched by the loose sweep')
})

test('same file shared in two spaces tracks both (multi-space reverse map)', async (t) => {
  const ctx = await setup(t)
  const spaceB = await createSpace('Borealis')
  const abs = writeSource(ctx, 'shared.txt', 'one file, two spaces')

  await addFile(ctx.spaceId, abs, 'shared.txt', 20, ctx.fake.ipc)
  await addFile(spaceB.spaceId, abs, 'shared.txt', 20, ctx.fake.ipc)

  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'shared.txt'), 'shared in space A')
  t.ok(await getOwnEntry(spaceB.spaceId, LOOSE_SHARE_ID, 'shared.txt'), 'shared in space B')

  // Unsharing in A must NOT remove B's entry (independent per-space tracking).
  await removeFile(ctx.spaceId, '/shared.txt')
  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'shared.txt'), 'A unshared')
  t.ok(await getOwnEntry(spaceB.spaceId, LOOSE_SHARE_ID, 'shared.txt'), 'B still shared after A unshared')
})

// FIX-2a: createSpace must publish the canonical (suffixed) loose-catalog key. The
// bug published a suffix-less key (getSpace null before the record was saved); the
// in-memory catalog cache masked it in-session, so the test drops the cache (a
// restart) and asserts the published key still resolves to the catalog the owner
// advertises into.
test('createSpace publishes the canonical (suffixed) loose-catalog key', async (t) => {
  const ctx = await setup(t) // setup() creates the space with the in-place flag ON
  const published = (await getProfileBee().get('loosecat/' + ctx.spaceId))?.value
  t.ok(published, 'a loose-catalog key was published at createSpace')

  dropCatalog(ctx.spaceId) // clear the ownCatalogs cache → re-derive from the saved record (simulates a restart)
  const canonical = await ownCatalogKeyHex(ctx.spaceId)
  t.is(published, canonical, 'published key matches the canonical (suffixed) catalog core')
})
