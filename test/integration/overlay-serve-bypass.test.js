import test from 'brittle'
import crypto from 'hypercore-crypto'
import { tmpDir, fs, path } from './overlay-vendor-helpers.js'
import { SUFFIX, overlay, link } from './overlay-link-helpers.js'
import { hashChunk } from '../../src/shared/transfer/backends/overlay/vendor/chunker.js'
import { scaled } from '../helpers/bare-timing.js'

// S1/S2: the membership serve gate lives at _onContentRequest, but the protocol
// has OTHER serve/receive entry points. In "mirall mode" (a serveAuthorizer is
// configured) those must be refused, or a connected peer could (S1) pull bytes
// via path-based fileRequest / direct chunkNeed without passing the gate, or (S2)
// overwrite the owner's source file via an unsolicited chunkHashes push.
const settle = (ms = 800) => new Promise((r) => setTimeout(r, scaled(ms)))
const MEMBER = 'a'.repeat(64)

test('S1: serve gate cannot be bypassed via fileRequest or direct chunkNeed', async (t) => {
  const pub = await overlay(t, 'byp-pub', { serveAuthorizer: async (peer, from) => from === MEMBER }) // only MEMBER may fetch

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
  const atk = await overlay(t, 'byp-atk')
  const [, atkPeer] = link(pub, atk)
  await settle()

  // Bypass attempt 1: path-based fileRequest for the registered serve path.
  atkPeer.msgs.fileRequest.send({ path: '/mir/' + oid, contentHash: oid, chunksHave: null })
  // Bypass attempt 2: skip the request entirely, demand chunks directly.
  atkPeer.msgs.chunkNeed.send({ path: '/mir/' + oid, indices: [0, 1, 2] })
  await settle(1500)
  t.is(served, 0, 'no bytes served to an unauthorized peer via fileRequest/chunkNeed')

  // Positive control: a real MEMBER fetch DOES serve (proves the spy + serve path).
  const member = await overlay(t, 'byp-mem', { localProfileKey: MEMBER })
  link(pub, member)
  await settle()
  const got = await member.fetchFile(oid, { timeout: 6000, reSeed: false })
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
  await pub.registerFile('/mir/' + oid, src, { contentHash: oid, size: content.length })

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

const onlyPeer = (o) => [...o._protocol._peers.values()][0]

// Any socket on the content topic is an overlay peer before its identity is known. In mirall mode
// the legacy path-sync frames must be no-ops: no feed key kept, no index row, no receive cancelled.
test('REGRESSION (MIR-53: legacy sync frames from an unverified peer write no index row and cancel no receive)', async (t) => {
  const victim = await overlay(t, 'l53-vic', { serveAuthorizer: async () => false, journalDir: tmpDir('l53-j') })
  const atk = await overlay(t, 'l53-atk')

  // A stale registration still names the path a receive is now in flight to.
  const target = path.join(tmpDir('l53-dl'), 'doc.bin')
  const old = Buffer.from('an owned file that used to live here')
  const oldHash = crypto.data(old).toString('hex')
  fs.writeFileSync(target, old)
  await victim.registerFile('/mir/' + oldHash, target, { contentHash: oldHash, size: old.length, prepare: false })
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
  atkPeer.msgs.syncState.send({ feedKey: Buffer.alloc(4096, 0xab), localSeq: 1, remoteSeq: 0 })
  await settle(200)
  for (let i = 0; i < 16; i++) atkPeer.msgs.transferComplete.send({ path: '/junk/' + i, contentHash: 'cd'.repeat(32) })
  atkPeer.msgs.chunkCancel.send({ path: '/mir/' + oldHash })
  await settle(1500)

  t.is(onlyPeer(victim).remoteFeedKey, null, 'the announced feed key was not kept')
  t.is(victim._index.bee.core.length, before, 'the index core did not grow')
  t.alike(await syncRows(victim), [], 'no sync: row exists')
  t.ok(fs.existsSync(target + SUFFIX), 'the partial survived the chunkCancel')
  t.ok(fs.existsSync(state.journalPath), 'so did its resume journal')
  t.ok(victim._transfer._active.has(target), 'and the receive is still active')
})

test('REGRESSION (MIR-53: mirall mode announces no sync feed on open)', async (t) => {
  const gated = await overlay(t, 'l53-open', { serveAuthorizer: async () => false })
  const upstream = await overlay(t, 'l53-open-up')
  const seen = { byUpstream: 0, byGated: 0 }
  upstream._protocol._onSyncState = () => { seen.byUpstream++ }
  gated._protocol._onSyncState = () => { seen.byGated++ }
  link(gated, upstream)
  await settle()
  t.is(seen.byUpstream, 0, 'the gated overlay sent no syncState')
  t.is(seen.byGated, 1, 'control: the channel is up and slot 0 still routes (an upstream-mode peer announces)')
})

test('REGRESSION (MIR-53: evicting a hash drops its register entry, and a re-registered hash still serves)', async (t) => {
  const pub = await overlay(t, 'l53-ev', { serveAuthorizer: async (_p, from) => from === MEMBER })
  const member = await overlay(t, 'l53-ev-m', { localProfileKey: MEMBER })
  const content = crypto.randomBytes(64 * 1024)
  const oid = crypto.data(content).toString('hex')
  const src = path.join(tmpDir('l53-ev-src'), 'doc.bin')
  fs.writeFileSync(src, content)
  await pub.registerFile('/mir/' + oid, src, { contentHash: oid, size: content.length, prepare: false })
  link(pub, member)
  await settle()

  const first = await member.fetchFile(oid, { destPath: path.join(tmpDir('l53-ev-o1'), 'a.bin'), timeout: scaled(6000), reSeed: false })
  t.ok(first, 'served before the evict')
  t.ok(pub._filePaths.has('content:' + oid), 'precondition: the serve left its content: entry')

  await pub.evictContent(oid)
  t.absent(pub._filePaths.has('/mir/' + oid), 'the register entry is gone')
  t.ok(pub._filePaths.has('content:' + oid), 'the serve entry stays for a download still in flight')

  await pub.registerFile('/mir/' + oid, src, { contentHash: oid, size: content.length, prepare: false })
  const again = await member.fetchFile(oid, { destPath: path.join(tmpDir('l53-ev-o2'), 'b.bin'), timeout: scaled(6000), reSeed: false })
  t.alike(again ? fs.readFileSync(again.destPath) : null, content, 'a re-registered hash serves again')
})

// A 1.11.x overlay differs on the wire only by announcing its sync feed on open; restoring that send
// on a mirall-mode overlay stands in for it.
function announcingFeed(o) {
  const proto = o._protocol
  const open = proto._onOpen.bind(proto)
  proto._onOpen = (peer, hs) => {
    open(peer, hs)
    if (!peer.rejected) peer.msgs.syncState.send({ feedKey: proto._syncEngine.feedKey, localSeq: proto._syncEngine.feed.length, remoteSeq: 0 })
  }
  return o
}

test('MIR-53: a peer that still announces its sync feed on open (1.11.x) downloads from and serves this build', async (t) => {
  const OLD = 'c'.repeat(64)
  const cur = await overlay(t, 'mv-cur', { localProfileKey: MEMBER, serveAuthorizer: async (_p, from) => from === OLD })
  const old = announcingFeed(await overlay(t, 'mv-old', { localProfileKey: OLD, serveAuthorizer: async (_p, from) => from === MEMBER }))
  let announced = 0
  const onSyncState = cur._protocol._onSyncState.bind(cur._protocol)
  cur._protocol._onSyncState = (peer, msg) => { announced++; return onSyncState(peer, msg) }

  const files = {}
  for (const [name, o] of [['cur', cur], ['old', old]]) {
    const bytes = crypto.randomBytes(96 * 1024)
    const hash = crypto.data(bytes).toString('hex')
    const src = path.join(tmpDir('mv-' + name), 'f.bin')
    fs.writeFileSync(src, bytes)
    await o.registerFile('/mir/' + hash, src, { contentHash: hash, size: bytes.length, prepare: false })
    files[name] = { bytes, hash }
  }
  link(cur, old)
  await settle()
  t.is(announced, 1, 'the old peer announced its feed')

  const fromOld = await cur.fetchFile(files.old.hash, { destPath: path.join(tmpDir('mv-o1'), 'x'), timeout: scaled(6000), reSeed: false })
  const fromCur = await old.fetchFile(files.cur.hash, { destPath: path.join(tmpDir('mv-o2'), 'y'), timeout: scaled(6000), reSeed: false })
  t.alike(fromOld ? fs.readFileSync(fromOld.destPath) : null, files.old.bytes, 'this build downloads from the old peer')
  t.alike(fromCur ? fs.readFileSync(fromCur.destPath) : null, files.cur.bytes, 'the old peer downloads from this build')
  t.is(onlyPeer(cur).remoteFeedKey, null, 'this build kept none of the announcement')
  t.alike(await syncRows(cur), [], 'and wrote no sync row')
})

test('REGRESSION (MIR-53: compaction drops sync rows in mirall mode and keeps them upstream)', async (t) => {
  const gated = await overlay(t, 'l53-cmp', { serveAuthorizer: async () => false })
  const upstream = await overlay(t, 'l53-cmp-up')
  for (const o of [gated, upstream]) {
    for (let i = 0; i < 4; i++) await o._index.putSyncState('ab'.repeat(2048), '/junk/' + i, { lastSeq: i, lastHash: 'cd'.repeat(32) })
  }

  t.ok(await gated.compactIndex({ isServed: () => true }), 'a sync row alone makes the index compactable')
  t.alike(await syncRows(gated), [], 'and the compacted index holds none')
  t.is(await upstream.compactIndex({ isServed: () => true }), null, 'control: upstream mode keeps its sync state')
  t.is((await syncRows(upstream)).length, 4)
})
