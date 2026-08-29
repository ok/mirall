import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { advertise, getOwnEntry, ownCatalogKeyHex } from '../../src/shared/shares/share-catalog.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { setSpaceDownloadRoot } from '../../src/shared/core/paths.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { getOverlay, initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayHashFile } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'
import { initDownloads, markDownloaded, markVerified, isVerifiedDownload, listFiles, getOwnedSourcePath } from '../../src/shared/transfer/files.js'
import { initPendingTransfers, recordPending, getPendingFor } from '../../src/shared/transfer/pending-transfers.js'
import {
  initLooseOverlay, looseShareFile, looseUnshareFile, looseListOwn, looseCancel, looseCancelPublish,
  handleLooseFsEvent, rehydrateLooseFiles, sweepLoosePresence,
  LOOSE_SHARE_ID, MAX_LOOSE_FILES_PER_SPACE, looseSources,
} from '../../src/shared/transfer/loose-overlay.js'

// Drive the in-place loose-file adapter against one fresh data layer. The defining
// property: sharing a loose file copies NO bytes into a core — the overlay serves
// straight from the user's source file on disk, addressed by content hash.
async function setup (t) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true, inPlaceFilesEnabled: true })
  await initDownloads()
  await initPendingTransfers()
  const space = await createSpace('Aurora')
  serveIndex.reset()
  looseSources.clear()
  await initOverlay()
  initLooseOverlay(ctx.fake.ipc)
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

test('looseShareFile advertises a hash and serves straight from the source (zero copy)', async (t) => {
  const ctx = await setup(t)
  const abs = writeSource(ctx, 'photo.jpg', 'in place bytes')

  await looseShareFile(ctx.spaceId, abs, 'photo.jpg')

  const entry = await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'photo.jpg')
  t.ok(entry?.contentHash, 'loose catalog entry carries a content hash')
  t.ok(serveIndex.has(entry.contentHash), 'hash registered in the serve index')
  t.alike([...serveIndex.spacesFor(entry.contentHash)], [ctx.spaceId])

  const got = await getOverlay().fetchFile(entry.contentHash, {})
  t.ok(got?.local, 'servable locally')
  t.is(got.destPath, abs, 'serves straight from the source file — no second copy')
  t.is(fs.readFileSync(got.destPath).toString(), 'in place bytes', 'bytes match the source')
})

test('looseShareFile emits publish decoration carrying an eta field, then a terminal done', async (t) => {
  const ctx = await setup(t)
  const abs = writeSource(ctx, 'big.bin', 'x'.repeat(64 * 1024))

  await looseShareFile(ctx.spaceId, abs, 'big.bin')

  const deco = ctx.fake.emitted('event:decoration').filter((e) => e.payload.key === '/big.bin')
  const progress = deco.filter((e) => e.payload.phase === 'publishing')
  t.ok(progress.length > 0, 'at least one publish decoration emitted on the transfer channel')
  t.ok(progress.every((e) => e.payload.channel === 'transfer'), 'publish progress rides the transfer decoration channel')
  t.ok(progress.every((e) => 'eta' in e.payload && (e.payload.eta === null || typeof e.payload.eta === 'number')), 'every publish decoration carries an eta field (null while estimating)')
  t.ok(deco.some((e) => e.payload.done === true), 'a terminal done frame clears the bar')
})

test('looseUnshareFile tombstones and drops the serve claim', async (t) => {
  const ctx = await setup(t)
  const abs = writeSource(ctx, 'a.txt', 'data')
  await looseShareFile(ctx.spaceId, abs, 'a.txt')
  const entry = await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'a.txt')
  t.ok(serveIndex.has(entry.contentHash))

  await looseUnshareFile(ctx.spaceId, '/a.txt')
  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'a.txt'), 'catalog entry tombstoned')
  t.absent(serveIndex.has(entry.contentHash), 'serve-index claim dropped')
  t.absent(looseSources.has(abs), 'reverse map cleared')
})

test('re-sharing a changed source advertises a new content hash', async (t) => {
  const ctx = await setup(t)
  const abs = writeSource(ctx, 'a.txt', 'v1')
  await looseShareFile(ctx.spaceId, abs, 'a.txt')
  const h1 = (await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'a.txt')).contentHash

  fs.writeFileSync(abs, 'v2 is longer')
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(abs, future, future)
  await looseShareFile(ctx.spaceId, abs, 'a.txt')

  const h2 = (await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'a.txt')).contentHash
  t.not(h1, h2, 'a new content hash is advertised after the edit')
  t.ok(serveIndex.has(h2), 'new hash servable')
})

test('R8: caps loose files at 100 per space; the 101st is rejected', async (t) => {
  const ctx = await setup(t)
  // One real shared file (tracked), then pad to exactly the cap with catalog stubs.
  const tracked = writeSource(ctx, 'kept.txt', 'real')
  await looseShareFile(ctx.spaceId, tracked, 'kept.txt')
  for (let i = 0; i < MAX_LOOSE_FILES_PER_SPACE - 1; i++) {
    await advertise(ctx.spaceId, LOOSE_SHARE_ID, `f${i}.txt`, { size: 1, mtime: i, contentHash: 'h' + i })
  }
  t.is((await looseListOwn(ctx.spaceId)).length, MAX_LOOSE_FILES_PER_SPACE, 'precondition: at the cap')

  // A genuinely new file at the cap is rejected (the check is now inside the per-space lock).
  const over = writeSource(ctx, 'over.txt', 'one too many')
  await t.exception(() => looseShareFile(ctx.spaceId, over, 'over.txt'), /Limit of 100/)

  // Re-sharing the already-tracked file (an update) is allowed at the cap.
  await t.execution(looseShareFile(ctx.spaceId, tracked, 'kept.txt'), 'update at cap does not throw')
})

test('R9: two different sources sharing a basename are suffixed, never overwritten', async (t) => {
  const ctx = await setup(t)
  const a = writeSource(ctx, 'photo.jpg', 'first')
  const b = writeSource(ctx, 'photo.jpg', 'second')

  await looseShareFile(ctx.spaceId, a, 'photo.jpg')
  await looseShareFile(ctx.spaceId, b, 'photo.jpg')

  const names = (await looseListOwn(ctx.spaceId)).map((e) => e.relPath).sort()
  t.alike(names, ['photo (1).jpg', 'photo.jpg'], 'second source got suffixed; first kept its name')

  await looseShareFile(ctx.spaceId, a, 'photo.jpg')
  t.is((await looseListOwn(ctx.spaceId)).length, 2, 'same-source re-share adds no new entry')
})

test('R5: rehydrate re-registers own loose files from the catalog after a restart', async (t) => {
  const ctx = await setup(t)
  const abs = writeSource(ctx, 'a.txt', 'persist me')
  await looseShareFile(ctx.spaceId, abs, 'a.txt')
  const hash = (await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'a.txt')).contentHash

  // Simulate a worker restart: fresh overlay instance + cleared in-memory maps.
  await teardownOverlay()
  serveIndex.reset()
  looseSources.clear()
  await initOverlay()
  t.absent(serveIndex.has(hash), 'precondition: serve maps cleared')

  await rehydrateLooseFiles()
  t.ok(serveIndex.has(hash), 'rehydrated: hash servable again')
  t.ok(looseSources.has(abs), 'reverse map repopulated')
  const got = await getOverlay().fetchFile(hash, {})
  t.is(got.destPath, abs, 'served from the source path after rehydrate')
})

test('REGRESSION (FIX-1b: rehydrate isolation): one file that throws does not abort re-registration of the rest', async (t) => {
  const ctx = await setup(t)
  // 'a.txt' sorts first in the catalog, so it is rehydrated before 'b.txt'.
  const a = writeSource(ctx, 'a.txt', 'AAA')
  const b = writeSource(ctx, 'b.txt', 'BBB')
  await looseShareFile(ctx.spaceId, a, 'a.txt')
  await looseShareFile(ctx.spaceId, b, 'b.txt')
  const hashB = (await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'b.txt')).contentHash

  // Simulate a restart, then make a.txt's re-registration throw (a non-vanish IO/perms-class
  // error). Pre-fix the throw escapes the rehydrate loop and b.txt is never re-registered.
  await teardownOverlay()
  serveIndex.reset()
  looseSources.clear()
  await initOverlay()
  const overlay = getOverlay()
  const realRF = overlay.registerFile.bind(overlay)
  overlay.registerFile = async (op, dp, meta) => {
    if (dp.endsWith('a.txt')) throw new Error('boom: a.txt unreadable')
    return realRF(op, dp, meta)
  }
  t.teardown(() => { overlay.registerFile = realRF })

  await rehydrateLooseFiles()
  t.ok(serveIndex.has(hashB), 'b.txt re-registered despite a.txt throwing earlier in the loop')
})

test('R6: sweep tombstones a loose entry whose source vanished', async (t) => {
  const ctx = await setup(t)
  const abs = writeSource(ctx, 'gone.txt', 'temporary')
  await looseShareFile(ctx.spaceId, abs, 'gone.txt')
  const hash = (await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'gone.txt')).contentHash

  fs.unlinkSync(abs)
  await sweepLoosePresence() // confirm-gone-twice: first pass defers (atomic-save guard)
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'gone.txt'), 'first sweep defers')
  await sweepLoosePresence() // second pass tombstones

  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'gone.txt'), 'source gone → entry tombstoned')
  t.absent(serveIndex.has(hash), 'serve-index claim dropped')
})

test('looseCancel discards a paused/queued partial: removes the partial file and the pending row', async (t) => {
  const ctx = await setup(t)
  // A paused/queued loose download = a pending row + a visible partial on disk, no
  // live transfer. Discard must clear both and emit the decoration done frame.
  const finalPath = path.join(ctx.tmpDir('dl'), 'big.bin')
  const partialPath = finalPath + '.mirall.part'
  fs.writeFileSync(partialPath, 'half a download')
  await recordPending(ctx.spaceId, '/big.bin', { total: 100, shareId: LOOSE_SHARE_ID, relPath: 'big.bin', inPlace: true, finalPath, ownerKey: 'peerkey' })
  t.ok(await getPendingFor(ctx.spaceId, '/big.bin'), 'precondition: pending row exists')
  t.ok(fs.existsSync(partialPath), 'precondition: partial on disk')

  await looseCancel(ctx.spaceId, '/big.bin')

  t.absent(await getPendingFor(ctx.spaceId, '/big.bin'), 'pending row cleared')
  t.absent(fs.existsSync(partialPath), 'visible partial removed')
  const done = ctx.fake.emitted('event:decoration').filter((e) => e.payload.done === true)
  t.ok(done.length > 0, 'decoration done frame emitted')
  t.is(done[done.length - 1].payload.spaceId, ctx.spaceId, 'decoration frame carries spaceId (FIX-EDA-12 contract)')
})

test('Item 1: isVerifiedDownload matches only when a verified record equals the hash', async (t) => {
  const ctx = await setup(t)
  t.is(await isVerifiedDownload(ctx.spaceId, '__loose__|a.txt', 'hhh'), false, 'no record → false')
  await markVerified(ctx.spaceId, '__loose__|a.txt', 'hhh')
  t.is(await isVerifiedDownload(ctx.spaceId, '__loose__|a.txt', 'hhh'), true, 'record matches → true')
  t.is(await isVerifiedDownload(ctx.spaceId, '__loose__|a.txt', 'other'), false, 'hash mismatch → false')
  t.is(await isVerifiedDownload(ctx.spaceId, '__loose__|a.txt', null), false, 'null hash → false')
})

// Owner in space A; consumer-context is space B (no own loose entry there → no
// own/peer dedupe collision). A verified, on-disk download surfaces verified:true.
test('Item 1: a downloaded+verified peer loose file surfaces verified:true (false otherwise)', async (t) => {
  const ctx = await setup(t)
  const abs = writeSource(ctx, 'v.bin', 'x'.repeat(2048))
  await looseShareFile(ctx.spaceId, abs, 'v.bin')
  const entry = await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'v.bin')
  const member = { publicKey: 'peerpub', displayName: 'Peer', driveKey: 'dk', looseCatalogKey: await ownCatalogKeyHex(ctx.spaceId) }

  const spaceB = await createSpace('Borealis')
  const dir = ctx.tmpDir('dl')
  setSpaceDownloadRoot(spaceB.spaceId, dir)
  const landed = path.join(dir, 'v.bin')
  fs.writeFileSync(landed, fs.readFileSync(abs))
  await markDownloaded(spaceB.spaceId, '/v.bin', landed, { hash: entry.contentHash })

  let row = (await listFiles(spaceB.spaceId, [member])).find((f) => f.path === '/v.bin')
  t.is(row?.status, 'downloaded', 'present on device')
  t.is(row.verified, false, 'no verified record → verified:false')

  await markVerified(spaceB.spaceId, LOOSE_SHARE_ID + '|v.bin', entry.contentHash)
  row = (await listFiles(spaceB.spaceId, [member])).find((f) => f.path === '/v.bin')
  t.is(row.verified, true, 'verified record matches the content hash → verified:true')
})

// Item 2B: a peer loose entry still being hashed (contentHash:null) is now listed as
// 'preparing' (parity with folder shares) instead of being hidden until the hash lands.
// A: a still-hashing OWN loose file must be listed (as 'publishing'), not hidden, so
// it survives a navigate-away/remount (the peer loop already does this; the own loop
// previously skipped no-contentHash entries).
// B: cancelling a loose publish mid-hash undoes the half-advertised (contentHash:null)
// entry and leaves no source marker — the Stop button on an indexing file works.
test('B: cancelling a loose publish mid-hash removes the half-advertised entry', async (t) => {
  const ctx = await setup(t)
  const overlay = getOverlay()
  const realPrepare = overlay.prepareForServe.bind(overlay)
  // Stub the long hash so it only settles once the publish is aborted.
  overlay.prepareForServe = (_disk, opts) => new Promise((_res, rej) => {
    const i = setInterval(() => { if (opts.signal?.aborted) { clearInterval(i); const e = new Error('aborted'); e.code = 'ECANCELLED'; rej(e) } }, 5)
  })
  t.teardown(() => { overlay.prepareForServe = realPrepare })

  const abs = writeSource(ctx, 'huge.bin', 'x'.repeat(2048))
  const pub = looseShareFile(ctx.spaceId, abs, 'huge.bin') // advertises contentHash:null, registers, then awaits the stub
  await new Promise((r) => setTimeout(r, 30))
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'huge.bin'), 'precondition: advertised (publishing)')

  looseCancelPublish(ctx.spaceId, '/huge.bin')
  await pub // resolves — a cancel is swallowed, not an error

  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'huge.bin'), 'half-advertised entry tombstoned on cancel')
  t.absent(await getOwnedSourcePath(ctx.spaceId, '/huge.bin'), 'no owned-source marker left behind')
  t.absent(looseSources.has(abs), 'reverse map clean')
})

test('REGRESSION (FIX-2: a non-cancel publish failure reverts the half-advertised entry)', async (t) => {
  const ctx = await setup(t)
  const overlay = getOverlay()
  const realPrepare = overlay.prepareForServe.bind(overlay)
  // Mimic the production failure: after the file was advertised contentHash:null, the
  // chunk-map persist threw BAD_ARGUMENT (a real error, not a cancel). Before FIX-2 the
  // catch reverted only on cancel, so this left a stuck "adding" entry in the catalog.
  overlay.prepareForServe = async () => {
    const e = new Error('Appended block exceeds the maximum suggested block size')
    e.code = 'BAD_ARGUMENT'
    throw e
  }
  t.teardown(() => { overlay.prepareForServe = realPrepare })

  const abs = writeSource(ctx, 'huge.bin', 'x'.repeat(2048))
  await t.exception(looseShareFile(ctx.spaceId, abs, 'huge.bin'), /maximum suggested block size/, 'the publish error propagates to the caller')

  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'huge.bin'), 'half-advertised entry reverted on failure — no stuck "adding"')
  t.absent(await getOwnedSourcePath(ctx.spaceId, '/huge.bin'), 'no owned-source marker left behind')
  t.absent(looseSources.has(abs), 'reverse map clean')
})

test('REGRESSION (FIX-2: a failure AFTER a successful publish does NOT revert the live entry)', async (t) => {
  // Guards the FIX-2 revert against over-reach: once publishContent has materialized the
  // real hash and made the file servable, a later throw (e.g. markOwnedSource / the final
  // emit) must NOT tombstone or downgrade the healthy entry. Inject by failing the SECOND
  // files-updated emit — the first fires on advertise (still publishing), the second fires
  // only after the publish has fully succeeded.
  const ctx = await setup(t)
  const abs = writeSource(ctx, 'ok.bin', 'x'.repeat(2048))

  let updates = 0
  const realEmit = ctx.fake.ipc.emit
  ctx.fake.ipc.emit = (type, payload) => {
    if (type === 'event:files-updated' && ++updates === 2) throw new Error('post-publish boom')
    return realEmit(type, payload)
  }
  t.teardown(() => { ctx.fake.ipc.emit = realEmit })

  await t.exception(looseShareFile(ctx.spaceId, abs, 'ok.bin'), /post-publish boom/, 'the post-publish error still propagates')

  const entry = await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'ok.bin')
  t.ok(entry?.contentHash, 'the successfully-published entry is NOT reverted by a post-publish failure')
  t.ok(serveIndex.has(entry.contentHash), 'and it stays servable')
})

test('A: a still-hashing own loose file is listed as publishing, then flips to mine', async (t) => {
  const ctx = await setup(t)
  await advertise(ctx.spaceId, LOOSE_SHARE_ID, 'big.bin', { size: 4096, mtime: 1, contentHash: null })
  let row = (await listFiles(ctx.spaceId, [])).find((f) => f.path === '/big.bin')
  t.ok(row, 'still-indexing own file is listed (server-truth, survives remount)')
  t.is(row.status, 'publishing')
  t.ok(row.inPlace, 'flagged in-place')

  await advertise(ctx.spaceId, LOOSE_SHARE_ID, 'big.bin', { size: 4096, mtime: 1, contentHash: 'h'.repeat(64) })
  row = (await listFiles(ctx.spaceId, [])).find((f) => f.path === '/big.bin')
  t.is(row.status, 'mine', 'once hashed it becomes an owned file')
})

test('Item 2B: a still-hashing peer loose entry is listed and presence-gates to unavailable when the owner is offline', async (t) => {
  const ctx = await setup(t)
  await advertise(ctx.spaceId, LOOSE_SHARE_ID, 'p.bin', { size: 4096, mtime: 1, contentHash: null })
  const member = { publicKey: 'peerpub', displayName: 'Peer', driveKey: 'dk', looseCatalogKey: await ownCatalogKeyHex(ctx.spaceId) }

  const spaceB = await createSpace('Borealis')
  const row = (await listFiles(spaceB.spaceId, [member])).find((f) => f.path === '/p.bin')
  t.ok(row, 'null-hash peer file is listed (was hidden before)')
  // Presence-gated (#372): with no in-process presence the owner reads offline, so a still-hashing
  // entry degrades to 'unavailable' rather than a stuck 'preparing'. The owner-online 'preparing'
  // case is covered by unhashedStatusFor's unit test + the loose-preparing flow test.
  t.is(row.status, 'unavailable')
  t.ok(row.inPlace, 'flagged in-place')
})

test('REGRESSION (FIX-cycle): files.js <-> loose-overlay.js import without a circular crash', async (t) => {
  const fmod = await import('../../src/shared/transfer/files.js')
  const lmod = await import('../../src/shared/transfer/loose-overlay.js')
  t.is(typeof fmod.addFile, 'function')
  t.is(typeof lmod.looseShareFile, 'function')
})

test('R10: fs-event dispatch — change re-hashes, atomic-save unlink is a no-op, real unlink is scoped per space', async (t) => {
  const ctx = await setup(t)
  const spaceB = await createSpace('Borealis')
  const abs = writeSource(ctx, 'doc.txt', 'v1')
  await looseShareFile(ctx.spaceId, abs, 'doc.txt')
  await looseShareFile(spaceB.spaceId, abs, 'doc.txt')
  const h1 = (await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'doc.txt')).contentHash

  fs.writeFileSync(abs, 'v2 is longer')
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(abs, future, future)
  await handleLooseFsEvent({ spaceId: ctx.spaceId, absPath: abs, action: 'change' })
  t.not((await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'doc.txt')).contentHash, h1, 'change re-advertised a new hash')

  // unlink while the file is still present (atomic-save) → no-op
  await handleLooseFsEvent({ spaceId: ctx.spaceId, absPath: abs, action: 'unlink' })
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'doc.txt'), 'present file not unshared on a spurious unlink')

  // real unlink, scoped to space A → A tombstoned, B intact
  fs.unlinkSync(abs)
  await handleLooseFsEvent({ spaceId: ctx.spaceId, absPath: abs, action: 'unlink' })
  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'doc.txt'), 'A unshared on unlink')
  t.ok(await getOwnEntry(spaceB.spaceId, LOOSE_SHARE_ID, 'doc.txt'), 'event scoped to A — B still shared')
})

test('R11 (Item 2A): publish builds the chunk map in one pass; the first serve does not re-chunk', async (t) => {
  const ctx = await setup(t)
  const overlay = getOverlay()
  let prepareCalls = 0
  const realPrepare = overlay._transfer.prepareFile.bind(overlay._transfer)
  overlay._transfer.prepareFile = (...a) => { prepareCalls++; return realPrepare(...a) }
  t.teardown(() => { overlay._transfer.prepareFile = realPrepare })

  // >1MB so the chunk map is persisted (by hash) — proves it is built at publish, so
  // the first peer fetch never pays a full-file re-chunk before the first byte.
  const abs = writeSource(ctx, 'big.bin', 'x'.repeat(2 * 1024 * 1024))
  await looseShareFile(ctx.spaceId, abs, 'big.bin')
  const entry = await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'big.bin')

  t.is(prepareCalls, 1, 'publish built the chunk map once (single hash+chunk streaming pass)')
  t.ok(await overlay._index.getChunkMapByHash(entry.contentHash), 'chunk map persisted by hash → no fetch-time re-chunk')
  // #4: the by-hash-only prep pass must NOT persist dead path-keyed state under the
  // throwaway /mir-prep key (the serve path resolves by hash, never reads these).
  t.absent(await overlay._index.getChunkMap('/mir-prep' + abs), 'no path-keyed /mir-prep chunk map (no FileIndex bloat)')
  t.absent(await overlay._index.getFile('/mir-prep' + abs), 'no /mir-prep file record')
  t.ok(serveIndex.has(entry.contentHash), 'file is registered as servable')
  const got = await getOverlay().fetchFile(entry.contentHash, {})
  t.is(got.destPath, abs, 'a local fetch returns the source path (no copy)')
})

test('R11b (Item 2A): the publish hash equals overlayHashFile (no wire change)', async (t) => {
  const ctx = await setup(t)
  const abs = writeSource(ctx, 'w.bin', 'z'.repeat(2 * 1024 * 1024))
  const expected = await overlayHashFile(abs)
  await looseShareFile(ctx.spaceId, abs, 'w.bin')
  t.is((await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'w.bin')).contentHash, expected, 'advertised hash unchanged by the single-pass publish')
})

test('R12 (FIX-1.4): concurrent same-basename adds → distinct entries, no clobber', async (t) => {
  const ctx = await setup(t)
  const a = writeSource(ctx, 'photo.jpg', 'A')
  const b = writeSource(ctx, 'photo.jpg', 'B') // different source, same basename
  await Promise.all([looseShareFile(ctx.spaceId, a, 'photo.jpg'), looseShareFile(ctx.spaceId, b, 'photo.jpg')])
  const names = (await looseListOwn(ctx.spaceId)).map((e) => e.relPath).sort()
  t.alike(names, ['photo (1).jpg', 'photo.jpg'], 'two distinct entries; neither clobbered')
})

test('R13 (FIX-1.4: #3): concurrent SAME-source adds dedup to one entry', async (t) => {
  const ctx = await setup(t)
  const c = writeSource(ctx, 'doc.txt', 'C')
  await Promise.all([looseShareFile(ctx.spaceId, c, 'doc.txt'), looseShareFile(ctx.spaceId, c, 'doc.txt')])
  t.is((await looseListOwn(ctx.spaceId)).filter((e) => e.relPath.startsWith('doc')).length, 1, 'one entry for one source')
})

test('R14 (FIX-1.4: #1): a share racing an unshare never leaves a tombstoned-but-servable hash', async (t) => {
  const ctx = await setup(t)
  const abs = writeSource(ctx, 'race.txt', 'data')
  const hash = await overlayHashFile(abs) // content hash, independent of share state
  await Promise.all([
    looseShareFile(ctx.spaceId, abs, 'race.txt'),
    looseUnshareFile(ctx.spaceId, '/race.txt'),
  ])
  const sharedInCatalog = !!(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'race.txt'))
  t.is(serveIndex.has(hash), sharedInCatalog, 'serveIndex agrees with the catalog (no desync)')
})

test('R15 (FIX-1.4): concurrent adds cannot exceed the per-space cap', async (t) => {
  const ctx = await setup(t)
  for (let i = 0; i < MAX_LOOSE_FILES_PER_SPACE - 1; i++) {
    await advertise(ctx.spaceId, LOOSE_SHARE_ID, `f${i}.txt`, { size: 1, mtime: i, contentHash: 'h' + i })
  }
  const a = writeSource(ctx, 'x.txt', 'x')
  const b = writeSource(ctx, 'y.txt', 'y')
  const r = await Promise.allSettled([looseShareFile(ctx.spaceId, a, 'x.txt'), looseShareFile(ctx.spaceId, b, 'y.txt')])
  t.is(r.filter((x) => x.status === 'fulfilled').length, 1, 'only one add at cap-1 succeeds')
  t.is(r.filter((x) => x.status === 'rejected').length, 1, 'the other rejects (LOOSE_FILE_LIMIT)')
  t.is((await looseListOwn(ctx.spaceId)).length, MAX_LOOSE_FILES_PER_SPACE, 'cap not exceeded')
})
