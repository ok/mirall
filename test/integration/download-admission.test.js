import test from 'brittle'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initPendingTransfers, recordPending } from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/backends/overlay/overlay-download.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'

const SPACE = 'space1'
const OWNER = 'ownerpub'
const hashFor = (n) => String(n % 10).repeat(64)

function testChannel (over = {}) {
  return {
    diagLabel: 'test download',
    inPlace: false,
    ownsPendingRow: (row) => row.overlayShare === true,
    pendingExtra: (job) => ({ overlayShare: true, shareId: job.shareId, relPath: job.relPath }),
    emitProgress: () => {}, emitError: () => {}, emitComplete: () => {}, emitCancelled: () => {},
    emitSuperseded: () => {}, emitPaused: () => {}, emitUpdated: () => {}, emitDecorationDone: () => {},
    transferIdForRow: (spaceId, row) => spaceId + '|folder1|' + row.relPath,
    isOwnerOnline: () => true,
    ...over,
  }
}

async function setup (t, concurrency) {
  const ctx = await freshPeer(t)
  await initDownloads()
  await initPendingTransfers()
  await initOverlay()
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, downloadConcurrency: concurrency })
  t.teardown(async () => { setRuntimeConfig(prev); await teardownOverlay() })
  return ctx
}

function makeJob (ctx, n, over = {}) {
  return {
    spaceId: SPACE, pendingKey: `/Photos/f${n}.bin`, path: `/Photos/f${n}.bin`, relPath: `f${n}.bin`,
    shareId: 'folder1', transferId: SPACE + '|folder1|f' + n + '.bin',
    contentHash: hashFor(n), size: 4096, ownerPublicKey: OWNER, verifyKey: 'folder1|f' + n + '.bin',
    finalPath: path.join(ctx.tmpDir('dl'), `f${n}.bin`), ...over,
  }
}

// A fetch that parks until released, so concurrency is observed structurally rather than by timing.
function barrierFetch () {
  const state = { live: 0, peak: 0, started: [], release: [] }
  getOverlay().fetchFile = async (hash, opts) => {
    state.live += 1
    state.peak = Math.max(state.peak, state.live)
    state.started.push(hash)
    await new Promise((resolve) => state.release.push(resolve))
    state.live -= 1
    return opts.finalPath
  }
  state.releaseAll = () => { while (state.release.length) state.release.shift()() }
  return state
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = () => sleep(60)

// Waits for a condition instead of a fixed delay: the resume path is coalesced and single-flighted,
// so a sleep long enough on this machine is not long enough on a slower CI runner.
async function until (fn, ms = 15000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(10)
  }
  return false
}

// REGRESSION (FIX-DL-ADMIT: runReconcile looped every pending row and called start() with no
// counting, so a reconnect with N pending rows spawned N chunk schedulers, watchdog timers, fds
// and progress tickers at once.)
test('REGRESSION (FIX-DL-ADMIT): a reconnect backlog never exceeds the admission limit', async (t) => {
  const ctx = await setup(t, 2)
  const jobs = Array.from({ length: 8 }, (_, i) => makeJob(ctx, i))
  const byKey = new Map(jobs.map((j) => [j.pendingKey, j]))
  const engine = createOverlayDownloadEngine(testChannel({
    resolvePendingRow: async (spaceId, row) => ({ removed: false, seq: undefined, job: byKey.get(row.filePath) }),
  }))
  const fetches = barrierFetch()

  for (const job of jobs) {
    await recordPending(SPACE, job.pendingKey, {
      total: job.size, inPlace: false, ownerKey: OWNER, finalPath: job.finalPath,
      contentHash: job.contentHash, bytesTransferred: 0, overlayShare: true,
      shareId: 'folder1', relPath: job.relPath,
    })
  }

  await engine.resumeForOwner(OWNER, SPACE)
  // Wait for the gate to fill rather than for a duration: the assertion is that it never fills
  // PAST the limit, which is checked continuously by the barrier's peak counter.
  t.ok(await until(() => engine.admissionStats().held >= 2), 'the reconcile admitted its first jobs')
  await settle()

  t.is(fetches.peak, 2, 'only two fetches ran at once')
  t.is(engine.admissionStats().held, 2, 'two slots held')
  t.ok(engine.admissionStats().queued >= 1, 'the rest are parked on the gate, not running')

  // Drain: every job must still complete once slots free.
  for (let i = 0; i < 40 && fetches.started.length < 8; i++) { fetches.releaseAll(); await settle() }
  t.is(fetches.started.length, 8, 'all eight eventually ran')
  t.is(fetches.peak, 2, 'and the peak never rose')
  fetches.releaseAll()
  await settle()
})

test('a job cancelled while queued never reaches the fetch', async (t) => {
  const ctx = await setup(t, 1)
  const engine = createOverlayDownloadEngine(testChannel())
  const fetches = barrierFetch()

  const first = makeJob(ctx, 1)
  const queued = makeJob(ctx, 2)
  await engine.start(first)
  t.ok(await until(() => fetches.started.length === 1), 'the first holds the only slot')

  await engine.start(queued)
  t.ok(await until(() => engine.admissionStats().queued === 1), 'the second is parked')
  t.is(fetches.started.length, 1, 'and never reached the fetch')

  engine.cancel(queued.transferId)
  fetches.releaseAll()
  await settle()

  t.is(fetches.started.length, 1, 'the cancelled job never fetched')
  t.absent(engine.has(queued.transferId), 'and left no registry slot behind')
  fetches.releaseAll()
  await settle()
})

test('an express job starts ahead of a queued bulk backlog', async (t) => {
  const ctx = await setup(t, 1)
  const engine = createOverlayDownloadEngine(testChannel())
  const fetches = barrierFetch()

  await engine.start(makeJob(ctx, 0))
  t.ok(await until(() => fetches.started.length === 1), 'the first job holds the only slot')
  for (let i = 1; i <= 4; i++) await engine.start(makeJob(ctx, i))
  t.ok(await until(() => engine.admissionStats().queued === 4), 'the bulk backlog is parked behind it')
  t.is(fetches.started.length, 1, 'none of the backlog started')

  await engine.start(makeJob(ctx, 9, { express: true }))
  t.ok(await until(() => fetches.started.length === 2), 'the express job started anyway')
  t.is(fetches.started[1], hashFor(9), 'and it was the express one, not the head of the bulk queue')

  fetches.releaseAll()
  await settle()
  fetches.releaseAll()
  await settle()
})

test('a limit of zero restores the unbounded behaviour', async (t) => {
  const ctx = await setup(t, 0)
  const engine = createOverlayDownloadEngine(testChannel())
  const fetches = barrierFetch()

  for (let i = 0; i < 6; i++) await engine.start(makeJob(ctx, i))
  t.ok(await until(() => fetches.peak === 6), 'every job ran at once')
  t.is(engine.admissionStats().queued, 0, 'nothing was gated')
  fetches.releaseAll()
  await settle()
})

// The supersede restart re-enters start() from inside settleFetch, which runs while the superseded
// job still holds its admission slot. It is safe only because restartAfterSupersede is
// fire-and-forget — settleFetch returns, the slot releases, and the restart's acquire is pumped by
// that release. An await added anywhere on that path would self-deadlock at limit 1, and this is
// the canary: it hangs rather than fails, so a timeout here means the chain became blocking.
test('a supersede restart at limit 1 does not deadlock on its own slot', async (t) => {
  const ctx = await setup(t, 1)
  const engine = createOverlayDownloadEngine(testChannel())
  const fetches = barrierFetch()

  const job = makeJob(ctx, 1)
  await engine.start(job)
  t.ok(await until(() => fetches.started.length === 1), 'the job holds the only slot')

  const newJob = makeJob(ctx, 2, { transferId: job.transferId, pendingKey: job.pendingKey })
  t.ok(engine.supersede(job.transferId, newJob, job.contentHash), 'superseded')
  fetches.releaseAll()
  t.ok(await until(() => fetches.started.length === 2),
    'the restart acquired the slot the superseded job released (a hang here means the chain became blocking)')
  t.is(fetches.started[1], hashFor(2), 'and it fetched the new content hash')
  fetches.releaseAll()
  await settle()
})

test('draining the gate at shutdown does not start a fetch into a torn-down overlay', async (t) => {
  const ctx = await setup(t, 1)
  const engine = createOverlayDownloadEngine(testChannel())
  const fetches = barrierFetch()

  await engine.start(makeJob(ctx, 1))
  t.ok(await until(() => fetches.started.length === 1), 'the first holds the slot')
  await engine.start(makeJob(ctx, 2))
  t.ok(await until(() => engine.admissionStats().queued === 1), 'the second is parked on the gate')

  await teardownOverlay()
  engine.drainAdmission()
  // A negative assertion, so it needs a real pause: the released waiter must NOT reach a fetch.
  await sleep(300)

  t.is(fetches.started.length, 1, 'the parked job abandoned instead of fetching')
  t.is(engine.admissionStats().queued, 0, 'and nothing is left holding close() open')
})
