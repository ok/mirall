import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay } from '../../src/shared/transfer/overlay/overlay-instance.js'
import { initPendingTransfers, getPendingFor } from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/overlay/overlay-download.js'
import { resetFetchSlots } from '../../src/shared/transfer/overlay/fetch-gate.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { LAYOUT } from '../../src/shared/transfer/overlay/download-job.js'
import { scaled } from '../helpers/bare-timing.js'

// Two bulk jobs on a one-slot gate: the second parks and reads Waiting, flips to active the moment
// the first settles (with a listing poke on that edge), and a pause or a cancel while parked ends
// it without a fetch ever running.

const SPACE = 'space1'
const OWNER = 'ownerpub'
const HASH = 'a'.repeat(64)

function testChannel(events) {
  return {
    diagLabelFor: () => 'test download',
    ownsPendingRow: (row) => row.overlayShare === true,
    pendingExtra: (job) => ({ overlayShare: true, shareId: job.shareId, relPath: job.relPath }),
    isOwnerOnline: () => true,
    emitProgress: () => {},
    emitError: (...a) => events.push(['error', ...a]),
    emitComplete: () => {},
    emitCancelled: (...a) => events.push(['cancelled', ...a]),
    emitSuperseded: () => {},
    emitPaused: (job, reason) => events.push(['paused', job, reason]),
    emitUpdated: (spaceId, shareId) => events.push(['updated', spaceId, shareId]),
    emitDecorationDone: () => {},
    transferIdForRow: (spaceId, row) => spaceId + '|folder1|' + row.relPath,
    resolvePendingRow: async () => ({ removed: false, seq: undefined, job: null }),
  }
}

async function setup(t) {
  const ctx = await freshPeer(t)
  await initDownloads()
  await initPendingTransfers()
  await initOverlay()
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, downloadConcurrency: 1 })
  resetFetchSlots()
  t.teardown(async () => { setRuntimeConfig(prev); resetFetchSlots(); await teardownOverlay() })
  return ctx
}

function makeJob(ctx, name, over = {}) {
  const root = ctx.tmpDir('dl')
  return {
    spaceId: SPACE, pendingKey: '/Photos/' + name, path: '/Photos/' + name, relPath: name,
    shareId: 'folder1', transferId: SPACE + '|folder1|' + name,
    contentHash: HASH, size: 4096, ownerKey: OWNER, verifyKey: 'folder1|' + name,
    finalPath: path.join(root, name), destRoot: root, layout: LAYOUT.FLAT, ...over,
  }
}

// A fetch the test releases by hand, so the slot stays held for as long as the assertions need.
function heldFetch() {
  const calls = []
  const release = () => { for (const c of calls) c.resolve({ ok: true }) }
  const fetchImpl = (hash, { finalPath }) => new Promise((resolve) => {
    fs.writeFileSync(finalPath, 'landed')
    calls.push({ resolve })
  })
  return { calls, release, fetchImpl }
}

const tick = () => new Promise((r) => setTimeout(r, scaled(50)))

test('the second bulk job parks and reads waiting; it flips to active on the first settle, with a poke', async (t) => {
  const ctx = await setup(t)
  const events = []
  const fetch = heldFetch()
  const engine = createOverlayDownloadEngine(testChannel(events), { fetchImpl: fetch.fetchImpl })
  const a = makeJob(ctx, 'a.bin')
  const b = makeJob(ctx, 'b.bin')

  await engine.start({ ...a, express: false })
  await engine.start({ ...b, express: false })
  await tick()
  t.is(engine.phase(a.transferId), 'active')
  t.is(engine.phase(b.transferId), 'waiting', 'the second job is parked behind the one-slot gate')
  t.is(fetch.calls.length, 1, 'only one fetch is running')
  const pokesWhileParked = events.filter((e) => e[0] === 'updated').length
  t.ok(pokesWhileParked >= 2, 'the park emitted a poke, so the listing re-derives waiting at once')

  fetch.release()
  await tick()
  t.is(engine.phase(a.transferId), null, 'the first settled')
  t.is(engine.phase(b.transferId), 'active', 'the second was admitted')
  t.ok(events.filter((e) => e[0] === 'updated').length > pokesWhileParked, 'admission emitted a poke')
  fetch.release()
  await tick()
  t.is(engine.phase(b.transferId), null)
})

test('pausing a parked job releases it without a fetch', async (t) => {
  const ctx = await setup(t)
  const events = []
  const fetch = heldFetch()
  const engine = createOverlayDownloadEngine(testChannel(events), { fetchImpl: fetch.fetchImpl })
  const a = makeJob(ctx, 'a.bin')
  const b = makeJob(ctx, 'b.bin')
  await engine.start({ ...a, express: false })
  await engine.start({ ...b, express: false })
  await tick()
  t.is(engine.phase(b.transferId), 'waiting')

  engine.pause(b.transferId)
  fetch.release()
  await tick()
  t.is(engine.phase(b.transferId), null, 'the parked job left the registry when admitted')
  t.is(fetch.calls.length, 1, 'its fetch never ran')
  t.ok(await getPendingFor(SPACE, b.pendingKey), 'the row survives a pause')
})

test('cancelling a parked job clears its row and leaves no partial', async (t) => {
  const ctx = await setup(t)
  const events = []
  const fetch = heldFetch()
  const engine = createOverlayDownloadEngine(testChannel(events), { fetchImpl: fetch.fetchImpl })
  const a = makeJob(ctx, 'a.bin')
  const b = makeJob(ctx, 'b.bin')
  await engine.start({ ...a, express: false })
  await engine.start({ ...b, express: false })
  await tick()

  await engine.cancel(b.transferId)
  fetch.release()
  await tick()
  t.is(engine.phase(b.transferId), null)
  t.absent(await getPendingFor(SPACE, b.pendingKey), 'the row is cleared')
  t.absent(fs.existsSync(b.finalPath + '.mirall.part'), 'no partial was ever written')
  t.absent(fs.existsSync(b.finalPath), 'nothing landed')
  t.is(fetch.calls.length, 1)
})

test('a tree job creates its folder under the root and lands below it', async (t) => {
  const ctx = await setup(t)
  const fetch = heldFetch()
  const engine = createOverlayDownloadEngine(testChannel([]), { fetchImpl: fetch.fetchImpl })
  const root = ctx.tmpDir('dl')
  const job = makeJob(ctx, 'a.bin', { finalPath: path.join(root, 'Vault', 'sub', 'a.bin'), destRoot: root, layout: LAYOUT.TREE })
  await engine.start({ ...job, express: false })
  await tick()
  t.ok(fs.existsSync(path.join(root, 'Vault', 'sub')), 'the folder exists before the fetch')
  const row = await getPendingFor(SPACE, job.pendingKey)
  t.is(row.layout, 'tree', 'the layout is persisted on the row')
  fetch.release()
  await tick()
  t.ok(fs.existsSync(job.finalPath), 'the file landed in its folder')
})

test('a tree job whose root is gone is refused rather than recreated', async (t) => {
  const ctx = await setup(t)
  const events = []
  const fetch = heldFetch()
  const engine = createOverlayDownloadEngine(testChannel(events), { fetchImpl: fetch.fetchImpl })
  const root = path.join(ctx.tmpDir('dl'), 'gone')
  const job = makeJob(ctx, 'a.bin', { finalPath: path.join(root, 'Vault', 'a.bin'), destRoot: root, layout: LAYOUT.TREE })
  await engine.start({ ...job, express: false })
  await tick()
  t.absent(fs.existsSync(root), 'the missing root was not created')
  t.ok(events.some((e) => e[0] === 'error' && e[2] === 'TRANSFER_DEST_UNAVAILABLE'), 'refused as destination unavailable')
  t.is(fetch.calls.length, 0)
})

test('a parked job leaves the registry the moment it is cancelled or paused, without a fetch', async (t) => {
  const ctx = await setup(t)
  const events = []
  const fetch = heldFetch()
  const engine = createOverlayDownloadEngine(testChannel(events), { fetchImpl: fetch.fetchImpl })
  const a = makeJob(ctx, 'a.bin')
  const b = makeJob(ctx, 'b.bin')
  const c = makeJob(ctx, 'c.bin')
  await engine.start({ ...a, express: false })
  await engine.start({ ...b, express: false })
  await engine.start({ ...c, express: false })
  await tick()
  t.is(engine.phase(b.transferId), 'waiting')

  const pokesBefore = events.filter((e) => e[0] === 'updated').length
  await engine.cancel(b.transferId)
  t.is(engine.phase(b.transferId), null, 'the cancelled job is gone at once, while the head fetch still runs')
  t.ok(events.filter((e) => e[0] === 'updated').length > pokesBefore, 'and the listing was poked')
  engine.pause(c.transferId)
  t.is(engine.phase(c.transferId), null, 'a paused parked job is released at once too')
  t.ok(await getPendingFor(SPACE, c.pendingKey), 'its row survives for the resume')

  // A fresh start under the cancelled id takes the slot; the stale waiter must not disturb it.
  const again = makeJob(ctx, 'b.bin', { finalPath: path.join(ctx.tmpDir('dl'), 'b.bin') })
  await engine.start({ ...again, express: false })
  await tick()
  t.is(engine.phase(again.transferId), 'waiting', 'the new attempt is registered')
  fetch.release()
  await tick()
  await tick()
  t.is(engine.phase(again.transferId), 'active', 'the stale waiter abandoned and the new attempt was admitted')
  t.is(fetch.calls.length, 2, 'the cancelled and the paused job never fetched')
  fetch.release()
  await tick()
})
