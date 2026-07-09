import test from 'brittle'
import b4a from 'b4a'
import Corestore from 'corestore'
import { mkdtempSync, fs, path, os } from './overlay-vendor-helpers.js'
import { FileIndex } from '../../src/shared/transfer/backends/overlay/vendor/file-index.js'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initContentBackendOverlay } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'

function tmpStore (label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), label + '-'))
  return new Corestore(dir)
}

async function rawContains (core, needle) {
  for (let i = 0; i < core.length; i++) {
    const blk = await core.get(i, { decrypt: false, valueEncoding: 'binary' })
    if (blk && b4a.toString(blk).includes(needle)) return true
  }
  return false
}

const HASH = 'ab'.repeat(32)
const CHUNK = [{ hash: 'cd'.repeat(32), offset: 0, length: 42 }]

test('overlay FileIndex is ciphertext at rest with a key, decrypts in-process', async (t) => {
  const key = b4a.from('77'.repeat(32), 'hex')
  const store = tmpStore('overlay-enc')
  t.teardown(() => store.close())

  const idx = new FileIndex(store.namespace('mirall-overlay-e1'), { encryptionKey: key })
  await idx.ready()
  await idx.putFile('/docs/secret-plan.txt', { contentHash: HASH, size: 42, mtime: 123 })
  await idx.putChunkMapByHash(HASH, CHUNK)

  t.absent(await rawContains(idx.bee.core, '/docs/secret-plan.txt'), 'path not in any plaintext block')
  t.absent(await rawContains(idx.bee.core, HASH), 'contentHash not in plaintext')
  t.is((await idx.getFile('/docs/secret-plan.txt')).size, 42, 'file entry decrypts in-process')
  t.alike(await idx.getChunkMapByHash(HASH), CHUNK, 'chunk map decrypts in-process')

  await idx.close()
})

test('overlay FileIndex without a key stays plaintext (insecure/test fallback)', async (t) => {
  const store = tmpStore('overlay-plain')
  t.teardown(() => store.close())

  const idx = new FileIndex(store.namespace('mirall-overlay'))
  await idx.ready()
  await idx.putFile('/docs/visible.txt', { contentHash: 'ee'.repeat(32), size: 7, mtime: 1 })

  t.ok(await rawContains(idx.bee.core, '/docs/visible.txt'), 'plaintext present without a key')

  await idx.close()
})

test('initOverlay encrypts the local index cores when M is present', async (t) => {
  const ctx = await freshPeerWithIdentity(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true })
  await initOverlay()
  initContentBackendOverlay(ctx.fake.ipc)
  t.teardown(async () => { await teardownOverlay() })

  const dir = ctx.tmpDir('src')
  const file = path.join(dir, 'topsecret.bin')
  fs.writeFileSync(file, Buffer.alloc(4096, 9))

  const overlay = getOverlay()
  await overlay.registerFile('/mir/topsecret', file, {})

  const cores = overlay.localCores()
  t.ok(cores.length >= 3, 'file-index + index-meta + sync-feed present')
  for (const core of cores) {
    t.absent(await rawContains(core, '/mir/topsecret'), 'no plaintext path in a local index core')
  }
  t.ok(await overlay._index.getFile('/mir/topsecret'), 'index reads the entry back in-process')
})

test('a keyless peer replicating the encrypted index reads only ciphertext', async (t) => {
  const key = b4a.from('99'.repeat(32), 'hex')
  const A = tmpStore('wire-a')
  const B = tmpStore('wire-b')
  t.teardown(() => { A.close(); B.close() })

  const idx = new FileIndex(A.namespace('mirall-overlay-e1'), { encryptionKey: key })
  await idx.ready()
  await idx.putFile('/mir/leak-me', { contentHash: 'ff'.repeat(32), size: 5, mtime: 1 })
  const coreKey = idx.bee.core.key

  const s1 = A.replicate(true)
  const s2 = B.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  t.teardown(() => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} })

  const bCore = B.get({ key: coreKey, valueEncoding: 'binary' })
  await bCore.ready()
  await bCore.update({ wait: true })
  t.ok(bCore.length > 0, 'peer replicated the index blocks')

  let plaintext = false
  for (let i = 0; i < bCore.length; i++) {
    const blk = await bCore.get(i, { timeout: 10000 })
    if (blk && b4a.toString(blk).includes('/mir/leak-me')) plaintext = true
  }
  t.absent(plaintext, 'a peer without the key reads only ciphertext over the wire')

  await bCore.close()
  await idx.close()
})

test('encrypted overlay index reopens across a store restart with the same key', async (t) => {
  const key = b4a.from('33'.repeat(32), 'hex')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overlay-restart-'))
  t.teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })

  let store = new Corestore(dir)
  let idx = new FileIndex(store.namespace('mirall-overlay-e1'), { encryptionKey: key })
  await idx.ready()
  await idx.putFile('/mir/persist', { contentHash: '11'.repeat(32), size: 3, mtime: 1 })
  await idx.close()
  await store.close()

  store = new Corestore(dir)
  idx = new FileIndex(store.namespace('mirall-overlay-e1'), { encryptionKey: key })
  await idx.ready()
  t.is((await idx.getFile('/mir/persist'))?.size, 3, 'entry survives restart + reopens with the key')
  await idx.close()
  await store.close()
})
