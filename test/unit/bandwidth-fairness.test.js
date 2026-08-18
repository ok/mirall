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
