import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { until } from '../helpers/bare-poll.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/overlay/overlay-instance.js'
import { initPendingTransfers, recordPending, getPendingFor } from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/overlay/overlay-download.js'
import { downloadChannel, requestShareDownload, setDownloadEngine } from '../../src/shared/transfer/overlay/share-downloads.js'
import { looseShareFor } from '../../src/shared/transfer/overlay/download-job.js'
import { getJournalDir } from '../../src/shared/transfer/overlay/overlay-journals.js'
import { journalPathFor } from '../../src/shared/transfer/overlay/engine/transfer/journal.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { upsertMember } from '../../src/shared/spaces/space.js'
import { advertise, ownCatalogKeyHex } from '../../src/shared/shares/own-catalog.js'
import { setSpaceDownloadRoot } from '../../src/shared/core/paths.js'
import { scaled } from '../helpers/bare-timing.js'

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

function testChannel(events) {
  return {
    diagLabelFor: () => 'test download',
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

async function setup(t) {
  const ctx = await freshPeer(t)
  await initDownloads()
  await initPendingTransfers()
  await initOverlay()
  t.teardown(async () => { await teardownOverlay() })
  return ctx
}

function makeJob(ctx, over = {}) {
  return {
    spaceId: 'space1', pendingKey: '/Photos/doc.bin', path: '/Photos/doc.bin', relPath: 'doc.bin',
    shareId: 'folder1', transferId: 'space1|folder1|doc.bin',
    contentHash: HASH_OLD, size: 4096, sourceSeq: 5, ownerKey: 'peerpub', verifyKey: 'folder1|doc.bin',
    finalPath: path.join(ctx.tmpDir('dl'), 'doc.bin'), ...over,
  }
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, scaled(ms)))
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
  const partial = job.finalPath + '.mirall.part'
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

  const partial = finalPath + '.mirall.part'
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

// A row whose destination re-resolved (a file now sits at its pin, or its own folder can no longer
// be reached) restarts at a new path; the partial at the path the row recorded holds the old
// content's bytes and nothing references it any more.
test('REGRESSION (restart-orphans-old-partial): a republished row that moved discards the partial it left behind', async (t) => {
  const ctx = await setup(t)
  const dl = ctx.tmpDir('dl')
  const oldFinal = path.join(dl, 'm.bin')
  const newFinal = path.join(dl, 'm (1).bin')
  const started = []
  const head = {
    removed: false, seq: 10,
    job: makeJob(ctx, { pendingKey: '/Photos/m.bin', relPath: 'm.bin', transferId: 'space1|folder1|m.bin', contentHash: HASH_NEW, sourceSeq: 10, finalPath: newFinal }),
  }
  const channel = { ...testChannel([]), resolvePendingRow: async () => head }
  const engine = createOverlayDownloadEngine(channel, {
    hasOverlay: () => true,
    fetchImpl: (hash) => { started.push(hash); return new Promise(() => {}) },
  })
  getOverlay().cancelFetch = () => {}
  getOverlay().notifyTransferStopped = () => {}

  const oldPartial = oldFinal + '.mirall.part'
  fs.writeFileSync(oldPartial, 'stale bytes of the OLD content')
  await recordPending('space1', '/Photos/m.bin', {
    total: 100, overlayShare: true, shareId: 'folder1', relPath: 'm.bin', ownerKey: 'peerpub',
    sourceSeq: 5, contentHash: HASH_OLD, finalPath: oldFinal, bytesTransferred: 31,
  })

  await engine.reconcileOnAppend('peerpub', 'space1')
  await settleTick()

  t.alike(started, [HASH_NEW], 'precondition: the row restarted on the new content')
  t.is((await getPendingFor('space1', '/Photos/m.bin'))?.finalPath, newFinal, 'precondition: at the new destination')
  t.absent(fs.existsSync(oldPartial), 'the partial at the old destination is discarded')
})

// A loose member of a space whose catalog this peer reads: its own catalog, read as a peer's.
async function looseMember(spaceId, publicKey) {
  const member = { publicKey, looseCatalogKeyEnc: await ownCatalogKeyHex(spaceId) }
  await upsertMember(spaceId, member, { verified: true })
  return looseShareFor(member)
}

// Two spaces download into one folder, so two owners' same-named files resolve one name. A row
// parked before its first byte holds its pin and no partial, so the name stays free for the other
// space's file, which takes it. When the parked row's source is re-published, its restart is refused
// the pin (a live slot holds it) and resolves a sibling; the path it leaves is the live transfer's.
test('REGRESSION (FIX-DLTO-R2: a republish restart deletes the partial of a live transfer on its old path)', async (t) => {
  const ctx = await setup(t)
  const root = ctx.tmpDir('dl-shared')
  const { spaceId: S1 } = await createSpace('Aurora')
  const { spaceId: S2 } = await createSpace('Borealis')
  setSpaceDownloadRoot(S1, root)
  setSpaceDownloadRoot(S2, root)
  const ownerA = 'a'.repeat(64)
  const ownerC = 'c'.repeat(64)
  const shareA = await looseMember(S1, ownerA)
  const shareC = await looseMember(S2, ownerC)
  const HASH_C = 'c'.repeat(64)
  await advertise(S1, LOOSE_SHARE_ID, 'report.pdf', { size: 4, mtime: 1, contentHash: HASH_OLD })
  await advertise(S2, LOOSE_SHARE_ID, 'report.pdf', { size: 4, mtime: 1, contentHash: HASH_C })

  const online = new Set([ownerC])
  const fetches = []
  let releaseC = () => {}
  const heldC = new Promise((r) => { releaseC = r })
  const engine = createOverlayDownloadEngine({ ...downloadChannel, isOwnerOnline: (pk) => online.has(pk) }, {
    hasOverlay: () => true,
    freeBytes: () => Number.MAX_SAFE_INTEGER,
    // A receive reduced to its partial: written at once, renamed into place when released. A
    // partial unlinked under it fails the rename, as the real receive's finalize does.
    fetchImpl: async (hash, { finalPath }) => {
      fetches.push({ hash, finalPath })
      fs.writeFileSync(finalPath + '.mirall.part', 'bytes of ' + hash.slice(0, 4))
      if (hash !== HASH_C) return await new Promise(() => {})
      await heldC
      try { fs.renameSync(finalPath + '.mirall.part', finalPath) } catch (err) { return { ok: false, code: err.message, cause: err } }
      return { ok: true }
    },
  })
  setDownloadEngine(engine)
  t.teardown(() => { releaseC(); setDownloadEngine(null) })

  t.ok((await requestShareDownload(S1, shareA, 'report.pdf')).queued, 'precondition: A is away, so S1\'s row parks before its first byte')
  const pin = path.join(root, 'report.pdf')
  t.is((await getPendingFor(S1, '/report.pdf'))?.finalPath, pin, 'precondition: S1\'s row holds the pin, with no partial')

  const c = await requestShareDownload(S2, shareC, 'report.pdf')
  t.is(c.finalPath, pin, 'precondition: C\'s file in S2 takes the same name')
  t.ok(await until(() => fetches.some((f) => f.hash === HASH_C), 2000), 'precondition: C\'s partial is being written')
  const cPartial = pin + '.mirall.part'
  const cJournal = journalPathFor(getJournalDir(), pin)
  fs.mkdirSync(path.dirname(cJournal), { recursive: true })
  fs.writeFileSync(cJournal, 'C\'s resume journal')

  online.add(ownerA)
  await advertise(S1, LOOSE_SHARE_ID, 'report.pdf', { size: 4, mtime: 2, contentHash: HASH_NEW })
  await engine.reconcileOnAppend(ownerA, S1)
  t.ok(await until(() => fetches.some((f) => f.hash === HASH_NEW), 4000), 'precondition: S1 restarted on A\'s new content')
  t.is(fetches.find((f) => f.hash === HASH_NEW).finalPath, path.join(root, 'report (1).pdf'), 'precondition: refused the pin C holds')

  t.ok(fs.existsSync(cPartial), 'C\'s partial is left alone')
  t.ok(fs.existsSync(cJournal), 'and so is its resume journal')
  releaseC()
  t.ok(await until(async () => !(await getPendingFor(S2, '/report.pdf')), 4000), 'C completes')
  t.is(fs.existsSync(pin) && fs.readFileSync(pin, 'utf8'), 'bytes of ' + HASH_C.slice(0, 4), 'with its own bytes at its own name')
})
