import test from 'brittle'
import { ChunkScheduler } from '../../src/shared/transfer/overlay/engine/scheduler/scheduler.js'
import { TIERS } from '../../src/shared/transfer/overlay/engine/chunker.js'

// A TransferManager stub: the scheduler only needs startReceive/writeChunk/finalize.
// We accept every chunk (the real hash-verify is exercised in the vendor-transfer
// integration test); here we isolate the timeout state machine.
function fakeTransfer(received = new Set()) {
  return {
    startReceive() { return { received } },
    writeChunk() { return { ok: true } },
    finalize() { return { ok: true } },
  }
}

const peer = { id: 'p1' }
const chunkList = (n) => Array.from({ length: n }, (_, i) => ({ hash: 'h' + i, length: 10 }))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
// The scheduler takes a chunk list only from a peer it asked.
const answer = (sched, p, list) => { sched.noteRequested(p); return sched.onChunkHashes(p, list) }

// REGRESSION (FIX: large-file overlay download stall): the scheduler timeout used
// to be a fixed OVERALL cap (30s), so any transfer slower than the cap — every
// multi-GB file, at any bandwidth — was aborted mid-stream. It is now an IDLE
// timeout, re-armed on each accepted chunk: steady progress past the window must
// complete; only a genuine stall fails.
test('idle timeout: a steadily-progressing transfer outlives the window (no overall cap)', async (t) => {
  const sched = new ChunkScheduler({
    path: 'content:steady', destPath: '/tmp/steady', transfer: fakeTransfer(),
    sendNeed: () => {}, timeout: 300, cap: 8,
  })
  const done = sched.promise()
  const chunks = chunkList(4)
  await answer(sched, peer, chunks)
  // Deliver one chunk every 100ms — 400ms total, well past the 300ms window a
  // fixed overall cap would impose, but each arrival is < 300ms apart so the idle
  // timer never fires.
  for (let i = 0; i < chunks.length; i++) {
    await wait(100)
    sched.onChunkData(peer, i, Buffer.alloc(10))
  }
  await done
  t.pass('completed without timing out — the timer is idle-based, re-armed per chunk')
})

test('idle timeout: a stalled transfer fails after the window', async (t) => {
  const sched = new ChunkScheduler({
    path: 'content:stall', destPath: '/tmp/stall', transfer: fakeTransfer(),
    sendNeed: () => {}, timeout: 150,
  })
  const done = sched.promise()
  await answer(sched, peer, chunkList(2))
  sched.onChunkData(peer, 0, Buffer.alloc(10)) // some progress, then go silent
  await t.exception(done, /stalled/, 'fails ~one idle window after the last accepted chunk')
})

// The terminal diagnostic hook (drives the [overlay] scheduler-end log) must
// report the reason and the bytes/chunks transferred at the point it ended.
test('onEnd reports the terminal reason and progress for the stall diagnostic', async (t) => {
  let ended = null
  const sched = new ChunkScheduler({
    path: 'content:diag', destPath: '/tmp/diag', transfer: fakeTransfer(),
    sendNeed: () => {}, timeout: 120, onEnd: (info) => { ended = info },
  })
  const done = sched.promise()
  await answer(sched, peer, chunkList(3))
  sched.onChunkData(peer, 0, Buffer.alloc(10))
  await t.exception(done, /stalled/)
  t.ok(ended, 'onEnd fired')
  t.is(ended.ok, false, 'reported as a failure')
  t.ok(/stalled/.test(ended.reason), 'reason carries the stall message')
  t.is(ended.receivedBytes, 10, 'received-bytes reflects the one accepted chunk')
  t.is(ended.totalBytes, 30, 'total-bytes is the full file size')
  t.is(ended.chunksRemaining, 2, 'two chunks were still outstanding at the stall')
})

// Resume: startReceive reports which chunks the partial already holds; the
// scheduler must request ONLY the missing ones and seed the byte counter so
// progress/ETA continue from the resumed offset rather than restarting at 0.
test('resume: requests only the chunks the partial lacks + seeds bytes', async (t) => {
  const needed = []
  let progress = null
  const sched = new ChunkScheduler({
    path: 'content:resume', destPath: '/tmp/resume',
    transfer: fakeTransfer(new Set([0, 1])),
    sendNeed: (_p, indices) => needed.push(...indices),
    onProgress: (r, tot) => { progress = { r, tot } },
    cap: 8, timeout: 1000,
  })
  sched.promise().catch(() => {})
  await answer(sched, peer, chunkList(4)) // 4 chunks × 10 bytes
  t.alike(needed.sort((a, b) => a - b), [2, 3], 'only the missing chunks are requested')
  t.ok(progress, 'progress emitted at resume')
  t.is(progress.r, 20, 'byte counter seeded with the two resumed chunks (10 each)')
  t.is(progress.tot, 40, 'total is the full file size')
  sched.cancel()
})

test('resume: a fully-present partial finalizes without requesting any chunk', async (t) => {
  let sent = 0
  const sched = new ChunkScheduler({
    path: 'content:full', destPath: '/tmp/full',
    transfer: fakeTransfer(new Set([0, 1, 2])),
    sendNeed: () => { sent++ }, timeout: 1000,
  })
  const done = sched.promise()
  await answer(sched, peer, chunkList(3))
  await done
  t.is(sent, 0, 'no chunk requested — the partial was already complete')
})

// The scheduler reports its have-bytes to holders right after startReceive (resume
// baseline), so holders can seed their sender-side bar to our true completion. A fresh
// download (nothing resumed) sends no baseline at start.
test('resume: emits onBaseline with the resumed byte count', async (t) => {
  let baseline = null
  const sched = new ChunkScheduler({
    path: 'content:base', destPath: '/tmp/base',
    transfer: fakeTransfer(new Set([0, 1])),
    sendNeed: () => {},
    onBaseline: (have) => { baseline = have },
    cap: 8, timeout: 1000,
  })
  sched.promise().catch(() => {})
  await answer(sched, peer, chunkList(4))
  t.is(baseline, 20, 'baseline = the two resumed chunks (10 each)')
  sched.cancel()
})

test('fresh download: no baseline is emitted at start (nothing resumed)', async (t) => {
  let called = false
  const sched = new ChunkScheduler({
    path: 'content:fresh', destPath: '/tmp/fresh',
    transfer: fakeTransfer(new Set()),
    sendNeed: () => {},
    onBaseline: () => { called = true },
    cap: 8, timeout: 1000,
  })
  sched.promise().catch(() => {})
  await answer(sched, peer, chunkList(3))
  t.is(called, false, 'have === 0 → no baseline frame at start')
  sched.cancel()
})

// Holders that join (or finish prepping) AFTER the resume baseline still need the true
// have, so the scheduler re-reports cumulative have-bytes as chunks land — throttled by
// reportInterval (0 here = report on every accepted chunk).
test('reports cumulative have-progress as chunks arrive (throttled by reportInterval)', async (t) => {
  const reports = []
  const sched = new ChunkScheduler({
    path: 'content:report', destPath: '/tmp/report',
    transfer: fakeTransfer(),
    sendNeed: () => {},
    onBaseline: (have) => reports.push(have),
    reportInterval: 0,
    cap: 8, timeout: 1000,
  })
  sched.promise().catch(() => {})
  await answer(sched, peer, chunkList(3)) // fresh: have=0, no baseline at start
  t.is(reports.length, 0, 'no report before any chunk lands')
  sched.onChunkData(peer, 0, Buffer.alloc(10))
  sched.onChunkData(peer, 1, Buffer.alloc(10))
  t.alike(reports, [10, 20], 'cumulative have re-reported per accepted chunk')
  sched.cancel()
})

test('cancel(): rejects the fetch with ECANCELLED and marks done', async (t) => {
  const sched = new ChunkScheduler({
    path: 'content:cancel', destPath: '/tmp/cancel', transfer: fakeTransfer(),
    sendNeed: () => {}, timeout: 1000,
  })
  const done = sched.promise()
  await answer(sched, peer, chunkList(3))
  sched.cancel()
  t.is(sched.done, true, 'scheduler marked done')
  await t.exception(done, /cancelled/, 'promise rejects on cancel')
  try { await done } catch (err) { t.is(err.code, 'ECANCELLED', 'distinct cancel code surfaced') }
})

// REGRESSION (FIX-A: the resume re-verify can run for seconds; arming the idle
// watchdog before it would self-trip a transfer that is making real progress).
test('REGRESSION (FIX-A): a slow startReceive is not charged against the idle watchdog', async (t) => {
  const sent = []
  const slowTransfer = {
    async startReceive() { await wait(60); return { received: new Set() } },
    writeChunk() { return { ok: true } },
    finalize() { return { ok: true } },
  }
  const sched = new ChunkScheduler({
    path: 'content:slow', destPath: '/tmp/slow', transfer: slowTransfer,
    sendNeed: (_p, idx) => sent.push(...idx), timeout: 20,
  })
  const settled = sched.promise().catch((e) => e)
  await answer(sched, peer, chunkList(2))
  t.absent(sched.done, 'did not stall-fail despite setup > idle window')
  t.ok(sent.length > 0, 'assigned chunk-needs after setup')
  sched.cancel()
  await settled
})

// REGRESSION (FIX-A): a cancel landing during the async setup is honored — no
// chunk-needs go out and the fetch rejects with ECANCELLED.
test('REGRESSION (FIX-A): cancel during startReceive setup is honored', async (t) => {
  const sent = []
  let release
  const slowTransfer = {
    startReceive() { return new Promise((r) => { release = () => r({ received: new Set() }) }) },
    writeChunk() { return { ok: true } },
    finalize() { return { ok: true } },
  }
  const sched = new ChunkScheduler({
    path: 'content:cancel-setup', destPath: '/tmp/cancel-setup', transfer: slowTransfer,
    sendNeed: (_p, idx) => sent.push(...idx), timeout: 1000,
  })
  const settled = sched.promise().catch((e) => e.code)
  const pending = answer(sched, peer, chunkList(2))
  sched.cancel()
  release()
  await pending
  t.is(await settled, 'ECANCELLED', 'fetch rejected with ECANCELLED')
  t.is(sent.length, 0, 'no chunk-needs sent after cancel')
})

// REGRESSION (FIX-A: multi-seeder resume self-trip): while peer A's async startReceive
// (a long journal-less re-verify) runs, peer B's chunk list must NOT re-arm the idle
// watchdog — or it fires mid-verify and stall-fails a healthy resume.
// REGRESSION (FIX-129): a local I/O error during writeChunk (ENOSPC / EACCES) is
// fatal and non-retryable — the scheduler must fail the fetch carrying the code, not
// loop over peers re-requesting the chunk. Distinguished from a hash/length mismatch
// (no code, retryable) and from a transient code (retryable).
test('REGRESSION (FIX-129): a fatal coded writeChunk failure fails the fetch with that code', async (t) => {
  let assigns = 0
  const enospcTransfer = {
    startReceive() { return { received: new Set() } },
    writeChunk() { return { ok: false, error: 'no space left on device', code: 'ENOSPC' } },
    finalize() { return { ok: true } },
  }
  const sched = new ChunkScheduler({
    path: 'content:enospc', destPath: '/tmp/enospc', transfer: enospcTransfer,
    sendNeed: () => { assigns++ }, timeout: 1000,
  })
  const done = sched.promise()
  await answer(sched, peer, chunkList(3))
  const before = assigns
  sched.onChunkData(peer, 0, Buffer.alloc(10))
  await t.exception(done, /write failed/, 'fetch rejects on the fatal write error')
  try { await done } catch (err) { t.is(err.code, 'ENOSPC', 'the fs error code is preserved') }
  t.is(assigns, before, 'no re-assign/retry after a fatal write error')
  t.is(sched.done, true, 'scheduler marked done')
})

test('REGRESSION (FIX-129): an uncoded writeChunk failure (mismatch) stays retryable, not fatal', async (t) => {
  const mismatchTransfer = {
    startReceive() { return { received: new Set() } },
    writeChunk() { return { ok: false, error: 'hash mismatch' } },
    finalize() { return { ok: true } },
  }
  const sched = new ChunkScheduler({
    path: 'content:mismatch', destPath: '/tmp/mismatch', transfer: mismatchTransfer,
    sendNeed: () => {}, timeout: 1000,
  })
  sched.promise().catch(() => {})
  await answer(sched, peer, chunkList(2))
  sched.onChunkData(peer, 0, Buffer.alloc(10))
  t.absent(sched.done, 'a content mismatch does not fail the fetch (retried elsewhere)')
  sched.cancel()
})

test('REGRESSION (FIX-129): a TRANSIENT coded writeChunk failure (EBUSY) is retried, not fatal', async (t) => {
  const busyTransfer = {
    startReceive() { return { received: new Set() } },
    writeChunk() { return { ok: false, error: 'device busy', code: 'EBUSY' } },
    finalize() { return { ok: true } },
  }
  const sched = new ChunkScheduler({
    path: 'content:ebusy', destPath: '/tmp/ebusy', transfer: busyTransfer,
    sendNeed: () => {}, timeout: 1000,
  })
  sched.promise().catch(() => {})
  await answer(sched, peer, chunkList(2))
  sched.onChunkData(peer, 0, Buffer.alloc(10))
  t.absent(sched.done, 'a transient fs error does not fail the whole fetch')
  sched.cancel()
})

// REGRESSION (FIX-A: multi-seeder resume self-trip): while peer A's async startReceive
// (a long journal-less re-verify) runs, peer B's chunk list must NOT re-arm the idle
// watchdog — or it fires mid-verify and stall-fails a healthy resume.
test('REGRESSION (FIX-A): a second seeder during setup does not re-arm the stall watchdog', async (t) => {
  const sent = []
  let release
  const slowTransfer = {
    startReceive() { return new Promise((r) => { release = () => r({ received: new Set() }) }) },
    writeChunk() { return { ok: true } },
    async finalize() { return { ok: true } },
  }
  const sched = new ChunkScheduler({
    path: 'content:multi', destPath: '/tmp/multi', transfer: slowTransfer,
    sendNeed: (_p, idx) => sent.push(...idx), timeout: 20,
  })
  const settled = sched.promise().catch((e) => e)
  const p1 = answer(sched, 'peerA', chunkList(2)) // begins the long setup
  await answer(sched, 'peerB', chunkList(2))       // a concurrent seeder lands mid-setup
  await wait(50)                                          // > the 20ms idle window
  t.absent(sched.done, 'no stall-fail: the later seeder did not re-arm the watchdog during setup')
  release()
  await p1
  t.ok(sent.length > 0, 'proceeds to assign after setup completes')
  sched.cancel()
  await settled
})

// A _fail-ended fetch (stall / all-peers-gone / fatal write error) must release the
// receiver state at the failure boundary — journal + close via transfer.pause — so a
// never-retried failure parks no fd and no chunk stash in TransferManager._active.
test('a stall _fail releases the receiver state via transfer.pause', async (t) => {
  const paused = []
  const transfer = {
    startReceive() { return { received: new Set() } },
    writeChunk() { return { ok: true } },
    async finalize() { return { ok: true } },
    async pause(p) { paused.push(p) },
  }
  const sched = new ChunkScheduler({
    path: 'content:failpause', destPath: '/tmp/failpause', transfer,
    sendNeed: () => {}, timeout: 100,
  })
  const done = sched.promise()
  await answer(sched, peer, chunkList(2))
  sched.onChunkData(peer, 0, Buffer.alloc(10)) // progress, then silence → idle stall
  await t.exception(done, /stalled/)
  t.alike(paused, ['/tmp/failpause'], 'pause(destPath) called exactly once at the failure boundary')
})

test('a _fail with a transfer lacking pause() does not throw', async (t) => {
  const sched = new ChunkScheduler({
    path: 'content:nopause', destPath: '/tmp/nopause', transfer: fakeTransfer(),
    sendNeed: () => {}, timeout: 80,
  })
  const done = sched.promise()
  await answer(sched, peer, chunkList(2))
  await t.exception(done, /stalled/, 'stall still rejects cleanly without a pause method')
})

// --- download cap -----------------------------------------------------------
// The limiter is injected, so these drive the gate without a live overlay.

// Mirrors the shape of a real bandwidth-limiter STREAM handle (createBandwidthLimiter().
// stream()), which is what OverlayProtocolV2 injects — including `wouldBlock` and `detach`,
// so this double cannot certify an interface production never sees. `topUp` is the double's
// own budget knob and has no counterpart in the real handle; it is deliberately NOT called
// `release`, which used to collide with the scheduler's teardown hook and poison `left`.
function fakeLimiter(allowance) {
  let left = allowance
  let detached = false
  const waiters = []
  return {
    isUnlimited: () => false,
    tryTake(bytes) {
      if (detached || left < bytes) return false
      left -= bytes
      return true
    },
    wouldBlock: () => detached,
    give(bytes) { left += bytes },
    whenAvailable(bytes, cb) { if (!detached) waiters.push(cb) },
    detach() { detached = true; waiters.length = 0 },
    topUp(amount) {
      left += amount
      const pending = waiters.splice(0, waiters.length)
      for (const cb of pending) cb()
    },
    pendingWaiters: () => waiters.length,
    detached: () => detached,
  }
}

test('download cap: chunks are requested only as budget allows', async (t) => {
  const requested = []
  const limiter = fakeLimiter(20) // room for exactly 2 of the 4 ten-byte chunks
  const sched = new ChunkScheduler({
    path: 'content:capped', destPath: '/tmp/capped', transfer: fakeTransfer(),
    sendNeed: (_peer, indices) => requested.push(...indices), timeout: 5000, cap: 8, limiter,
  })
  const done = sched.promise()
  await answer(sched, peer, chunkList(4))
  t.is(requested.length, 2, 'only the affordable chunks were asked for')
  t.is(limiter.pendingWaiters(), 1, 'the scheduler registered a retry for the rest')

  limiter.topUp(20)
  await wait(0)
  t.is(requested.length, 4, 'the rest are requested once budget refills')

  for (let i = 0; i < 4; i++) sched.onChunkData(peer, i, Buffer.alloc(10))
  await done
  t.pass('capped transfer still completes')
})

// REGRESSION (FIX: bandwidth cap must not look like a stall): the idle watchdog measures
// SILENCE. Time spent waiting on our own limiter is not silence, so a cap low enough to
// hold every chunk longer than the window must not fail the transfer.
test('download cap: waiting on the limiter does not trip the idle watchdog', async (t) => {
  const limiter = fakeLimiter(10) // one chunk, then gated for the rest of the test
  const sched = new ChunkScheduler({
    path: 'content:slow', destPath: '/tmp/slow', transfer: fakeTransfer(),
    sendNeed: () => {}, timeout: 120, cap: 8, limiter,
  })
  const done = sched.promise()
  await answer(sched, peer, chunkList(4))

  // Stay gated for well over the idle window, re-arming as a real refill loop would.
  for (let i = 0; i < 4; i++) {
    await wait(60)
    limiter.topUp(0)
  }

  let failed = false
  done.catch(() => { failed = true })
  await wait(0)
  t.absent(failed, 'no stall failure while the transfer was merely paced')

  limiter.topUp(1000)
  await wait(0)
  for (let i = 0; i < 4; i++) sched.onChunkData(peer, i, Buffer.alloc(10))
  await done
  t.pass('completes once the cap allows')
})

test('REGRESSION (MIR-53: a bad chunk refunds the cap only when it was charged to its sender)', async (t) => {
  const limiter = fakeLimiter(1000)
  let refunded = 0
  const give = limiter.give
  limiter.give = (bytes) => { refunded += bytes; give(bytes) }
  const mismatch = {
    startReceive() { return { received: new Set() } },
    writeChunk() { return { ok: false, error: 'hash mismatch' } },
    finalize() { return { ok: true } },
  }
  const sched = new ChunkScheduler({
    path: 'content:refund', destPath: '/tmp/refund', transfer: mismatch,
    sendNeed: () => {}, timeout: 1000, cap: 8, limiter,
  })
  sched.promise().catch(() => {})
  await answer(sched, peer, chunkList(2))

  sched.onChunkData({ id: 'stranger' }, 0, Buffer.alloc(10))
  t.is(refunded, 0, 'a chunk never charged to the sender refunds nothing')
  sched.onChunkData(peer, 0, Buffer.alloc(10))
  t.is(refunded, 10, "the charged peer's bad chunk is refunded, once")
  sched.cancel()
})

test('REGRESSION (MIR-53: a source takes no chunk the fetch has in flight to another peer, nor one already written)', async (t) => {
  const limiter = fakeLimiter(20)
  const written = []
  const transfer = { ...fakeTransfer(), writeChunk(_dest, index) { written.push(index); return { ok: true } } }
  const sched = new ChunkScheduler({
    path: 'content:owed', destPath: '/tmp/owed', transfer, sendNeed: () => {}, timeout: 1000, cap: 1, limiter,
  })
  sched.promise().catch(() => {})
  const other = { id: 'p2' }
  await answer(sched, peer, chunkList(4))
  await answer(sched, other, chunkList(4))
  t.ok(sched.awaitsChunk(peer, 0) && sched.awaitsChunk(other, 1), 'precondition: chunk 0 is in flight to peer, 1 to other')

  sched.onChunkData(peer, 1, Buffer.alloc(10))
  sched.onChunkData(peer, 3, Buffer.alloc(10))
  t.alike(written, [], "neither another peer's chunk nor an unassigned one is written")
  sched.onChunkData(peer, 0, Buffer.alloc(10))
  sched.onChunkData(peer, 0, Buffer.alloc(10))
  t.alike(written, [0], 'its own chunk is written, once')
  sched.cancel()
  t.absent(sched.awaitsChunk(other, 1), 'nothing is awaited once the fetch ends')
})

function countingTransfer() {
  const calls = []
  return {
    calls,
    startReceive(dest, meta) { calls.push(meta); return { received: new Set() } },
    writeChunk() { return { ok: true } },
    finalize() { return { ok: true } },
    pause() {},
  }
}
const MIN0 = TIERS[0].minSize
// A tier-0 honest map: three min-size chunks and a 100-byte tail.
const SIZE = 3 * MIN0 + 100
const honest = () => [
  { hash: 'a'.repeat(64), length: MIN0 }, { hash: 'b'.repeat(64), length: MIN0 },
  { hash: 'c'.repeat(64), length: MIN0 }, { hash: 'd'.repeat(64), length: 100 },
]
const sized = (transfer, extra = {}) => new ChunkScheduler({
  path: 'content:x', destPath: '/tmp/x', transfer, sendNeed: () => {}, timeout: 1000, size: SIZE, ...extra,
})

test('REGRESSION (MIR-46: a map from a peer we never asked is dropped)', async (t) => {
  const transfer = countingTransfer()
  const sched = sized(transfer)
  sched.promise().catch(() => {})
  const owner = { id: 'owner' }
  const raw = { id: 'raw' }
  sched.noteRequested(owner)
  await sched.onChunkHashes(raw, [{ hash: 'e'.repeat(64), length: SIZE }])
  t.is(transfer.calls.length, 0, 'the unsolicited map never reached startReceive')
  t.absent(sched.done, 'the fetch is still waiting on the owner')
  await sched.onChunkHashes(owner, honest())
  t.is(transfer.calls.length, 1, 'the owner map started the receive')
  t.is(transfer.calls[0]?.size, SIZE, 'geometry is the owner map')
  sched.cancel()
})

test('REGRESSION (MIR-46: a map whose lengths do not sum to the catalog size never reaches startReceive)', async (t) => {
  const transfer = countingTransfer()
  const sched = sized(transfer)
  const done = sched.promise()
  const owner = { id: 'owner' }
  sched.noteRequested(owner)
  await sched.onChunkHashes(owner, [...honest(), { hash: 'f'.repeat(64), length: 1 }])
  await t.exception(done, /chunk map rejected: size mismatch/)
  t.is(transfer.calls.length, 0, 'no partial was created or truncated')
})

test('a size of 0 is an unknown size, not an empty file the map must match', async (t) => {
  const transfer = countingTransfer()
  const sched = sized(transfer, { size: 0 })
  sched.promise().catch(() => {})
  const owner = { id: 'owner' }
  sched.noteRequested(owner)
  await sched.onChunkHashes(owner, honest())
  t.is(transfer.calls.length, 1, 'the owner map started the receive')
  sched.cancel()
})

test('REGRESSION (MIR-46: a map with more entries than the tier allows is refused)', async (t) => {
  const transfer = countingTransfer()
  const sched = sized(transfer)
  const done = sched.promise()
  const owner = { id: 'owner' }
  sched.noteRequested(owner)
  const n = Math.ceil(SIZE / MIN0) + 2
  const base = Math.floor(SIZE / n)
  const list = Array.from({ length: n }, (_, i) => ({ hash: i.toString(16).padStart(64, '0'), length: i === n - 1 ? SIZE - base * (n - 1) : base }))
  await sched.onChunkHashes(owner, list)
  await t.exception(done, /too many chunks/)
  t.is(transfer.calls.length, 0)
})

test('REGRESSION (MIR-46: a chunk longer than the tier maximum is refused)', async (t) => {
  const size = TIERS[0].maxSize + 1
  const transfer = countingTransfer()
  const sched = sized(transfer, { size })
  const done = sched.promise()
  const owner = { id: 'owner' }
  sched.noteRequested(owner)
  await sched.onChunkHashes(owner, [{ hash: 'a'.repeat(64), length: size }])
  await t.exception(done, /chunk length out of range/)
  t.is(transfer.calls.length, 0)
})

test('REGRESSION (MIR-46: a second map that differs from the adopted one is not a source)', async (t) => {
  const needs = []
  const transfer = countingTransfer()
  const sched = sized(transfer, { sendNeed: (p, idx) => needs.push([p.id, ...idx]) })
  sched.promise().catch(() => {})
  const a = { id: 'a' }
  const b = { id: 'b' }
  sched.noteRequested(a)
  sched.noteRequested(b)
  await sched.onChunkHashes(a, honest())
  const forged = honest().map((c) => ({ ...c, hash: 'f'.repeat(64) }))
  await sched.onChunkHashes(b, forged)
  t.absent(sched.sources().has(b), 'b was refused as a source')
  t.ok(needs.every(([id]) => id === 'a'), 'no chunk-need was ever sent to b')
  t.is(transfer.calls.length, 1, 'the adopted map was not replaced')
  sched.cancel()
})

test('MIR-46: an identical second map joins as a source', async (t) => {
  const transfer = countingTransfer()
  const sched = sized(transfer)
  sched.promise().catch(() => {})
  const a = { id: 'a' }
  const b = { id: 'b' }
  sched.noteRequested(a)
  sched.noteRequested(b)
  await sched.onChunkHashes(a, honest())
  await sched.onChunkHashes(b, honest())
  t.ok(sched.sources().has(b), 'an honest co-holder is a source')
  sched.cancel()
})

test('MIR-46: a peer that already answered cannot answer again', async (t) => {
  const transfer = countingTransfer()
  const sched = sized(transfer, { size: undefined })
  sched.promise().catch(() => {})
  const a = { id: 'a' }
  sched.noteRequested(a)
  await sched.onChunkHashes(a, honest())
  t.absent(sched.awaitsMapFrom(a), 'no longer awaited')
  await sched.onChunkHashes(a, [{ hash: 'e'.repeat(64), length: 5 }])
  t.is(transfer.calls.length, 1, 'the repeat was ignored')
  sched.cancel()
})

test('MIR-52: maxMapEntries is the tier bound for a known size, null without one', (t) => {
  const known = sized(countingTransfer())
  t.is(known.maxMapEntries(), Math.ceil(SIZE / MIN0) + 1, 'the same bound the map is refused past')
  const big = sized(countingTransfer(), { size: 20 * 1024 ** 3 })
  t.is(big.maxMapEntries(), Math.ceil(20 * 1024 ** 3 / TIERS[3].minSize) + 1, 'the tier follows the size')
  const unknown = sized(countingTransfer(), { size: 0 })
  t.is(unknown.maxMapEntries(), null, 'no known size, no derived bound')
  for (const s of [known, big, unknown]) s.cancel()
})
