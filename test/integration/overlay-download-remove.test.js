import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initPendingTransfers, recordPending, getPendingFor } from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/backends/overlay/overlay-download.js'

// REGRESSION (FIX-REMOVE-1): a deliberate owner removal (tombstone observed on a catalog
// append) terminates the receiver's download intent — partial discarded + durable row cleared,
// with a removal signal for the toast — so a later re-add of the same content does NOT
// auto-resume. A transient null (mid-rehash / offline owner) is left intact. Covers the shared
// overlay engine (loose + folder both ride it) with a fake channel.

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
    emitPaused: (job) => events.push(['paused', job]),
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

const settleTick = () => new Promise((r) => setTimeout(r, 400)) // coalescer window (250ms) + sweep

test('reconcileOnAppend tears down a tombstoned inactive row, keeps a transient one, and signals the toast', async (t) => {
  const ctx = await setup(t)
  const removed = new Set(['/Photos/gone.bin'])
  const removedSignals = []
  const channel = {
    ...testChannel([]),
    isOwnerOnline: () => true,
    resolvePendingRow: async (_s, row) => ({ removed: removed.has(row.filePath), seq: undefined, job: null }),
    emitRemovedByOwner: (spaceId, pendingKey, row) => removedSignals.push({ pendingKey, fileName: row.relPath }),
  }
  const engine = createOverlayDownloadEngine(channel, { hasOverlay: () => true })
  getOverlay().cancelFetch = () => {}
  getOverlay().notifyTransferStopped = () => {}

  const dl = ctx.tmpDir('dl')
  const goneFinal = path.join(dl, 'gone.bin')
  const gonePartial = goneFinal + '.overlay-partial'
  fs.writeFileSync(gonePartial, 'half a download')
  await recordPending('space1', '/Photos/gone.bin', { total: 100, overlayShare: true, shareId: 'folder1', relPath: 'gone.bin', ownerKey: 'peerpub', finalPath: goneFinal })
  await recordPending('space1', '/Photos/other.bin', { total: 100, overlayShare: true, shareId: 'folder1', relPath: 'other.bin', ownerKey: 'peerpub', finalPath: path.join(dl, 'other.bin') })

  await engine.reconcileOnAppend('peerpub', 'space1')
  await settleTick()

  t.absent(await getPendingFor('space1', '/Photos/gone.bin'), 'tombstoned row cleared')
  t.absent(fs.existsSync(gonePartial), 'tombstoned partial discarded (semantics a)')
  t.ok(await getPendingFor('space1', '/Photos/other.bin'), 'transient row kept (still resumable — no false teardown)')
  t.alike(removedSignals, [{ pendingKey: '/Photos/gone.bin', fileName: 'gone.bin' }], 'emitRemovedByOwner fired once, for the removed file only (drives the toast)')
})

test('reconcileOnAppend tears down a RE-PUBLISHED row (new catalog seq, even same content) — closes the unobserved remove+re-add', async (t) => {
  const ctx = await setup(t)
  const dl = ctx.tmpDir('dl')
  const channel = {
    ...testChannel([]),
    isOwnerOnline: () => true,
    // The entry is live and resumable, but at a NEW catalog seq — a re-publish we never saw tombstoned.
    resolvePendingRow: async () => ({
      removed: false, seq: 9,
      job: makeJob(ctx, { pendingKey: '/Photos/re.bin', relPath: 're.bin', transferId: 'space1|folder1|re.bin', sourceSeq: 9, finalPath: path.join(dl, 're.bin') }),
    }),
    emitRemovedByOwner: () => {},
  }
  const engine = createOverlayDownloadEngine(channel, { hasOverlay: () => true, fetchImpl: () => new Promise(() => {}) })
  getOverlay().cancelFetch = () => {}
  getOverlay().notifyTransferStopped = () => {}

  // Recorded at source seq 5; the catalog head is now seq 9 → a re-add we never observed.
  await recordPending('space1', '/Photos/re.bin', { total: 100, overlayShare: true, shareId: 'folder1', relPath: 're.bin', ownerKey: 'peerpub', sourceSeq: 5, finalPath: path.join(dl, 're.bin') })

  await engine.reconcileOnAppend('peerpub', 'space1')
  await settleTick()

  t.absent(await getPendingFor('space1', '/Photos/re.bin'), 're-published row torn down — a re-add does not auto-resume even when the tombstone was never seen')
  t.absent(engine.has('space1|folder1|re.bin'), 'not resumed')
})

test('reconcileOnAppend tears down a MANUALLY-PAUSED row when its source was removed (decision #1)', async (t) => {
  const ctx = await setup(t)
  const channel = { ...testChannel([]), isOwnerOnline: () => true, resolvePendingRow: async () => ({ removed: true, seq: undefined, job: null }), emitRemovedByOwner: () => {} }
  let settleFetch = null
  const engine = createOverlayDownloadEngine(channel, { hasOverlay: () => true, fetchImpl: () => new Promise((resolve) => { settleFetch = resolve }) })
  getOverlay().cancelFetch = () => {}
  getOverlay().notifyTransferStopped = () => {}

  const job = makeJob(ctx, { pendingKey: '/Photos/p.bin', path: '/Photos/p.bin', relPath: 'p.bin', transferId: 'space1|folder1|p.bin', finalPath: path.join(ctx.tmpDir('dl'), 'p.bin') })
  await engine.start(job)
  engine.pause(job.transferId)
  settleFetch({ ok: false, code: 'ECANCELLED' })
  await new Promise((r) => setTimeout(r, 50))
  t.ok(await getPendingFor('space1', '/Photos/p.bin'), 'precondition: paused row present')

  await engine.reconcileOnAppend('peerpub', 'space1')
  await settleTick()
  t.absent(await getPendingFor('space1', '/Photos/p.bin'), 'manual pause did NOT survive the owner removal')
})

test('reconcileOnAppend skips an ACTIVE row (reconcileActive* owns it)', async (t) => {
  const ctx = await setup(t)
  const channel = { ...testChannel([]), isOwnerOnline: () => true, resolvePendingRow: async () => ({ removed: true, seq: undefined, job: null }), emitRemovedByOwner: () => {} }
  const engine = createOverlayDownloadEngine(channel, { hasOverlay: () => true, fetchImpl: () => new Promise(() => {}) })
  getOverlay().cancelFetch = () => {}

  const job = makeJob(ctx)
  await engine.start(job)
  t.ok(engine.has(job.transferId), 'precondition: active slot')

  await engine.reconcileOnAppend('peerpub', 'space1')
  await settleTick()

  t.ok(await getPendingFor('space1', '/Photos/doc.bin'), 'active row left for reconcileActive* — not torn down by the sweep')
  t.ok(engine.has(job.transferId), 'still active')
})
