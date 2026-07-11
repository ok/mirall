import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initPendingTransfers, recordPending, getPendingFor } from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/backends/overlay/overlay-download.js'

// REGRESSION (FIX-3): re-publishing a source is TWO catalog appends — advertise(contentHash:null)
// → hash the source → setMaterializedHash. The receiver's reconcile read that null-hash window as
// a remove+re-add of identical content and DROPPED the download, which then never resumed.
//
// The fix PARKS the transfer instead: on the null-hash window it aborts the doomed old-hash fetch
// WITHOUT a terminal event and releases the slot, keeping the pending row so the status derives
// 'preparing' and the materialized-hash append restarts it via runReconcile. This file covers: the
// active park releases cleanly no matter how the doomed fetch settles (no-holder, checksum, or a
// lucky completion of the OLD bytes — which must not land as downloaded), and the inactive-row
// null window is kept then restarted when the real hash lands.

const HASH_OLD = 'a'.repeat(64)
const HASH_NEW = 'b'.repeat(64)

function testChannel (events) {
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
    emitDecorationDone: () => events.push(['decoration-done']),
    emitUpdated: () => {},
    emitRemovedByOwner: () => events.push(['removed']),
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
    shareId: 'folder1', transferId: 'space1|folder1|doc.bin',
    contentHash: HASH_OLD, size: 4096, sourceSeq: 5, ownerPublicKey: 'peerpub', verifyKey: 'folder1|doc.bin',
    finalPath: path.join(ctx.tmpDir('dl'), 'doc.bin'), ...over,
  }
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms))
const settleTick = () => tick(400) // the reconcile coalescer window (250ms) + sweep

test('releaseForRepublish parks the transfer — no error, row kept, partial discarded', async (t) => {
  const ctx = await setup(t)
  const events = []
  let settle = null
  let aborted = false
  const engine = createOverlayDownloadEngine(testChannel(events), {
    hasOverlay: () => true,
    fetchImpl: () => new Promise((resolve) => { settle = resolve }),
  })
  getOverlay().cancelFetch = () => { aborted = true; settle({ ok: false, code: 'ECANCELLED' }) }

  const job = makeJob(ctx)
  await engine.start(job)
  const partial = job.finalPath + '.overlay-partial'
  fs.writeFileSync(partial, 'stale bytes of the OLD content')

  t.ok(engine.releaseForRepublish(job.transferId), 'the mid-rehash slot is parked')
  await tick()

  t.ok(aborted, 'the doomed old-hash fetch is aborted (not left running to orphan)')
  t.absent(engine.has(job.transferId), 'the slot is released — nothing left to orphan')
  t.absent(events.some(([k]) => k === 'error'), 'no transfer-error surfaced (the failure is expected, not real)')
  t.ok(await getPendingFor('space1', '/Photos/doc.bin'), 'the durable row survives so the status derives preparing')
  t.absent(fs.existsSync(partial), 'the stale old-content partial is discarded — it can never verify against the new hash')
})

test('a checksum failure under a re-publish parks too, not reported as an integrity error', async (t) => {
  const ctx = await setup(t)
  const events = []
  let settle = null
  const engine = createOverlayDownloadEngine(testChannel(events), {
    hasOverlay: () => true,
    fetchImpl: () => new Promise((resolve) => { settle = resolve }),
  })
  // The abort races a checksum failure the fetch was about to report — the park must win.
  getOverlay().cancelFetch = () => settle({ ok: false, code: 'EHASHMISMATCH' })

  const job = makeJob(ctx)
  await engine.start(job)
  engine.releaseForRepublish(job.transferId)
  await tick()

  t.absent(events.some(([k]) => k === 'error'), 'the expected mismatch is NOT surfaced as a checksum error')
  t.absent(engine.has(job.transferId), 'released to the pending row')
  t.ok(await getPendingFor('space1', '/Photos/doc.bin'), 'row kept')
})

test('a lucky completion of the OLD content under a re-publish is abandoned, not marked downloaded', async (t) => {
  const ctx = await setup(t)
  const events = []
  let settle = null
  const engine = createOverlayDownloadEngine(testChannel(events), {
    hasOverlay: () => true,
    fetchImpl: () => new Promise((resolve) => { settle = resolve }),
  })
  // The old-hash fetch actually completed (another holder served it) just as we park it.
  getOverlay().cancelFetch = () => {}

  const job = makeJob(ctx)
  await engine.start(job)
  fs.writeFileSync(job.finalPath, 'the OLD content, finished to disk before we could abort')

  engine.releaseForRepublish(job.transferId)
  settle({ ok: true }) // the fetch reports success for the OLD hash
  await tick()

  t.absent(events.some(([k]) => k === 'complete'), 'the stale OLD content is NOT announced as complete')
  t.absent(fs.existsSync(job.finalPath), 'the stale finished file is removed — we want the NEW content, not this')
  const row = await getPendingFor('space1', '/Photos/doc.bin')
  t.ok(row, 'the row survives so the new hash restarts it')
  t.absent(row.contentHash === undefined && row.bytesTransferred, 'progress reset')
})

test('a user cancel outranks a concurrent park — the row is cleared, not left preparing', async (t) => {
  const ctx = await setup(t)
  const events = []
  let settle = null
  const engine = createOverlayDownloadEngine(testChannel(events), {
    hasOverlay: () => true,
    fetchImpl: () => new Promise((resolve) => { settle = resolve }),
  })
  getOverlay().cancelFetch = () => {} // abort is async — it settles below, after the cancel lands
  getOverlay().notifyTransferStopped = () => {}

  const job = makeJob(ctx)
  await engine.start(job)
  engine.releaseForRepublish(job.transferId) // park in flight...
  await engine.cancelByKey(job.spaceId, job.pendingKey, job.transferId) // ...user discards before the abort settles
  settle({ ok: false, code: 'ECANCELLED' }) // the doomed fetch finally settles
  await tick()

  t.absent(await getPendingFor('space1', '/Photos/doc.bin'), 'the explicit cancel cleared the row (it outranks the park)')
  t.absent(engine.has(job.transferId), 'no slot lingers')
})

test('releaseForRepublish is a no-op on a cancelled/paused/absent slot', async (t) => {
  const ctx = await setup(t)
  const engine = createOverlayDownloadEngine(testChannel([]), {
    hasOverlay: () => true,
    fetchImpl: () => new Promise(() => {}),
  })
  getOverlay().cancelFetch = () => {}

  t.absent(engine.releaseForRepublish('space1|folder1|nonexistent'), 'unknown transfer → no-op')
  const job = makeJob(ctx)
  await engine.start(job)
  engine.pause(job.transferId)
  t.absent(engine.releaseForRepublish(job.transferId), 'a paused slot is not re-parked')
})

test('REGRESSION (FIX-3): an INACTIVE row in the null-hash window is kept, then restarted when the hash lands', async (t) => {
  const ctx = await setup(t)
  const dl = ctx.tmpDir('dl')
  const finalPath = path.join(dl, 'r.bin')
  const started = []
  // The owner is mid-rehash: the head has a NEW seq but no hash yet, so no job can be built.
  let head = { removed: false, seq: 9, job: null }
  const channel = { ...testChannel([]), resolvePendingRow: async () => head }
  const engine = createOverlayDownloadEngine(channel, {
    hasOverlay: () => true,
    fetchImpl: (hash) => { started.push(hash); return new Promise(() => {}) },
  })
  getOverlay().cancelFetch = () => {}
  getOverlay().notifyTransferStopped = () => {}

  const partial = finalPath + '.overlay-partial'
  fs.writeFileSync(partial, 'stale bytes of the OLD content')
  await recordPending('space1', '/Photos/r.bin', {
    total: 100, overlayShare: true, shareId: 'folder1', relPath: 'r.bin', ownerKey: 'peerpub',
    sourceSeq: 5, contentHash: HASH_OLD, finalPath, bytesTransferred: 31,
  })

  await engine.reconcileOnAppend('peerpub', 'space1')
  await settleTick()

  t.ok(await getPendingFor('space1', '/Photos/r.bin'),
    'the row SURVIVES the null-hash window — dropping it here is the bug that killed the download')
  t.is(started.length, 0, 'and nothing is fetched yet: there is no hash to fetch')

  // setMaterializedHash lands: the same watcher fires again, now with the real hash.
  head = {
    removed: false, seq: 10,
    job: makeJob(ctx, { pendingKey: '/Photos/r.bin', relPath: 'r.bin', transferId: 'space1|folder1|r.bin', contentHash: HASH_NEW, sourceSeq: 10, finalPath }),
  }
  await engine.reconcileOnAppend('peerpub', 'space1')
  await settleTick()

  t.alike(started, [HASH_NEW], 'the parked download restarts itself on the new content — no user action')
  t.absent(fs.existsSync(partial), 'the stale partial is discarded first, so the new hash verifies from byte zero')
  const row = await getPendingFor('space1', '/Photos/r.bin')
  t.is(row.sourceSeq, 10, 'the row is re-pointed at the new version')
  t.is(row.contentHash, HASH_NEW, 'and at the new content hash')
})

test('REGRESSION (FIX-3): a republish-restart of an errored row clears the stale errorCode', async (t) => {
  const ctx = await setup(t)
  const dl = ctx.tmpDir('dl')
  const finalPath = path.join(dl, 'e.bin')
  const started = []
  const head = {
    removed: false, seq: 10,
    job: makeJob(ctx, { pendingKey: '/Photos/e.bin', relPath: 'e.bin', transferId: 'space1|folder1|e.bin', contentHash: HASH_NEW, sourceSeq: 10, finalPath }),
  }
  const channel = { ...testChannel([]), resolvePendingRow: async () => head }
  const engine = createOverlayDownloadEngine(channel, {
    hasOverlay: () => true,
    fetchImpl: (hash) => { started.push(hash); return new Promise(() => {}) },
  })
  getOverlay().cancelFetch = () => {}
  getOverlay().notifyTransferStopped = () => {}

  // A row that terminally failed on the OLD content (checksum), then the owner published new content.
  await recordPending('space1', '/Photos/e.bin', {
    total: 100, overlayShare: true, shareId: 'folder1', relPath: 'e.bin', ownerKey: 'peerpub',
    sourceSeq: 5, contentHash: HASH_OLD, finalPath, errorCode: 'TRANSFER_CHECKSUM', erroredAt: 1,
  })

  await engine.reconcileOnAppend('peerpub', 'space1')
  await settleTick()

  const row = await getPendingFor('space1', '/Photos/e.bin')
  t.absent(row.errorCode, 'the stale checksum error is cleared (it belonged to the old content)')
  t.absent(row.erroredAt, 'and its timestamp')
  t.is(row.contentHash, HASH_NEW, 're-pointed at the new content')
  t.alike(started, [HASH_NEW], 'and the download restarts clean instead of staying wedged as errored')
})
