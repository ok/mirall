import test from 'brittle'
import b4a from 'b4a'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { initStore, getStore, setMasterSecret, overlayIndexEncryptionKey } from '../../src/shared/core/store.js'
import { FileIndex } from '../../src/shared/transfer/backends/overlay/vendor/file-index.js'
import { migrateOverlayIndexToEncrypted } from '../../src/shared/transfer/backends/overlay/migrate-overlay-index-encrypt.js'

function tmp (label) {
  const dir = path.join(os.tmpdir(), `ovmig-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function rawContains (core, needle) {
  for (let i = 0; i < core.length; i++) {
    const blk = await core.get(i, { decrypt: false, valueEncoding: 'binary' })
    if (blk && b4a.toString(blk).includes(needle)) return true
  }
  return false
}

async function coreInStore (dkHex) {
  for await (const dk of getStore().list()) {
    if (b4a.toString(dk, 'hex') === dkHex) return true
  }
  return false
}

const HASH = 'ab'.repeat(32)
const CHUNK = [{ hash: 'cd'.repeat(32), offset: 0, length: 100 }]

test('REGRESSION: migration copies the plaintext overlay index into an encrypted generation and purges the plaintext', async (t) => {
  const M = b4a.from('55'.repeat(32), 'hex')
  const root = tmp('run')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  initStore(path.join(root, 'app-storage'))
  setMasterSecret(M)

  const legacy = new FileIndex(getStore().namespace('mirall-overlay'))
  await legacy.ready()
  await legacy.putFile('/mir/secret.bin', { contentHash: HASH, size: 100, mtime: 5 })
  await legacy.putChunkMapByHash(HASH, CHUNK)
  const legacyMainDk = b4a.toString(legacy.bee.core.discoveryKey, 'hex')
  t.ok(await rawContains(legacy.bee.core, '/mir/secret.bin'), 'precondition: legacy index is plaintext')
  await legacy.close()

  const res = await migrateOverlayIndexToEncrypted()
  t.is(res.skipped, false, 'migration ran')
  t.ok(res.copied >= 1, 'copied at least the file + chunk-map entries')

  const enc = new FileIndex(getStore().namespace('mirall-overlay-e1'), { encryptionKey: overlayIndexEncryptionKey() })
  await enc.ready()
  t.is((await enc.getFile('/mir/secret.bin'))?.size, 100, 'file entry copied into the encrypted generation')
  t.alike(await enc.getChunkMapByHash(HASH), CHUNK, 'chunk map preserved (no re-chunk needed)')
  t.absent(await rawContains(enc.bee.core, '/mir/secret.bin'), 'encrypted at rest')
  await enc.close()

  t.absent(await coreInStore(legacyMainDk), 'legacy plaintext core purged from the store')

  const res2 = await migrateOverlayIndexToEncrypted()
  t.is(res2.skipped, true, 'second run is a marker-gated no-op')

  await getStore().close()
})

test('REGRESSION: the purged plaintext generation reopens clean across a restart (alias dropped, no STORAGE_EMPTY)', async (t) => {
  const M = b4a.from('77'.repeat(32), 'hex')
  const root = tmp('reopen')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
  const storePath = path.join(root, 'app-storage')

  // Boot 1: seed a plaintext overlay index + migrate + shut down.
  initStore(storePath)
  setMasterSecret(M)
  const legacy = new FileIndex(getStore().namespace('mirall-overlay'))
  await legacy.ready()
  await legacy.putFile('/mir/secret.bin', { contentHash: HASH, size: 100, mtime: 5 })
  await legacy.close()
  await migrateOverlayIndexToEncrypted()
  await getStore().close()

  // Boot 2: a fresh worker WITHOUT M (insecure/no-KEK) reopens the plaintext generation. Unless
  // the purge dropped the by-name alias, index-meta.ready() would hit a dangling alias and throw
  // STORAGE_EMPTY (which _open does not guard for index-meta) → overlay/worker boot crash.
  initStore(storePath)
  setMasterSecret(null)
  const reopened = new FileIndex(getStore().namespace('mirall-overlay'))
  await reopened.ready() // must not throw
  t.is(reopened.bee.core.length, 0, 'plaintext generation reopens fresh + empty')
  t.is(await reopened.getFile('/mir/secret.bin'), null, 'no cleartext survives the purge')
  await reopened.close()
  await getStore().close()
})

test('REGRESSION: migration purges an orphaned older (compacted) plaintext generation too', async (t) => {
  const M = b4a.from('66'.repeat(32), 'hex')
  const root = tmp('orphan')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  initStore(path.join(root, 'app-storage'))
  setMasterSecret(M)

  // Seed v1 with droppable content, then compact to v2 WITHOUT purging v1 — simulating a
  // compaction interrupted after the version flip (file-index.js) but before the caller's
  // clearAndPurgeCore. v1 is left orphaned and plaintext.
  const legacy = new FileIndex(getStore().namespace('mirall-overlay'))
  await legacy.ready()
  await legacy.putFile('/mir/keep.bin', { contentHash: HASH, size: 10, mtime: 1 })
  await legacy.putChunkMapByHash(HASH, CHUNK)
  const v1Dk = b4a.toString(legacy.bee.core.discoveryKey, 'hex')
  const oldCore = await legacy.compact({ isServed: () => false }) // drops the oid map → rolls to v2
  t.ok(oldCore, 'precondition: compaction rolled to a new generation')
  t.is(b4a.toString(oldCore.discoveryKey, 'hex'), v1Dk, 'orphaned core is the old v1')
  t.is(legacy.version, 2, 'current generation is v2')
  const v2Dk = b4a.toString(legacy.bee.core.discoveryKey, 'hex')
  await oldCore.close() // release the session but do NOT purge — leaves v1 on disk as an orphan
  await legacy.close()

  t.ok(await coreInStore(v1Dk), 'precondition: orphaned v1 present before migration')

  const res = await migrateOverlayIndexToEncrypted()
  t.is(res.skipped, false, 'migration ran')

  t.absent(await coreInStore(v1Dk), 'orphaned v1 plaintext generation purged')
  t.absent(await coreInStore(v2Dk), 'current v2 plaintext generation purged')

  await getStore().close()
})

test('migration is a no-op without a master secret', async (t) => {
  const root = tmp('nom')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  initStore(path.join(root, 'app-storage'))
  setMasterSecret(null)

  const res = await migrateOverlayIndexToEncrypted()
  t.is(res.skipped, true, 'skipped without M')

  await getStore().close()
})
