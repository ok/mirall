import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { saveOwnedMount } from '../../src/shared/folders/mount-store.js'
import { initialPublishScan } from '../../src/shared/folders/owned-folders.js'
import { getOwnEntry } from '../../src/shared/shares/share-catalog.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { getOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import {
  initContentBackendOverlay, _resetContentBackendOverlay, overlayHashFile, overlaySweepPresence, makeServable,
} from '../../src/shared/transfer/backends/overlay/overlay-backend.js'

// Drive the overlay adapter's OWNER side against one fresh data layer. The
// consumer fetch (two-peer) is validated in the flow tier (A6). The defining
// property asserted here: publishing copies NO bytes into a core — the overlay
// serves straight from the user's source file on disk.
async function setup (t, { files = {} } = {}) {
  const ctx = await freshPeer(t)
  const space = await createSpace('Aurora')
  const share = {
    id: generateShareId(),
    type: 'owned-folder',
    name: 'Vault',
    contentMode: 'overlay',
    owner: getLocalPublicKeyHex(),
    createdAt: Date.now(),
  }
  await publishShare(space.spaceId, share)
  const mountPath = ctx.tmpDir('mount')
  await saveOwnedMount({ spaceId: space.spaceId, shareId: share.id, mountPath, ignore: [], createdAt: Date.now() })
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(mountPath, ...rel.split('/'))
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, contents)
  }
  initContentBackendOverlay(ctx.fake.ipc)
  serveIndex._reset()
  await overlayBackend.init() // initOverlay + rehydrate (nothing published yet)
  t.teardown(async () => {
    _resetContentBackendOverlay()
    serveIndex._reset()
    await teardownOverlay()
  })
  return { ...ctx, spaceId: space.spaceId, share, mountPath }
}

test('publishAdd advertises a hash and serves straight from the source file', async (t) => {
  const ctx = await setup(t, { files: { 'docs/a.txt': 'hello overlay' } })
  const abs = path.join(ctx.mountPath, 'docs', 'a.txt')

  const changed = await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'docs/a.txt', abs)
  t.ok(changed, 'publishAdd reports a change')

  const entry = await getOwnEntry(ctx.spaceId, ctx.share.id, 'docs/a.txt')
  t.ok(entry, 'catalog has the entry')
  t.ok(entry.contentHash, 'contentHash backfilled after hashing (advertise-first)')
  t.ok(serveIndex.has(entry.contentHash), 'hash registered in the serve index')
  t.alike([...serveIndex.spacesFor(entry.contentHash)], [ctx.spaceId])

  // Black-box proof of "no second copy": a local fetch resolves to the SOURCE
  // path, not a core/blob copy, and the bytes match.
  const got = await getOverlay().fetchFile(entry.contentHash, {})
  t.ok(got?.local, 'file is servable locally')
  t.is(got.destPath, abs, 'serves straight from the source file (no copy made)')
  t.is(fs.readFileSync(got.destPath).toString(), 'hello overlay', 'bytes match the source')
})

test('REGRESSION (FIX-2: a folder publish failure reverts the half-advertised entry — parity with loose)', async (t) => {
  // publishContent (shared by loose + folder) advertises contentHash:null before the
  // hash; a failed hash (e.g. the >15 MiB chunk-map BAD_ARGUMENT) must not leave the
  // folder catalog with a stuck "preparing" entry.
  const ctx = await setup(t, { files: { 'docs/big.txt': 'x'.repeat(2048) } })
  const abs = path.join(ctx.mountPath, 'docs', 'big.txt')

  const overlay = getOverlay()
  const realPrepare = overlay.prepareForServe.bind(overlay)
  overlay.prepareForServe = async () => {
    const e = new Error('Appended block exceeds the maximum suggested block size')
    e.code = 'BAD_ARGUMENT'
    throw e
  }
  t.teardown(() => { overlay.prepareForServe = realPrepare })

  await t.exception(overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'docs/big.txt', abs), /maximum suggested block size/, 'the publish error propagates')
  t.absent(await getOwnEntry(ctx.spaceId, ctx.share.id, 'docs/big.txt'), 'no stuck "preparing" entry — the folder publish reverted, same as loose')
})

test('REGRESSION (FIX-2: a failed folder RE-publish keeps the prior version, not a tombstone)', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'v1' } })
  const abs = path.join(ctx.mountPath, 'a.txt')
  await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'a.txt', abs)
  const v1 = (await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt')).contentHash
  t.ok(v1, 'v1 published')

  // Change the file so the next publish re-hashes, then make that re-hash fail.
  fs.writeFileSync(abs, 'v2 is longer')
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(abs, future, future)
  const overlay = getOverlay()
  const realPrepare = overlay.prepareForServe.bind(overlay)
  overlay.prepareForServe = async () => { throw new Error('re-hash boom') }
  t.teardown(() => { overlay.prepareForServe = realPrepare })

  await t.exception(overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'a.txt', abs), /re-hash boom/)
  t.is((await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt'))?.contentHash, v1, 'the prior version stays advertised — not tombstoned, not stuck null')
})

test('REGRESSION (FIX: a folder file is not tombstoned on a single presence-sweep miss — atomic-save guard, parity with loose)', async (t) => {
  // The loose sweep confirms-gone-twice so an editor atomic-save (rename-over /
  // delete+recreate) doesn't transiently tombstone a healthy file and cascade the
  // deletion to mirror peers. The folder sweep must do the same.
  const ctx = await setup(t, { files: { 'a.txt': 'data' } })
  const abs = path.join(ctx.mountPath, 'a.txt')
  await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'a.txt', abs)
  t.ok(await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt'), 'published')

  fs.unlinkSync(abs) // source gone (could be a transient atomic-save window)
  await overlaySweepPresence()
  t.ok(await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt'), 'a single miss only arms — not tombstoned')

  await overlaySweepPresence()
  t.absent(await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt'), 'a second consecutive miss reclaims it')
})

test('FIX: a folder file that reappears between sweeps (atomic save) is never tombstoned', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'data' } })
  const abs = path.join(ctx.mountPath, 'a.txt')
  await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'a.txt', abs)

  fs.unlinkSync(abs)            // brief absence (atomic save in progress)
  await overlaySweepPresence() // arms
  fs.writeFileSync(abs, 'data') // back before the next sweep
  await overlaySweepPresence() // disarms on presence — must NOT tombstone

  t.ok(await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt'), 'reappeared file is not tombstoned')
})

test('publishAdd is a no-op for an unchanged, already-hashed file', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'data' } })
  const abs = path.join(ctx.mountPath, 'a.txt')
  await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'a.txt', abs)
  const again = await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'a.txt', abs)
  t.absent(again, 'second publishAdd reports no change')
})

test('publishAdd re-hashes a changed file (new hash advertised)', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'v1' } })
  const abs = path.join(ctx.mountPath, 'a.txt')
  await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'a.txt', abs)
  const h1 = (await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt')).contentHash

  // Change the bytes (and bump mtime so the size/mtime guard sees a change).
  fs.writeFileSync(abs, 'v2 is longer')
  const future = new Date(Date.now() + 5000)
  fs.utimesSync(abs, future, future)
  const changed = await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'a.txt', abs)
  t.ok(changed, 'changed file reports a change')
  const h2 = (await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt')).contentHash
  t.not(h1, h2, 'a new contentHash is advertised')
  t.ok(serveIndex.has(h2), 'new hash servable')
})

test('listOwn returns advertised entries with their hashes', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'one', 'b.txt': 'two' } })
  await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'a.txt', path.join(ctx.mountPath, 'a.txt'))
  await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'b.txt', path.join(ctx.mountPath, 'b.txt'))
  const { entries: own } = await overlayBackend.listOwn(ctx.spaceId, ctx.share.id)
  t.is(own.length, 2)
  t.ok(own.every((e) => e.contentHash), 'every entry has a hash')
})

test('scan advertises all on-disk files and tombstones removed ones', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'one', 'b.txt': 'two' } })
  const r1 = await initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  t.is(r1.uploaded, 2, 'both files advertised')
  t.is(r1.totalOnDisk, 2)

  fs.unlinkSync(path.join(ctx.mountPath, 'a.txt'))
  const r2 = await initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  t.is(r2.deleted, 1, 'tombstoned the removed file')
  const { entries: own } = await overlayBackend.listOwn(ctx.spaceId, ctx.share.id)
  t.is(own.length, 1)
  t.is(own[0].relPath, 'b.txt')
})

test('REGRESSION (FIX-2: scan isolation): one erroring file does not abort the scan or skip tombstones', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'one', 'b.txt': 'two', 'gone.txt': 'three' } })
  const r1 = await initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  t.is(r1.uploaded, 3, 'all three advertised on the first pass')

  // Remove one file (must be tombstoned) AND make one still-present file throw during
  // prepare (a perms flap / IO error mid-loop). Pre-fix the throw escapes the loop, so
  // the tombstone pass never runs and gone.txt stays advertised. a.txt is mutated so the
  // scan re-prepares it (publishContent skips prepareForServe for unchanged files).
  fs.unlinkSync(path.join(ctx.mountPath, 'gone.txt'))
  fs.writeFileSync(path.join(ctx.mountPath, 'a.txt'), 'one changed')
  const overlay = getOverlay()
  const realPrepare = overlay.prepareForServe.bind(overlay)
  overlay.prepareForServe = async (diskPath, opts) => {
    if (diskPath.endsWith('a.txt')) throw new Error('boom: a.txt unreadable')
    return realPrepare(diskPath, opts)
  }
  t.teardown(() => { overlay.prepareForServe = realPrepare })

  const r2 = await initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  t.is(r2.deleted, 1, 'tombstone pass still ran despite the mid-loop throw')

  const { entries: own } = await overlayBackend.listOwn(ctx.spaceId, ctx.share.id)
  const paths = own.map((e) => e.relPath).sort()
  t.alike(paths, ['a.txt', 'b.txt'], 'gone.txt tombstoned; a.txt kept (prior version) and b.txt intact')
})

test('REGRESSION (FIX-3b): makeServable does not add a serve-index claim when registerFile reports the source vanished', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'hi' } })
  const overlay = getOverlay()
  const realRF = overlay.registerFile.bind(overlay)
  overlay.registerFile = async () => null // source vanished between hash and register
  t.teardown(() => { overlay.registerFile = realRF })

  await makeServable(ctx.spaceId, ctx.share.id, 'a.txt', path.join(ctx.mountPath, 'a.txt'), 'deadbeefhash', 2)
  t.absent(serveIndex.has('deadbeefhash'), 'no serve-gate claim for a hash the overlay never registered')
})

test('publishDelete tombstones and drops the serve-index claim', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'data' } })
  const abs = path.join(ctx.mountPath, 'a.txt')
  await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'a.txt', abs)
  const entry = await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt')
  t.ok(serveIndex.has(entry.contentHash))

  await overlayBackend.publishDelete(ctx.spaceId, ctx.share, 'a.txt')
  t.absent(await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt'), 'catalog entry tombstoned')
  t.absent(serveIndex.has(entry.contentHash), 'serve-index claim dropped')
})

// Content-addressed dedup (R3): two identical files share one content hash, and
// the serve index refcounts by path — so deleting one of them must NOT revoke
// serve for the other (the bug a space-granular index would have).
test('dedup: two identical files share one hash; deleting one keeps the other servable', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'same exact bytes', 'copy/a.txt': 'same exact bytes' } })
  await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'a.txt', path.join(ctx.mountPath, 'a.txt'))
  await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'copy/a.txt', path.join(ctx.mountPath, 'copy', 'a.txt'))

  const e1 = await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt')
  const e2 = await getOwnEntry(ctx.spaceId, ctx.share.id, 'copy/a.txt')
  t.is(e1.contentHash, e2.contentHash, 'identical bytes → identical content hash (dedup)')
  t.ok(serveIndex.has(e1.contentHash))

  // Delete one path — the hash must stay servable for the other (this is the fix).
  await overlayBackend.publishDelete(ctx.spaceId, ctx.share, 'a.txt')
  t.ok(serveIndex.has(e1.contentHash), 'hash still servable after deleting one of two identical paths')
  const got = await getOverlay().fetchFile(e1.contentHash, {})
  t.ok(got?.local, 'still fetchable from the remaining copy')
  t.is(fs.readFileSync(got.destPath).toString(), 'same exact bytes', 'bytes intact')

  // Delete the other — now the hash is forgotten.
  await overlayBackend.publishDelete(ctx.spaceId, ctx.share, 'copy/a.txt')
  t.absent(serveIndex.has(e1.contentHash), 'forgotten once both identical paths are deleted')
})

// The owner must be refreshed at advertise-time (the `preparing` row), not only
// after the slow hash — so it tracks the consumer instead of lagging a whole
// scan behind. Deterministic proof: the share-files-updated refresh is emitted
// before the first hashing-progress event.
test('owner refresh fires at advertise-time, before hashing progress', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'advertise before hashing' } })
  await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'a.txt', path.join(ctx.mountPath, 'a.txt'))

  const order = ctx.fake.events.map((e) => e.type)
  const firstUpdated = order.indexOf('event:share-files-updated')
  const firstPrepare = ctx.fake.events.findIndex((e) => e.type === 'event:decoration' && e.payload.phase === 'preparing')
  t.ok(firstUpdated >= 0, 'owner received a share-files-updated refresh')
  t.ok(firstPrepare >= 0, 'hashing emitted a prepare decoration')
  t.ok(firstUpdated < firstPrepare, 'refresh fired before hashing — owner sees the preparing row at advertise-time')
})

// The whole-file integrity verify (now STREAMED so a multi-GB file is checked
// without buffering it) must still reject bytes that don't hash to the requested
// content hash. Tamper the source on disk WITHOUT re-publishing: the serve index
// still maps the old hash to this path, so the local-hit verify is what catches
// the mismatch — it must refuse to serve the stale bytes.
test('streaming verify rejects a source whose bytes no longer match the content hash', async (t) => {
  const ctx = await setup(t, { files: { 'a.txt': 'the original, registered bytes' } })
  const abs = path.join(ctx.mountPath, 'a.txt')
  await overlayBackend.publishAdd(ctx.spaceId, ctx.share, 'a.txt', abs)
  const entry = await getOwnEntry(ctx.spaceId, ctx.share.id, 'a.txt')
  t.ok(serveIndex.has(entry.contentHash), 'precondition: hash is servable')

  fs.writeFileSync(abs, 'tampered — different length and different bytes entirely')

  // No peers in this single-peer setup, so a refused local hit falls through to a
  // (bounded) peer wait and returns null — proving the verify did NOT serve the
  // mismatched bytes.
  const got = await getOverlay().fetchFile(entry.contentHash, { peerWaitMs: 50 })
  t.is(got, null, 'streamed whole-file verify rejected the mismatched source')
})

test('releaseRemote is a no-op (overlay stores nothing on the owner)', (t) => {
  t.execution(() => overlayBackend.releaseRemote('s', { id: 'x' }, 'a.txt'))
})
