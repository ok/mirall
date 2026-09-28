import test from 'brittle'
import Protomux from 'protomux'
import crypto from 'hypercore-crypto'
import { Duplex } from 'streamx'
import { tmpStore, tmpDir, fs, path } from './overlay-vendor-helpers.js'
import { HyperOverlayV2 } from '../../src/shared/transfer/backends/overlay/vendor/overlay-v2.js'
import { scaled } from '../helpers/bare-timing.js'

// The fetch gate: a download asks only the peers the holderAuthorizer accepts, adopts a chunk map
// only from a peer it asked and only when it fits the catalog size, and tells only the asked peers
// about its pause/progress. The raw peer here is any socket on the content topic: attached to the
// overlay channel, never authenticated, answering every request and pushing a forged map unasked.
function makeDuplex() {
  let aWrite, bWrite
  const a = new Duplex({ write(d, cb) { bWrite(d); cb() }, read() {} })
  const b = new Duplex({ write(d, cb) { aWrite(d); cb() }, read() {} })
  aWrite = (d) => a.push(d)
  bWrite = (d) => b.push(d)
  return [a, b]
}
const settle = (ms = 600) => new Promise((r) => setTimeout(r, scaled(ms)))
const MEMBER = 'a'.repeat(64)
const OWNER = 'b'.repeat(64)
const SUFFIX = '.mirall.part'

async function overlay(t, label, opts = {}) {
  const o = new HyperOverlayV2(tmpStore(label), { namespace: 'mirall-overlay', destDir: tmpDir(label + '-d'), partialSuffix: SUFFIX, ...opts })
  await o.ready()
  t.teardown(async () => { try { await o.close() } catch {} })
  return o
}

function link(a, b) {
  const [x, y] = makeDuplex()
  return [a.attachProtocol(Protomux.from(x)), b.attachProtocol(Protomux.from(y))]
}

async function scene(t, { holders, serveDelayMs = 300 }) {
  const content = crypto.randomBytes(192 * 1024)
  const oid = crypto.data(content).toString('hex')
  const src = path.join(tmpDir('hg-src'), 'doc.bin')
  fs.writeFileSync(src, content)

  const owner = await overlay(t, 'hg-own', { serveAuthorizer: async (_p, from) => from === MEMBER })
  await owner.registerFile('/mir/' + oid, src, { contentHash: oid, size: content.length })
  const realServe = owner._protocol._onContentRequest.bind(owner._protocol)
  owner._protocol._onContentRequest = async (peer, msg) => {
    await settle(serveDelayMs)
    if (!owner.closing) return realServe(peer, msg)
  }
  const ownerSeen = { transferControl: 0 }
  const realControl = owner._protocol._onTransferControl.bind(owner._protocol)
  owner._protocol._onTransferControl = (peer, msg) => { ownerSeen.transferControl++; return realControl(peer, msg) }

  const raw = await overlay(t, 'hg-raw')
  const seen = { contentRequest: 0, transferControl: 0, transferProgress: 0 }
  const forged = { path: 'content:' + oid, tier: 0, chunks: [{ hash: 'e'.repeat(64), length: content.length * 4 }], more: 0 }
  raw._protocol._onContentRequest = (peer) => { seen.contentRequest++; peer.msgs.chunkHashes.send(forged) }
  raw._protocol._onTransferControl = () => { seen.transferControl++ }
  raw._protocol._onTransferProgress = () => { seen.transferProgress++ }

  const accepted = new Set()
  const req = await overlay(t, 'hg-req', {
    localProfileKey: MEMBER,
    serveAuthorizer: async () => false,
    holderAuthorizer: (peer, ownerKey) => ownerKey === OWNER && accepted.has(peer),
  })
  const [ownerOnReq] = link(req, owner)
  const [rawOnReq, reqOnRaw] = link(req, raw)
  for (const name of holders) accepted.add(name === 'owner' ? ownerOnReq : rawOnReq)
  await settle()
  const spam = setInterval(() => { try { reqOnRaw.msgs.chunkHashes.send(forged) } catch {} }, 20)
  t.teardown(() => clearInterval(spam))
  return { req, content, oid, seen, ownerSeen }
}

test('REGRESSION (MIR-46: a raw peer answering first cannot poison the download)', async (t) => {
  const { req, content, oid, seen } = await scene(t, { holders: ['owner'] })
  const dest = path.join(tmpDir('hg-out'), 'doc.bin')
  const got = await req.fetchFile(oid, { destPath: dest, ownerKey: OWNER, size: content.length, timeout: scaled(6000), reSeed: false })
  t.ok(got, 'the fetch completed')
  t.alike(got ? fs.readFileSync(dest) : null, content, "the owner's bytes landed")
  t.is(seen.contentRequest, 0, 'the raw peer never received the content request')
})

test('REGRESSION (MIR-46: a map whose sum is not the catalog size creates no partial)', async (t) => {
  const { req, content, oid } = await scene(t, { holders: ['raw'] })
  const dest = path.join(tmpDir('hg-out2'), 'doc.bin')
  let started = 0
  const real = req._transfer.startReceive.bind(req._transfer)
  req._transfer.startReceive = (...a) => { started++; return real(...a) }
  const got = await req.fetchFile(oid, { destPath: dest, ownerKey: OWNER, size: content.length, timeout: scaled(3000), reSeed: false })
  t.is(got, null, 'reported as no holder, not as an integrity failure')
  t.is(started, 0, 'startReceive never ran')
  t.absent(fs.existsSync(dest + SUFFIX), 'no partial was created or truncated')
})

test('REGRESSION (MIR-67: a pause reaches only the peer we asked)', async (t) => {
  const { req, content, oid, seen, ownerSeen } = await scene(t, { holders: ['owner'], serveDelayMs: 3000 })
  const dest = path.join(tmpDir('hg-out3'), 'doc.bin')
  const f = req.fetchFile(oid, { destPath: dest, ownerKey: OWNER, size: content.length, timeout: scaled(12000), reSeed: false })
  await settle(500)
  t.ok(await req.cancelFetch(oid, { discardPartial: false }), 'the pause hit a live fetch')
  await f.catch(() => {})
  await settle()
  t.is(ownerSeen.transferControl, 1, 'the asked holder was told')
  t.is(seen.transferControl + seen.transferProgress, 0, 'the raw peer saw no transfer frames')
})

test('MIR-46: with no accepted holder the fetch reports no holder without asking anyone', async (t) => {
  const { req, content, oid, seen } = await scene(t, { holders: [] })
  const got = await req.fetchFile(oid, { ownerKey: OWNER, size: content.length, peerWaitMs: 300, timeout: scaled(3000), reSeed: false })
  t.is(got, null)
  t.is(seen.contentRequest, 0)
})
