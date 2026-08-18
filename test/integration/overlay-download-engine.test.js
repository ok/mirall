import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initPendingTransfers, recordPending, getPendingFor, updatePendingProgress, clearPending } from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads, isDownloadedFile } from '../../src/shared/transfer/files.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { ErrorCodes } from '../../src/shared/core/errors.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/backends/overlay/overlay-download.js'

// The shared overlay consumer engine (used by both loose + folder). The success/
// pause/resume paths need a peer to serve bytes (flow-tested in CI); here we cover
// the deterministic, network-free behavior: the pending row is recorded up front
// (so reconnect can auto-resume), and discard clears the partial + pending row.
function testChannel (events) {
  return {
    diagLabel: 'test download',
    inPlace: false,
    ownsPendingRow: (row) => row.overlayShare === true,
    pendingExtra: (job) => ({ overlayShare: true, shareId: job.shareId, relPath: job.relPath, catalogKey: job.catalogKey }),
    emitProgress: () => {},
    emitError: (...a) => events.push(['error', ...a]),
    emitComplete: () => {},
    emitCancelled: (...a) => events.push(['cancelled', ...a]),
    emitSuperseded: (job) => events.push(['superseded', job]),
    emitPaused: (job, reason, opts) => events.push(['paused', job, reason, opts]),
    emitUpdated: (spaceId) => events.push(['updated', spaceId]),
    transferIdForRow: (spaceId, row) => spaceId + '|folder1|' + row.relPath,
    resolvePendingRow: async () => ({ removed: false, seq: undefined, job: null }),
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
    shareId: 'folder1', catalogKey: 'cat-hex', transferId: 'space1|folder1|doc.bin',
    contentHash: 'h'.repeat(64), size: 4096, ownerPublicKey: 'peerpub', verifyKey: 'folder1|doc.bin',
    finalPath: path.join(ctx.tmpDir('dl'), 'doc.bin'), ...over,
  }
}

const tick = () => new Promise((r) => setTimeout(r, 30))

// #1 — a cancel that lands during the (no-op) startup window must NOT resurrect the
// file: even if the fetch races to completion, the IIFE drops the bytes.
test('#1: a cancel during an in-flight fetch never resurrects the downloaded file', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = { ...testChannel(events), isOwnerOnline: () => true }
  const engine = createOverlayDownloadEngine(channel)
  const overlay = getOverlay()
  let resolveFetch = null
  overlay.fetchFile = () => new Promise((res) => { resolveFetch = res })
  let cancelOpts = null
  overlay.cancelFetch = (_hash, opts) => { cancelOpts = opts }

  const finalPath = path.join(ctx.tmpDir('dl'), 'big.bin')
  const job = makeJob(ctx, { finalPath })
  await engine.start(job)
  t.ok(engine.has(job.transferId), 'in-flight slot reserved')

  await engine.cancelByKey(job.spaceId, job.pendingKey, job.transferId)
  t.is(cancelOpts?.discardPartial, true, 'cancelFetch(discardPartial:true) issued while fetching')
  t.absent(await getPendingFor(job.spaceId, job.pendingKey), 'pending row cleared on cancel')

  // The fetch races to completion AFTER the cancel (the abort was a no-op in this window).
  fs.writeFileSync(finalPath, 'landed bytes')
  resolveFetch({ destPath: finalPath, local: false, size: 11 })
  await tick()

  t.absent(fs.existsSync(finalPath), 'cancelled file removed, not resurrected')
  t.absent(await isDownloadedFile(job.spaceId, job.pendingKey), 'not marked downloaded')
  t.absent(engine.has(job.transferId), 'slot released')
})

// REGRESSION (FIX-1: pausing an in-flight overlay download logged a WARN
// "INCOMPLETE … gave up at N/M bytes" — a deliberate pause read as a failure in
// the console). A pause keeps the row + partial for resume and is NOT a give-up.
test('#pause: keeps the resumable row and never warns (pause is not a give-up)', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = { ...testChannel(events), isOwnerOnline: () => true }
  const engine = createOverlayDownloadEngine(channel)
  const overlay = getOverlay()
  let rejectFetch = null
  overlay.fetchFile = () => new Promise((_res, rej) => { rejectFetch = rej })
  let cancelOpts = null
  overlay.cancelFetch = (_hash, opts) => { cancelOpts = opts }

  const finalPath = path.join(ctx.tmpDir('dl'), 'big.bin')
  const job = makeJob(ctx, { finalPath })
  await engine.start(job)
  t.ok(engine.has(job.transferId), 'in-flight slot reserved')

  t.ok(engine.pause(job.transferId), 'pause accepted while fetching')
  t.is(cancelOpts?.discardPartial, false, 'pause keeps the partial (discardPartial:false)')

  // Settle the paused fetch (cancelFetch makes the scheduler reject ECANCELLED).
  // Capture console.warn across the IIFE to prove a deliberate pause emits no WARN.
  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  try {
    rejectFetch(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }))
    await tick()
  } finally { console.warn = origWarn }

  t.is(warns.length, 0, 'pausing emits no WARN — not "INCOMPLETE … gave up"')
  t.ok(await getPendingFor(job.spaceId, job.pendingKey), 'pending row kept so resume can continue')
  t.absent(events.some((e) => e[0] === 'error'), 'no error event on a pause')
  t.ok(events.some((e) => e[0] === 'updated'), 'emitUpdated fired so the row derives a paused state')
  t.absent(engine.has(job.transferId), 'single-flight slot released after the pause settles')
})

// REGRESSION (FIX-1: when the only holder quits mid-download the overlay fetch gives up
// with no r.code — no-holder / all-peers-gone / stall. That must NOT record an errorCode:
// the row stays clean so the status derives paused-offline and auto-resumes on reconnect,
// mirroring the eager path. Previously it recorded PEER_NOT_AVAILABLE → status 'error' →
// the user saw "Transfer failed").
// [mirall] FIX-BW9 moved WHEN this give-up happens, not what it looks like: a code-less
// failure is now retried a few times first (a throttled holder looks identical to a gone one
// here), and only an exhausted retry — no bytes banked across attempts — parks the row. The
// retry timings are shortened so the test still drives to the same end state.
test('#holder-gone: a no-holder give-up surfaces paused, records no error, no WARN', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = { ...testChannel(events), isOwnerOnline: () => true }
  const engine = createOverlayDownloadEngine(channel, { stallRetry: { baseMs: 10, maxMs: 10, dryLimit: 1 } })
  // fetchFile resolves null = no holder / all peers gone / stall → fetchContentToFile
  // returns { ok:false } with no code.
  getOverlay().fetchFile = () => Promise.resolve(null)

  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  const job = makeJob(ctx)
  try {
    await engine.start(job)
    await tick()
    await new Promise((r) => setTimeout(r, 600))   // the retry, and its give-up
  } finally { console.warn = origWarn }

  const row = await getPendingFor('space1', '/Photos/doc.bin')
  t.ok(row, 'pending row kept (resumable)')
  t.absent(row.errorCode, 'no errorCode recorded — a vanished holder is not a failure')
  t.ok(events.some((e) => e[0] === 'paused'), 'emitPaused fired so the row shows paused, not failed')
  t.is(events.find((e) => e[0] === 'paused')?.[2], 'interrupted', 'the paused event carries reason interrupted (owner online) — end-to-end pauseReasonFor wiring')
  t.absent(events.some((e) => e[0] === 'error'), 'no error event on a vanished holder')
  t.ok(events.some((e) => e[0] === 'updated'), 'emitUpdated fired so the list re-derives the paused state')
  t.is(warns.length, 0, 'a vanished holder logs at debug, not the give-up WARN')
  t.absent(engine.has(job.transferId), 'single-flight slot released')
})

// A genuine integrity mismatch stays terminal: the holder served bytes that don't match
// the hash, so retrying it can't self-heal. Records TRANSFER_CHECKSUM.
test('#checksum: an integrity mismatch still records a terminal error (not paused)', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = { ...testChannel(events), isOwnerOnline: () => true }
  const engine = createOverlayDownloadEngine(channel)
  getOverlay().fetchFile = () => Promise.reject(Object.assign(new Error('hash mismatch'), { code: 'EHASHMISMATCH' }))

  await engine.start(makeJob(ctx))
  await tick()

  const row = await getPendingFor('space1', '/Photos/doc.bin')
  t.is(row.errorCode, ErrorCodes.TRANSFER_CHECKSUM, 'integrity mismatch recorded as a terminal checksum error')
  t.ok(events.some((e) => e[0] === 'error'), 'emitError fired (terminal)')
  t.absent(events.some((e) => e[0] === 'paused'), 'not paused — a bad-bytes failure is terminal')
})

// A real local error (a failed copy of a local hit) stays terminal → DOWNLOAD_FAILED.
test('#local-error: a copy failure records a terminal error, not paused', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = { ...testChannel(events), isOwnerOnline: () => true }
  const engine = createOverlayDownloadEngine(channel)
  // A local hit whose source path can't be copied (missing) → fetchContentToFile returns
  // { ok:false, code:<copy error message> }.
  getOverlay().fetchFile = () =>
    Promise.resolve({ destPath: path.join(ctx.tmpDir('src'), 'missing-src'), local: true, size: 10 })

  await engine.start(makeJob(ctx))
  await tick()

  const row = await getPendingFor('space1', '/Photos/doc.bin')
  t.is(row.errorCode, ErrorCodes.DOWNLOAD_FAILED, 'a local copy failure is terminal')
  t.ok(events.some((e) => e[0] === 'error'), 'emitError fired')
  t.absent(events.some((e) => e[0] === 'paused'), 'not paused')
})

// #5 — auto-resume skips a terminal checksum failure (won't self-heal) but retries a
// transient one.
test('#5: resumeForOwner skips a checksum-errored row, retries a transient one', async (t) => {
  const ctx = await setup(t)
  const started = []
  const channel = {
    ...testChannel([]),
    isOwnerOnline: () => true,
    resolvePendingRow: async (spaceId, row) => ({
      removed: false, seq: undefined,
      job: {
        spaceId, pendingKey: row.filePath, path: row.filePath, relPath: row.relPath, shareId: 'folder1', catalogKey: 'k',
        transferId: spaceId + '|folder1|' + row.relPath, contentHash: 'h'.repeat(64), size: 10,
        ownerPublicKey: row.ownerKey, verifyKey: 'folder1|' + row.relPath, finalPath: path.join(ctx.tmpDir('dl'), row.relPath),
      },
    }),
  }
  const engine = createOverlayDownloadEngine(channel)
  getOverlay().fetchFile = (_hash, opts) => { started.push(opts.destPath); return new Promise(() => {}) }

  await recordPending('space2', '/checksum.bin', { total: 10, overlayShare: true, ownerKey: 'peer', relPath: 'checksum.bin', errorCode: ErrorCodes.TRANSFER_CHECKSUM, finalPath: '/x' })
  await recordPending('space2', '/transient.bin', { total: 10, overlayShare: true, ownerKey: 'peer', relPath: 'transient.bin', errorCode: ErrorCodes.PEER_NOT_AVAILABLE, finalPath: '/y' })

  await engine.resumeForOwner('peer', 'space2')
  await tick()

  t.is(started.length, 1, 'only one row was retried')
  t.ok(started[0].endsWith('transient.bin'), 'the transient row was retried, the checksum row was skipped')
})

test('engine.start records a resumable pending row, then queues when the owner is offline', async (t) => {
  const ctx = await setup(t)
  const events = []
  const engine = createOverlayDownloadEngine(testChannel(events))
  const job = makeJob(ctx)

  const res = await engine.start(job) // owner is offline in the sandbox → queued
  t.ok(res.queued, 'queued (owner offline)')

  const row = await getPendingFor('space1', '/Photos/doc.bin')
  t.ok(row, 'pending row recorded up front (survives the offline gap for reconnect-resume)')
  t.is(row.overlayShare, true, 'carries the overlay-share marker')
  t.is(row.ownerKey, 'peerpub', 'carries ownerKey')
  t.is(row.catalogKey, 'cat-hex', 'carries catalogKey (so reconnect can re-look-up the entry)')
  t.is(row.finalPath, job.finalPath, 'carries finalPath for resume')
  t.absent(engine.has(job.transferId), 'single-flight slot released after queueing')
})

test('engine.start is single-flight: a duplicate trigger does not double-reserve', async (t) => {
  const ctx = await setup(t)
  const engine = createOverlayDownloadEngine(testChannel([]))
  // Pre-occupy the registry to simulate an in-flight transfer, then a duplicate start
  // returns the same transferId without recording a second pending row.
  engine._registry.set('space1|folder1|doc.bin', { finalPath: '/x', paused: false })
  const res = await engine.start(makeJob(ctx))
  t.is(res.transferId, 'space1|folder1|doc.bin', 'returns the in-flight transfer')
  t.is(res.finalPath, '/x', 'returns the in-flight finalPath')
})

test('engine.cancelByKey removes the partial + pending row and emits', async (t) => {
  const ctx = await setup(t)
  const events = []
  const engine = createOverlayDownloadEngine(testChannel(events))
  const finalPath = path.join(ctx.tmpDir('dl'), 'big.bin')
  const partial = finalPath + '.mirall.part'
  fs.writeFileSync(partial, 'half a download')
  await recordPending('space1', '/Photos/big.bin', { total: 100, overlayShare: true, shareId: 'folder1', relPath: 'big.bin', ownerKey: 'peerpub', finalPath })

  await engine.cancelByKey('space1', '/Photos/big.bin', 'space1|folder1|big.bin')

  t.absent(await getPendingFor('space1', '/Photos/big.bin'), 'pending row cleared')
  t.absent(fs.existsSync(partial), 'visible partial removed')
  t.ok(events.some((e) => e[0] === 'cancelled'), 'emitCancelled fired')
  t.ok(events.some((e) => e[0] === 'updated'), 'emitUpdated fired')
})

// REGRESSION (FIX-1: a mid-transfer source change aborts the stale fetch and restarts
// on the new hash, with no terminal cancelled/error event).
test('#supersede: aborts the in-flight fetch and restarts on the new contentHash', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = { ...testChannel(events), isOwnerOnline: () => true }
  const engine = createOverlayDownloadEngine(channel)
  const overlay = getOverlay()

  const fetchCalls = []
  let firstReject = null
  overlay.fetchFile = (hash, opts) => {
    fetchCalls.push({ hash, destPath: opts.destPath })
    if (fetchCalls.length === 1) return new Promise((_res, rej) => { firstReject = rej })
    return new Promise(() => {}) // the restarted fetch stays in flight
  }
  let cancelCall = null
  overlay.cancelFetch = (hash, opts) => { cancelCall = { hash, opts } }

  const job = makeJob(ctx)
  await engine.start(job)
  t.ok(engine.has(job.transferId), 'in-flight slot reserved')

  const newJob = makeJob(ctx, { contentHash: 'n'.repeat(64), size: 8192 })
  t.ok(engine.supersede(job.transferId, newJob), 'supersede accepted while fetching')
  t.is(cancelCall?.hash, job.contentHash, 'cancelFetch targets the OLD hash')
  t.is(cancelCall?.opts?.discardPartial, true, 'partial discarded — old-content bytes are useless')
  t.ok(events.some((e) => e[0] === 'superseded'), 'emitSuperseded fired (no cancelled/error)')
  t.absent(events.some((e) => e[0] === 'cancelled'), 'no terminal cancelled event on a supersede')

  // Settle the aborted fetch → the IIFE restarts on the new job.
  firstReject(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }))
  await tick()

  t.is(fetchCalls.length, 2, 'a second fetch started for the new content')
  t.is(fetchCalls[1].hash, newJob.contentHash, 'restart fetches the NEW hash')
  t.ok(engine.has(job.transferId), 'slot stays present across the swap (no observable gap)')
  const row = await getPendingFor(job.spaceId, job.pendingKey)
  t.is(row.total, newJob.size, 'pending row reflects the new size')
})

test('#supersede: unknown transferId is a no-op', async (t) => {
  await setup(t)
  const engine = createOverlayDownloadEngine(testChannel([]))
  t.absent(engine.supersede('space1|folder1|missing', makeJobBare()), 'no slot → false')
})

// REGRESSION (FIX-7: a read-decide-supersede gap must not supersede the wrong/replaced
// transfer). The expectedHash guard rejects when the slot's hash already moved on.
test('#supersede: expectedHash mismatch (slot completed/replaced) is a no-op', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = { ...testChannel(events), isOwnerOnline: () => true }
  const engine = createOverlayDownloadEngine(channel)
  getOverlay().fetchFile = () => new Promise(() => {})
  getOverlay().cancelFetch = () => {}

  const job = makeJob(ctx)
  await engine.start(job)
  const ok = engine.supersede(job.transferId, makeJob(ctx, { contentHash: 'n'.repeat(64) }), 'x'.repeat(64))
  t.absent(ok, 'supersede refused: the slot no longer holds the hash we decided to replace')
  t.absent(events.some((e) => e[0] === 'superseded'), 'no superseded event when the guard rejects')
})

// REGRESSION (FIX-3: a supersede restart that cannot begin must not leave a stuck
// "restarting" row). When the owner drops before the restart starts, it surfaces paused.
test('#supersede: restart that queues (owner offline) surfaces paused, no stuck slot', async (t) => {
  const ctx = await setup(t)
  const events = []
  let online = true
  const channel = { ...testChannel(events), isOwnerOnline: () => online }
  const engine = createOverlayDownloadEngine(channel)
  const overlay = getOverlay()
  let firstReject = null
  let fetchCount = 0
  overlay.fetchFile = () => { fetchCount += 1; return new Promise((_res, rej) => { if (fetchCount === 1) firstReject = rej }) }
  overlay.cancelFetch = () => {}

  const job = makeJob(ctx)
  await engine.start(job)
  t.ok(engine.supersede(job.transferId, makeJob(ctx, { contentHash: 'n'.repeat(64) })), 'supersede accepted')

  online = false // owner drops before the restart can begin
  firstReject(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }))
  await tick(); await tick()

  t.ok(events.some((e) => e[0] === 'paused'), 'queued restart surfaced transfer-paused, not a silent stuck row')
  t.absent(engine.has(job.transferId), 'no leaked slot after the queued restart')
})

function makeJobBare () {
  return { spaceId: 'space1', pendingKey: '/Photos/doc.bin', path: '/Photos/doc.bin', relPath: 'doc.bin', transferId: 'space1|folder1|missing', contentHash: 'n'.repeat(64), size: 1, ownerPublicKey: 'peerpub', verifyKey: 'folder1|doc.bin', finalPath: '/x' }
}

// REGRESSION (FIX-EDA-11: cancelByKey emits while the slot is still registered, so a list
// read racing the abort re-derives the cancelled row as 'downloading'; the settle previously
// released the slot without any emit, leaving that stale row until an unrelated event).
test('REGRESSION (FIX-EDA-11): cancel settle re-emits after the registry slot is deleted', async (t) => {
  const ctx = await setup(t)
  const updates = []
  let engine = null
  const tid = 'space1|folder1|doc.bin'
  const channel = {
    ...testChannel([]),
    isOwnerOnline: () => true,
    emitUpdated: () => updates.push({ slotLive: engine.has(tid) }),
  }
  let settleFetch = null
  engine = createOverlayDownloadEngine(channel, {
    hasOverlay: () => true,
    fetchImpl: () => new Promise((resolve) => { settleFetch = resolve }),
  })
  getOverlay().cancelFetch = () => {}

  const job = makeJob(ctx)
  await engine.start(job)
  t.ok(engine.has(tid), 'precondition: slot reserved, fetch in flight')

  await engine.cancelByKey(job.spaceId, job.pendingKey, tid)
  t.ok(updates.length > 0, 'cancelByKey emitted')
  t.ok(updates[updates.length - 1].slotLive, 'the cancel emit fires while the slot is still registered (the race window)')

  settleFetch({ ok: false, code: 'ECANCELLED' })
  await tick()

  t.absent(engine.has(tid), 'slot released on settle')
  t.ok(updates.some((u) => !u.slotLive), 'a settle-time emit lands after the registry delete, correcting a racing list read')
})

// REGRESSION (FIX-EDA-14: resumeForOwner built the job — remote head-pulls under an 8s
// budget — BEFORE the registry/pause gate, so a manually-paused row paid remote reads on
// every owner catalog append, forever).
test('REGRESSION (FIX-EDA-14): reconnect resume gates paused rows before resolvePendingRow', async (t) => {
  const ctx = await setup(t)
  const built = []
  let settleFetch = null
  const channel = {
    ...testChannel([]),
    isOwnerOnline: () => true,
    resolvePendingRow: async (spaceId, row) => { built.push(row.relPath); return { removed: false, seq: undefined, job: null } },
  }
  const engine = createOverlayDownloadEngine(channel, {
    hasOverlay: () => true,
    fetchImpl: () => new Promise((resolve) => { settleFetch = resolve }),
  })
  getOverlay().cancelFetch = () => {}

  // A manually-paused row: start a fetch, pause it, let it settle so the single-flight
  // slot is released and only the pausedHashes marker remains.
  const pausedJob = makeJob(ctx, { pendingKey: '/Photos/paused.bin', path: '/Photos/paused.bin', relPath: 'paused.bin', transferId: 'space1|folder1|paused.bin', finalPath: path.join(ctx.tmpDir('dl'), 'paused.bin') })
  await engine.start(pausedJob)
  engine.pause(pausedJob.transferId)
  settleFetch({ ok: false, code: 'ECANCELLED' })
  await tick()
  t.absent(engine.has(pausedJob.transferId), 'precondition: paused slot released')

  // A second, non-paused interrupted row from the same owner proves the scan runs.
  await recordPending('space1', '/Photos/other.bin', { total: 100, overlayShare: true, shareId: 'folder1', relPath: 'other.bin', ownerKey: 'peerpub', finalPath: path.join(ctx.tmpDir('dl'), 'other.bin') })

  await engine.resumeForOwner('peerpub', 'space1')
  await new Promise((r) => setTimeout(r, 400)) // debounce window (250ms) + scan

  t.alike(built, ['other.bin'], 'the paused row never reaches resolvePendingRow on reconnect; the interrupted row does')
})

test('resume scans are debounced per (owner, space): an append burst collapses', async (t) => {
  const ctx = await setup(t)
  let rowVisits = 0
  const channel = {
    ...testChannel([]),
    isOwnerOnline: () => true,
    ownsPendingRow: () => { rowVisits += 1; return false },
  }
  const engine = createOverlayDownloadEngine(channel, { hasOverlay: () => true })

  await recordPending('space3', '/a.bin', { total: 1, overlayShare: true, relPath: 'a.bin', ownerKey: 'peerpub', finalPath: path.join(ctx.tmpDir('dl'), 'a.bin') })
  await engine.resumeForOwner('peerpub', 'space3')
  await engine.resumeForOwner('peerpub', 'space3')
  await engine.resumeForOwner('peerpub', 'space3')
  await new Promise((r) => setTimeout(r, 400))

  t.is(rowVisits, 2, 'a burst collapses to the leading + one trailing scan')
})

// REGRESSION (FIX-ENOSPC-1: the receive path's full-size preallocation failed with a raw
// ENOSPC that recorded generic DOWNLOAD_FAILED — the row and toast said "Transfer failed"
// even though a dedicated disk-full message exists).
test('REGRESSION (FIX-ENOSPC-1): an ENOSPC fetch failure records TRANSFER_DISK_FULL', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = { ...testChannel(events), isOwnerOnline: () => true }
  const engine = createOverlayDownloadEngine(channel)
  getOverlay().fetchFile = () =>
    Promise.reject(Object.assign(new Error('ENOSPC: no space left on device, ftruncate 6'), { code: 'ENOSPC' }))

  await engine.start(makeJob(ctx))
  await tick()

  const row = await getPendingFor('space1', '/Photos/doc.bin')
  t.is(row.errorCode, ErrorCodes.TRANSFER_DISK_FULL, 'ENOSPC classified as disk-full, not generic failure')
  const err = events.find((e) => e[0] === 'error')
  t.is(err?.[2], ErrorCodes.TRANSFER_DISK_FULL, 'emitError carries the disk-full code')
  t.absent(events.some((e) => e[0] === 'paused'), 'not paused — disk-full is terminal until space frees')
})

// REGRESSION (FIX-ENOSPC-2: nothing checked free space before starting, so a too-large
// download spun up the scheduler and holder handshake just to fail on preallocation —
// and on sparse filesystems would only fail after filling the disk mid-transfer).
test('REGRESSION (FIX-ENOSPC-2): preflight refuses a download the volume cannot hold', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = { ...testChannel(events), isOwnerOnline: () => true }
  let fetches = 0
  const engine = createOverlayDownloadEngine(channel, {
    hasOverlay: () => true,
    fetchImpl: () => { fetches += 1; return new Promise(() => {}) },
    freeBytes: () => 1024,
  })

  const job = makeJob(ctx)
  const res = await engine.start(job)

  t.ok(res.queued, 'start returns without a live transfer')
  t.is(fetches, 0, 'no fetch was attempted')
  t.absent(engine.has(job.transferId), 'single-flight slot released')
  const row = await getPendingFor(job.spaceId, job.pendingKey)
  t.is(row.errorCode, ErrorCodes.TRANSFER_DISK_FULL, 'row records disk-full up front')
  const err = events.find((e) => e[0] === 'error')
  t.is(err?.[2], ErrorCodes.TRANSFER_DISK_FULL, 'emitError carries the disk-full code')
  t.ok(events.some((e) => e[0] === 'updated'), 'emitUpdated fired so the row re-derives')
})

test('preflight lets a download through when the volume has room', async (t) => {
  const ctx = await setup(t)
  const channel = { ...testChannel([]), isOwnerOnline: () => true }
  let fetches = 0
  const engine = createOverlayDownloadEngine(channel, {
    hasOverlay: () => true,
    fetchImpl: () => { fetches += 1; return new Promise(() => {}) },
    freeBytes: () => Number.MAX_SAFE_INTEGER,
  })

  await engine.start(makeJob(ctx))
  t.is(fetches, 1, 'fetch started')
})

// REGRESSION (FIX-ENOSPC-3: a disk-full row was auto-resumed on every owner catalog append
// and reconnect — each retry re-preallocating and re-failing with another error toast,
// though a retry cannot succeed until the user frees space).
test('REGRESSION (FIX-ENOSPC-3): auto-resume skips a disk-full row', async (t) => {
  const ctx = await setup(t)
  const built = []
  const channel = {
    ...testChannel([]),
    isOwnerOnline: () => true,
    resolvePendingRow: async (spaceId, row) => { built.push(row.relPath); return { removed: false, seq: undefined, job: null } },
  }
  const engine = createOverlayDownloadEngine(channel, { hasOverlay: () => true })

  await recordPending('space4', '/full.bin', { total: 10, overlayShare: true, relPath: 'full.bin', ownerKey: 'peerpub', errorCode: ErrorCodes.TRANSFER_DISK_FULL, finalPath: path.join(ctx.tmpDir('dl'), 'full.bin') })
  await recordPending('space4', '/other.bin', { total: 10, overlayShare: true, relPath: 'other.bin', ownerKey: 'peerpub', finalPath: path.join(ctx.tmpDir('dl'), 'other.bin') })

  await engine.resumeForOwner('peerpub', 'space4')
  await new Promise((r) => setTimeout(r, 400))

  t.alike(built, ['other.bin'], 'the disk-full row never reaches resolvePendingRow; the clean row does')
})

// === stall auto-retry (FIX-BW9) ===
// A code-less fetch failure is "the bytes stopped": a holder that dropped, or one whose upload
// cap kept it silent past the 30s no-progress watchdog. The engine cannot tell them apart, and
// a holder that never disconnects fires neither auto-resume trigger — so the throttled case
// parked the row until the user clicked Resume, and (measured) each click bought one chunk.

// No `scaled()` here: test/helpers/timing.js reads process.env, which Bare does not provide, so
// the bare suite cannot scale its waits. These are fixed and deliberately generous — each retry
// window has to cover a RocksDB read, the backoff, a re-start and a RocksDB write on a loaded
// runner, and this suite already carries a known one-random-failure-per-run flake.
const fastRetry = { baseMs: 20, maxMs: 40, dryLimit: 3 }

// A retry re-drives runReconcile, so its channel must resolve a row into a job the way the real
// folder channel does (catalog read → destination re-anchor → prevBytes reset). The shared
// testChannel returns `job: null` on purpose for the reconcile tests, which would make every
// retry a no-op here and hide the behavior under test.
function retryChannel (events) {
  return {
    ...testChannel(events),
    isOwnerOnline: () => true,
    resolvePendingRow: async (spaceId, row) => ({
      removed: false,
      seq: row.sourceSeq,
      job: {
        spaceId, pendingKey: row.filePath, path: row.filePath, relPath: row.relPath, shareId: row.shareId,
        transferId: spaceId + '|folder1|' + row.relPath, contentHash: row.contentHash, size: row.total || 4096,
        sourceSeq: row.sourceSeq, ownerPublicKey: row.ownerKey, verifyKey: 'folder1|' + row.relPath,
        finalPath: row.finalPath, prevBytes: row.bytesTransferred || 0,
      },
    }),
  }
}

test('REGRESSION (FIX-BW9): a stalled fetch retries itself while the owner is online', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = retryChannel(events)
  let fetches = 0
  let settle = null
  const engine = createOverlayDownloadEngine(channel, {
    fetchImpl: () => { fetches += 1; return new Promise((r) => { settle = r }) },
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stallRetry: fastRetry,
  })

  const job = makeJob(ctx)
  await engine.start(job)
  t.is(fetches, 1, 'precondition: the first fetch is in flight')

  settle({ ok: false })                      // no code: stalled / holder gone
  await tick()
  // The paused emit still fires — on the folder channel it IS the terminal decoration frame —
  // but it carries `retrying`, which is what suppresses the OS notification on the loose
  // channel. Withholding the emit entirely stranded a progress bar for the whole backoff.
  const paused = events.find((e) => e[0] === 'paused')
  t.ok(paused, 'the row still got its terminal paused emit')
  t.is(paused[3]?.retrying, true, 'flagged as retrying, so no OS notification is raised')
  await tick()
  t.is(fetches, 2, 'the engine retried the stalled fetch on its own')
})

test('FIX-BW9: retries that bank no bytes give up and park the row as before', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = retryChannel(events)
  let fetches = 0
  let settle = null
  const engine = createOverlayDownloadEngine(channel, {
    fetchImpl: () => { fetches += 1; return new Promise((r) => { settle = r }) },
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stallRetry: fastRetry,
  })

  const job = makeJob(ctx)
  await engine.start(job)
  for (let i = 0; i < 6 && settle; i++) { settle({ ok: false }); settle = null; await tick(); await tick() }

  t.ok(fetches <= 1 + fastRetry.dryLimit, `a wedged holder is not retried forever (${fetches} attempts)`)
  t.ok(events.some((e) => e[0] === 'paused'), 'and the row is finally parked, exactly as before the fix')
})

test('FIX-BW9: a retry that banks bytes keeps the transfer going', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = retryChannel(events)
  let fetches = 0
  let settle = null
  const engine = createOverlayDownloadEngine(channel, {
    fetchImpl: () => { fetches += 1; return new Promise((r) => { settle = r }) },
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stallRetry: fastRetry,
  })

  const job = makeJob(ctx)
  await engine.start(job)
  // A throttled holder always banks SOME bytes per attempt — that progress is what resets the
  // dry counter, so the retries continue past the give-up limit a wedged holder would hit.
  for (let i = 1; i <= 5 && settle; i++) {
    await updatePendingProgress(job.spaceId, job.pendingKey, i * 1024)
    settle({ ok: false }); settle = null
    await tick(); await tick()
  }

  t.ok(fetches > 1, `the transfer kept being retried (${fetches} attempts)`)
  // The mechanism itself: banked bytes reset the dry counter, so the budget never runs out
  // however long the transfer takes. (Attempt COUNT is not the assertion — runReconcile's
  // 250 ms debounce coalesces retries at this test's 20 ms backoff; production is 3 s+.)
  t.is(engine._stallRetries.get(job.transferId)?.dry, 0, 'progress reset the retry budget')
  const pausedEmits = events.filter((e) => e[0] === 'paused')
  t.ok(pausedEmits.length > 0 && pausedEmits.every((e) => e[3]?.retrying === true),
    `every pause along the way was flagged retrying, so the user is never notified or asked to click Resume (${pausedEmits.length} emits)`)
})

test('FIX-BW9: a pause during the retry backoff stops the retry', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = retryChannel(events)
  let fetches = 0
  let settle = null
  const engine = createOverlayDownloadEngine(channel, {
    fetchImpl: () => { fetches += 1; return new Promise((r) => { settle = r }) },
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stallRetry: { baseMs: 120, maxMs: 120, dryLimit: 3 },
  })
  getOverlay().cancelFetch = () => {}

  const job = makeJob(ctx)
  await engine.start(job)
  settle({ ok: false })
  await tick()                       // inside the backoff window
  t.ok(engine._stallRetries.has(job.transferId), 'precondition: a retry is armed')
  engine.pause(job.transferId)

  // The record itself must be gone. Asserting only "no second fetch" proves nothing: the
  // timer's own `pausedHashes` guard would satisfy that even with an orphaned timer still
  // armed — and an orphan survives discard and space-leave, which is how the row comes back.
  t.absent(engine._stallRetries.has(job.transferId), 'the pause cleared the retry record and its timer')
  await new Promise((r) => setTimeout(r, 600))
  t.is(fetches, 1, 'and no retry fired')
})

// REPRODUCED in review: during the backoff there is NO registry slot, so `activeSlots()` — the
// only thing space-leave teardown walks — is empty and cancels nothing. The timer then fired
// after the row was purged and `start()`'s recordPending re-created it, re-downloading into a
// space the user had left.
test('REGRESSION (FIX-BW9): a retry cannot resurrect a pending row purged while it waited', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = retryChannel(events)
  let fetches = 0
  let settle = null
  const engine = createOverlayDownloadEngine(channel, {
    fetchImpl: () => { fetches += 1; return new Promise((r) => { settle = r }) },
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stallRetry: { baseMs: 80, maxMs: 80, dryLimit: 3 },
  })

  const job = makeJob(ctx)
  await engine.start(job)
  settle({ ok: false })
  await tick()
  t.is([...engine.activeSlots()].length, 0, 'precondition: no slot for teardown to find during the backoff')

  // What leaving a space does to this row (worker/main.js clearPendingForSpace).
  await clearPending(job.spaceId, job.pendingKey)
  await new Promise((r) => setTimeout(r, 600))

  t.is(fetches, 1, 'the retry declined to start once its row was gone')
  t.absent(await getPendingFor(job.spaceId, job.pendingKey), 'and the purged row stayed purged')
})

// REPRODUCED in review: `stallRetries.set` replaced the record without clearing the old timer,
// so a second stall during a backoff orphaned the first — unreachable by pause, discard or
// leave, and it undid the user's Discard by re-creating the row.
test('REGRESSION (FIX-BW9): a re-armed retry does not orphan the previous timer', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = retryChannel(events)
  let fetches = 0
  let settle = null
  const engine = createOverlayDownloadEngine(channel, {
    fetchImpl: () => { fetches += 1; return new Promise((r) => { settle = r }) },
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stallRetry: { baseMs: 150, maxMs: 150, dryLimit: 3 },
  })
  getOverlay().cancelFetch = () => {}

  const job = makeJob(ctx)
  await engine.start(job)
  settle({ ok: false }); await tick()          // timer #1 armed
  await engine.start(job)                       // a reconcile-driven start during the backoff
  settle({ ok: false }); await tick()          // timer #2 armed — #1 must have been cleared
  const started = fetches

  await engine.cancelByKey(job.spaceId, job.pendingKey, job.transferId)   // the user discards
  await new Promise((r) => setTimeout(r, 600))

  t.is(fetches, started, 'no orphaned timer fired after the discard')
  t.absent(await getPendingFor(job.spaceId, job.pendingKey), 'the discarded row was not re-created')
})

// The job captured before the stall carries a contentHash and a destination that can both be
// stale by the time the timer fires. Because the retry re-drives the reconcile scan instead of
// replaying that job, the source is re-read: a republish during the backoff is picked up rather
// than overwritten with the old hash.
test('FIX-BW9: a retry follows the row to a new content hash instead of replaying the old one', async (t) => {
  const ctx = await setup(t)
  const events = []
  const channel = retryChannel(events)
  const asked = []
  let settle = null
  const engine = createOverlayDownloadEngine(channel, {
    fetchImpl: (contentHash) => { asked.push(contentHash); return new Promise((r) => { settle = r }) },
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stallRetry: { baseMs: 150, maxMs: 150, dryLimit: 3 },
  })

  const job = makeJob(ctx)
  await engine.start(job)
  settle({ ok: false })
  await tick()
  const row = await getPendingFor(job.spaceId, job.pendingKey)
  await recordPending(job.spaceId, job.pendingKey, { ...row, contentHash: 'f'.repeat(64), bytesTransferred: 0 })
  await new Promise((r) => setTimeout(r, 700))

  t.is(asked[0], job.contentHash, 'precondition: the first fetch used the original hash')
  t.is(asked[asked.length - 1], 'f'.repeat(64), 'the retry fetched the NEW content the row points at')
  const after = await getPendingFor(job.spaceId, job.pendingKey)
  t.is(after.contentHash, 'f'.repeat(64), 'and the row was never rewritten back to the old hash')
})

// The same staleness applies to the destination: resolvePendingRow re-anchors it against the
// space's current download folder (reuseDest), which a replayed job bypassed entirely — so a
// folder changed during the backoff resumed into the old one.
test('FIX-BW9: a retry re-anchors the destination the row resolves to', async (t) => {
  const ctx = await setup(t)
  const events = []
  const moved = path.join(ctx.tmpDir('dl2'), 'doc.bin')
  const channel = {
    ...retryChannel(events),
    resolvePendingRow: async (spaceId, row) => ({
      removed: false,
      seq: row.sourceSeq,
      job: {
        spaceId, pendingKey: row.filePath, path: row.filePath, relPath: row.relPath, shareId: row.shareId,
        transferId: spaceId + '|folder1|' + row.relPath, contentHash: row.contentHash, size: 4096,
        sourceSeq: row.sourceSeq, ownerPublicKey: row.ownerKey, verifyKey: 'folder1|' + row.relPath,
        finalPath: moved, prevBytes: 0,      // what reuseDest returns after a folder change
      },
    }),
  }
  const dests = []
  let settle = null
  const engine = createOverlayDownloadEngine(channel, {
    fetchImpl: (_h, opts) => { dests.push(opts.finalPath); return new Promise((r) => { settle = r }) },
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stallRetry: { baseMs: 150, maxMs: 150, dryLimit: 3 },
  })

  const job = makeJob(ctx)
  await engine.start(job)
  settle({ ok: false })
  await tick()
  await new Promise((r) => setTimeout(r, 700))

  t.is(dests[0], job.finalPath, 'precondition: the first fetch used the original destination')
  t.is(dests[dests.length - 1], moved, 'the retry landed in the re-anchored folder, not the stale one')
})

// Giving up must still settle the row. On the folder channel emitPaused IS the terminal
// decoration frame, so a silent bail strands a progress bar that then samples across the gap.
test('FIX-BW9: an owner that goes offline during the backoff still settles the row as paused', async (t) => {
  const ctx = await setup(t)
  const events = []
  let online = true
  const channel = { ...retryChannel(events), isOwnerOnline: () => online }
  let settle = null
  const engine = createOverlayDownloadEngine(channel, {
    fetchImpl: () => new Promise((r) => { settle = r }),
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stallRetry: { baseMs: 80, maxMs: 80, dryLimit: 3 },
  })

  const job = makeJob(ctx)
  await engine.start(job)
  settle({ ok: false })
  await tick()
  const beforeBail = events.filter((e) => e[0] === 'paused').length
  online = false                                  // the owner drops during the backoff
  await new Promise((r) => setTimeout(r, 600))

  t.ok(events.filter((e) => e[0] === 'paused').length > beforeBail, 'the row was settled as paused, not left silent')
  t.absent(engine._stallRetries.has(job.transferId), 'and the retry record was released')
})

test('FIX-BW9: an offline owner is left to the reconnect path, not retried', async (t) => {
  const ctx = await setup(t)
  const events = []
  let online = true
  const channel = { ...retryChannel(events), isOwnerOnline: () => online }
  let fetches = 0
  let settle = null
  const engine = createOverlayDownloadEngine(channel, {
    fetchImpl: () => { fetches += 1; return new Promise((r) => { settle = r }) },
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    stallRetry: fastRetry,
  })

  const job = makeJob(ctx)
  await engine.start(job)
  online = false
  settle({ ok: false })
  await tick(); await tick()

  t.is(fetches, 1, 'no retry — resumeForOwner already covers a reconnect')
  t.ok(events.some((e) => e[0] === 'paused'), 'the row parks as paused-offline')
})
