import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'
import { freshPeer, freshDurable } from '../helpers/store.js'
import { setupOwnedShare } from '../helpers/owned.js'
import { createSpace, getSpace, getSpaceContentKey, upsertMember } from '../../src/shared/spaces/space.js'
import { getStore } from '../../src/shared/core/store.js'
import { reclaimLegacyPeerCaches } from '../../src/shared/storage/legacy-peer-cache.js'
import { getOwnEntry } from '../../src/shared/shares/share-catalog.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { onFsEvent, periodicReconcile } from '../../src/shared/folders/owned-folders.js'
import { overlayHashFile } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'
import { getOverlay, initOverlay, teardownOverlay, getJournalDir } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { journalNameFor } from '../../src/shared/transfer/backends/overlay/vendor/transfer.js'
import { PARTIAL_SUFFIX } from '../../src/shared/transfer/partial-suffix.js'
import { cleanupOrphanedPartials } from '../../src/shared/transfer/partial-sweep.js'
import { DEFAULT_IGNORE, shouldIgnore } from '../../src/shared/folders/path-keys.js'
import { initDownloads, addFile, removeFile } from '../../src/shared/transfer/files.js'
import { initPendingTransfers } from '../../src/shared/transfer/pending-transfers.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { initLooseOverlay, looseHasOwn, looseSources } from '../../src/shared/transfer/loose-overlay.js'

// C2 — periodicReconcile dropped its { deep } arg, so the scheduled deep pass ran shallow and
// re-hashed + re-advertised identical content whose mtime merely drifted (churn → mirror
// peers refetch). The deep path re-points via registerFile instead (no prepareForServe).
test('REGRESSION (C2): periodicReconcile forwards { deep } — mtime-drifted identical content is re-pointed, not re-hashed', async (t) => {
  const ctx = await setupOwnedShare(t)
  const abs = path.join(ctx.mountPath, 'doc.txt')
  fs.writeFileSync(abs, 'stable-content')
  await onFsEvent(ctx.spaceId, ctx.share.id, 'add', 'doc.txt', abs)
  const entryA = await getOwnEntry(ctx.spaceId, ctx.share.id, 'doc.txt')

  // Count re-hashes: prepareForServe rebuilds the chunk map. A deep reconcile of an
  // mtime-drifted-but-identical file must NOT re-hash; a shallow one would.
  const overlay = getOverlay()
  const origPrepare = overlay.prepareForServe.bind(overlay)
  let prepareCalls = 0
  overlay.prepareForServe = async (...a) => { prepareCalls++; return origPrepare(...a) }
  t.teardown(() => { overlay.prepareForServe = origPrepare })

  // Drift the mtime without changing content (a copy/backup tool touched it).
  const future = new Date(Date.now() + 60_000)
  fs.utimesSync(abs, future, future)

  await periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [], { deep: true })

  const entryB = await getOwnEntry(ctx.spaceId, ctx.share.id, 'doc.txt')
  t.is(prepareCalls, 0, 'deep reconcile re-pointed identical content without re-hashing (no churn)')
  t.is(entryB.contentHash, entryA.contentHash, 'content hash preserved across the reconcile')
})

// C5a — the ignore glob must track the live partial suffix, or a stale mirror partial in an
// owned-share mount is published to peers as a real file.
test('REGRESSION (C5): DEFAULT_IGNORE excludes .mirall.part so a stale mirror partial is never published', (t) => {
  t.ok(shouldIgnore('file.mirall.part', DEFAULT_IGNORE), 'overlay partial suffix is ignored')
  t.ok(shouldIgnore('sub/deep.bin.mirall.part', DEFAULT_IGNORE), 'a nested overlay partial is ignored')
  t.absent(shouldIgnore('file.txt', DEFAULT_IGNORE), 'a real file is not ignored')
})

// C5b — the boot sweep only covered the Downloads dir; a mirror writes partials into the mount
// dir (nested), so crash-orphans leaked there. The sweep must cover mount dirs recursively while
// keeping any partial a paused/in-flight transfer can still resume from (its journal survives).
test('REGRESSION (C5): boot sweep reclaims orphaned .mirall.part in a foreign mount dir but keeps a resumable one', async (t) => {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true })
  await initOverlay()
  await initPendingTransfers()
  t.teardown(async () => { await teardownOverlay(); setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: false }) })

  const downloadsDir = ctx.tmpDir('dl')
  const mountDir = ctx.tmpDir('mount')
  fs.mkdirSync(path.join(mountDir, 'sub'), { recursive: true })

  // Orphan (no pending row, no resume journal), nested — must be swept.
  const orphan = path.join(mountDir, 'sub', 'a.bin' + PARTIAL_SUFFIX)
  fs.writeFileSync(orphan, 'x')
  // Resumable — a live journal references its target; must be kept.
  const keepTarget = path.join(mountDir, 'b.bin')
  const keep = keepTarget + PARTIAL_SUFFIX
  fs.writeFileSync(keep, 'y')
  const journalDir = getJournalDir()
  fs.mkdirSync(journalDir, { recursive: true })
  fs.writeFileSync(path.join(journalDir, journalNameFor(keepTarget)), 'journal-state')

  await cleanupOrphanedPartials(downloadsDir, [mountDir])

  t.absent(fs.existsSync(orphan), 'nested orphaned partial in the mount dir was swept')
  t.ok(fs.existsSync(keep), 'a partial with a live resume journal was kept')
})

// C6 — addFile always publishes loose (overlay is the only path), but removeFile still gated the
// unshare on the inPlaceFiles flag, so with the flag off a file could be added but never unshared.
test('REGRESSION (C6): removeFile unshares a loose file even when the inPlaceFiles flag is off', async (t) => {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true, inPlaceFilesEnabled: true })
  await initDownloads()
  await initPendingTransfers()
  const space = await createSpace('Aurora')
  serveIndex.reset()
  looseSources.clear()
  await initOverlay()
  initLooseOverlay(ctx.fake.ipc)
  t.teardown(async () => { serveIndex.reset(); await teardownOverlay()
    setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: false, inPlaceFilesEnabled: false })
  })

  const src = path.join(ctx.tmpDir('src'), 'note.txt')
  fs.writeFileSync(src, 'hello')
  await addFile(space.spaceId, src, 'note.txt')
  t.ok(await looseHasOwn(space.spaceId, '/note.txt'), 'file is shared loose after addFile')

  // Flag off (a degraded / version-skew config): removeFile must still unshare.
  setRuntimeConfig({ ...getRuntimeConfig(), inPlaceFilesEnabled: false })
  await removeFile(space.spaceId, '/note.txt')
  t.absent(await looseHasOwn(space.spaceId, '/note.txt'), 'file was unshared despite the flag being off')
})

// C7 — the retired eager path cached peer downloads in per-member driveKey blob cores. Overlay
// never clears/surfaces them (storage:info reports contentBytes:0, reclaim UI removed), so on
// upgrade the bytes strand on disk. A one-shot flag-guarded migration must reclaim them.
test('REGRESSION (C7): boot migration reclaims a stranded legacy peer-drive cache (idempotently)', async (t) => {
  await freshDurable(t)   // boot() runs this very migration; the test drives it itself
  const space = await createSpace('Cached')
  const sck = getSpaceContentKey(space.spaceId, await getSpace(space.spaceId))

  // Simulate a legacy eager peer-download cache: a peer drive in our store with a cached block.
  const peerDrive = new Hyperdrive(getStore(), null, sck ? { encryptionKey: sck } : {})
  await peerDrive.ready()
  await peerDrive.put('/cached.bin', b4a.alloc(4096, 7))
  const driveKey = b4a.toString(peerDrive.key, 'hex')
  await upsertMember(space.spaceId, { publicKey: 'ab'.repeat(32), driveKey, displayName: 'Peer' })
  t.ok(await peerDrive.has('/cached.bin'), 'peer cache block present before migration')
  // Release the seed sessions so the migration can open the same drive by key (in production the
  // peer drive isn't otherwise open — the peer-drive registry was removed with the eager path).
  await peerDrive.getBlobs()
  try { await peerDrive.blobs?.core.close() } catch {}
  try { await peerDrive.db?.close() } catch {}

  const res = await reclaimLegacyPeerCaches()
  t.is(res.cleared, 1, 'one legacy peer cache reclaimed')

  const check = new Hyperdrive(getStore(), b4a.from(driveKey, 'hex'), sck ? { encryptionKey: sck } : {})
  await check.ready()
  t.absent(await check.has('/cached.bin'), 'cached block cleared by the migration')
  try { await check.blobs?.core.close() } catch {}
  try { await check.db?.close() } catch {}

  t.alike(await reclaimLegacyPeerCaches(), { skipped: true }, 'idempotent — flag-guarded, skips on re-run')
})
