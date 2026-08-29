import test from 'brittle'
import Protomux from 'protomux'
import crypto from 'hypercore-crypto'
import { Duplex } from 'streamx'
import { tmpStore, tmpDir, fs, path } from './overlay-vendor-helpers.js'
import { HyperOverlayV2 } from '../../src/shared/transfer/backends/overlay/vendor/overlay-v2.js'
import { hashChunk } from '../../src/shared/transfer/backends/overlay/vendor/chunker.js'

// S1/S2: the membership serve gate lives at _onContentRequest, but the protocol
// has OTHER serve/receive entry points. In "mirall mode" (a serveAuthorizer is
// configured) those must be refused, or a connected peer could (S1) pull bytes
// via path-based fileRequest / direct chunkNeed without passing the gate, or (S2)
// overwrite the owner's source file via an unsolicited chunkHashes push.
function makeDuplex () {
  let aWrite, bWrite
  const a = new Duplex({ write (d, cb) { bWrite(d); cb() }, read () {} })
  const b = new Duplex({ write (d, cb) { aWrite(d); cb() }, read () {} })
  aWrite = (d) => a.push(d)
  bWrite = (d) => b.push(d)
  return [a, b]
}
const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms))
const MEMBER = 'a'.repeat(64)

test('S1: serve gate cannot be bypassed via fileRequest or direct chunkNeed', async (t) => {
  const pub = new HyperOverlayV2(tmpStore('byp-pub'), {
    namespace: 'mirall-overlay', destDir: tmpDir('byp-pub-d'),
    serveAuthorizer: async (peer, from) => from === MEMBER, // only MEMBER may fetch
  })
  await pub.ready()
  t.teardown(async () => { try { await pub.close() } catch {} })

  const content = crypto.randomBytes(128 * 1024)
  const oid = crypto.data(content).toString('hex')
  const src = path.join(tmpDir('byp-src'), 'doc.bin')
  fs.writeFileSync(src, content)
  await pub.registerFile('/mir/' + oid, src, { contentHash: oid, size: content.length })

  // Spy the owner's serve primitive: readChunk is only called when it actually
  // streams bytes out.
  let served = 0
  // The serve loop now reads through a per-session fd, so the spy moves to readChunkAt.
  const realRead = pub._transfer.readChunkAt.bind(pub._transfer)
  pub._transfer.readChunkAt = (...a) => { served++; return realRead(...a) }

  // Attacker: connected, but never authorized (no MEMBER identity).
  const atk = new HyperOverlayV2(tmpStore('byp-atk'), { namespace: 'mirall-overlay', destDir: tmpDir('byp-atk-d') })
  await atk.ready()
  t.teardown(async () => { try { await atk.close() } catch {} })
  const [pa, pb] = makeDuplex()
  pub.attachProtocol(Protomux.from(pa))
  const atkPeer = atk.attachProtocol(Protomux.from(pb))
  await settle()

  // Bypass attempt 1: path-based fileRequest for the registered serve path.
  atkPeer.msgs.fileRequest.send({ path: '/mir/' + oid, contentHash: oid, chunksHave: null })
  // Bypass attempt 2: skip the request entirely, demand chunks directly.
  atkPeer.msgs.chunkNeed.send({ path: '/mir/' + oid, indices: [0, 1, 2] })
  await settle(1500)
  t.is(served, 0, 'no bytes served to an unauthorized peer via fileRequest/chunkNeed')

  // Positive control: a real MEMBER fetch DOES serve (proves the spy + serve path).
  const member = new HyperOverlayV2(tmpStore('byp-mem'), {
    namespace: 'mirall-overlay', destDir: tmpDir('byp-mem-d'), localProfileKey: MEMBER,
  })
  await member.ready()
  t.teardown(async () => { try { await member.close() } catch {} })
  const [ma, mb] = makeDuplex()
  pub.attachProtocol(Protomux.from(ma))
  member.attachProtocol(Protomux.from(mb))
  await settle()
  const got = await member.fetchFile(oid, { timeout: 6000, reSeed: false })
  t.ok(got, 'authorized member fetch succeeds')
  t.ok(served > 0, 'serve path was exercised for the authorized fetch (spy works)')
})

test('S2: an unsolicited chunkHashes push cannot overwrite the owner source file', async (t) => {
  // Allow-all serve — proving the overwrite is blocked even when SERVING is open.
  const pub = new HyperOverlayV2(tmpStore('ovw-pub'), {
    namespace: 'mirall-overlay', destDir: tmpDir('ovw-pub-d'), serveAuthorizer: async () => true,
  })
  await pub.ready()
  t.teardown(async () => { try { await pub.close() } catch {} })

  const content = Buffer.from('the owner\'s real, precious source bytes')
  const oid = crypto.data(content).toString('hex')
  const src = path.join(tmpDir('ovw-src'), 'precious.txt')
  fs.writeFileSync(src, content)
  await pub.registerFile('/mir/' + oid, src, { contentHash: oid, size: content.length })

  const atk = new HyperOverlayV2(tmpStore('ovw-atk'), { namespace: 'mirall-overlay', destDir: tmpDir('ovw-atk-d') })
  await atk.ready()
  t.teardown(async () => { try { await atk.close() } catch {} })
  const [pa, pb] = makeDuplex()
  pub.attachProtocol(Protomux.from(pa))
  const atkPeer = atk.attachProtocol(Protomux.from(pb))
  await settle()

  // Forge a receive against the owner's OWN serve path: chunkHashes for /mir/<oid>
  // with attacker-chosen chunks, then the matching chunkData. Without the guard
  // the owner would startReceive on its own file and finalize-rename the attacker
  // bytes over it.
  const evil = Buffer.from('EVIL OVERWRITE PAYLOAD')
  atkPeer.msgs.chunkHashes.send({ path: '/mir/' + oid, tier: 0, chunks: [{ hash: hashChunk(evil), length: evil.length }] })
  atkPeer.msgs.chunkData.send({ path: '/mir/' + oid, index: 0, data: evil })
  await settle(1500)

  t.alike(fs.readFileSync(src), content, 'owner source file is byte-for-byte unchanged')
})
