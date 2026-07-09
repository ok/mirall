// A2 gate: exercise the §4.1 serve authorization hook end-to-end through the
// real vendored protocol. A publisher registers a file with a serveAuthorizer
// that only admits a specific requester identity; an approved consumer fetches
// the bytes, a non-member gets a "miss" (silent drop → fetch returns null).
// This proves the injected gate denies WITHOUT a membership oracle.
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

const settle = (ms = 400) => new Promise(r => setTimeout(r, ms))
const MEMBER = 'a'.repeat(64)
const STRANGER = 'b'.repeat(64)

test('serve gate: approved member fetches, non-member gets a miss', async (t) => {
  // Publisher admits ONLY the MEMBER identity (stand-in for the real MIR-01/28 gate).
  const seen = []
  const pub = new HyperOverlayV2(tmpStore('ov2-gate-pub'), {
    namespace: 'mirall-overlay',
    destDir: tmpDir('ov2-gate-pub-dest'),
    serveAuthorizer: async (peer, from, contentHash) => { seen.push(from); return from === MEMBER },
  })
  const member = new HyperOverlayV2(tmpStore('ov2-gate-member'), {
    namespace: 'mirall-overlay', destDir: tmpDir('ov2-gate-member-dest'), localProfileKey: MEMBER,
  })
  const stranger = new HyperOverlayV2(tmpStore('ov2-gate-stranger'), {
    namespace: 'mirall-overlay', destDir: tmpDir('ov2-gate-stranger-dest'), localProfileKey: STRANGER,
  })
  await pub.ready(); await member.ready(); await stranger.ready()
  t.teardown(async () => {
    for (const o of [pub, member, stranger]) { try { await o.close() } catch {} }
  })

  // Publish a file servable by content hash.
  const content = crypto.randomBytes(200 * 1024)
  const oid = crypto.data(content).toString('hex')
  const srcDir = tmpDir('ov2-gate-src')
  const srcPath = path.join(srcDir, 'doc.bin')
  fs.writeFileSync(srcPath, content)
  await pub.registerFile('/mir/' + oid, srcPath, { contentHash: oid, size: content.length })

  // Member connection → fetch succeeds, bytes match.
  const [ma, mb] = makeDuplex()
  pub.attachProtocol(Protomux.from(ma))
  member.attachProtocol(Protomux.from(mb))
  await settle()
  const got = await member.fetchFile(oid, { timeout: 6000, reSeed: false })
  t.ok(got, 'approved member fetched the file')
  if (got) t.is(Buffer.compare(fs.readFileSync(got.destPath), content), 0, 'bytes match')

  // Stranger connection → denied → silent drop → fetch times out → null.
  const [sa, sb] = makeDuplex()
  pub.attachProtocol(Protomux.from(sa))
  stranger.attachProtocol(Protomux.from(sb))
  await settle()
  const denied = await stranger.fetchFile(oid, { timeout: 1500, peerWaitMs: 1000, reSeed: false })
  t.is(denied, null, 'non-member got a miss (no bytes, no oracle)')

  t.ok(seen.includes(MEMBER), 'gate saw the member identity')
  t.ok(seen.includes(STRANGER), 'gate saw (and rejected) the stranger identity')
})
