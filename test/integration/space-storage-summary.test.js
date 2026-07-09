import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import Hyperbee from 'hyperbee'
import { freshPeer } from '../helpers/store.js'
import { makePeer, replicate, waitFor } from '../helpers/peer-bee.js'
import { createSpace, updateMembers } from '../../src/shared/spaces/space.js'
import { initDownloads, addFile, markVerified, listVerifiedForShare } from '../../src/shared/transfer/files.js'
import { initPendingTransfers } from '../../src/shared/transfer/pending-transfers.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { listSharesForSpace } from '../../src/shared/shares/share-registry.js'
import { advertise, fileKey, collectPeerShare } from '../../src/shared/shares/share-catalog.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { getStore } from '../../src/shared/core/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initContentBackendOverlay } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'
import { saveForeignMount } from '../../src/shared/folders/mount-store.js'
import { spaceStorageSummary } from '../../src/shared/storage/space-storage.js'

// spaceStorageSummary feeds the space view's storage widget: ONE space-wide
// {totalBytes, onDeviceBytes} across every folder share (owned, mirrored,
// browse-only) plus the loose files. The single-peer-observable guarantees:
// owned folders and own loose files count fully on-device; a browse-only peer
// share counts toward the total but never on-device; a mirrored share counts
// on-device only the files whose hash-verified record still matches the
// owner's advertised content hash (the same predicate the per-row listing
// uses, done in bulk without stat'ing the mirror).

async function setup (t) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true })
  await initOverlay()
  initContentBackendOverlay(ctx.fake.ipc)
  t.teardown(async () => { await teardownOverlay() })
  await initDownloads()
  await initPendingTransfers()
  const space = await createSpace('Aurora')
  return { ...ctx, spaceId: space.spaceId }
}

async function publishOwnFolder (spaceId, name, entries) {
  const shareId = generateShareId()
  await publishShare(spaceId, {
    id: shareId, type: 'owned-folder', name, owner: getLocalPublicKeyHex(),
    spaceId, createdAt: Date.now(), contentMode: 'overlay',
  })
  for (const e of entries) await advertise(spaceId, shareId, e.relPath, { size: e.size, mtime: e.mtime ?? 0, contentHash: e.contentHash ?? null })
  return shareId
}

// A remote owner: its profile bee carries the share record, a second bee the
// catalog entries; both replicate into the local store like a real peer's would.
async function seedRemoteShare (t, ctx, spaceId, entries) {
  const peer = await makePeer(t)
  const shareId = generateShareId()
  const catalogCore = peer.store.get({ name: 'catalog' })
  await catalogCore.ready()
  const catalog = new Hyperbee(catalogCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  for (const e of entries) await catalog.put(fileKey(shareId, e.relPath), { size: e.size, mtime: e.mtime ?? 0, contentHash: e.contentHash ?? null })
  await peer.bee.put('caps/folder-shares', true)
  await peer.bee.put('share/' + spaceId + '/' + shareId, {
    id: shareId, type: 'owned-folder', name: 'Remote', createdAt: 1,
    contentMode: 'overlay', catalogKey: b4a.toString(catalogCore.key, 'hex'),
  })
  replicate(peer.store, getStore(), t)
  await updateMembers(spaceId, [{ publicKey: peer.key, driveKey: null, displayName: 'Owner' }])
  await waitFor(async () => (await listSharesForSpace(spaceId)).some((s) => s.id === shareId))
  return { shareId, ownerKey: peer.key, catalogKeyHex: b4a.toString(catalogCore.key, 'hex') }
}

test('owned folders and own loose files count fully, in total and on-device', async (t) => {
  const ctx = await setup(t)
  await publishOwnFolder(ctx.spaceId, 'Docs', [
    { relPath: 'a.bin', size: 100, contentHash: 'ha' },
    { relPath: 'sub/b.bin', size: 200, contentHash: 'hb' },
  ])
  const src = path.join(ctx.tmpDir('src'), 'loose.txt')
  fs.writeFileSync(src, 'loose content') // 13 bytes
  await addFile(ctx.spaceId, src, 'loose.txt')

  const s = await spaceStorageSummary(ctx.spaceId)
  t.is(s.totalBytes, 313, 'total = folder bytes + loose bytes')
  t.is(s.onDeviceBytes, 313, 'own content is fully on this device')
})

test('a browse-only peer share counts toward the total but not on-device', async (t) => {
  const ctx = await setup(t)
  await seedRemoteShare(t, ctx, ctx.spaceId, [
    { relPath: 'x.bin', size: 50, contentHash: 'hx' },
    { relPath: 'y.bin', size: 70, contentHash: 'hy' },
  ])

  const s = await spaceStorageSummary(ctx.spaceId)
  t.is(s.totalBytes, 120, 'peer share bytes count toward the space total')
  t.is(s.onDeviceBytes, 0, 'nothing materialized → nothing on-device')
})

test('a mirrored share counts only hash-verified files on-device; a stale hash does not', async (t) => {
  const ctx = await setup(t)
  const { shareId, ownerKey } = await seedRemoteShare(t, ctx, ctx.spaceId, [
    { relPath: 'a.bin', size: 10, contentHash: 'ha' },
    { relPath: 'b.bin', size: 20, contentHash: 'hb' },
    { relPath: 'c.bin', size: 30, contentHash: 'hc' },
  ])
  await saveForeignMount({
    spaceId: ctx.spaceId, shareId, ownerKey, mountPath: ctx.tmpDir('mirror'),
    enabled: true, status: 'active', syncedPaths: [], renamedPaths: {},
  })
  // a.bin materialized + verified against the current hash; b.bin's record is
  // stale (the owner re-published under a new hash) → must NOT count; c.bin
  // never landed.
  await markVerified(ctx.spaceId, shareId + '|a.bin', 'ha')
  await markVerified(ctx.spaceId, shareId + '|b.bin', 'OLD')

  const s = await spaceStorageSummary(ctx.spaceId)
  t.is(s.totalBytes, 60, 'the whole share counts toward the space total')
  t.is(s.onDeviceBytes, 10, 'only the still-current verified file counts on-device')
})

test('summary spans share kinds: owned + mirrored + loose in one number', async (t) => {
  const ctx = await setup(t)
  const { shareId, ownerKey } = await seedRemoteShare(t, ctx, ctx.spaceId, [
    { relPath: 'm.bin', size: 40, contentHash: 'hm' },
    { relPath: 'n.bin', size: 60, contentHash: 'hn' },
  ])
  await saveForeignMount({
    spaceId: ctx.spaceId, shareId, ownerKey, mountPath: ctx.tmpDir('mirror'),
    enabled: true, status: 'active', syncedPaths: [], renamedPaths: {},
  })
  await markVerified(ctx.spaceId, shareId + '|m.bin', 'hm')
  await publishOwnFolder(ctx.spaceId, 'Mine', [{ relPath: 'own.bin', size: 5, contentHash: 'ho' }])

  const s = await spaceStorageSummary(ctx.spaceId)
  t.is(s.totalBytes, 105, 'total sums owned + mirrored shares')
  t.is(s.onDeviceBytes, 45, 'on-device sums owned bytes + the mirrored verified subset')
})

test('an unknown space yields zeros instead of throwing', async (t) => {
  await setup(t)
  const s = await spaceStorageSummary('no-such-space')
  t.alike(s, { totalBytes: 0, onDeviceBytes: 0 })
})

test('listVerifiedForShare isolates its share prefix', async (t) => {
  const ctx = await setup(t)
  await markVerified(ctx.spaceId, 'share-one|a.bin', 'ha')
  await markVerified(ctx.spaceId, 'share-one|sub/b.bin', 'hb')
  await markVerified(ctx.spaceId, 'share-two|a.bin', 'other')

  const map = await listVerifiedForShare(ctx.spaceId, 'share-one')
  t.is(map.size, 2, 'only the requested share is scanned')
  t.is(map.get('a.bin'), 'ha')
  t.is(map.get('sub/b.bin'), 'hb')
})

test('REGRESSION: a fully-read empty peer catalog is complete=false but stalled=false (no perpetual re-poke)', async (t) => {
  const ctx = await setup(t)
  // A member who published a catalog key but shared nothing: the catalog core is length 0.
  const peer = await makePeer(t)
  const catalogCore = peer.store.get({ name: 'catalog' })
  await catalogCore.ready()
  replicate(peer.store, getStore(), t)
  const res = await collectPeerShare(b4a.toString(catalogCore.key, 'hex'), generateShareId(), {})
  t.is(res.entries.length, 0, 'nothing to list')
  t.is(res.complete, false, 'still complete=false so the renderer keeps its last good list over an empty read')
  t.is(res.stalled, false, 'a reachable, fully-read empty catalog is NOT stalled — so the tick will not re-poke it forever')
})

test('collectPeerShare onEach sees every entry even at limit=0 (no rows retained)', async (t) => {
  const ctx = await setup(t)
  const { shareId, catalogKeyHex } = await seedRemoteShare(t, ctx, ctx.spaceId, [
    { relPath: 'p.bin', size: 1, contentHash: 'hp' },
    { relPath: 'q.bin', size: 2, contentHash: 'hq' },
    { relPath: 'r.bin', size: 3, contentHash: 'hr' },
  ])
  const seen = []
  const res = await collectPeerShare(catalogKeyHex, shareId, { limit: 0, onEach: (e) => seen.push(e.relPath) })
  t.is(res.entries.length, 0, 'limit=0 retains no rows (the FIX-141 heap bound)')
  t.is(res.total, 3, 'true count intact')
  t.is(res.totalBytes, 6, 'true byte total intact')
  t.alike(seen.sort(), ['p.bin', 'q.bin', 'r.bin'], 'onEach saw every counted entry')
})
