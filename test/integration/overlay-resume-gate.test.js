import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import url from 'bare-url'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/overlay/overlay-instance.js'
import { initPendingTransfers, recordPending, getPendingFor } from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/overlay/overlay-download.js'
import { downloadChannel } from '../../src/shared/transfer/overlay/share-downloads.js'
import { scaled } from '../helpers/bare-timing.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { registerFiles } from '../../src/worker/ipc/files.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { advertise, getOwnEntry } from '../../src/shared/shares/own-catalog.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'
import { createFolderChooser } from '../../src/worker/download-folder-push.js'

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
const silentLog = { debug() {}, info() {}, warn() {}, error() {} }
const OWNER = 'ownerpub'
const HASH = 'a'.repeat(64)

function testChannel(events, over = {}) {
  return {
    diagLabelFor: () => 'test download',
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
    spaceId: SPACE, pendingKey: '/Photos/doc.bin', path: '/Photos/doc.bin', relPath: 'doc.bin',
    shareId: 'folder1', transferId: SPACE + '|folder1|doc.bin',
    contentHash: HASH, size: 4096, ownerKey: OWNER, verifyKey: 'folder1|doc.bin',
    finalPath: path.join(ctx.tmpDir('dl'), 'doc.bin'), ...over,
  }
}

// Seeds the row a dropped connection leaves behind: intent recorded, partial on disk, no live slot.
async function seedInterruptedRow(job, bytesTransferred) {
  await recordPending(SPACE, job.pendingKey, {
    total: job.size, inPlace: false, ownerKey: OWNER, finalPath: job.finalPath,
    contentHash: HASH, bytesTransferred, overlayShare: true, shareId: 'folder1', relPath: job.relPath,
  })
}

const settle = () => new Promise((r) => setTimeout(r, scaled(400))) // past the 250ms resume coalescer

// The bug lives in which hooks the worker installs, and the engine cannot observe that — so pin it
// structurally, the way FIX-D2 pins the completion write order. The control-plane hook must be
// installed unconditionally: putting it in the `else` of the content-plane branch (the old wiring)
// left the control handshake firing into null, and with it the only trigger that cannot race the
// presence gate it is checked against.
test('REGRESSION (FIX-9: the control-plane resume hook is installed even when the content plane is on)', (t) => {
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  // The hook wiring moved with the boot sequence into the composition root.
  const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'worker', 'boot.js'), 'utf8')

  // Both planes now take the SAME overlay backend as a constructor dep, which is the invariant
  // this pinned: the control hook can no longer be the else-branch of the content plane, because
  // neither is a branch any more.
  const swarmDep = src.match(/new Swarm\('swarm', \{[\s\S]*?\}\)\)/)?.[0] || ''
  const contentDep = src.match(/new ContentSwarm\('content-swarm', \{[^}]*\}\)/)?.[0] || ''
  t.ok(/overlayBackend/.test(swarmDep), 'the control swarm resumes through the overlay backend')
  t.ok(/overlayBackend/.test(contentDep), 'and so does the content swarm')
  t.absent(/setOverlayReconnectHook|setContentResumeHook/.test(src),
    'neither resume path is a nullable hook slot any more')
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

  const partial = job.finalPath + '.mirall.part'
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

// One engine owns both kinds of row, so a settled id of either kind resolves from its pending row on
// the production channel.
test('REGRESSION (FIX-10: cancelling a settled loose download discards its partial and row too)', async (t) => {
  const ctx = await setup(t)
  const engine = createOverlayDownloadEngine({ ...downloadChannel, isOwnerOnline: () => true })

  const looseFinal = path.join(ctx.tmpDir('dl'), 'loose.bin')
  const looseId = SPACE + '|__loose__|loose.bin'
  fs.writeFileSync(looseFinal + '.mirall.part', 'half a download')
  await recordPending(SPACE, '/loose.bin', {
    total: 4096, inPlace: true, ownerKey: OWNER, finalPath: looseFinal,
    contentHash: HASH, bytesTransferred: 2048, shareId: '__loose__', relPath: 'loose.bin',
  })
  const folderFinal = path.join(ctx.tmpDir('dl'), 'doc.bin')
  fs.writeFileSync(folderFinal + '.mirall.part', 'half a download')
  await recordPending(SPACE, '/Photos/doc.bin', {
    total: 4096, inPlace: false, ownerKey: OWNER, finalPath: folderFinal,
    contentHash: HASH, bytesTransferred: 2048, overlayShare: true, shareId: 'folder1', relPath: 'doc.bin', catalogKey: 'c'.repeat(64),
  })

  t.ok(await engine.cancel(looseId), 'cancel resolves the loose row with no live slot')
  t.absent(fs.existsSync(looseFinal + '.mirall.part'), 'the loose partial is discarded')
  t.absent(await getPendingFor(SPACE, '/loose.bin'), 'the loose pending row is cleared')
  t.ok(await getPendingFor(SPACE, '/Photos/doc.bin'), 'the folder row is left alone')

  t.ok(await engine.cancel(SPACE + '|folder1|doc.bin'), 'the same engine resolves the settled folder row')
  t.absent(fs.existsSync(folderFinal + '.mirall.part'), 'the folder partial is discarded')
  t.absent(await getPendingFor(SPACE, '/Photos/doc.bin'), 'the folder pending row is cleared')
})

test('cancel of an id with neither a slot nor a row is a clean no-op', async (t) => {
  await setup(t)
  const events = []
  const engine = createOverlayDownloadEngine(testChannel(events))

  t.absent(await engine.cancel(SPACE + '|folder1|never-started.bin'), 'nothing to cancel — reports false')
  t.is(events.length, 0, 'no cancelled/updated events for a no-op')
})

// The engine keeps a no-op silent; the click that found nothing is the handler's to answer, because
// the row that offered it is stale and would otherwise keep its dead Discard. The id names its share,
// so the poke reaches that one listing, loose or folder alike.
test('a cancel click that finds nothing re-derives the stale row on its own listing', async (t) => {
  await setup(t)
  const fake = createFakeIpc()
  registerFiles(fake.ipc, { log: silentLog, chooseFolder: createFolderChooser({ ipc: fake.ipc, publishRevealRoots: () => {} }) })

  t.alike(await fake.call('files:cancel-download', { transferId: SPACE + '|folder1|gone.bin' }), { ok: true })
  t.alike(await fake.call('files:cancel-download', { transferId: SPACE + '|__loose__|gone.bin' }), { ok: true })
  t.alike(fake.emitted('event:share-files-updated').map((e) => e.payload),
    [{ spaceId: SPACE, shareId: 'folder1' }, { spaceId: SPACE, shareId: LOOSE_SHARE_ID }])
  t.is(fake.emitted('event:files-updated').length, 0, 'never every listing in the space')
})

// The remove handler's own poke names the loose list rather than every listing in the space. The
// tombstone's catalog append separately fires the own-catalog hook's share-axis wildcard
// (folder-publish.js), which this fake ipc is not wired to, so only the handler's emit is pinned.
test('the unshare handler\'s own poke names the loose listing', async (t) => {
  await setup(t)
  const { spaceId } = await createSpace('Aurora')
  await advertise(spaceId, LOOSE_SHARE_ID, 'note.txt', { size: 4, mtime: 1, contentHash: HASH })
  const fake = createFakeIpc()
  registerFiles(fake.ipc, { log: silentLog, chooseFolder: createFolderChooser({ ipc: fake.ipc, publishRevealRoots: () => {} }) })

  t.alike(await fake.call('files:remove', { spaceId, path: '/note.txt' }), { ok: true })
  t.absent(await getOwnEntry(spaceId, LOOSE_SHARE_ID, 'note.txt'), 'the entry is unshared')
  t.alike(fake.emitted('event:share-files-updated').map((e) => e.payload), [{ spaceId, shareId: LOOSE_SHARE_ID }])
  t.is(fake.emitted('event:files-updated').length, 0, 'and not the space-wide name')
})

// The engine cannot observe whether the worker gates the cancel on a live slot, so pin it
// structurally the way the FIX-9 hook wiring is pinned above.
test('REGRESSION (FIX-10: the cancel handler reaches the engine whether or not a slot is live)', (t) => {
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(here, '..', '..', 'src', 'worker', 'ipc', 'files.js'), 'utf8')

  const from = src.indexOf("ipc.handle('files:cancel-download'")
  const to = src.indexOf("ipc.handle('files:pause-download'")
  t.ok(from > -1 && to > from, 'the cancel handler exists ahead of the pause handler')

  const handler = src.slice(from, to)
  t.ok(handler.includes('await cancelShareDownload(id)'), 'cancel hands every id to the engine')
  t.ok(handler.includes('transferIdParts(id)'), 'a stale row re-derives on the id\'s own share')
  t.absent(handler.includes('shareDownloadPhase('), 'cancel does not gate on a live slot')
})
