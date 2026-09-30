// [mirall] MIR-52 — a receiver reassembles a paged chunkHashes map only for a fetch that awaits it
// from that peer, and only within bounds. A map past its size-derived entry count is refused for that
// fetch; a peer past MAX_PAGED_ENTRIES_PER_PEER or MAX_PAGED_MAPS_PER_PEER is dropped. A closed
// channel releases the peer's buffer, and a refused page releases what it buffered for that path.
import test from 'brittle'
import * as m from '../../src/shared/transfer/backends/overlay/engine/wire/messages.js'
import { MAX_PAGED_ENTRIES_PER_PEER, MAX_PAGED_MAPS_PER_PEER, sendChunkHashes } from '../../src/shared/transfer/backends/overlay/engine/wire/paging.js'
import { makeProtocol } from '../helpers/overlay-engine.js'
import { ChunkScheduler } from '../../src/shared/transfer/backends/overlay/engine/scheduler/scheduler.js'
import { TIERS } from '../../src/shared/transfer/backends/overlay/engine/chunker.js'

function fakeTransfer() {
  const calls = []
  return {
    calls,
    startReceive(destPath, info) { calls.push(info); return { received: new Set() } },
    writeChunk() { return { ok: true } },
    finalize() { return { ok: true } },
    pause() {},
    cancel() {},
  }
}

// attach() over a fake mux. close() runs onclose synchronously, as protomux's Channel.close does,
// and frames go through the real chunkHashes dispatch.
function attachPeer(proto) {
  let onclose = null
  let onChunkHashes = null
  const channel = {
    closed: false,
    addMessage({ encoding, onmessage }) {
      if (encoding === m.chunkHashes) onChunkHashes = onmessage
      return { send() {} }
    },
    open() {},
    close() {
      if (this.closed) return
      this.closed = true
      onclose()
    },
  }
  const mux = {
    stream: { on() {}, removeListener() {}, emit() {} },
    createChannel(opts) { onclose = opts.onclose; return channel },
  }
  const peer = proto.attach(mux)
  return { peer, channel, send: (msg) => onChunkHashes(msg) }
}

const ENTRY = { hash: 'a'.repeat(64), length: TIERS[0].minSize }
const page = (path, n, more = 1) => ({ path, tier: 0, chunks: new Array(n).fill(ENTRY), more })

const hashOf = (path) => path.slice('content:'.length)

function awaitingScheduler(proto, path, peer, size, transfer = fakeTransfer()) {
  const sched = new ChunkScheduler({ path, destPath: '/tmp/' + path, transfer, sendNeed() {}, timeout: 5000, size })
  sched.promise().catch(() => {})
  sched.noteRequested(peer)
  proto.fetches.adoptForTests(hashOf(path), sched)
  return sched
}

const fakeScheduler = () => ({ awaitsMapFrom: () => true, maxMapEntries: () => null, notePageProgress() {}, removePeer() {}, onChunkHashes() {} })
const buffersAny = (proto, peer, paths) => paths.some((path) => proto.pages.has(peer, path))
const mapPaths = (n) => Array.from({ length: n }, (_, i) => 'content:' + i)

test('REGRESSION (MIR-52: a map paged past its size-derived bound is refused for that fetch)', (t) => {
  const proto = makeProtocol(fakeTransfer())
  t.teardown(() => proto.destroy())
  const { peer, channel, send } = attachPeer(proto)
  const size = 3 * TIERS[0].minSize + 100
  const bound = Math.ceil(size / TIERS[0].minSize) + 1
  const sched = awaitingScheduler(proto, 'content:x', peer, size)

  send(page('content:x', bound - 1))
  send(page('content:x', 1))
  t.ok(proto.pages.has(peer, 'content:x'), 'pages up to the bound are buffered')
  t.ok(sched.awaitsMapFrom(peer), 'and the map is still awaited')
  t.absent(channel.closed, 'within the bound the peer stays')

  send(page('content:x', 1))
  t.absent(proto.pages.has(peer, 'content:x'), 'the page past the bound released the buffer')
  t.absent(sched.awaitsMapFrom(peer), 'the fetch no longer awaits a map from it')
  t.ok(sched.done, 'with no other holder the fetch failed')
  t.absent(channel.closed, 'the channel stays for everything else')

  send(page('content:x', 1))
  t.absent(proto.pages.has(peer, 'content:x'), 'its later pages are not buffered')
})

test('MIR-52: a first page already past the size-derived bound is refused without buffering', (t) => {
  const proto = makeProtocol(fakeTransfer())
  t.teardown(() => proto.destroy())
  const { peer, channel, send } = attachPeer(proto)
  const size = 3 * TIERS[0].minSize + 100
  const sched = awaitingScheduler(proto, 'content:x', peer, size)

  send(page('content:x', Math.ceil(size / TIERS[0].minSize) + 2))
  t.absent(proto.pages.has(peer, 'content:x'), 'nothing was buffered')
  t.absent(sched.awaitsMapFrom(peer), 'the map was refused')
  t.absent(channel.closed, 'the peer stays')
})

test('REGRESSION (MIR-52: MAX_PAGED_ENTRIES_PER_PEER bounds a peer across its maps, whatever size the catalog claims)', (t) => {
  const proto = makeProtocol(fakeTransfer())
  t.teardown(() => proto.destroy())
  const { peer, channel, send } = attachPeer(proto)
  const claimed = awaitingScheduler(proto, 'content:claimed', peer, 2 ** 50)
  const unknown = awaitingScheduler(proto, 'content:unknown', peer)
  t.teardown(() => { claimed.cancel(); unknown.cancel() })
  t.ok(claimed.maxMapEntries() > MAX_PAGED_ENTRIES_PER_PEER, 'the claimed size alone would allow more')

  const full = page('content:claimed', 100000)
  const pages = Math.floor((MAX_PAGED_ENTRIES_PER_PEER - 1) / 100000)
  for (let i = 0; i < pages; i++) send(full)
  send(page('content:claimed', MAX_PAGED_ENTRIES_PER_PEER - 1 - pages * 100000))
  send(page('content:unknown', 1))
  t.ok(proto.pages.has(peer, 'content:claimed') && proto.pages.has(peer, 'content:unknown'), 'buffered up to the budget across both maps')
  t.absent(channel.closed, 'at the budget the peer stays')

  send(page('content:unknown', 1))
  t.ok(channel.closed, 'one entry past the budget dropped the peer')
  t.absent(buffersAny(proto, peer, ['content:claimed', 'content:unknown']), 'its page buffer is released')
  t.absent(claimed.awaitsMapFrom(peer) || unknown.awaitsMapFrom(peer), 'no fetch awaits it any more')
})

test('REGRESSION (MIR-52: a peer cannot hold more than MAX_PAGED_MAPS_PER_PEER maps at once)', (t) => {
  const proto = makeProtocol(fakeTransfer())
  t.teardown(() => proto.destroy())
  const { peer, channel, send } = attachPeer(proto)
  for (let i = 0; i <= MAX_PAGED_MAPS_PER_PEER; i++) proto.fetches.adoptForTests(String(i), fakeScheduler())

  for (let i = 0; i < MAX_PAGED_MAPS_PER_PEER; i++) send(page('content:' + i, 1))
  t.ok(mapPaths(MAX_PAGED_MAPS_PER_PEER).every((path) => proto.pages.has(peer, path)), 'every map up to the cap is buffered')
  t.absent(channel.closed, 'at the cap the peer stays')

  send(page('content:' + MAX_PAGED_MAPS_PER_PEER, 1))
  t.ok(channel.closed, 'one more map dropped the peer')
  t.absent(buffersAny(proto, peer, mapPaths(MAX_PAGED_MAPS_PER_PEER + 1)), 'its page buffer is released')
})

test('REGRESSION (MIR-52: pages for a path nobody awaits from this peer are never buffered)', (t) => {
  const gated = makeProtocol(fakeTransfer())
  t.teardown(() => gated.destroy())
  const a = attachPeer(gated)
  for (let i = 0; i < 100; i++) a.send(page('content:' + i, 1))
  t.absent(buffersAny(gated, a.peer, mapPaths(100)), 'no scheduler: nothing buffered')

  const other = { id: 'other' }
  const sched = awaitingScheduler(gated, 'content:asked', other)
  t.teardown(() => sched.cancel())
  a.send(page('content:asked', 1))
  t.absent(gated.pages.has(a.peer, 'content:asked'), 'a scheduler that asked another peer: nothing buffered')
  t.absent(a.channel.closed, 'refused pages do not drop the peer')

  const registered = makeProtocol(fakeTransfer(), { contentHashPaths: new Map([['wanted', '/disk/wanted']]) })
  t.teardown(() => registered.destroy())
  const b = attachPeer(registered)
  b.send(page('content:wanted', 1))
  t.absent(registered.pages.has(b.peer, 'content:wanted'), 'a registered file target without a scheduler: nothing buffered')
})

test('MIR-52: closing the channel releases the page buffer', (t) => {
  const proto = makeProtocol(fakeTransfer())
  t.teardown(() => proto.destroy())
  const { peer, channel, send } = attachPeer(proto)
  proto.fetches.adoptForTests('x', fakeScheduler())
  send(page('content:x', 1))
  t.ok(proto.pages.has(peer, 'content:x'), 'page buffered')

  channel.close()
  t.absent(proto.pages.has(peer, 'content:x'), 'released on close')
})

test('MIR-52: a half-paged map left by an ended fetch is discarded, and a new answer assembles clean', async (t) => {
  const transfer = fakeTransfer()
  const proto = makeProtocol(transfer)
  t.teardown(() => proto.destroy())
  const { peer, send } = attachPeer(proto)
  const hash = 'b'.repeat(64)
  const path = 'content:' + hash
  const first = proto.fetchContent(hash, [peer], { destPath: '/tmp/mir52-stale' })
  send(page(path, 2))
  await proto.cancelContent(hash)
  await t.exception(first, /cancelled/)

  send(page(path, 2))
  t.absent(proto.pages.has(peer, path), 'the old answer\'s next page, refused, took the buffer with it')

  const second = proto.fetchContent(hash, [peer], { destPath: '/tmp/mir52-stale' })
  second.catch(() => {})
  send(page(path, 3))
  send(page(path, 1, 0))
  t.is(transfer.calls[0]?.chunks.length, 4, 'the new answer was not appended to the old one')
  await proto.cancelContent(hash)
})

test('MIR-52: a fetch re-issued before the old answer\'s tail lands still gets the whole map', async (t) => {
  const transfer = fakeTransfer()
  const proto = makeProtocol(transfer)
  t.teardown(() => proto.destroy())
  const { peer, send } = attachPeer(proto)
  const hash = 'd'.repeat(64)
  const path = 'content:' + hash
  const first = proto.fetchContent(hash, [peer], { destPath: '/tmp/mir52-restart' })
  send(page(path, 2))
  await proto.cancelContent(hash, { signal: false })
  await t.exception(first, /cancelled/)

  const second = proto.fetchContent(hash, [peer], { destPath: '/tmp/mir52-restart' })
  second.catch(() => {})
  send(page(path, 1, 0))
  t.is(transfer.calls[0]?.chunks.length, 3, 'the buffered head and the tail made one map')
  await proto.cancelContent(hash)
})

test('MIR-52: an honest paged map at its size bound still assembles', (t) => {
  const transfer = fakeTransfer()
  const proto = makeProtocol(transfer)
  t.teardown(() => proto.destroy())
  const { peer, channel, send } = attachPeer(proto)
  const min = TIERS[3].minSize
  const count = 250000
  const size = count * min
  const sched = awaitingScheduler(proto, 'content:big', peer, size, transfer)
  t.teardown(() => sched.cancel())

  const sent = []
  sendChunkHashes({ msgs: { chunkHashes: { send: (msg) => sent.push(msg) } } }, 'content:big', 3, new Array(count).fill({ hash: 'c'.repeat(64), length: min }))
  t.ok(sent.length > 1, 'the map pages')
  for (const f of sent) send(f)

  t.absent(channel.closed, 'the peer stays')
  t.is(transfer.calls.length, 1, 'the assembled map reached startReceive')
  t.is(transfer.calls[0]?.chunks.length, count, 'every entry arrived')
  t.absent(proto.pages.has(peer, 'content:big'), 'the buffer cleared on the final page')
})
