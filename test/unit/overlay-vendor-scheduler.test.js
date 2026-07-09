import test from 'brittle'
import { ChunkScheduler } from '../../src/shared/transfer/backends/overlay/vendor/chunk-scheduler.js'

// A TransferManager stub: the scheduler only needs startReceive/writeChunk/finalize.
// We accept every chunk (the real hash-verify is exercised in the vendor-transfer
// integration test); here we isolate the timeout state machine.
function fakeTransfer (received = new Set()) {
  return {
    startReceive () { return { received } },
    writeChunk () { return { ok: true } },
    finalize () { return { ok: true } },
  }
}

const peer = { id: 'p1' }
const chunkList = (n) => Array.from({ length: n }, (_, i) => ({ hash: 'h' + i, length: 10 }))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

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
  await sched.onChunkHashes(peer, chunks)
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
  await sched.onChunkHashes(peer, chunkList(2))
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
  await sched.onChunkHashes(peer, chunkList(3))
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
  await sched.onChunkHashes(peer, chunkList(4)) // 4 chunks × 10 bytes
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
  await sched.onChunkHashes(peer, chunkList(3))
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
  await sched.onChunkHashes(peer, chunkList(4))
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
  await sched.onChunkHashes(peer, chunkList(3))
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
  await sched.onChunkHashes(peer, chunkList(3)) // fresh: have=0, no baseline at start
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
  await sched.onChunkHashes(peer, chunkList(3))
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
    async startReceive () { await wait(60); return { received: new Set() } },
    writeChunk () { return { ok: true } },
    finalize () { return { ok: true } },
  }
  const sched = new ChunkScheduler({
    path: 'content:slow', destPath: '/tmp/slow', transfer: slowTransfer,
    sendNeed: (_p, idx) => sent.push(...idx), timeout: 20,
  })
  const settled = sched.promise().catch((e) => e)
  await sched.onChunkHashes(peer, chunkList(2))
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
    startReceive () { return new Promise((r) => { release = () => r({ received: new Set() }) }) },
    writeChunk () { return { ok: true } },
    finalize () { return { ok: true } },
  }
  const sched = new ChunkScheduler({
    path: 'content:cancel-setup', destPath: '/tmp/cancel-setup', transfer: slowTransfer,
    sendNeed: (_p, idx) => sent.push(...idx), timeout: 1000,
  })
  const settled = sched.promise().catch((e) => e.code)
  const pending = sched.onChunkHashes(peer, chunkList(2))
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
    startReceive () { return { received: new Set() } },
    writeChunk () { return { ok: false, error: 'no space left on device', code: 'ENOSPC' } },
    finalize () { return { ok: true } },
  }
  const sched = new ChunkScheduler({
    path: 'content:enospc', destPath: '/tmp/enospc', transfer: enospcTransfer,
    sendNeed: () => { assigns++ }, timeout: 1000,
  })
  const done = sched.promise()
  await sched.onChunkHashes(peer, chunkList(3))
  const before = assigns
  sched.onChunkData(peer, 0, Buffer.alloc(10))
  await t.exception(done, /write failed/, 'fetch rejects on the fatal write error')
  try { await done } catch (err) { t.is(err.code, 'ENOSPC', 'the fs error code is preserved') }
  t.is(assigns, before, 'no re-assign/retry after a fatal write error')
  t.is(sched.done, true, 'scheduler marked done')
})

test('REGRESSION (FIX-129): an uncoded writeChunk failure (mismatch) stays retryable, not fatal', async (t) => {
  const mismatchTransfer = {
    startReceive () { return { received: new Set() } },
    writeChunk () { return { ok: false, error: 'hash mismatch' } },
    finalize () { return { ok: true } },
  }
  const sched = new ChunkScheduler({
    path: 'content:mismatch', destPath: '/tmp/mismatch', transfer: mismatchTransfer,
    sendNeed: () => {}, timeout: 1000,
  })
  sched.promise().catch(() => {})
  await sched.onChunkHashes(peer, chunkList(2))
  sched.onChunkData(peer, 0, Buffer.alloc(10))
  t.absent(sched.done, 'a content mismatch does not fail the fetch (retried elsewhere)')
  sched.cancel()
})

test('REGRESSION (FIX-129): a TRANSIENT coded writeChunk failure (EBUSY) is retried, not fatal', async (t) => {
  const busyTransfer = {
    startReceive () { return { received: new Set() } },
    writeChunk () { return { ok: false, error: 'device busy', code: 'EBUSY' } },
    finalize () { return { ok: true } },
  }
  const sched = new ChunkScheduler({
    path: 'content:ebusy', destPath: '/tmp/ebusy', transfer: busyTransfer,
    sendNeed: () => {}, timeout: 1000,
  })
  sched.promise().catch(() => {})
  await sched.onChunkHashes(peer, chunkList(2))
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
    startReceive () { return new Promise((r) => { release = () => r({ received: new Set() }) }) },
    writeChunk () { return { ok: true } },
    async finalize () { return { ok: true } },
  }
  const sched = new ChunkScheduler({
    path: 'content:multi', destPath: '/tmp/multi', transfer: slowTransfer,
    sendNeed: (_p, idx) => sent.push(...idx), timeout: 20,
  })
  const settled = sched.promise().catch((e) => e)
  const p1 = sched.onChunkHashes('peerA', chunkList(2)) // begins the long setup
  await sched.onChunkHashes('peerB', chunkList(2))       // a concurrent seeder lands mid-setup
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
    startReceive () { return { received: new Set() } },
    writeChunk () { return { ok: true } },
    async finalize () { return { ok: true } },
    async pause (p) { paused.push(p) },
  }
  const sched = new ChunkScheduler({
    path: 'content:failpause', destPath: '/tmp/failpause', transfer,
    sendNeed: () => {}, timeout: 100,
  })
  const done = sched.promise()
  await sched.onChunkHashes(peer, chunkList(2))
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
  await sched.onChunkHashes(peer, chunkList(2))
  await t.exception(done, /stalled/, 'stall still rejects cleanly without a pause method')
})
