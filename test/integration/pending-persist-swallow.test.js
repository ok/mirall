import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import {
  initPendingTransfers, recordPending, recordPendingError, updatePendingProgress, getPendingFor, _pendingBeeForTests,
} from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads, isDownloadedFile, markDownloaded } from '../../src/shared/transfer/files.js'
import { ErrorCodes } from '../../src/shared/core/errors.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/backends/overlay/overlay-download.js'

// A write that encodes STATUS or INTENT may fail loudly, never silently. These pin the four
// pending-row writes in the download engine plus the read-modify-write ordering that protects
// the verdict they record.

const HASH_OLD = 'a'.repeat(64)
const HASH_NEW = 'b'.repeat(64)
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const settleTick = () => tick(400) // the reconcile coalescer window plus its sweep

// Capture only the module under test's warn lines; everything else still reaches the real
// console (brittle's TAP rides on it — a blanket stub miscounts and hides diagnostics).
function captureLog (t, method, prefix) {
  const lines = []
  const real = console[method]
  console[method] = (...a) => { const s = a.join(' '); if (s.startsWith(prefix)) lines.push(s); else real(...a) }
  t.teardown(() => { console[method] = real })
  return lines
}

// Make selected writes to the pending bee fail. Predicates see (key, value) for put and (key)
// for del; a predicate that returns false lets the write through unchanged.
function failPendingWrites (t, { put = () => false, del = () => false } = {}) {
  const bee = _pendingBeeForTests()
  const realPut = bee.put.bind(bee)
  const realDel = bee.del.bind(bee)
  bee.put = (key, value, opts) => put(key, value) ? Promise.reject(new Error('EIO: injected put failure')) : realPut(key, value, opts)
  bee.del = (key, opts) => del(key) ? Promise.reject(new Error('EIO: injected del failure')) : realDel(key, opts)
  const restore = () => { bee.put = realPut; bee.del = realDel }
  t.teardown(restore)
  return restore
}

// Folder-style channel whose resolvePendingRow returns a live job, so resumeForOwner can
// re-drive a row. `started` collects every fetch the engine actually begins.
function channelFor (ctx, events, started, { hash = HASH_OLD, seq = 5 } = {}) {
  return {
    diagLabel: 'test download',
    inPlace: false,
    isOwnerOnline: () => true,
    ownsPendingRow: (row) => row.overlayShare === true,
    pendingExtra: (job) => ({ overlayShare: true, shareId: job.shareId, relPath: job.relPath }),
    emitProgress: () => {},
    emitVerifying: () => {},
    emitError: (job, code) => events.push(['error', code]),
    emitComplete: () => events.push(['complete']),
    emitCancelled: () => events.push(['cancelled']),
    emitSuperseded: () => events.push(['superseded']),
    emitPaused: () => events.push(['paused']),
    emitDecorationDone: () => {},
    emitUpdated: (spaceId) => events.push(['updated', spaceId]),
    transferIdForRow: (spaceId, row) => spaceId + '|folder1|' + row.relPath,
    resolvePendingRow: async (spaceId, row) => ({
      removed: false,
      seq,
      job: {
        spaceId, pendingKey: row.filePath, path: row.filePath, relPath: row.relPath, shareId: 'folder1',
        transferId: spaceId + '|folder1|' + row.relPath, contentHash: hash, size: 4096, sourceSeq: seq,
        ownerPublicKey: row.ownerKey, verifyKey: 'folder1|' + row.relPath,
        finalPath: path.join(ctx.tmpDir('dl'), row.relPath), prevBytes: row.bytesTransferred || 0,
      },
    }),
  }
}

async function setup (t) {
  const ctx = await freshPeer(t)
  await initDownloads()
  await initPendingTransfers()
  await initOverlay()
  t.teardown(async () => { await teardownOverlay() })
  return ctx
}

function makeJob (ctx, over = {}) {
  return {
    spaceId: 'space1', pendingKey: '/Photos/doc.bin', path: '/Photos/doc.bin', relPath: 'doc.bin',
    shareId: 'folder1', transferId: 'space1|folder1|doc.bin',
    contentHash: HASH_OLD, size: 4096, sourceSeq: 5, ownerPublicKey: 'peerpub', verifyKey: 'folder1|doc.bin',
    finalPath: path.join(ctx.tmpDir('dl'), 'doc.bin'), ...over,
  }
}

// REGRESSION (FIX-PENDING-SWALLOW-1: the errorCode write is the only thing that keeps a
// checksum failure out of the next level-triggered re-drive, and its rejection was swallowed —
// the UI was told 'error' while the row stayed an ordinary interrupted row that the next
// reconnect re-fetched from the same holder, to fail identically.)
test('REGRESSION (FIX-PENDING-SWALLOW-1): a checksum failure whose verdict cannot be persisted is still not auto-resumed', async (t) => {
  const ctx = await setup(t)
  const events = []
  const started = []
  const engine = createOverlayDownloadEngine(channelFor(ctx, events, started))
  getOverlay().fetchFile = (_hash, opts) => {
    started.push(opts.destPath)
    return Promise.reject(Object.assign(new Error('hash mismatch'), { code: 'EHASHMISMATCH' }))
  }
  // Only the verdict fails: start()'s own row write and progress ticks carry no errorCode.
  const restore = failPendingWrites(t, { put: (_key, value) => value.errorCode !== undefined })
  const warns = captureLog(t, 'warn', '[overlay-download]')

  await engine.start(makeJob(ctx))
  await tick()

  t.is(started.length, 1, 'the first fetch ran')
  t.ok(events.some(([k]) => k === 'error'), 'the UI is told the transfer failed (true before and after)')
  const row = await getPendingFor('space1', '/Photos/doc.bin')
  t.ok(row, 'the row survives the failure')
  t.absent(row.errorCode, 'the durable verdict really did not land — this test injects that')
  t.ok(warns.some((l) => l.includes('could not persist the transfer error')), 'the failed persist is said out loud')

  // The owner reconnects: the row must NOT be re-driven in this process.
  await engine.resumeForOwner('peerpub', 'space1')
  await settleTick()
  t.is(started.length, 1, 'no second fetch — the in-memory verdict suppresses the re-drive')

  // The user's explicit Resume outranks the verdict, like it outranks a durable errorCode.
  restore()
  engine.clearPauseMarker('space1|folder1|doc.bin')
  await engine.resumeForOwner('peerpub', 'space1')
  await settleTick()
  t.is(started.length, 2, 'a deliberate Resume re-attempts')
  t.is((await getPendingFor('space1', '/Photos/doc.bin')).errorCode, ErrorCodes.TRANSFER_CHECKSUM, 'with writes restored the verdict lands durably')
})

// REGRESSION (FIX-PENDING-SWALLOW-2: clearPending after a completed download was swallowed. The
// claim wins the status, but the resume scan iterated pending rows without a downloaded check —
// so a row that outlived its claim re-fetched a file already on disk on the next reconnect.)
test('REGRESSION (FIX-PENDING-SWALLOW-2): a completed download whose row outlives its claim is finished by the reconciler, not re-fetched', async (t) => {
  const ctx = await setup(t)
  const events = []
  const started = []
  const engine = createOverlayDownloadEngine(channelFor(ctx, events, started))
  const job = makeJob(ctx)
  getOverlay().fetchFile = (_hash, opts) => {
    started.push(opts.destPath)
    fs.writeFileSync(job.finalPath, 'landed bytes')
    return Promise.resolve({ destPath: job.finalPath, local: false, size: 12 })
  }
  const restore = failPendingWrites(t, { del: (key) => key === 'space1:/Photos/doc.bin' })
  const warns = captureLog(t, 'warn', '[overlay-download]')

  await engine.start(job)
  await tick()

  t.ok(events.some(([k]) => k === 'complete'), 'the download completed')
  t.ok(await isDownloadedFile('space1', '/Photos/doc.bin'), 'claimed downloaded')
  t.ok(await getPendingFor('space1', '/Photos/doc.bin'), 'the row survived the injected failed clear')
  t.ok(warns.some((l) => l.includes('could not clear the pending row of a completed download')), 'the failed clear is visible')

  await engine.resumeForOwner('peerpub', 'space1')
  await settleTick()
  t.is(started.length, 1, 'the reconciler does not fetch a file we already have')

  restore()
  await engine.resumeForOwner('peerpub', 'space1')
  await settleTick()
  t.absent(await getPendingFor('space1', '/Photos/doc.bin'), 'once the delete works, the reconciler finishes the intent')
  t.is(started.length, 1, 'still no second fetch')
})

// REGRESSION (FIX-PENDING-SWALLOW-3: clearPending on discard was swallowed — the renderer got
// 'cancelled' and the IPC returned ok while the row survived with its partial gone, so the next
// reconnect restarted the download the user had just discarded, from zero.)
test('REGRESSION (FIX-PENDING-SWALLOW-3): a discard whose row delete fails reports the failure instead of a cancel that did not happen', async (t) => {
  const ctx = await setup(t)
  const events = []
  const engine = createOverlayDownloadEngine(channelFor(ctx, events, []))
  getOverlay().fetchFile = () => new Promise(() => {})
  getOverlay().cancelFetch = () => {}
  const job = makeJob(ctx)
  await engine.start(job)
  failPendingWrites(t, { del: () => true })
  const warns = captureLog(t, 'warn', '[overlay-download]')

  await t.exception(engine.cancelByKey(job.spaceId, job.pendingKey, job.transferId), /injected del failure/, 'the caller sees the failed discard')
  t.ok(await getPendingFor('space1', '/Photos/doc.bin'), 'the row is still there — nothing durable changed')
  t.absent(events.some(([k]) => k === 'cancelled'), 'no cancelled event for a discard that did not land')
  t.ok(events.some(([k]) => k === 'updated'), 'the list is told to re-derive from the row')
  t.ok(warns.some((l) => l.includes('could not clear the pending row on discard')), 'and the log says why')
})

// REGRESSION (FIX-PENDING-SWALLOW-4: the row re-point on a republish restart was swallowed —
// emitSuperseded fired ("updated, re-downloading") and start() then failed the same write at
// debug level, leaving a restart spinner that never proceeds and nothing at warn.)
test('REGRESSION (FIX-PENDING-SWALLOW-4): a failed re-point skips the restart and says so; the next scan retries it', async (t) => {
  const ctx = await setup(t)
  const events = []
  const started = []
  const engine = createOverlayDownloadEngine(channelFor(ctx, events, started, { hash: HASH_NEW, seq: 9 }))
  getOverlay().fetchFile = (_hash, opts) => { started.push(opts.destPath); return new Promise(() => {}) }
  await recordPending('space1', '/Photos/doc.bin', {
    total: 4096, overlayShare: true, ownerKey: 'peerpub', shareId: 'folder1', relPath: 'doc.bin',
    contentHash: HASH_OLD, sourceSeq: 5, finalPath: path.join(ctx.tmpDir('dl'), 'doc.bin'), bytesTransferred: 100,
  })
  const restore = failPendingWrites(t, { put: (_key, value) => value.contentHash === HASH_NEW })
  const warns = captureLog(t, 'warn', '[overlay-download]')

  await engine.reconcileOnAppend('peerpub', 'space1')
  await settleTick()

  t.absent(events.some(([k]) => k === 'superseded'), 'no "re-downloading" announcement for a restart that could not be recorded')
  t.is(started.length, 0, 'no fetch on a row that still names the old content')
  t.is((await getPendingFor('space1', '/Photos/doc.bin')).contentHash, HASH_OLD, 'the row is unchanged, so the next scan derives restart again')
  t.ok(warns.some((l) => l.includes('could not re-point the pending row')), 'the failed write is visible')

  restore()
  await engine.reconcileOnAppend('peerpub', 'space1')
  await settleTick()
  t.ok(events.some(([k]) => k === 'superseded'), 'the next scan completes the restart')
  t.is(started.length, 1, 'and starts on the new content')
})

// REGRESSION (FIX-PENDING-SWALLOW-RMW: updatePendingProgress and recordPendingError were
// unserialized read-modify-writes on the same row. A progress tick issued after the error write
// — chunks still landing after a mismatch — read the row before the verdict and wrote it back
// without one.)
test('REGRESSION (FIX-PENDING-SWALLOW-RMW): a progress tick issued after the error write cannot erase the errorCode', async (t) => {
  await setup(t)
  await recordPending('space9', '/late.bin', { total: 10, overlayShare: true, ownerKey: 'peer', relPath: 'late.bin', finalPath: '/z' })

  // Both writes are issued in the same turn, error first — the order the engine issues them in
  // when chunks are still landing as the mismatch is classified.
  const verdict = recordPendingError('space9', '/late.bin', ErrorCodes.TRANSFER_CHECKSUM)
  const lateTick = updatePendingProgress('space9', '/late.bin', 9999)
  await Promise.all([verdict, lateTick])

  const row = await getPendingFor('space9', '/late.bin')
  t.is(row.errorCode, ErrorCodes.TRANSFER_CHECKSUM, 'the verdict survives a progress tick issued after it')
  t.is(row.bytesTransferred, 9999, 'and the tick still recorded its bytes')
})

// A claim written without a content hash (an older record, or a loose intent row) must NOT let
// the completed-row guard discard a pending row for genuinely new content: verifyOnDevice only
// compares hashes when both sides carry one, so the strict form is what the guard uses.
test('the completed-row guard needs a claim that names the same content, not just any claim', async (t) => {
  const ctx = await setup(t)
  const events = []
  const started = []
  const engine = createOverlayDownloadEngine(channelFor(ctx, events, started))
  const job = makeJob(ctx)
  getOverlay().fetchFile = (_hash, opts) => { started.push(opts.destPath); return new Promise(() => {}) }

  // A hashless claim at the row's path, and a row that wants NEW content.
  fs.writeFileSync(job.finalPath, 'stale bytes')
  await markDownloaded('space1', '/Photos/doc.bin', job.finalPath, { hash: null })
  await recordPending('space1', '/Photos/doc.bin', {
    total: 4096, overlayShare: true, ownerKey: 'peerpub', shareId: 'folder1', relPath: 'doc.bin',
    contentHash: HASH_OLD, sourceSeq: 5, finalPath: job.finalPath, bytesTransferred: 0,
  })

  await engine.resumeForOwner('peerpub', 'space1')
  await settleTick()

  t.ok(await getPendingFor('space1', '/Photos/doc.bin'), 'the row survives — a hashless claim does not prove we hold this content')
  t.is(started.length, 1, 'and the download actually runs')
})
