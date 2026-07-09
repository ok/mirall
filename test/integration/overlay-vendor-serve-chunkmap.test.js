import test from 'brittle'
import Protomux from 'protomux'
import crypto from 'hypercore-crypto'
import { Duplex } from 'streamx'
import { tmpStore, tmpDir, fs, path } from './overlay-vendor-helpers.js'
import { HyperOverlayV2 } from '../../src/shared/transfer/backends/overlay/vendor/overlay-v2.js'

function makeDuplex () {
  let aWrite, bWrite
  const a = new Duplex({ write (d, cb) { bWrite(d); cb() }, read () {} })
  const b = new Duplex({ write (d, cb) { aWrite(d); cb() }, read () {} })
  aWrite = (d) => a.push(d)
  bWrite = (d) => b.push(d)
  return [a, b]
}
const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms))

// REGRESSION (FIX: multi-second stall before a large overlay download starts):
// the owner re-chunked the whole file on every serve because the serve key
// ('content:<hash>') differed from the publish key ('/mir/<hash>'), so the
// publish-time chunk-map cache always missed. For a multi-GB file that is a
// full-file read of latency BEFORE the first byte ships. The chunk map is
// content-addressed, so publish and serve must share it — a publish-then-serve
// must NOT re-chunk.
test('owner reuses the publish-time chunk map at serve (no re-chunk)', async (t) => {
  const pub = new HyperOverlayV2(tmpStore('cm-pub'), {
    namespace: 'mirall-overlay', destDir: tmpDir('cm-pub-d'), serveAuthorizer: async () => true,
  })
  await pub.ready()
  t.teardown(async () => { try { await pub.close() } catch {} })

  const content = crypto.randomBytes(2 * 1024 * 1024) // 2MB → >1MB, so a chunk map persists
  const oid = crypto.data(content).toString('hex')
  const src = path.join(tmpDir('cm-src'), 'big.bin')
  fs.writeFileSync(src, content)

  // Publish — chunks the file exactly once.
  await pub.registerFile('/mir/' + oid, src, { contentHash: oid, size: content.length })
  t.ok(await pub._index.getChunkMapByHash(oid), 'publish populated the content-addressed chunk map')

  // Spy AFTER publish: from here, any prepareFile call is a serve-time re-chunk.
  let reChunks = 0
  const realPrepare = pub._transfer.prepareFile.bind(pub._transfer)
  pub._transfer.prepareFile = (...a) => { reChunks++; return realPrepare(...a) }

  const con = new HyperOverlayV2(tmpStore('cm-con'), { namespace: 'mirall-overlay', destDir: tmpDir('cm-con-d') })
  await con.ready()
  t.teardown(async () => { try { await con.close() } catch {} })
  const [pa, pb] = makeDuplex()
  pub.attachProtocol(Protomux.from(pa))
  con.attachProtocol(Protomux.from(pb))
  await settle()

  const got = await con.fetchFile(oid, { timeout: 8000, reSeed: false })
  t.ok(got, 'consumer fetched the file')
  t.is(Buffer.compare(fs.readFileSync(got.destPath), content), 0, 'bytes match')
  t.is(reChunks, 0, 'owner did NOT re-chunk at serve — the publish-time map was reused')
})

test('REGRESSION (FIX-3): registerFile returns null (no throw) when the source is gone', async (t) => {
  const ov = new HyperOverlayV2(tmpStore('rf-gone'), {
    namespace: 'mirall-overlay', destDir: tmpDir('rf-gone-d'), serveAuthorizer: async () => true,
  })
  await ov.ready()
  t.teardown(async () => { try { await ov.close() } catch {} })

  // Source moved out between prepare and register (narrow TOCTOU). Pre-fix this throws
  // ENOENT out of makeServable; post-fix it bails with null.
  const res = await ov.registerFile('/mir/deadbeef', path.join(tmpDir('rf-gone-src'), 'nope.bin'), {
    contentHash: 'deadbeef', size: 123,
  })
  t.is(res, null, 'missing source → null, not a thrown ENOENT')
})
