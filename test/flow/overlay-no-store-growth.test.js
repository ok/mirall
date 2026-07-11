import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, dirSize } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// The defining overlay guarantee, measured on the real on-disk stores: publishing
// imports NO blob into the owner's corestore, and downloading writes NO content
// blocks into the consumer's corestore — the bytes land only in the consumer's
// downloads FOLDER (a separate dir), fetched content-addressed straight from the
// owner's source file. An 8 MB file makes the signal unmistakable: if blocks were
// written, the store would grow by ~8 MB; here both stores grow by metadata only.
const FLAGS = { overlayEnabled: true }
const SIZE = 8 * 1024 * 1024 // dwarfs RocksDB WAL/compaction + catalog/chunk-map metadata

const flush = (ms = 1500) => new Promise((r) => setTimeout(r, ms))

test('overlay: publish imports no blob; download writes no content blocks into the consumer store',
  { timeout: scaled(180000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = mkTmpDir(t)
    const bStore = mkTmpDir(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, flags: FLAGS })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: bStore, downloads: mkTmpDir(t), flags: FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    const bytes = patternedBytes(SIZE, 5)
    fs.writeFileSync(path.join(folder, 'big.bin'), bytes)

    // ── Owner: publishing must not import the file into the corestore ──
    const aBeforePublish = dirSize(aStore)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone
    await flush()
    const aAfterPublish = dirSize(aStore)
    const aPublishDelta = aAfterPublish - aBeforePublish
    t.ok(aPublishDelta < SIZE / 4,
      `owner store grew ${aPublishDelta}B publishing an ${SIZE}B file — metadata only, no blob import`)

    // ── Consumer: measure the store right before the download ──
    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'big.bin' && e.status === 'remote'),
      { ms: 60000 })
    const bBeforeDownload = dirSize(bStore)

    const done = B.waitFor('event:transfer-complete', (m) => m.path === '/Vault/big.bin', 60000)
    const res = await B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'big.bin' })
    t.ok(res?.transferId, 'download returned a transferId (non-blocking)')
    const completed = await done
    t.ok(fs.existsSync(completed.localPath), 'file downloaded to disk')
    t.ok(fs.readFileSync(completed.localPath).equals(bytes), 'downloaded bytes match the source')
    t.ok(!completed.localPath.startsWith(bStore), 'downloaded file lives in the downloads folder, not the store')

    // ── Consumer: the corestore must not have grown by the file size ──
    await flush()
    const bAfterDownload = dirSize(bStore)
    const bDelta = bAfterDownload - bBeforeDownload
    t.ok(bDelta < SIZE / 4,
      `consumer store grew only ${bDelta}B downloading an ${SIZE}B file — NO content blocks written`)

    // ── Owner: serving streamed from the source file, not a core ──
    const aAfterServe = dirSize(aStore)
    const aServeDelta = aAfterServe - aAfterPublish
    t.ok(aServeDelta < SIZE / 4, `owner store grew only ${aServeDelta}B serving — no materialization`)
  })
