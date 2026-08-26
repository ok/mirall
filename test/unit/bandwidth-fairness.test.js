// Several transfers sharing ONE global cap, driven through real ChunkSchedulers.
//
// This is the cross-component case the per-module suites both missed:
// bandwidth-limiter.test.js only ever drove a single consumer, and
// overlay-vendor-scheduler.test.js drove a single ChunkScheduler against a hand-rolled
// fakeLimiter. Every bug in the FIX-BW series only exists when two or more real schedulers
// share one real limiter, so they lived in the gap between the two files.
//
// Real ChunkScheduler + real createBandwidthLimiter. The only fakes are the TransferManager
// (accept every chunk) and the wire (deliver a requested chunk after 1ms, i.e. a line rate
// far above any cap used here, so the CAP is what binds).

import test from 'brittle'
import { createBandwidthLimiter } from '../../src/shared/transfer/bandwidth-limiter.js'
import { ChunkScheduler } from '../../src/shared/transfer/backends/overlay/vendor/chunk-scheduler.js'
import { scaled } from '../helpers/timing.js'

const KB = 1024
const CHUNK = 64 * KB
const TOTAL_CHUNKS = 4000        // ~256 MB: far more than any run below can finish

const fakeTransfer = {
  startReceive: () => ({ received: new Set() }),
  writeChunk: () => ({ ok: true }),
  finalize: () => ({ ok: true }),
  pause: async () => {},
}

const chunkList = (n = TOTAL_CHUNKS, size = CHUNK) =>
  Array.from({ length: n }, (_, i) => ({ hash: 'h' + i, length: size }))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// One transfer: a scheduler, its own limiter stream (exactly how OverlayProtocolV2 wires a
// scheduler up), one peer, and a byte counter.
function startTransfer (limiter, name, { chunkSize = CHUNK, mute = false } = {}) {
  const rec = { name, bytes: 0, chunkSize }
  const peer = { id: `peer-${name}` }
  const sched = new ChunkScheduler({
    path: `content:${name}`,
    destPath: `/tmp/${name}`,
    transfer: fakeTransfer,
    timeout: scaled(30_000),
    cap: 8,
    limiter: limiter.stream(),
    sendNeed: (_p, indices) => {
      if (mute) return
      indices.forEach((index, k) => setTimeout(() => {
        if (sched.done) return
        rec.bytes += chunkSize
        sched.onChunkData(peer, index, { length: chunkSize })
      }, k + 1))
    },
  })
  sched.promise().catch(() => {})
  sched.onChunkHashes(peer, chunkList(TOTAL_CHUNKS, chunkSize))
  rec.sched = sched
  return rec
}

const report = (recs) => recs.map((r) => `${r.name}=${Math.round(r.bytes / KB)}KB`).join(' ')

test('REGRESSION (FIX-BW1): four parallel downloads all progress under one cap', async (t) => {
  const CAP = 2 * 1024 * KB
  const limiter = createBandwidthLimiter(() => CAP)
  const recs = ['a', 'b', 'c', 'd'].map((n) => startTransfer(limiter, n))

  await wait(scaled(1500))
  for (const r of recs) r.sched.cancel()
  limiter.destroy()

  for (const r of recs) t.ok(r.bytes > 0, `${r.name} downloaded something (${Math.round(r.bytes / KB)} KB)`)
  const total = recs.reduce((s, r) => s + r.bytes, 0)
  t.ok(Math.min(...recs.map((r) => r.bytes)) >= total * 0.08, `no transfer was squeezed out — ${report(recs)}`)
})

// The shape from the field report: one big file already running at the cap, then more
// downloads started on top of it. Before the fix the later ones received zero bytes for as
// long as the first kept running.
test('REGRESSION (FIX-BW1): downloads started later are not starved by the incumbent', async (t) => {
  const CAP = 2 * 1024 * KB
  const limiter = createBandwidthLimiter(() => CAP)
  const first = startTransfer(limiter, 'incumbent')
  await wait(scaled(400))                      // let it settle at the full cap
  const later = ['late1', 'late2'].map((n) => startTransfer(limiter, n))

  await wait(scaled(1200))
  for (const r of [first, ...later]) r.sched.cancel()
  limiter.destroy()

  for (const r of later) t.ok(r.bytes > 0, `${r.name} broke through the incumbent (${Math.round(r.bytes / KB)} KB)`)
  const lateTotal = later.reduce((s, r) => s + r.bytes, 0)
  t.ok(lateTotal >= first.bytes * 0.25, `the late starters got a real share — ${report([first, ...later])}`)
})

// REGRESSION (FIX-BW3): fairness must be in BYTES, not in turns. Chunk size comes from the
// file-size tier, so two concurrent transfers routinely differ by 64x. A turn-based queue
// gives the large-chunk transfer 100% and the small one exactly 0.
test('REGRESSION (FIX-BW3): transfers with different chunk sizes share the cap', async (t) => {
  const CAP = 2 * 1024 * KB
  const limiter = createBandwidthLimiter(() => CAP)
  const big = startTransfer(limiter, 'big-file', { chunkSize: 1024 * KB })
  const small = startTransfer(limiter, 'small-file', { chunkSize: 16 * KB })

  await wait(scaled(1500))
  for (const r of [big, small]) r.sched.cancel()
  limiter.destroy()

  t.ok(small.bytes > 0, `the small-chunk transfer was not starved (${Math.round(small.bytes / KB)} KB)`)
  t.ok(big.bytes > 0, `the large-chunk transfer ran too (${Math.round(big.bytes / KB)} KB)`)
  const total = big.bytes + small.bytes
  t.ok(small.bytes >= total * 0.15, `and the split is by bytes, not by turns — ${report([big, small])}`)
})

// The aggregate cap was never the broken part — it held even while the split was
// winner-take-all. This is an invariant guard, NOT a regression test: it passes against the
// pre-fix code too.
test('five parallel downloads still respect the aggregate cap', async (t) => {
  const CAP = 1024 * KB
  const limiter = createBandwidthLimiter(() => CAP)
  const recs = ['a', 'b', 'c', 'd', 'e'].map((n) => startTransfer(limiter, n))

  const startedAt = Date.now()
  await wait(scaled(1500))
  const elapsed = (Date.now() - startedAt) / 1000
  for (const r of recs) r.sched.cancel()
  limiter.destroy()

  const total = recs.reduce((s, r) => s + r.bytes, 0)
  // One second of bucket depth is allowed on top of the steady rate.
  t.ok(total <= CAP * (elapsed + 1.5), `five transfers together stayed under the cap (${Math.round(total / KB)} KB in ${elapsed.toFixed(2)}s)`)
  t.ok(total >= CAP * elapsed * 0.5, `and the cap was actually being used (${Math.round(total / KB)} KB)`)
})

// A cap far below one chunk is the worst case for a byte bucket: every chunk needs several
// seconds of budget, so a naive implementation hands the whole bucket to whoever asks first.
test('REGRESSION (FIX-BW1): three downloads share a cap smaller than one chunk', async (t) => {
  const CAP = 48 * KB                  // one 64 KB chunk costs more than a second
  const limiter = createBandwidthLimiter(() => CAP)
  const recs = ['a', 'b', 'c'].map((n) => startTransfer(limiter, n))

  await wait(scaled(5000))
  for (const r of recs) r.sched.cancel()
  limiter.destroy()

  t.is(recs.filter((r) => r.bytes > 0).length, 3, `every transfer got at least one chunk — ${report(recs)}`)
})

// REGRESSION (FIX-BW2): MIN_BYTES_PER_SECOND is documented as the floor that keeps one chunk
// inside the 30s idle watchdog, but the arithmetic never held: 32 KB/s x 30 s = 983,040
// bytes, under the 1 MB tier-2 max chunk. Pre-fix, a wake scheduled past the window (the
// bucket goes deeply negative after an oversized chunk) failed a perfectly healthy transfer.
test('REGRESSION (FIX-BW2): a chunk costing more than the watchdog window is paced, not failed', async (t) => {
  const limiter = createBandwidthLimiter(() => 32 * KB)    // the floor
  const BIG = 256 * KB                                      // 8 seconds of budget per chunk
  const peer = { id: 'p1' }
  let delivered = 0
  let rejection = null
  const sched = new ChunkScheduler({
    path: 'content:paced',
    destPath: '/tmp/paced',
    transfer: fakeTransfer,
    timeout: scaled(500),                                   // far shorter than one chunk costs
    cap: 8,
    limiter: limiter.stream(),
    sendNeed: (_p, indices) => {
      indices.forEach((index, k) => setTimeout(() => {
        if (sched.done) return
        delivered++
        sched.onChunkData(peer, index, { length: BIG })
      }, k + 1))
    },
  })
  sched.promise().catch((err) => { rejection = err.message })
  sched.onChunkHashes(peer, chunkList(40, BIG))

  await wait(scaled(2000))
  const stalled = rejection
  sched.cancel()
  limiter.destroy()

  t.absent(stalled, `the transfer was paced, not stall-failed (${stalled || 'no rejection'})`)
  t.ok(delivered > 0, `and it is still moving bytes (${delivered} chunk(s) at 32 KB/s)`)
})

// REGRESSION (FIX-BW4): the first attempt at FIX-BW2 re-armed the watchdog from a limiter
// heartbeat, which fires on a timer with no peer involvement — so it never fired again and a
// peer that wedged while still TCP-alive (no FIN, so removePeer never runs) was NEVER
// detected. Measured on that revision: not detected after 6000ms against a 500ms window.
// The watchdog must still catch a silent peer while a cap is in force.
test('REGRESSION (FIX-BW4): a silent peer is still detected while a cap is in force', async (t) => {
  const limiter = createBandwidthLimiter(() => 512 * KB)
  const peer = { id: 'mute' }
  const startedAt = Date.now()
  let failedAfter = null
  const sched = new ChunkScheduler({
    path: 'content:mute',
    destPath: '/tmp/mute',
    transfer: fakeTransfer,
    timeout: scaled(400),
    cap: 8,
    limiter: limiter.stream(),
    sendNeed: () => {},          // answers the chunk list, then never sends a byte
  })
  sched.promise().catch(() => { failedAfter = Date.now() - startedAt })
  sched.onChunkHashes(peer, chunkList(200, CHUNK))

  await wait(scaled(2500))
  limiter.destroy()

  t.ok(failedAfter !== null, `the stall was detected (after ${failedAfter}ms)`)
  t.ok(failedAfter < scaled(2000), 'and promptly — not swallowed by pacing')
})

// REGRESSION (FIX-BW5): ending the peer loop the moment the cap bites collapses
// multi-source fetch to single-source — the first peer in iteration order is gated before it
// ever fills its slots, so the others are never reached. Measured pre-fix at a 2 MB/s cap:
// A=38 / B=0 / C=0 chunk-needs.
test('REGRESSION (FIX-BW5): a capped download still spreads across every holder', async (t) => {
  const limiter = createBandwidthLimiter(() => 2 * 1024 * KB)
  const served = new Map()
  const peers = [{ id: 'A' }, { id: 'B' }, { id: 'C' }]
  const sched = new ChunkScheduler({
    path: 'content:multi',
    destPath: '/tmp/multi',
    transfer: fakeTransfer,
    timeout: scaled(30_000),
    cap: 8,
    limiter: limiter.stream(),
    sendNeed: (peer, indices) => {
      served.set(peer.id, (served.get(peer.id) || 0) + indices.length)
      indices.forEach((index, k) => setTimeout(() => {
        if (sched.done) return
        sched.onChunkData(peer, index, { length: CHUNK })
      }, k + 1))
    },
  })
  sched.promise().catch(() => {})
  for (const p of peers) await sched.onChunkHashes(p, chunkList(TOTAL_CHUNKS, CHUNK))

  await wait(scaled(1200))
  sched.cancel()
  limiter.destroy()

  const counts = peers.map((p) => `${p.id}=${served.get(p.id) || 0}`).join(' ')
  for (const p of peers) t.ok((served.get(p.id) || 0) > 0, `holder ${p.id} was used under the cap (${counts})`)
})

// REGRESSION (FIX-BW8): scoping the watchdog to "bytes outstanding with a peer" removed the
// fetch's only unconditional liveness bound. Suppression must key on being PACED — the
// limiter holding our retry — not merely on having nothing outstanding, or a limiter that
// refuses the retry (torn down mid-transfer) leaves the fetch with no timer at all: it never
// settles, its `content:<hash>` entry is never cleared, and every later fetch of that hash
// joins the dead promise.
test('REGRESSION (FIX-BW8): a torn-down limiter fails the fetch instead of hanging it', async (t) => {
  const limiter = createBandwidthLimiter(() => 32 * KB)
  const peer = { id: 'p1' }
  let settled = null
  const sched = new ChunkScheduler({
    path: 'content:torn',
    destPath: '/tmp/torn',
    transfer: fakeTransfer,
    timeout: scaled(400),
    cap: 8,
    limiter: limiter.stream(),
    sendNeed: () => {},
  })
  sched.promise().then(() => { settled = 'ok' }).catch((e) => { settled = e.message })
  sched.onChunkHashes(peer, chunkList(40, 512 * KB))   // each chunk is 16s of budget: gated
  await wait(scaled(100))
  limiter.destroy()                                     // teardown while parked
  await wait(scaled(1200))

  t.ok(settled !== null, `the fetch settled rather than hanging forever (${settled})`)
  t.ok(/stalled/.test(settled || ''), 'and it settled as a stall, releasing the download slot')
})

// REGRESSION (FIX-BW8): _assign re-arms the watchdog on every call, and a second holder's
// chunk list re-enters _assign during the first holder's startReceive await. onChunkHashes
// clears the timer for exactly that window, so _armIdleTimer must honour `_settingUp` or a
// healthy journal-less resume with 3+ holders is stall-failed.
test('REGRESSION (FIX-BW8): a second holder mid-setup does not resurrect the watchdog', async (t) => {
  const limiter = createBandwidthLimiter(() => 8 * 1024 * KB)
  let release
  const slowTransfer = {
    startReceive: () => new Promise((r) => { release = () => r({ received: new Set() }) }),
    writeChunk: () => ({ ok: true }),
    finalize: () => ({ ok: true }),
    pause: async () => {},
  }
  let failed = null
  const sched = new ChunkScheduler({
    path: 'content:resume',
    destPath: '/tmp/resume',
    transfer: slowTransfer,
    timeout: scaled(300),
    cap: 8,
    limiter: limiter.stream(),
    sendNeed: (peer, indices) => {
      indices.forEach((index, k) => setTimeout(() => {
        if (sched.done) return
        sched.onChunkData(peer, index, { length: CHUNK })
      }, k + 1))
    },
  })
  sched.promise().catch((e) => { failed = e.message })
  for (const id of ['A', 'B', 'C']) sched.noteRequested({ id })
  const first = sched.onChunkHashes({ id: 'A' }, chunkList(200, CHUNK))   // begins the long setup
  await sched.onChunkHashes({ id: 'B' }, chunkList(200, CHUNK))           // re-enters _assign
  await wait(scaled(800))                                                 // well past the window
  t.absent(failed, `no stall-fail during setup (${failed || 'none'})`)
  release()
  await first
  await wait(scaled(200))
  t.absent(failed, 'and none after setup completed either')
  sched.cancel()
  limiter.destroy()
})

test('an uncapped limiter leaves parallel downloads unthrottled', async (t) => {
  const limiter = createBandwidthLimiter(() => 0)
  const recs = ['a', 'b', 'c'].map((n) => startTransfer(limiter, n))
  await wait(scaled(300))
  for (const r of recs) r.sched.cancel()
  limiter.destroy()
  for (const r of recs) t.ok(r.bytes > 2 * 1024 * KB, `${r.name} ran at wire speed (${Math.round(r.bytes / KB)} KB)`)
})

// A finished scheduler must hand its unspent grant back, or a cap's worth of budget leaks
// out of the shared bucket on every transfer that ends mid-round.
test('a cancelled transfer detaches its stream and returns unspent budget', async (t) => {
  const limiter = createBandwidthLimiter(() => 256 * KB)
  const held = limiter.stream()
  const rec = startTransfer(limiter, 'ending')
  await wait(scaled(300))
  rec.sched.cancel()
  await wait(scaled(50))
  // With the transfer gone nothing is queued, so a fresh consumer sees the bucket directly.
  t.absent(held.wouldBlock(), 'the ended transfer left no entry blocking the queue')
  limiter.destroy()
})

// --- the SENDER's cap against the RECEIVER's watchdog (FIX-BW9) -------------
// Every case above paces the DOWNLOAD side, where the scheduler can see its own limiter and
// scope the watchdog around it (FIX-BW2/BW4/BW8). The upload side is the blind spot: the
// holder waits on ITS cap, nothing goes on the wire, and the downloader — which cannot know
// a cap exists — reads the silence as a wedge and aborts a transfer that is merely slow.
// Measured pre-fix at a 2:1 cost-to-window ratio: 1 chunk delivered, then `multi-source fetch
// stalled`, and (because the engine reads a code-less failure as "holder gone") a parked row
// that no reconnect or catalog append ever comes to resume.
//
// The wire half — protocol-v2 emitting message 14 while parked — is covered in
// test/integration/overlay-vendor-backpressure.test.js; here the serve loop is modelled so a
// real limiter and a real scheduler meet, which is the pair that produces the bug.

// A holder serving one receiver, paced by ITS OWN upload limiter. `announce` decides whether
// it speaks FIX-BW9 keep-alives while parked (a new holder) or stays silent (a v1.8.0 one).
function startSender (limiter, sched, peer, { chunkSize, announce, everyMs = 40 }) {
  const stream = limiter.stream()
  const rec = { stream, delivered: 0 }
  rec.serve = (indices) => {
    ;(async () => {
      for (const index of indices) {
        const beat = announce
          ? setInterval(() => sched.notePeerAlive(peer, index), everyMs)
          : null
        const paid = await stream.take(chunkSize).finally(() => clearInterval(beat))
        if (paid <= 0 || sched.done) return
        rec.delivered++
        sched.onChunkData(peer, index, { length: chunkSize })
      }
    })()
  }
  return rec
}

function startCappedFetch (limiter, { announce, chunkSize = 128 * KB, window = 400, maxSilence }) {
  const peer = { id: 'holder' }
  const state = { rejection: null }
  let sender = null
  const sched = new ChunkScheduler({
    path: 'content:capped-' + (announce ? 'new' : 'old'),
    destPath: '/tmp/capped',
    transfer: fakeTransfer,
    timeout: scaled(window),
    cap: 8,
    limiter: null,                                  // the RECEIVER is unthrottled
    keepAliveMaxSilence: maxSilence,
    sendNeed: (_p, indices) => sender.serve(indices),
  })
  sender = startSender(limiter, sched, peer, { chunkSize, announce })
  sched.promise().catch((err) => { state.rejection = err.message })
  sched.noteRequested(peer)
  sched.onChunkHashes(peer, chunkList(80, chunkSize))
  return { sched, peer, sender, state }
}

test('REGRESSION (FIX-BW9): a throttled holder no longer trips the receiver watchdog', async (t) => {
  // 32 KB/s against 128 KB chunks: 4s per chunk, ten times the window. In production this is
  // a 4 MB tier-3 chunk at the 32 KB/s cap floor — 128s against the 30s watchdog.
  // A cap belongs to the HOLDER's machine, so the two holders get a limiter each.
  const quietCap = createBandwidthLimiter(() => 32 * KB)
  const talkingCap = createBandwidthLimiter(() => 32 * KB)
  const quiet = startCappedFetch(quietCap, { announce: false })
  const talking = startCappedFetch(talkingCap, { announce: true })

  await wait(scaled(1500))
  const stillFetching = !talking.sched.done          // read before the teardown settles it
  const delivered = talking.sender.delivered
  quiet.sched.cancel(); talking.sched.cancel()
  quietCap.destroy(); talkingCap.destroy()

  t.ok(/stalled/.test(quiet.state.rejection || ''), `a silent holder still fails the fetch (${quiet.state.rejection || 'no rejection'}) — the pre-fix behavior`)
  t.absent(talking.state.rejection, `a holder that announces itself while paced does not (${talking.state.rejection || 'no rejection'})`)
  t.ok(stillFetching, 'and its fetch is still alive, waiting on bytes that are coming')
  t.ok(delivered > 0, `with bytes actually moving through the cap (${delivered} chunk(s))`)
})

// The gate that keeps this from becoming FIX-BW4 again: a keep-alive only counts from a peer
// that actually owes us the chunk it names. Without it, ANY connected peer could hold a fetch
// open forever with zero bytes — and the watchdog would never fire for anyone.
test('FIX-BW9: a keep-alive from a peer that owes us nothing does not hold the fetch open', async (t) => {
  const limiter = createBandwidthLimiter(() => 512 * KB)
  const mute = { id: 'mute' }
  const bystander = { id: 'bystander' }
  let rejection = null
  const sched = new ChunkScheduler({
    path: 'content:bystander',
    destPath: '/tmp/bystander',
    transfer: fakeTransfer,
    timeout: scaled(400),
    cap: 8,
    limiter: limiter.stream(),
    sendNeed: () => {},                     // the real holder answers the list, then goes silent
  })
  sched.promise().catch((err) => { rejection = err.message })
  sched.onChunkHashes(mute, chunkList(200, CHUNK))
  // A peer with nothing assigned keep-alives hard for chunks it was never given.
  const spam = setInterval(() => { for (let i = 0; i < 8; i++) sched.notePeerAlive(bystander, i) }, 10)

  // The same warm-up FIX-BW4 allows: under a download cap nothing is assigned — and so no
  // watchdog is armed — for well over a second, so a shorter window proves nothing.
  await wait(scaled(2500))
  clearInterval(spam)
  limiter.destroy()

  t.ok(/stalled/.test(rejection || ''), `the silent holder was still detected (${rejection || 'no rejection'})`)
})

// And the bound: a holder that keep-alives forever while sending nothing is a wedge wearing a
// costume. The extension is measured from the last ACCEPTED progress, so it cannot be
// refreshed by more keep-alives.
test('FIX-BW9: keep-alives are bounded — a holder that never sends bytes is still failed', async (t) => {
  const peer = { id: 'liar' }
  let rejection = null
  let failedAfter = null                     // stamped BY the rejection, not by the test's own wait
  const startedAt = Date.now()
  const sched = new ChunkScheduler({
    path: 'content:liar',
    destPath: '/tmp/liar',
    transfer: fakeTransfer,
    timeout: scaled(200),
    cap: 8,
    limiter: null,
    keepAliveMaxSilence: scaled(600),       // production: 30 minutes
    sendNeed: () => {},                     // never serves a byte, only talks
  })
  sched.promise().catch((err) => { rejection = err.message; failedAfter = Date.now() - startedAt })
  sched.noteRequested(peer)
  sched.onChunkHashes(peer, chunkList(80, CHUNK))
  const beat = setInterval(() => { for (let i = 0; i < 8; i++) sched.notePeerAlive(peer, i) }, 20)

  await wait(scaled(1600))
  clearInterval(beat)

  t.ok(/stalled/.test(rejection || ''), `the fetch was failed despite continuous keep-alives (${rejection || 'no rejection'})`)
  // Sampling this after the fixed wait instead would make it ~1600ms whatever happened — a
  // no-op notePeerAlive (failing at the 200ms window) would report the same number and pass.
  t.ok(failedAfter > scaled(500), `but only after the bound was spent, not inside the window (${failedAfter}ms)`)
})

// --- transport liveness (FIX-BW10) ------------------------------------------
// The watchdog is asked "is this peer dead?" but measures "has a chunk completed?". Those
// diverge whenever ONE chunk legitimately outlives the window — a 4 MiB tier-3 chunk needs
// 33.6s at 1 Mbit/s, and a chunk queued behind other traffic on the same Noise stream takes
// longer still — so a healthy holder on a slow or congested link was failed as a stall. These
// drive the scheduler with the transport byte counter protocol-v2 injects in production
// (peer.mux.stream.rawStream.bytesReceived, measured: 360 B per 30s window on an IDLE
// connection, and advancing throughout the 2s a 4 MiB frame spends on the wire while the
// frame-granular counter stays at zero).

// A transport counter that ticks `bytes` every `everyMs`. Returns the reader the scheduler gets
// and a stop(), so a finished test leaves no interval behind.
function rxTicker (bytes, everyMs) {
  let rx = 0
  const timer = setInterval(() => { rx += bytes }, everyMs)
  timer.unref?.()
  return { read: () => rx, stop: () => clearInterval(timer) }
}

test('REGRESSION (FIX-BW10): a chunk that outlives the idle window is not failed while bytes arrive', async (t) => {
  const WINDOW = scaled(400)
  const rx = rxTicker(8 * KB, 20)          // ~400 KB/s of real inbound bytes
  const peer = { id: 'slow' }
  let failed = null
  const sched = new ChunkScheduler({
    path: 'content:slow',
    destPath: '/tmp/slow',
    transfer: fakeTransfer,
    timeout: WINDOW,
    cap: 1,
    peerBytes: rx.read,
    // one chunk, delivered at 3x the window: the case that must survive
    sendNeed: (_p, indices) => setTimeout(() => {
      if (!sched.done) sched.onChunkData(peer, indices[0], { length: CHUNK })
    }, WINDOW * 3),
  })
  sched.promise().catch((err) => { failed = err })
  await sched.onChunkHashes(peer, chunkList(4, CHUNK))

  await wait(WINDOW * 2)
  t.is(failed, null, 'still alive after twice the idle window, because the peer is delivering')
  await wait(WINDOW * 2)
  t.is(failed, null, 'and the late chunk was accepted instead of the fetch being stall-failed')
  t.is(sched._received.get(peer), 1, 'the chunk really did land')

  rx.stop()
  sched.cancel()
})

// REGRESSION (FIX-BW4, re-asserted): a peer that wedges while still TCP-alive sends no FIN, so
// removePeer never runs and the watchdog is the only thing that can end the fetch. A liveness
// probe must not blind it — a wedged peer moves no bytes.
test('REGRESSION (FIX-BW10): a silent peer is still failed inside the window with the probe wired', async (t) => {
  const WINDOW = scaled(400)
  const startedAt = Date.now()
  let failedAfter = null
  const sched = new ChunkScheduler({
    path: 'content:wedged',
    destPath: '/tmp/wedged',
    transfer: fakeTransfer,
    timeout: WINDOW,
    cap: 8,
    peerBytes: () => 0,                    // connected, but not one byte since
    sendNeed: () => {},
  })
  sched.promise().catch(() => { failedAfter = Date.now() - startedAt })
  await sched.onChunkHashes({ id: 'wedged' }, chunkList(200, CHUNK))

  await wait(WINDOW * 4)
  t.ok(failedAfter !== null, `the stall was detected (after ${failedAfter}ms)`)
  t.ok(failedAfter < WINDOW * 3, 'and promptly — the probe did not defer it')
})

// An idle Noise stream still carries an empty keep-alive every 5s (hyperdht connectionKeepAlive)
// plus UDX ACKs. If that chatter could clear the floor, every wedged-but-connected peer would
// hold its fetch open to the 30-minute bound — FIX-BW4 through the gate meant to prevent it.
test('REGRESSION (FIX-BW10): protocol chatter below the floor does not extend the fetch', async (t) => {
  const WINDOW = scaled(400)
  const rx = rxTicker(20, 50)              // keep-alive-sized dribble, nothing more
  let failed = false
  const sched = new ChunkScheduler({
    path: 'content:chatty',
    destPath: '/tmp/chatty',
    transfer: fakeTransfer,
    timeout: WINDOW,
    cap: 8,
    peerBytes: rx.read,
    sendNeed: () => {},
  })
  sched.promise().catch(() => { failed = true })
  await sched.onChunkHashes({ id: 'chatty' }, chunkList(50, CHUNK))

  await wait(WINDOW * 3)
  rx.stop()
  t.ok(failed, 'a peer that only chatters is still a silent peer')
})

// The extension is scoped to a peer that owes us something, exactly as notePeerAlive is. Setup:
// as many chunks as the cap, so the first holder takes them all and the second is left owing
// nothing while its transport counter runs hot.
test('FIX-BW10: bytes from a peer that owes us nothing do not extend the fetch', async (t) => {
  const WINDOW = scaled(400)
  const A = { id: 'A' }
  const B = { id: 'B' }
  const rxB = rxTicker(1024 * KB, 20)
  let failed = false
  const sched = new ChunkScheduler({
    path: 'content:scope',
    destPath: '/tmp/scope',
    transfer: fakeTransfer,
    timeout: WINDOW,
    cap: 4,
    peerBytes: (peer) => (peer === B ? rxB.read() : 0),
    sendNeed: () => {},
  })
  sched.promise().catch(() => { failed = true })
  await sched.onChunkHashes(A, chunkList(4, CHUNK))   // A takes all four (the cap), then goes silent
  await sched.onChunkHashes(B, chunkList(4, CHUNK))   // B answers, is assigned nothing, floods bytes
  t.is(sched._peerInflight.get(B), 0, 'B owes nothing (precondition)')

  await wait(WINDOW * 3)
  rxB.stop()
  t.ok(failed, 'the fetch failed on A being silent, despite B being loud')
})

// Bytes prove the peer is alive, not that OUR batch is still being served. Every early return in
// the holder's serve loop — unreadable file, revoked grant, abandoned drain — leaves it as busy
// as ever with our chunks never coming. The abandon budget catches that in proportion to how
// fast that peer is working, instead of holding the fetch to the 30-minute bound.
test('REGRESSION (FIX-BW10): a peer that delivers everything except our chunks is still failed', async (t) => {
  const WINDOW = scaled(400)
  const OWED = 4 * CHUNK                                  // cap 4, so this is what it owes us
  const rx = rxTicker(256 * KB, Math.round(WINDOW / 8))   // 8 ticks = 2 MB per window
  const startedAt = Date.now()
  let failedAfter = null
  const sched = new ChunkScheduler({
    path: 'content:busy',
    destPath: '/tmp/busy',
    transfer: fakeTransfer,
    timeout: WINDOW,
    cap: 4,
    peerBytes: rx.read,
    // Budget = OWED * 2 + slack = 3 MB, i.e. 12 ticks: over one window's worth of traffic, under
    // two, so the fix must extend once and then give up.
    abandonSlackBytes: 3 * 1024 * KB - OWED * 2,
    sendNeed: () => {},                                   // asked, never served — the dropped batch
  })
  sched.promise().catch(() => { failedAfter = Date.now() - startedAt })
  await sched.onChunkHashes({ id: 'busy-elsewhere' }, chunkList(20, CHUNK))

  await wait(WINDOW * 8)
  rx.stop()
  t.ok(failedAfter !== null, `the dropped batch was caught (after ${failedAfter}ms)`)
  t.ok(failedAfter > WINDOW * 1.5, 'after extending at least once — the peer was demonstrably alive')
  t.ok(failedAfter < WINDOW * 6, 'and in proportion to its traffic, not at the 30-minute bound')
})

// The bound is the last line of defence: an extension that can renew itself forever is a
// watchdog that never fires. _lastProgressAt advances only on VERIFIED progress, which no
// remote peer can drive.
test('FIX-BW10: transport liveness cannot outlive the verified-progress bound', async (t) => {
  const WINDOW = scaled(300)
  const BOUND = scaled(1200)
  const rx = rxTicker(64 * KB, Math.round(WINDOW / 8))
  const startedAt = Date.now()
  let failedAfter = null
  const sched = new ChunkScheduler({
    path: 'content:forever',
    destPath: '/tmp/forever',
    transfer: fakeTransfer,
    timeout: WINDOW,
    cap: 8,
    peerBytes: rx.read,
    abandonSlackBytes: Number.MAX_SAFE_INTEGER,   // budget disabled: isolate the bound
    keepAliveMaxSilence: BOUND,
    sendNeed: () => {},
  })
  sched.promise().catch(() => { failedAfter = Date.now() - startedAt })
  await sched.onChunkHashes({ id: 'forever' }, chunkList(200, CHUNK))

  await wait(BOUND * 2)
  rx.stop()
  t.ok(failedAfter !== null, 'the bound fired')
  t.ok(failedAfter >= BOUND, 'not before the bound')
  t.ok(failedAfter < BOUND + WINDOW * 2, 'and within one window of it')
})

// The budget is measured from a debt clock, and an accepted chunk restarts it. Clearing it
// outright left a hole at the tail of a file: every remaining chunk is already in flight, so
// _assign sends no new batch, nothing re-seeds the clock, and the extension goes unbudgeted.
test('REGRESSION (FIX-BW10): the abandon budget survives an accepted chunk with nothing left to ask for', async (t) => {
  const WINDOW = scaled(400)
  const OWED = 7 * CHUNK                                  // what is left in flight after one lands
  const rx = rxTicker(256 * KB, Math.round(WINDOW / 8))
  const peer = { id: 'tail' }
  const startedAt = Date.now()
  let failedAfter = null
  const sched = new ChunkScheduler({
    path: 'content:tail',
    destPath: '/tmp/tail',
    transfer: fakeTransfer,
    timeout: WINDOW,
    cap: 8,
    peerBytes: rx.read,
    abandonSlackBytes: 4 * 1024 * KB - OWED * 2,
    // exactly cap chunks, delivered once and then never again: the whole file is in flight, so
    // no later assign has anything to hand out
    sendNeed: (_p, indices) => setTimeout(() => {
      if (!sched.done) sched.onChunkData(peer, indices[0], { length: CHUNK })
    }, 10),
  })
  sched.promise().catch(() => { failedAfter = Date.now() - startedAt })
  await sched.onChunkHashes(peer, chunkList(8, CHUNK))

  await wait(WINDOW * 8)
  rx.stop()
  t.is(sched._received.get(peer), 1, 'one chunk landed, then the holder went quiet on the rest')
  t.ok(failedAfter !== null, `the remaining batch was still budgeted (failed after ${failedAfter}ms)`)
  t.ok(failedAfter < WINDOW * 6, 'and not held to the 30-minute bound')
})

// The extension is scoped to peers holding OUR chunks. A peer we only sent a content request to
// may never answer at all — a holder that lacks the file and one whose serve gate denied us both
// return silently — so its unrelated traffic on the shared mux must not re-arm anything, or every
// connected peer becomes an unbounded hold. Fast-failing that wait is what `_requested` is for.
test('REGRESSION (FIX-BW10): an unanswered content request cannot extend the fetch', async (t) => {
  const WINDOW = scaled(400)
  const holder = { id: 'holder' }
  const asked = { id: 'asked-but-silent' }
  const rx = rxTicker(1024 * KB, 20)                      // the non-holder is busy with other work
  const startedAt = Date.now()
  let failedAfter = null
  const sched = new ChunkScheduler({
    path: 'content:asked',
    destPath: '/tmp/asked',
    transfer: fakeTransfer,
    timeout: WINDOW,
    cap: 4,
    peerBytes: (peer) => (peer === asked ? rx.read() : 0),
    sendNeed: () => {},
  })
  sched.promise().catch(() => { failedAfter = Date.now() - startedAt })
  sched.noteRequested(asked)                              // fanned out to it; it never answers
  await sched.onChunkHashes(holder, chunkList(20, CHUNK)) // the real holder answers, then wedges
  t.ok(sched._requested.has(asked), 'the unanswered peer is still outstanding (precondition)')

  await wait(WINDOW * 3)
  rx.stop()
  t.ok(failedAfter !== null, `the wedged holder was caught (after ${failedAfter}ms)`)
  t.ok(failedAfter < WINDOW * 3, 'inside the window, not held to the 30-minute bound')
})
