import test from 'brittle'
import crypto from 'hypercore-crypto'
import { tmpDir, fs, path } from './overlay-engine-helpers.js'
import { SUFFIX, overlay, link } from './overlay-link-helpers.js'
import { scaled } from '../helpers/bare-timing.js'
import { waitFor } from '../helpers/bare-poll.js'
import { createBandwidthLimiter } from '../../src/shared/transfer/bandwidth-limiter.js'

// The fetch gate: a download asks only the peers the holderAuthorizer accepts, adopts a chunk map
// only from a peer it asked and only when it fits the catalog size, and tells only the asked peers
// about its pause/progress. The raw peer here is any socket on the content topic: attached to the
// overlay channel, never authenticated, answering every request and pushing a forged map unasked.
const settle = (ms = 600) => new Promise((r) => setTimeout(r, scaled(ms)))
const MEMBER = 'a'.repeat(64)
const OWNER = 'b'.repeat(64)

async function scene(t, { holders, serveDelayMs = 300, reqOpts = {} }) {
  const content = crypto.randomBytes(192 * 1024)
  const oid = crypto.data(content).toString('hex')
  const src = path.join(tmpDir('hg-src'), 'doc.bin')
  fs.writeFileSync(src, content)

  const owner = await overlay(t, 'hg-own', { serveAuthorizer: async (_p, from) => from === MEMBER })
  await owner.registerFile(src, { contentHash: oid, size: content.length })
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
    ...reqOpts,
  })
  const [ownerOnReq] = link(req, owner)
  const [rawOnReq, reqOnRaw] = link(req, raw)
  for (const name of holders) accepted.add(name === 'owner' ? ownerOnReq : rawOnReq)
  await settle()
  const spam = setInterval(() => { try { reqOnRaw.msgs.chunkHashes.send(forged) } catch {} }, 20)
  t.teardown(() => clearInterval(spam))
  return { req, content, oid, seen, ownerSeen, rawOnReq, reqOnRaw }
}

test('REGRESSION (MIR-46: a raw peer answering first cannot poison the download)', async (t) => {
  const { req, content, oid, seen } = await scene(t, { holders: ['owner'] })
  const dest = path.join(tmpDir('hg-out'), 'doc.bin')
  const got = await req.fetchFile(oid, { destPath: dest, ownerKey: OWNER, size: content.length, timeout: scaled(6000) })
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
  const got = await req.fetchFile(oid, { destPath: dest, ownerKey: OWNER, size: content.length, timeout: scaled(3000) })
  t.is(got, null, 'reported as no holder, not as an integrity failure')
  t.is(started, 0, 'startReceive never ran')
  t.absent(fs.existsSync(dest + SUFFIX), 'no partial was created or truncated')
})

test('REGRESSION (MIR-67: a pause reaches only the peer we asked)', async (t) => {
  const { req, content, oid, seen, ownerSeen } = await scene(t, { holders: ['owner'], serveDelayMs: 3000 })
  const dest = path.join(tmpDir('hg-out3'), 'doc.bin')
  const f = req.fetchFile(oid, { destPath: dest, ownerKey: OWNER, size: content.length, timeout: scaled(12000) })
  await settle(500)
  t.ok(await req.cancelFetch(oid, { discardPartial: false }), 'the pause hit a live fetch')
  await f.catch(() => {})
  await settle()
  t.is(ownerSeen.transferControl, 1, 'the asked holder was told')
  t.is(seen.transferControl + seen.transferProgress, 0, 'the raw peer saw no transfer frames')
})

test('MIR-46: with no accepted holder the fetch reports no holder without asking anyone', async (t) => {
  const { req, content, oid, seen } = await scene(t, { holders: [] })
  const got = await req.fetchFile(oid, { ownerKey: OWNER, size: content.length, peerWaitMs: 300, timeout: scaled(3000) })
  t.is(got, null)
  t.is(seen.contentRequest, 0)
})

// The download cap, with every refund made through a fetch's own stream handle counted.
function countingLimiter(t, bytesPerSecond) {
  const limiter = createBandwidthLimiter(() => bytesPerSecond)
  t.teardown(() => limiter.destroy())
  const refunds = { bytes: 0 }
  const stream = () => {
    const s = limiter.stream()
    const give = s.give
    s.give = (bytes) => { refunds.bytes += bytes; give(bytes) }
    return s
  }
  return { refunds, limiter: { ...limiter, stream } }
}

test('REGRESSION (MIR-53: chunk data from a peer the fetch took no map from reaches neither the scheduler nor the download cap)', async (t) => {
  const { refunds, limiter } = countingLimiter(t, 32 * 1024)
  const { req, content, oid, rawOnReq, reqOnRaw } = await scene(t, { holders: ['owner'], reqOpts: { downloadLimiter: limiter } })
  const p = 'content:' + oid
  const f = req.fetchFile(oid, { destPath: path.join(tmpDir('hg-out5'), 'doc.bin'), ownerKey: OWNER, size: content.length, timeout: scaled(20000) })
  f.catch(() => {})
  await waitFor(() => req._protocol._schedulers.get(p)?._chunks, 5000, { interval: 10, label: "the owner's map adopted" })
  const sched = req._protocol._schedulers.get(p)
  const reached = []
  const onChunkData = sched.onChunkData.bind(sched)
  sched.onChunkData = (peer, index, data) => { if (peer === rawOnReq) reached.push(index); return onChunkData(peer, index, data) }

  const last = sched._chunks.length - 1
  const junk = Buffer.alloc(sched._chunks[last].length, 0x55)
  for (let i = 0; i < 20; i++) reqOnRaw.msgs.chunkData.send({ path: p, index: last, data: junk })
  await settle(300)
  t.ok(req._protocol._schedulers.get(p) === sched && !sched._done, 'precondition: the fetch was still running as the frames landed')

  t.is(reached.length, 0, 'no frame from the raw peer reached the scheduler')
  t.is(refunds.bytes, 0, 'the download cap took no refund')
  t.absent(sched._peers.has(rawOnReq), 'the raw peer is not a source')
  t.is(sched._peers.size, 1, 'the owner still is')
  await req.cancelFetch(oid, { discardPartial: true })
})
