import test from 'brittle'
import { peerRxBytes, peerTxBytes, createDrainWaiter } from '../../src/shared/transfer/overlay/engine/protocol/transport-probe.js'

test('the RX probe prefers the packet counter, then the socket, then frames', (t) => {
  const withRaw = (rawStream) => ({ mux: { stream: { rawStream, rawBytesRead: 7 } } })
  t.is(peerRxBytes(withRaw({ bytesReceived: 42, bytesRead: 9 })), 42, 'udx packet counter wins')
  t.is(peerRxBytes(withRaw({ bytesReceived: NaN, bytesRead: 9 })), 9, 'a non-finite packet counter falls through to the socket')
  t.is(peerRxBytes(withRaw({ bytesReceived: Infinity })), 7, 'then to the per-frame counter')
  t.is(peerRxBytes(withRaw(null)), 7, 'which is also the answer with no raw stream')
  t.is(peerRxBytes({ mux: { stream: { rawBytesRead: Infinity } } }), null, 'nothing finite reads as null')
  t.is(peerRxBytes({ mux: {} }), null, 'no stream reads as null')
  t.is(peerRxBytes(undefined), null, 'and a missing peer is not a throw')
})

test('the TX probe prefers transmitted packets, then the socket, else null', (t) => {
  const withRaw = (rawStream) => ({ mux: { stream: { rawStream } } })
  t.is(peerTxBytes(withRaw({ bytesTransmitted: 5, bytesWritten: 3 })), 5)
  t.is(peerTxBytes(withRaw({ bytesTransmitted: NaN, bytesWritten: 3 })), 3)
  t.is(peerTxBytes(withRaw({})), null)
  t.is(peerTxBytes(withRaw(null)), null)
  t.is(peerTxBytes(undefined), null)
})

// A peer whose stream never drains on its own; drain()/close() fire the stream's events.
function parkedPeer(tx = null) {
  const listeners = { drain: new Set(), close: new Set() }
  const stream = {
    rawStream: tx === null ? null : { get bytesTransmitted() { return tx() } },
    on(ev, fn) { listeners[ev].add(fn) },
    removeListener(ev, fn) { listeners[ev].delete(fn) },
  }
  const peer = { mux: { stream }, channel: { closed: false, drained: false } }
  const fire = (ev) => { for (const fn of [...listeners[ev]]) fn() }
  return {
    peer,
    listening: () => listeners.drain.size + listeners.close.size,
    drain() { peer.channel.drained = true; fire('drain') },
    close() { peer.channel.closed = true; fire('close') },
  }
}

test('a drained channel resolves at once; a closed one or no stream resolves false at once', async (t) => {
  const waiter = createDrainWaiter()
  const { peer } = parkedPeer()
  peer.channel.drained = true
  t.is(await waiter.wait(peer), true)
  t.is(await waiter.wait({ mux: { stream: {} }, channel: { closed: true } }), false)
  t.is(await waiter.wait({ mux: {}, channel: { closed: false } }), false)
})

test('concurrent waits on one peer share one waiter, which resolves true on drain', async (t) => {
  const waiter = createDrainWaiter({ drainTimeout: 5000, drainNoProgress: 5000 })
  const p = parkedPeer()
  const first = waiter.wait(p.peer)
  t.is(waiter.wait(p.peer), first, 'the second wait gets the same promise')
  t.is(p.listening(), 2, 'one pair of listeners, not one per wait')
  p.drain()
  t.is(await first, true)
  t.is(p.listening(), 0, 'the listeners are removed')
  p.peer.channel.drained = false
  t.not(waiter.wait(p.peer), first, 'a later wait starts fresh')
  p.close()
})

test('a channel that closes while waiting resolves false', async (t) => {
  const waiter = createDrainWaiter({ drainTimeout: 5000, drainNoProgress: 5000 })
  const p = parkedPeer()
  const waiting = waiter.wait(p.peer)
  p.close()
  t.is(await waiting, false)
})

test('a peer that stops transmitting is abandoned after one no-progress window', async (t) => {
  const waiter = createDrainWaiter({ drainTimeout: 5000, drainNoProgress: 30 })
  const p = parkedPeer(() => 4096)
  const startedAt = Date.now()
  t.is(await waiter.wait(p.peer), false)
  t.ok(Date.now() - startedAt < 1000, 'within the no-progress window, not the flat budget')
})

test('a peer still transmitting keeps the wait alive', async (t) => {
  let tx = 0
  const ticker = setInterval(() => { tx += 1024 }, 5)
  const waiter = createDrainWaiter({ drainTimeout: 5000, drainNoProgress: 30 })
  const p = parkedPeer(() => tx)
  let settled = false
  const waiting = waiter.wait(p.peer).then((alive) => { settled = true; return alive })
  await new Promise((r) => setTimeout(r, 150))
  t.absent(settled, 'five windows later it is still waiting')
  clearInterval(ticker)
  p.drain()
  t.is(await waiting, true)
})

test('with no TX counter the wait uses the flat budget', async (t) => {
  const waiter = createDrainWaiter({ drainTimeout: 60, drainNoProgress: 5 })
  const p = parkedPeer()
  const startedAt = Date.now()
  t.is(await waiter.wait(p.peer), false)
  t.ok(Date.now() - startedAt >= 55, 'it waited the flat budget, not the no-progress window')
})
