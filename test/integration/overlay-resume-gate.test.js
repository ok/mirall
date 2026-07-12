import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import url from 'bare-url'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initPendingTransfers, recordPending, getPendingFor } from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/backends/overlay/overlay-download.js'

// REGRESSION (FIX-9: a download interrupted by a dropped connection never resumed).
//
// The resume trigger and the resume gate read DIFFERENT network planes. With the content plane on,
// the only trigger was a content-hello (bulk plane), while start()'s gate asks whether the owner is
// present on the CONTROL plane. The bulk socket reconnects faster than the control handshake
// completes, so on a flapping link every trigger landed inside a control-down window and was
// dropped silently — leaving a fully recoverable transfer parked forever.
//
// The fix fires the resume from BOTH planes' reconnects: the control handshake marks presence
// synchronously before firing, so its trigger can never observe the stale "offline" the bulk-plane
// trigger races. These tests pin the engine half of that contract — the trigger must survive a
// gate-closed attempt, the resumed byte count must not be wiped by the attempt that bails, and a
// manual resume must never leave a pause marker that suppresses every later reconnect.

const SPACE = 'space1'
const OWNER = 'ownerpub'
const HASH = 'a'.repeat(64)

function testChannel (events, over = {}) {
  return {
    diagLabel: 'test download',
    inPlace: false,
    ownsPendingRow: (row) => row.overlayShare === true,
    pendingExtra: (job) => ({ overlayShare: true, shareId: job.shareId, relPath: job.relPath }),
    emitProgress: () => {},
    emitError: (...a) => events.push(['error', ...a]),
    emitComplete: () => {},
    emitCancelled: (...a) => events.push(['cancelled', ...a]),
    emitSuperseded: () => {},
    emitPaused: (job, reason) => events.push(['paused', job, reason]),
    emitUpdated: (spaceId) => events.push(['updated', spaceId]),
    emitDecorationDone: () => {},
    transferIdForRow: (spaceId, row) => spaceId + '|folder1|' + row.relPath,
    ...over,
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
    spaceId: SPACE, pendingKey: '/Photos/doc.bin', path: '/Photos/doc.bin', relPath: 'doc.bin',
    shareId: 'folder1', transferId: SPACE + '|folder1|doc.bin',
    contentHash: HASH, size: 4096, ownerPublicKey: OWNER, verifyKey: 'folder1|doc.bin',
    finalPath: path.join(ctx.tmpDir('dl'), 'doc.bin'), ...over,
  }
}

// Seeds the row a dropped connection leaves behind: intent recorded, partial on disk, no live slot.
async function seedInterruptedRow (job, bytesTransferred) {
  await recordPending(SPACE, job.pendingKey, {
    total: job.size, inPlace: false, ownerKey: OWNER, finalPath: job.finalPath,
    contentHash: HASH, bytesTransferred, overlayShare: true, shareId: 'folder1', relPath: job.relPath,
  })
}

const settle = () => new Promise((r) => setTimeout(r, 400)) // past the 250ms resume coalescer

// The bug lives in which hooks the worker installs, and the engine cannot observe that — so pin it
// structurally, the way FIX-D2 pins the completion write order. The control-plane hook must be
// installed unconditionally: putting it in the `else` of the content-plane branch (the old wiring)
// left the control handshake firing into null, and with it the only trigger that cannot race the
// presence gate it is checked against.
test('REGRESSION (FIX-9: the control-plane resume hook is installed even when the content plane is on)', (t) => {
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'worker', 'main.js'), 'utf8')

  const controlAt = src.indexOf('setOverlayReconnectHook(autoResume)')
  const contentAt = src.indexOf('setContentResumeHook(')
  t.ok(controlAt > -1, 'the control-plane resume hook is wired')
  t.ok(contentAt > -1, 'the content-plane resume hook is wired')
  t.ok(controlAt < contentAt,
    'the control hook is installed before (i.e. outside) the content-plane branch — not as its else')
  t.absent(/else\s*\{\s*setOverlayReconnectHook/.test(src),
    'the control hook is not gated behind the content plane being off')
})

test('REGRESSION (FIX-9: a resume trigger arriving while the owner looks offline does not consume the intent)', async (t) => {
  const ctx = await setup(t)
  const events = []
  let ownerOnline = false
  let fetches = 0

  const job = makeJob(ctx)
  const channel = testChannel(events, {
    isOwnerOnline: () => ownerOnline,
    resolvePendingRow: async () => ({ removed: false, seq: undefined, job }),
  })
  const engine = createOverlayDownloadEngine(channel)
  getOverlay().fetchFile = async () => { fetches++; return job.finalPath }

  await seedInterruptedRow(job, 1024)

  // The bulk plane reconnects first and fires its resume — but the control handshake has not
  // landed yet, so presence still reads offline and the gate holds.
  await engine.resumeForOwner(OWNER, SPACE)
  await settle()
  t.is(fetches, 0, 'the gate held the doomed fetch while the owner was not present')
  t.absent(engine.has(job.transferId), 'no slot left registered')

  // The control handshake completes: presence flips, and the hook it fires must still find a live
  // intent to act on. Before the fix, this second trigger did not exist.
  ownerOnline = true
  await engine.resumeForOwner(OWNER, SPACE)
  await settle()
  t.is(fetches, 1, 'the later trigger restarted the fetch — the intent was not consumed by the gate')
})

test('REGRESSION (FIX-9: a start() that bails at the gate keeps the partial byte count)', async (t) => {
  const ctx = await setup(t)
  const events = []
  const job = makeJob(ctx, { prevBytes: 14_155_776, size: 16_777_216 })
  const channel = testChannel(events, { isOwnerOnline: () => false })
  const engine = createOverlayDownloadEngine(channel)

  await seedInterruptedRow(job, 14_155_776)
  const res = await engine.start(job)

  t.ok(res.queued, 'start reports queued — the owner is not reachable')
  const row = await getPendingFor(SPACE, job.pendingKey)
  t.is(row.bytesTransferred, 14_155_776, 'the resumed progress survived the bailed start (row not reset to 0)')
})

test('REGRESSION (FIX-9: a manual resume that fails before start() clears the pause marker)', async (t) => {
  const ctx = await setup(t)
  const events = []
  let ownerOnline = true
  let fetches = 0

  const job = makeJob(ctx)
  const channel = testChannel(events, {
    isOwnerOnline: () => ownerOnline,
    resolvePendingRow: async () => ({ removed: false, seq: undefined, job }),
  })
  const engine = createOverlayDownloadEngine(channel)
  getOverlay().fetchFile = async () => { fetches++; return job.finalPath }
  getOverlay().cancelFetch = () => {}

  await seedInterruptedRow(job, 2048)
  engine.pause(job.transferId) // no live slot: records the intent as a marker
  ownerOnline = false

  // The user hits resume while the owner is unreachable. The attempt cannot start — but it MUST
  // still retire the pause marker, or every later reconnect skips this row as "manually paused".
  engine.clearPauseMarker(job.transferId)
  await engine.start(job)
  t.is(fetches, 0, 'the manual attempt could not start')

  ownerOnline = true
  await engine.resumeForOwner(OWNER, SPACE)
  await settle()
  t.is(fetches, 1, 'the next reconnect resumed it — no stale pause marker suppressing the row')
})

test('REGRESSION (FIX-9: pausing a transfer whose fetch already settled still sticks)', async (t) => {
  const ctx = await setup(t)
  const events = []
  let fetches = 0

  const job = makeJob(ctx)
  const channel = testChannel(events, {
    isOwnerOnline: () => true,
    resolvePendingRow: async () => ({ removed: false, seq: undefined, job }),
  })
  const engine = createOverlayDownloadEngine(channel)
  getOverlay().fetchFile = async () => { fetches++; return job.finalPath }

  await seedInterruptedRow(job, 4096)
  t.absent(engine.has(job.transferId), 'the dropped connection already settled the fetch — no slot')

  // The click lands after the drop settled it. With no slot to flag, the pause used to do nothing
  // at all and the row auto-resumed on the next reconnect, against the user's explicit intent.
  t.ok(engine.pause(job.transferId), 'pause records the intent even with no live slot')

  await engine.resumeForOwner(OWNER, SPACE)
  await settle()
  t.is(fetches, 0, 'the reconnect did not auto-resume a user-paused row')
})

// REGRESSION (FIX-10: cancelling a settled download was a silent no-op).
//
// The same defect class as the pause bug above: files:cancel-download routed on whether the
// transfer was LIVE, and the engine's cancel() read the spaceId + pendingKey off the live slot. A
// dropped connection deregisters that slot the moment the fetch settles, so a discard clicked in
// that window reached neither backend — the partial stayed on disk, the pending row stayed (and
// auto-resumed on the next reconnect), and the IPC reply still said ok. Pause could be fixed by
// routing on the id's shape alone; cancel needs the pendingKey, and a FOLDER pendingKey embeds the
// share NAME the id does not carry — so the key is resolved from the pending row instead.

test('REGRESSION (FIX-10: cancelling a transfer whose fetch already settled discards the partial and the pending row)', async (t) => {
  const ctx = await setup(t)
  const events = []

  const job = makeJob(ctx)
  const channel = testChannel(events, {
    isOwnerOnline: () => true,
    resolvePendingRow: async () => ({ removed: false, seq: undefined, job }),
  })
  const engine = createOverlayDownloadEngine(channel)

  const partial = job.finalPath + '.overlay-partial'
  fs.writeFileSync(partial, 'half a download')
  await seedInterruptedRow(job, 2048)
  t.absent(engine.has(job.transferId), 'the dropped connection already settled the fetch — no slot')

  // With no slot to read the spaceId/pendingKey from, cancel used to bail out entirely.
  t.ok(await engine.cancel(job.transferId), 'cancel resolves the row even with no live slot')

  t.absent(fs.existsSync(partial), 'the partial is discarded')
  t.absent(await getPendingFor(SPACE, job.pendingKey), 'the pending row is cleared')
  t.ok(events.some((e) => e[0] === 'cancelled'), 'emitCancelled fired')
  t.ok(events.some((e) => e[0] === 'updated'), 'emitUpdated fired')
})

test('REGRESSION (FIX-10: a cancelled settled row does not resurrect on the next reconnect)', async (t) => {
  const ctx = await setup(t)
  const events = []
  let fetches = 0

  const job = makeJob(ctx)
  const channel = testChannel(events, {
    isOwnerOnline: () => true,
    resolvePendingRow: async () => ({ removed: false, seq: undefined, job }),
  })
  const engine = createOverlayDownloadEngine(channel)
  getOverlay().fetchFile = async () => { fetches++; return job.finalPath }

  await seedInterruptedRow(job, 2048)
  await engine.cancel(job.transferId)

  // The row used to survive the cancel, so the next reconnect happily resumed a download the user
  // had just discarded.
  await engine.resumeForOwner(OWNER, SPACE)
  await settle()
  t.is(fetches, 0, 'the reconnect found nothing to resume — the cancel actually landed')
})

// The shared harness channel is folder-shaped. Loose downloads run on the SAME engine with a
// different row filter + id scheme, and the fixed handler routes settled loose ids straight here.
test('REGRESSION (FIX-10: cancelling a settled loose download discards its partial and row too)', async (t) => {
  const ctx = await setup(t)
  const events = []

  const finalPath = path.join(ctx.tmpDir('dl'), 'loose.bin')
  const transferId = SPACE + '|__loose__|loose.bin'
  const channel = testChannel(events, {
    inPlace: true,
    ownsPendingRow: (row) => row.inPlace === true && row.shareId === '__loose__',
    transferIdForRow: (spaceId, row) => spaceId + '|__loose__|' + row.relPath,
    isOwnerOnline: () => true,
  })
  const engine = createOverlayDownloadEngine(channel)

  const partial = finalPath + '.overlay-partial'
  fs.writeFileSync(partial, 'half a download')
  await recordPending(SPACE, '/loose.bin', {
    total: 4096, inPlace: true, ownerKey: OWNER, finalPath,
    contentHash: HASH, bytesTransferred: 2048, shareId: '__loose__', relPath: 'loose.bin',
  })

  t.ok(await engine.cancel(transferId), 'cancel resolves the loose row with no live slot')
  t.absent(fs.existsSync(partial), 'the partial is discarded')
  t.absent(await getPendingFor(SPACE, '/loose.bin'), 'the pending row is cleared')
})

test('cancel of an id with neither a slot nor a row is a clean no-op', async (t) => {
  await setup(t)
  const events = []
  const engine = createOverlayDownloadEngine(testChannel(events))

  t.absent(await engine.cancel(SPACE + '|folder1|never-started.bin'), 'nothing to cancel — reports false')
  t.is(events.length, 0, 'no cancelled/updated events for a no-op')
})

// The engine cannot observe which gate the worker routes on, so pin it structurally the way the
// FIX-9 hook wiring is pinned above.
test('REGRESSION (FIX-10: the cancel handler routes on the id shape, not on a live slot)', (t) => {
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'worker', 'main.js'), 'utf8')

  const from = src.indexOf("ipc.handle('files:cancel-download'")
  const to = src.indexOf("ipc.handle('files:pause-download'")
  t.ok(from > -1 && to > from, 'the cancel handler exists ahead of the pause handler')

  const handler = src.slice(from, to)
  t.ok(handler.includes('isLooseTransferId('), 'cancel routes on the id shape')
  t.absent(handler.includes('looseHasTransfer('), 'cancel no longer gates on a live loose slot')
  t.absent(handler.includes('overlayHasTransfer('), 'cancel no longer gates on a live overlay slot')
})
