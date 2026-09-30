import test from 'brittle'
import crypto from 'hypercore-crypto'
import Protomux from 'protomux'
import c from 'compact-encoding'
import { tmpDir, fs, path } from './overlay-engine-helpers.js'
import { SUFFIX, overlay, link, makeDuplex } from './overlay-link-helpers.js'
import * as m from '../../src/shared/transfer/backends/overlay/engine/messages-v2.js'
import { hashChunk } from '../../src/shared/transfer/backends/overlay/engine/chunker.js'
import { scaled } from '../helpers/bare-timing.js'
import { sendLegacy } from '../helpers/legacy-overlay-frames.js'

// S1/S2: the membership serve gate lives at _onContentRequest, but a connected peer can put any
// frame on the channel. Those must be refused, or it could (S1) pull bytes via a retired fileRequest
// or a direct chunkNeed without passing the gate, or (S2) overwrite the owner's source file via an
// unsolicited chunkHashes push.
const settle = (ms = 800) => new Promise((r) => setTimeout(r, scaled(ms)))
const MEMBER = 'a'.repeat(64)

test('S1: serve gate cannot be bypassed via fileRequest or direct chunkNeed', async (t) => {
  const pub = await overlay(t, 'byp-pub', { serveAuthorizer: async (peer, from) => from === MEMBER }) // only MEMBER may fetch

  const content = crypto.randomBytes(128 * 1024)
  const oid = crypto.data(content).toString('hex')
  const src = path.join(tmpDir('byp-src'), 'doc.bin')
  fs.writeFileSync(src, content)
  await pub.registerFile(src, { contentHash: oid, size: content.length })

  // Spy the owner's serve primitive: readChunk is only called when it actually
  // streams bytes out.
  let served = 0
  // The serve loop now reads through a per-session fd, so the spy moves to readChunkAt.
  const realRead = pub._transfer.readChunkAt.bind(pub._transfer)
  pub._transfer.readChunkAt = (...a) => { served++; return realRead(...a) }

  // Attacker: connected, but never authorized (no MEMBER identity).
  const atk = await overlay(t, 'byp-atk')
  const [, atkPeer] = link(pub, atk)
  await settle()

  // Bypass attempt 1: path-based fileRequest for the registered serve path.
  sendLegacy(atkPeer, 'fileRequest', { path: '/mir/' + oid, contentHash: oid })
  // Bypass attempt 2: skip the request entirely, demand chunks directly.
  atkPeer.msgs.chunkNeed.send({ path: '/mir/' + oid, indices: [0, 1, 2] })
  atkPeer.msgs.chunkNeed.send({ path: 'content:' + oid, indices: [0, 1, 2] })
  await settle(1500)
  t.is(served, 0, 'no bytes served to an unauthorized peer via fileRequest/chunkNeed')

  // Positive control: a real MEMBER fetch DOES serve (proves the spy + serve path).
  const member = await overlay(t, 'byp-mem', { localProfileKey: MEMBER })
  link(pub, member)
  await settle()
  const got = await member.fetchFile(oid, { destPath: path.join(tmpDir('byp-out'), 'doc.bin'), timeout: 6000 })
  t.ok(got, 'authorized member fetch succeeds')
  t.ok(served > 0, 'serve path was exercised for the authorized fetch (spy works)')
})

test('S2: an unsolicited chunkHashes push cannot overwrite the owner source file', async (t) => {
  // Allow-all serve — proving the overwrite is blocked even when SERVING is open.
  const pub = await overlay(t, 'ovw-pub', { serveAuthorizer: async () => true })

  const content = Buffer.from('the owner\'s real, precious source bytes')
  const oid = crypto.data(content).toString('hex')
  const src = path.join(tmpDir('ovw-src'), 'precious.txt')
  fs.writeFileSync(src, content)
  await pub.registerFile(src, { contentHash: oid, size: content.length })

  const atk = await overlay(t, 'ovw-atk')
  const [, atkPeer] = link(pub, atk)
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

async function syncRows(o) {
  const keys = []
  for await (const { key } of o._index.bee.createReadStream({ gte: 'sync:', lt: 'sync;' })) keys.push(key)
  return keys
}

// Counts the frames that arrive on a peer record's slot 0 (the retired syncState).
function countSlot0(peer) {
  const seen = { frames: 0 }
  peer.channel.messages[0].onmessage = () => { seen.frames++ }
  return seen
}

// Any socket on the content topic is an overlay peer before its identity is known. The retired
// path-sync frames must be no-ops: no index row, no receive cancelled.
test('REGRESSION (MIR-53: legacy sync frames from an unverified peer write no index row and cancel no receive)', async (t) => {
  const victim = await overlay(t, 'l53-vic', { serveAuthorizer: async () => false, journalDir: tmpDir('l53-j') })
  const atk = await overlay(t, 'l53-atk')

  // A stale registration still names the path a receive is now in flight to.
  const target = path.join(tmpDir('l53-dl'), 'doc.bin')
  const old = Buffer.from('an owned file that used to live here')
  const oldHash = crypto.data(old).toString('hex')
  fs.writeFileSync(target, old)
  await victim.registerFile(target, { contentHash: oldHash, size: old.length })
  fs.unlinkSync(target)
  const content = crypto.randomBytes(64 * 1024)
  const state = await victim._transfer.startReceive(target, {
    size: content.length,
    contentHash: crypto.data(content).toString('hex'),
    chunks: [{ hash: hashChunk(content), offset: 0, length: content.length }],
  })
  t.teardown(() => victim._transfer.cancel(target))
  victim._transfer._flushJournalSync(state)
  t.ok(fs.existsSync(target + SUFFIX) && fs.existsSync(state.journalPath), 'precondition: partial and journal on disk')

  const [, atkPeer] = link(victim, atk)
  await settle()
  const before = victim._index.bee.core.length
  sendLegacy(atkPeer, 'syncState', { feedKey: Buffer.alloc(4096, 0xab), localSeq: 1, remoteSeq: 0 })
  await settle(200)
  for (let i = 0; i < 16; i++) sendLegacy(atkPeer, 'transferComplete', { path: '/junk/' + i, contentHash: 'cd'.repeat(32) })
  sendLegacy(atkPeer, 'chunkCancel', { path: '/mir/' + oldHash })
  sendLegacy(atkPeer, 'chunkCancel', { path: target })
  await settle(1500)

  t.is(victim._index.bee.core.length, before, 'the index core did not grow')
  t.alike(await syncRows(victim), [], 'no sync: row exists')
  t.ok(fs.existsSync(target + SUFFIX), 'the partial survived the chunkCancel')
  t.ok(fs.existsSync(state.journalPath), 'so did its resume journal')
  t.ok(victim._transfer._active.has(target), 'and the receive is still active')
})

test('REGRESSION (MIR-53: mirall mode announces no sync feed on open)', async (t) => {
  const gated = await overlay(t, 'l53-open', { serveAuthorizer: async () => false })
  const other = await overlay(t, 'l53-open-other')
  const [, otherSide] = link(gated, other)
  const seen = countSlot0(otherSide)
  await settle()
  t.ok(otherSide.remoteVersion !== null, 'the channel is up')
  t.is(seen.frames, 0, 'the gated overlay sent nothing on slot 0')
})

test('REGRESSION (MIR-53: evicting a hash drops its chunk map, and a re-registered hash still serves)', async (t) => {
  const pub = await overlay(t, 'l53-ev', { serveAuthorizer: async (_p, from) => from === MEMBER })
  const member = await overlay(t, 'l53-ev-m', { localProfileKey: MEMBER })
  const content = crypto.randomBytes(64 * 1024)
  const oid = crypto.data(content).toString('hex')
  const src = path.join(tmpDir('l53-ev-src'), 'doc.bin')
  fs.writeFileSync(src, content)
  await pub.registerFile(src, { contentHash: oid, size: content.length })
  link(pub, member)
  await settle()

  const first = await member.fetchFile(oid, { destPath: path.join(tmpDir('l53-ev-o1'), 'a.bin'), timeout: scaled(6000) })
  t.ok(first, 'served before the evict')
  t.ok(pub._filePaths.has('content:' + oid), 'precondition: the serve left its content: entry')
  t.ok(await pub._index.getChunkMapByHash(oid), 'precondition: the serve persisted its chunk map')

  await pub.evictContent(oid)
  t.absent(await pub._index.getChunkMapByHash(oid), 'the chunk map is gone')
  t.ok(pub._filePaths.has('content:' + oid), 'the serve entry stays for a download still in flight')

  await pub.registerFile(src, { contentHash: oid, size: content.length })
  const again = await member.fetchFile(oid, { destPath: path.join(tmpDir('l53-ev-o2'), 'b.bin'), timeout: scaled(6000) })
  t.alike(again ? fs.readFileSync(again.destPath) : null, content, 'a re-registered hash serves again')
})

// A 1.11.x overlay differs on the wire only by announcing its sync feed on open; adding that send
// to this build's overlay stands in for it.
function announcingFeed(o) {
  const proto = o._protocol
  const open = proto._onOpen.bind(proto)
  proto._onOpen = (peer, hs) => {
    open(peer, hs)
    if (!peer.rejected) sendLegacy(peer, 'syncState', { feedKey: 'ab'.repeat(32), localSeq: 0, remoteSeq: 0 })
  }
  return o
}

test('MIR-53: a peer that still announces its sync feed on open (1.11.x) downloads from and serves this build', async (t) => {
  const OLD = 'c'.repeat(64)
  const cur = await overlay(t, 'mv-cur', { localProfileKey: MEMBER, serveAuthorizer: async (_p, from) => from === OLD })
  const old = announcingFeed(await overlay(t, 'mv-old', { localProfileKey: OLD, serveAuthorizer: async (_p, from) => from === MEMBER }))
  const files = {}
  for (const [name, o] of [['cur', cur], ['old', old]]) {
    const bytes = crypto.randomBytes(96 * 1024)
    const hash = crypto.data(bytes).toString('hex')
    const src = path.join(tmpDir('mv-' + name), 'f.bin')
    fs.writeFileSync(src, bytes)
    await o.registerFile(src, { contentHash: hash, size: bytes.length })
    files[name] = { bytes, hash }
  }
  const [curSide] = link(cur, old)
  const seen = countSlot0(curSide)
  await settle()
  t.is(seen.frames, 1, 'the old peer announced its feed')

  const fromOld = await cur.fetchFile(files.old.hash, { destPath: path.join(tmpDir('mv-o1'), 'x'), timeout: scaled(6000) })
  const fromCur = await old.fetchFile(files.cur.hash, { destPath: path.join(tmpDir('mv-o2'), 'y'), timeout: scaled(6000) })
  t.alike(fromOld ? fs.readFileSync(fromOld.destPath) : null, files.old.bytes, 'this build downloads from the old peer')
  t.alike(fromCur ? fs.readFileSync(fromCur.destPath) : null, files.cur.bytes, 'the old peer downloads from this build')
  t.alike(await syncRows(cur), [], 'this build wrote no sync row')
})

test('REGRESSION (MIR-53: compaction drops sync rows a peer planted)', async (t) => {
  const o = await overlay(t, 'l53-cmp', { serveAuthorizer: async () => false })
  for (let i = 0; i < 4; i++) await o._index.bee.put('sync:' + 'ab'.repeat(2048) + ':/junk/' + i, { lastSeq: i, lastHash: 'cd'.repeat(32) })

  t.ok(await o.compactIndex({ isServed: () => true }), 'a sync row alone makes the index compactable')
  t.alike(await syncRows(o), [], 'and the compacted index holds none')
})

test('REGRESSION (legacy slots are inert): an old peer\'s frames on every retired slot change nothing', async (t) => {
  const pub = await overlay(t, 'inert-pub', { serveAuthorizer: async () => false })
  const old = await overlay(t, 'inert-old')
  const [pubSide, oldSide] = link(pub, old)
  await settle()
  const indexLength = pub._index.bee.core.length
  let answered = 0
  for (const slot of oldSide.channel.messages) slot.onmessage = () => { answered++ }
  const H = 'ab'.repeat(32)
  sendLegacy(oldSide, 'syncState', { feedKey: '34'.repeat(32), localSeq: 9, remoteSeq: 0 })
  sendLegacy(oldSide, 'fileOffer', { path: '/mir/' + H, contentHash: H, size: 1, mtime: 1, op: 0 })
  sendLegacy(oldSide, 'fileRequest', { path: '/mir/' + H, contentHash: H })
  sendLegacy(oldSide, 'chunkCancel', { path: 'content:' + H })
  sendLegacy(oldSide, 'transferComplete', { path: '/x', contentHash: H })
  sendLegacy(oldSide, 'treeRequest', { hash: H, nonce: 1 })
  await settle()
  t.is(pub._index.bee.core.length, indexLength, 'no index row written')
  t.absent(pubSide.channel.closed, 'the channel is still open')
  t.is(answered, 0, 'nothing came back on any slot')
})

// protomux destroys the whole mux when a codec throws, taking the control channel and replication on
// that socket with it, so a retired slot decodes nothing.
test('REGRESSION (legacy slots are inert): garbage on a retired slot does not take the socket down', async (t) => {
  const pub = await overlay(t, 'garbage-pub', { serveAuthorizer: async () => false })
  const [a, b] = makeDuplex()
  const pubSide = pub.attachProtocol(Protomux.from(a))
  const channel = Protomux.from(b).createChannel({ protocol: 'hyper-overlay/v2', id: null, handshake: m.handshake })
  const slots = Array.from({ length: 15 }, () => channel.addMessage({ encoding: c.raw }))
  channel.open({ version: 2, capabilities: 0 })
  await settle()
  // A length prefix announcing bytes that never come.
  for (const id of [0, 1, 2, 6, 7, 8, 9, 10]) slots[id].send(Buffer.from([0xff]))
  await settle()
  t.absent(pubSide.channel.closed, 'the overlay channel survived')
  t.absent(a.destroyed, 'the socket survived')
})
