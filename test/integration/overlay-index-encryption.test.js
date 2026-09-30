import test from 'brittle'
import b4a from 'b4a'
import Corestore from 'corestore'
import { mkdtempSync, fs, path, os } from './overlay-engine-helpers.js'
import { FileIndex } from '../../src/shared/transfer/overlay/engine/store/file-index.js'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/overlay/overlay-instance.js'
import { initOverlayIpc } from '../helpers/overlay-ipc.js'

function tmpStore(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), label + '-'))
  return new Corestore(dir)
}

async function rawContains(core, needle) {
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
  await idx.putChunkMapByHash(HASH, CHUNK)

  t.absent(await rawContains(idx.bee.core, HASH), 'contentHash not in plaintext')
  t.absent(await rawContains(idx.bee.core, CHUNK[0].hash), 'chunk hash not in plaintext')
  t.alike(await idx.getChunkMapByHash(HASH), CHUNK, 'chunk map decrypts in-process')

  await idx.close()
})

test('overlay FileIndex without a key stays plaintext (insecure/test fallback)', async (t) => {
  const store = tmpStore('overlay-plain')
  t.teardown(() => store.close())

  const idx = new FileIndex(store.namespace('mirall-overlay'))
  await idx.ready()
  await idx.putChunkMapByHash('ee'.repeat(32), CHUNK)

  t.ok(await rawContains(idx.bee.core, 'ee'.repeat(32)), 'plaintext present without a key')

  await idx.close()
})

test('initOverlay encrypts the local index cores when M is present', async (t) => {
  const ctx = await freshPeer(t)
  await initOverlay()
  initOverlayIpc(ctx.fake.ipc)
  t.teardown(async () => { await teardownOverlay() })

  const dir = ctx.tmpDir('src')
  const file = path.join(dir, 'topsecret.bin')
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 9))

  const overlay = getOverlay()
  const { contentHash } = await overlay.prepareForServe(file)
  await overlay.registerFile(file, { contentHash })

  const cores = overlay.localCores()
  t.is(cores.length, 2, 'file-index + index-meta')
  for (const core of cores) {
    t.absent(await rawContains(core, contentHash), 'no plaintext hash in a local index core')
  }
  t.ok(await overlay.index.getChunkMapByHash(contentHash), 'index reads the entry back in-process')
})

test('a keyless peer replicating the encrypted index reads only ciphertext', async (t) => {
  const key = b4a.from('99'.repeat(32), 'hex')
  const A = tmpStore('wire-a')
  const B = tmpStore('wire-b')
  t.teardown(() => { A.close(); B.close() })

  const idx = new FileIndex(A.namespace('mirall-overlay-e1'), { encryptionKey: key })
  await idx.ready()
  await idx.putChunkMapByHash('ff'.repeat(32), CHUNK)
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
    if (blk && b4a.toString(blk).includes('ff'.repeat(32))) plaintext = true
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
  await idx.putChunkMapByHash('11'.repeat(32), CHUNK)
  await idx.close()
  await store.close()

  store = new Corestore(dir)
  idx = new FileIndex(store.namespace('mirall-overlay-e1'), { encryptionKey: key })
  await idx.ready()
  t.alike(await idx.getChunkMapByHash('11'.repeat(32)), CHUNK, 'entry survives restart + reopens with the key')
  await idx.close()
  await store.close()
})
