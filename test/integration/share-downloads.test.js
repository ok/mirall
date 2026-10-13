import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { until } from '../helpers/bare-poll.js'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { upsertMember } from '../../src/shared/spaces/space.js'
import { putContentKey } from '../../src/shared/spaces/space-keys.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createBee } from '../../src/shared/core/store.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { fileKey } from '../../src/shared/shares/catalog-keys.js'
import { isPeerCatalogWatched } from '../../src/shared/shares/peer-catalog.js'
import { generateShareId, publishShare, tombstoneShare } from '../../src/shared/shares/shares.js'
import { advertise, ownCatalogKeyHex } from '../../src/shared/shares/own-catalog.js'
import { initPendingTransfers, recordPending, getPendingFor } from '../../src/shared/transfer/pending-transfers.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/overlay/overlay-download.js'
import {
  cancelShareDownload, downloadChannel, listPeerWithMeta, requestShareDownload, setDownloadEngine, watchedCatalogVersion,
} from '../../src/shared/transfer/overlay/share-downloads.js'
import { downloadJob, looseShareFor } from '../../src/shared/transfer/overlay/download-job.js'
import { LOOSE_SHARE_ID, looseTransferIdFor, transferIdFor } from '../../src/shared/transfer/transfer-id.js'

// Loose and folder downloads run through one wrapper and one engine. Every case here runs over both
// kinds: what must differ between them is only what a persisted row, a wire event or the mirror
// already depends on.

const OWNER = 'o'.repeat(64)
const KEY = 'c'.repeat(64)
const HASH = 'a'.repeat(64)
const FOLDER = { id: 'sh1', name: 'Vault', owner: OWNER, catalogKeyEnc: KEY, catalogEpoch: 0 }
const LOOSE = looseShareFor({ publicKey: OWNER, looseCatalogKeyEnc: KEY, looseCatalogEpoch: 0 })

async function setup(t) {
  const ctx = await freshPeer(t)
  await initPendingTransfers()
  const space = await createSpace('Aurora')
  return { ...ctx, spaceId: space.spaceId }
}

function jobFor(ctx, spaceId, share, relPath, pendingKey) {
  return downloadJob({
    spaceId, share, relPath, pendingKey, keyHex: KEY, encrypted: true, epoch: 0,
    entry: { contentHash: HASH, size: 4096, seq: 3 }, finalPath: path.join(ctx.tmpDir('dl'), relPath),
  })
}

const keysOf = (row) => Object.keys(row).filter((k) => k !== 'updatedAt').sort()

// PERSISTED: the field set each kind writes. A build owns a row by these fields, so a row written by
// any build is owned by every other one.
test('a started download writes the same row fields per kind as before', async (t) => {
  const ctx = await setup(t)
  const engine = createOverlayDownloadEngine({ ...downloadChannel, isOwnerOnline: () => false })
  const updates = () => ({
    loose: ctx.fake.emitted('event:files-updated').map((e) => e.payload),
    folder: ctx.fake.emitted('event:share-files-updated').map((e) => e.payload),
  })

  const before = updates()
  t.ok((await engine.start(jobFor(ctx, ctx.spaceId, LOOSE, 'a.bin', '/a.bin'))).queued, 'loose: queued while the owner is away')
  const afterLoose = updates()
  t.ok((await engine.start(jobFor(ctx, ctx.spaceId, FOLDER, 'b.bin', '/Vault/b.bin'))).queued, 'folder: queued too')
  const afterFolder = updates()
  t.alike(afterLoose.loose.slice(before.loose.length), [{ spaceId: ctx.spaceId }], 'a loose start updates the loose listing')
  t.is(afterLoose.folder.length, before.folder.length, 'and not a folder listing')
  t.alike(afterFolder.folder.slice(afterLoose.folder.length), [{ spaceId: ctx.spaceId }], 'a folder start updates the folder listing')
  t.is(afterFolder.loose.length, afterLoose.loose.length, 'and not the loose one')

  const loose = await getPendingFor(ctx.spaceId, '/a.bin')
  t.alike(keysOf(loose), ['bytesTransferred', 'contentHash', 'finalPath', 'inPlace', 'ownerKey', 'relPath', 'shareId', 'sourceSeq', 'total'])
  t.is(loose.inPlace, true)
  t.is(loose.shareId, LOOSE_SHARE_ID)

  const folder = await getPendingFor(ctx.spaceId, '/Vault/b.bin')
  t.alike(keysOf(folder), ['bytesTransferred', 'catalogEpoch', 'catalogKeyEnc', 'contentHash', 'finalPath', 'inPlace', 'overlayShare', 'ownerKey', 'relPath', 'shareId', 'sourceSeq', 'total'])
  t.is(folder.inPlace, false)
  t.is(folder.overlayShare, true)
  t.is(folder.catalogKeyEnc, KEY)
})

test('rows an earlier build wrote are owned and discarded; an unmarked row is left alone', async (t) => {
  const ctx = await setup(t)
  const S = ctx.spaceId
  const dl = ctx.tmpDir('dl')
  const seeded = {
    loose: { key: '/big.bin', id: looseTransferIdFor(S, 'big.bin'), row: { total: 100, shareId: LOOSE_SHARE_ID, relPath: 'big.bin', inPlace: true, ownerKey: OWNER } },
    'loose intent': { key: '/later.bin', id: looseTransferIdFor(S, 'later.bin'), row: { inPlace: true, shareId: LOOSE_SHARE_ID, relPath: 'later.bin', ownerKey: OWNER, total: 0 } },
    folder: {
      key: '/Vault/doc.bin', id: transferIdFor(S, 'sh1', 'doc.bin'),
      row: { total: 100, inPlace: false, ownerKey: OWNER, contentHash: HASH, bytesTransferred: 10, overlayShare: true, shareId: 'sh1', relPath: 'doc.bin', catalogKey: KEY },
    },
    'folder, encrypted catalog': {
      key: '/Vault/enc.bin', id: transferIdFor(S, 'sh1', 'enc.bin'),
      row: { total: 100, inPlace: false, ownerKey: OWNER, contentHash: HASH, bytesTransferred: 10, overlayShare: true, shareId: 'sh1', relPath: 'enc.bin', catalogKeyEnc: KEY, catalogEpoch: 2 },
    },
  }
  for (const [name, { key, row }] of Object.entries(seeded)) {
    const finalPath = path.join(dl, name.replace(/\W/g, '-') + '.bin')
    fs.writeFileSync(finalPath + '.mirall.part', 'partial')
    await recordPending(S, key, { ...row, finalPath })
  }
  const legacyFinal = path.join(dl, 'legacy.bin')
  fs.writeFileSync(legacyFinal + '.mirall.part', 'partial')
  await recordPending(S, '/Old/legacy.bin', { shareId: 'sh9', relPath: 'legacy.bin', ownerKey: OWNER, finalPath: legacyFinal })

  for (const [name, { key, id }] of Object.entries(seeded)) {
    const finalPath = path.join(dl, name.replace(/\W/g, '-') + '.bin')
    t.ok(await cancelShareDownload(id), `${name}: the id resolves its row`)
    t.absent(await getPendingFor(S, key), `${name}: the row is cleared`)
    t.absent(fs.existsSync(finalPath + '.mirall.part'), `${name}: the partial is discarded`)
  }
  t.absent(await cancelShareDownload(transferIdFor(S, 'sh9', 'legacy.bin')), 'an unmarked row is not this engine\'s')
  t.ok(await getPendingFor(S, '/Old/legacy.bin'), 'and it stays')
  t.ok(fs.existsSync(legacyFinal + '.mirall.part'), 'with its partial')
})

test('one reconnect pass resolves both kinds of the owner\'s rows', async (t) => {
  const ctx = await setup(t)
  const resolved = []
  const engine = createOverlayDownloadEngine({
    ...downloadChannel,
    isOwnerOnline: () => true,
    resolvePendingRow: async (spaceId, row) => { resolved.push(row.shareId); return { removed: false, seq: undefined, job: null } },
  })
  const dl = ctx.tmpDir('dl')
  await recordPending(ctx.spaceId, '/a.bin', {
    total: 4096, inPlace: true, ownerKey: OWNER, finalPath: path.join(dl, 'a.bin'), contentHash: HASH, sourceSeq: 3,
    bytesTransferred: 10, shareId: LOOSE_SHARE_ID, relPath: 'a.bin',
  })
  await recordPending(ctx.spaceId, '/Vault/b.bin', {
    total: 4096, inPlace: false, ownerKey: OWNER, finalPath: path.join(dl, 'b.bin'), contentHash: HASH, sourceSeq: 3,
    bytesTransferred: 10, overlayShare: true, shareId: 'sh1', relPath: 'b.bin', catalogKey: KEY,
  })

  await engine.resumeForOwner(OWNER, ctx.spaceId)
  t.ok(await until(() => resolved.length === 2, 2000), 'both rows were resolved')
  t.alike(resolved.sort(), ['__loose__', 'sh1'], 'each by its own share')
})

function stubEngine(t) {
  const calls = { start: 0, clearPauseMarker: [] }
  setDownloadEngine({
    start: async () => { calls.start++; return { transferId: 'stub', finalPath: '/x' } },
    clearPauseMarker: (id) => { calls.clearPauseMarker.push(id) },
    reconcileOnAppend: async () => {},
  })
  t.teardown(() => setDownloadEngine(null))
  return calls
}

// The owner's catalog read as a peer's: the own catalog is encrypted under this space's key, which
// this peer holds, so the descriptor resolves it exactly as it would a co-member's.
async function ownAsPeer(ctx) {
  const keyHex = await ownCatalogKeyHex(ctx.spaceId)
  const member = { publicKey: OWNER, displayName: 'Owner', looseCatalogKeyEnc: keyHex }
  const folder = { id: 'sh1', name: 'Vault', owner: OWNER, catalogKeyEnc: keyHex, catalogEpoch: 0 }
  return { keyHex, member, loose: looseShareFor(member), folder }
}

test('a click the catalog cannot answer keeps a loose intent row and nothing for a folder', async (t) => {
  const ctx = await setup(t)
  const { loose, folder } = await ownAsPeer(ctx)
  await advertise(ctx.spaceId, LOOSE_SHARE_ID, 'other.bin', { size: 4, mtime: 1, contentHash: HASH })
  const calls = stubEngine(t)

  t.alike(await requestShareDownload(ctx.spaceId, loose, 'missing.bin'), { queued: true }, 'loose: queued')
  const intent = await getPendingFor(ctx.spaceId, '/missing.bin')
  t.alike({ ...intent, updatedAt: undefined }, { inPlace: true, shareId: LOOSE_SHARE_ID, relPath: 'missing.bin', ownerKey: OWNER, total: 0, updatedAt: undefined },
    'the intent row has exactly the shape an earlier build wrote')
  t.ok(ctx.fake.emitted('event:files-updated').some((e) => e.payload.spaceId === ctx.spaceId), 'and the loose listing is told')

  t.alike(await requestShareDownload(ctx.spaceId, folder, 'missing.bin'), { queued: true }, 'folder: queued')
  t.absent(await getPendingFor(ctx.spaceId, '/Vault/missing.bin'), 'with no row')

  t.alike(await requestShareDownload(ctx.spaceId, looseShareFor(undefined), 'x.bin'), { queued: true }, 'an unknown member: queued')
  t.absent(await getPendingFor(ctx.spaceId, '/x.bin'), 'with no row')
  t.ok(calls.clearPauseMarker.includes(looseTransferIdFor(ctx.spaceId, 'x.bin')), 'but the pause marker is still retired')
  t.is(calls.start, 0, 'nothing started')
})

test('a hashed entry starts on the one engine for both kinds', async (t) => {
  const ctx = await setup(t)
  const { loose, folder } = await ownAsPeer(ctx)
  await advertise(ctx.spaceId, LOOSE_SHARE_ID, 'a.bin', { size: 4, mtime: 1, contentHash: HASH })
  await advertise(ctx.spaceId, 'sh1', 'b.bin', { size: 4, mtime: 1, contentHash: HASH })
  const started = []
  setDownloadEngine({
    start: async (job) => { started.push(job); return { transferId: job.transferId, finalPath: job.finalPath } },
    clearPauseMarker: () => {},
    reconcileOnAppend: async () => {},
  })
  t.teardown(() => setDownloadEngine(null))

  await requestShareDownload(ctx.spaceId, loose, 'a.bin')
  await requestShareDownload(ctx.spaceId, folder, 'b.bin')
  t.alike(started.map((j) => [j.transferId, j.pendingKey, j.express]), [
    [looseTransferIdFor(ctx.spaceId, 'a.bin'), '/a.bin', true],
    [transferIdFor(ctx.spaceId, 'sh1', 'b.bin'), '/Vault/b.bin', true],
  ])
})

test('one descriptor reads each share from the owner\'s one catalog', async (t) => {
  const ctx = await setup(t)
  const { loose, folder } = await ownAsPeer(ctx)
  await advertise(ctx.spaceId, LOOSE_SHARE_ID, 'a.bin', { size: 4, mtime: 1, contentHash: HASH })
  await advertise(ctx.spaceId, 'sh1', 'b.bin', { size: 4, mtime: 1, contentHash: HASH })

  t.is(await watchedCatalogVersion(ctx.spaceId, loose), null, 'no version before a read armed the watch')
  const looseRead = await listPeerWithMeta(ctx.spaceId, loose)
  const folderRead = await listPeerWithMeta(ctx.spaceId, folder)
  t.alike(looseRead.entries.map((e) => e.relPath), ['a.bin'], 'the loose share lists its own rows')
  t.alike(folderRead.entries.map((e) => e.relPath), ['b.bin'], 'the folder share lists its own')
  t.ok(looseRead.complete, 'a whole read')
  t.is(typeof await watchedCatalogVersion(ctx.spaceId, loose), 'number', 'the read armed the watch, so the version is live')
  t.alike(await listPeerWithMeta(ctx.spaceId, looseShareFor({ publicKey: OWNER })), { entries: [], complete: true, total: 0, totalBytes: 0 },
    'a keyless member reads as an empty, whole listing')
})

// === Rows resolved through the production resolve ===

// A catalog encrypted under the space's key at epoch 2, which differs from the epoch-0 key: a
// read under the wrong epoch opens it with the wrong key. Closed after writing, so the first open
// the code under test makes is its own.
async function epochTwoCatalog(spaceId, shareId, relPath) {
  const sck = crypto.randomBytes(32)
  await putContentKey(spaceId, sck, { epoch: 2 })
  const bee = createBee('epoch-two-catalog-' + b4a.toString(crypto.randomBytes(8), 'hex'), { encryptionKey: sck })
  await bee.ready()
  await bee.put(fileKey(shareId, relPath), { size: 4, mtime: 1, contentHash: HASH })
  const keyHex = b4a.toString(bee.core.key, 'hex')
  await bee.close()
  return keyHex
}

const oldFolderRow = (ctx, over) => ({
  filePath: '/Vault/doc.bin', total: 4, inPlace: false, overlayShare: true, shareId: 'sh1', relPath: 'doc.bin',
  ownerKey: OWNER, finalPath: path.join(ctx.tmpDir('dl'), 'doc.bin'), contentHash: HASH, sourceSeq: 1, bytesTransferred: 0, ...over,
})

test('REGRESSION (a folder download row stores the epoch of the catalog it read)', async (t) => {
  const ctx = await setup(t)
  const keyHex = await epochTwoCatalog(ctx.spaceId, 'sh1', 'doc.bin')
  const share = { id: 'sh1', name: 'Vault', owner: OWNER, catalogKeyEnc: keyHex, catalogEpoch: 2 }

  t.ok((await requestShareDownload(ctx.spaceId, share, 'doc.bin')).queued, 'queued while the owner is away, with its row written')
  const row = await getPendingFor(ctx.spaceId, '/Vault/doc.bin')
  t.is(row?.catalogKeyEnc, keyHex, 'the row carries the catalog key')
  t.is(row?.catalogEpoch, 2, 'and the epoch whose key opens it, so a fallback resolve picks the right key')
})

test('REGRESSION (a folder row whose owner record is unreadable resolves through the key and epoch it carries)', async (t) => {
  const ctx = await setup(t)
  const config = getRuntimeConfig()
  // absolute: the unknown owner's record read must give up quickly; the catalog itself is local.
  setRuntimeConfig({ ...config, peerReadTimeoutMs: 500 })
  t.teardown(() => setRuntimeConfig(config))
  const keyHex = await epochTwoCatalog(ctx.spaceId, 'sh1', 'doc.bin')
  const row = oldFolderRow(ctx, { catalogKeyEnc: keyHex, catalogEpoch: 2 })

  const { job } = await downloadChannel.resolvePendingRow(ctx.spaceId, row)
  t.is(job?.contentHash, HASH, 'the entry was read under the epoch-2 key')
  t.is(job?.ownerKey, OWNER, 'owned by the row\'s owner')
  t.is(job?.folderName, null, 'with no record to name the folder')
  t.absent(isPeerCatalogWatched(keyHex, 'download:sh1'), 'and no append watch is armed from a row\'s own key')
})

test('a loose row an earlier build wrote resolves through its owner\'s roster entry', async (t) => {
  const ctx = await setup(t)
  const keyHex = await ownCatalogKeyHex(ctx.spaceId)
  await upsertMember(ctx.spaceId, { publicKey: OWNER, looseCatalogKeyEnc: keyHex }, { verified: true })
  await advertise(ctx.spaceId, LOOSE_SHARE_ID, 'a.bin', { size: 4, mtime: 1, contentHash: HASH })
  const row = {
    filePath: '/a.bin', total: 4, inPlace: true, shareId: LOOSE_SHARE_ID, relPath: 'a.bin', ownerKey: OWNER,
    finalPath: path.join(ctx.tmpDir('dl'), 'a.bin'), contentHash: HASH, sourceSeq: 1, bytesTransferred: 0,
  }

  const { job } = await downloadChannel.resolvePendingRow(ctx.spaceId, row)
  t.is(job?.transferId, looseTransferIdFor(ctx.spaceId, 'a.bin'), 'the loose transfer')
  t.is(job?.pendingKey, '/a.bin', 'on the row\'s own key')
  t.is(job?.contentHash, HASH)
  t.is(job?.ownerKey, OWNER)
  t.ok(isPeerCatalogWatched(keyHex, 'download:' + LOOSE_SHARE_ID), 'an auto-resumed loose row arms change detection')
})

async function publishedFolder(ctx) {
  const share = {
    id: generateShareId(), type: 'owned-folder', name: 'Vault', owner: getLocalPublicKeyHex(), contentMode: 'overlay',
    catalogKeyEnc: await ownCatalogKeyHex(ctx.spaceId), catalogEpoch: 0, createdAt: Date.now(),
  }
  await publishShare(ctx.spaceId, share)
  await advertise(ctx.spaceId, share.id, 'doc.bin', { size: 4, mtime: 1, contentHash: HASH })
  return share
}

test('a folder row an earlier build wrote resolves through the owner\'s current record', async (t) => {
  const ctx = await setup(t)
  const share = await publishedFolder(ctx)
  // A stale plaintext key on the row: only the current record can open the catalog.
  const row = oldFolderRow(ctx, { shareId: share.id, ownerKey: share.owner, catalogKey: 'd'.repeat(64) })

  const { job } = await downloadChannel.resolvePendingRow(ctx.spaceId, row)
  t.is(job?.contentHash, HASH, 'read under the record\'s key, not the row\'s')
  t.is(job?.folderName, 'Vault', 'named by the record')
  t.is(job?.ownerKey, share.owner)
  t.is(job?.catalogKeyEnc, share.catalogKeyEnc, 'and the job carries the record\'s key forward')
  t.ok(isPeerCatalogWatched(share.catalogKeyEnc, 'download:' + share.id), 'a live record arms change detection')
})

test('a tombstoned share record resolves the row but arms no watch', async (t) => {
  const ctx = await setup(t)
  const share = await publishedFolder(ctx)
  await tombstoneShare(ctx.spaceId, share.id)
  const row = oldFolderRow(ctx, { shareId: share.id, ownerKey: share.owner, catalogKeyEnc: share.catalogKeyEnc, catalogEpoch: 0 })

  await downloadChannel.resolvePendingRow(ctx.spaceId, row)
  t.absent(isPeerCatalogWatched(share.catalogKeyEnc, 'download:' + share.id), 'a deleted share is not watched for changes')
})
