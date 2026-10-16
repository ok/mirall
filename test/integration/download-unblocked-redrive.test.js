import test from 'brittle'
import fs from 'bare-fs'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay } from '../../src/shared/transfer/overlay/overlay-instance.js'
import { initPendingTransfers, getPendingFor, updatePendingProgress } from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/overlay/overlay-download.js'
import { OverlayBackend } from '../../src/shared/transfer/overlay/overlay-runtime.js'
import { downloadChannel, requestShareDownload, setDownloadEngine } from '../../src/shared/transfer/overlay/share-downloads.js'
import { looseShareFor } from '../../src/shared/transfer/overlay/download-job.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { upsertMember } from '../../src/shared/spaces/space.js'
import { advertise, ownCatalogKeyHex } from '../../src/shared/shares/own-catalog.js'
import { initConvergenceTick, redriveUnblockedTransfers } from '../../src/shared/network/convergence-tick.js'
import { scaled } from '../helpers/bare-timing.js'
import { until } from '../helpers/bare-poll.js'
import path from 'bare-path'
import { setSpaceDownloadRoot, forgetSpaceDownloadRoot } from '../../src/shared/core/paths.js'
import { SPACE, OWNER, testChannel, makeJob, readOnlyDir, writableDir, writingHolder, enospcHolder, errorsIn } from '../helpers/readonly-download.js'

// The convergence tick's re-drive of a download whose folder the user fixed while the owner stayed
// connected — the case neither the reconnect nor a catalog append ever reaches.

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const tick = () => new Promise((r) => setTimeout(r, scaled(60)))
const settle = () => new Promise((r) => setTimeout(r, scaled(400)))
const DEST_VERDICT_TTL_MS = 60_000

// The tick's arm driven as the swarm wires it, against the real backend method: this engine stands
// in as the backend's download engine, so the backend's scan and resume are the production ones. The
// engine's clock is the test's, so the kept folder verdict can be expired; the owner's presence is
// the channel's word, as in production.
async function armedTick(t, { channel = {}, engine: engineOpts = {}, dir: makeDir = (ctx) => readOnlyDir(t, ctx, 'dl-unblocked') } = {}) {
  const ctx = await freshPeer(t)
  await initDownloads()
  await initPendingTransfers()
  await initOverlay()
  const dir = makeDir(ctx)
  const job = makeJob(dir ?? ctx.tmpDir('dl-unused'))
  const events = []
  const seen = []
  const clock = { now: 0 }
  const owner = { online: true }
  const engine = createOverlayDownloadEngine({ ...testChannel(events, job, { ownerOnline: () => owner.online }), ...channel }, { now: () => clock.now, ...engineOpts })
  let resumes = 0
  const resumeForOwner = engine.resumeForOwner
  engine.resumeForOwner = (ownerKey, spaceId) => { resumes += 1; return resumeForOwner(ownerKey, spaceId) }
  const backend = new OverlayBackend('overlay-test', { ipc: ctx.fake.ipc, broadcastSharePrepare() {} })
  backend.engine = engine
  setDownloadEngine(engine)
  initConvergenceTick({
    log: silent,
    getStalledOwners: () => null,
    getRedriveUnblocked: () => (opts) => backend.redriveUnblocked(opts),
    getSwarm: () => ({}),
    getIpc: () => null,
  })
  t.teardown(async () => {
    setDownloadEngine(null)
    initConvergenceTick({ log: silent, getStalledOwners: () => null, getRedriveUnblocked: () => null, getSwarm: () => null, getIpc: () => null })
    await teardownOverlay()
  })
  return { ctx, dir, job, events, seen, clock, owner, engine, resumed: () => resumes }
}

const skipped = (t) => { t.comment('skipped: chmod does not make a folder read-only for this process (Windows or root)'); t.pass() }

const MEMBER = 'b'.repeat(64)
const DOC_HASH = 'd'.repeat(64)

// The tick against the production resolve: the click is the real download path and the re-drive
// resolves the row through the real channel, so the folder a row lands in is jobFor's answer rather
// than a copy of its rule. The member's loose catalog is this peer's own, read as a peer's; its file
// is 11 bytes, what writingHolder writes. The space downloads into `folder(ctx)`.
async function realTick(t, { folder: makeFolder, engine: engineOpts = {} }) {
  const ctx = await freshPeer(t)
  await initDownloads()
  await initPendingTransfers()
  await initOverlay()
  const { spaceId } = await createSpace('Aurora')
  const member = { publicKey: MEMBER, looseCatalogKeyEnc: await ownCatalogKeyHex(spaceId) }
  await upsertMember(spaceId, member, { verified: true })
  await advertise(spaceId, LOOSE_SHARE_ID, 'doc.bin', { size: 11, mtime: 1, contentHash: DOC_HASH })
  const folder = makeFolder(ctx)
  setSpaceDownloadRoot(spaceId, folder)
  const seen = []
  const clock = { now: 0 }
  const owner = { online: true }
  const engine = createOverlayDownloadEngine({ ...downloadChannel, isOwnerOnline: () => owner.online }, { now: () => clock.now, ...engineOpts })
  let resumes = 0
  const resumeForOwner = engine.resumeForOwner
  engine.resumeForOwner = (ownerKey, sid) => { resumes += 1; return resumeForOwner(ownerKey, sid) }
  const backend = new OverlayBackend('overlay-test', { ipc: ctx.fake.ipc, broadcastSharePrepare() {} })
  backend.engine = engine
  setDownloadEngine(engine)
  initConvergenceTick({
    log: silent,
    getStalledOwners: () => null,
    getRedriveUnblocked: () => (opts) => backend.redriveUnblocked(opts),
    getSwarm: () => ({}),
    getIpc: () => null,
  })
  t.teardown(async () => {
    setDownloadEngine(null)
    forgetSpaceDownloadRoot(spaceId)
    initConvergenceTick({ log: silent, getStalledOwners: () => null, getRedriveUnblocked: () => null, getSwarm: () => null, getIpc: () => null })
    await teardownOverlay()
  })
  return {
    ctx, spaceId, folder, seen, clock, owner, engine,
    click: () => requestShareDownload(spaceId, looseShareFor(member), 'doc.bin'),
    row: () => getPendingFor(spaceId, '/doc.bin'),
    resumed: () => resumes,
  }
}

// Each beat asks about every pending row twice (the stalled-owner rescue and the re-drive). A row's
// folder is read only when its fault is judged by it, and then from the kept readings, so a folder
// costs at most one stat a minute however many rows land in it.
test('REGRESSION (FIX-DLTO-R27: the tick stats the folder of every pending row on every beat)', async (t) => {
  const ctx = await freshPeer(t)
  setSpaceDownloadRoot(SPACE, writableDir(ctx, 'dl-space'))
  t.teardown(() => forgetSpaceDownloadRoot(SPACE))
  const own = writableDir(ctx, 'dl-own')
  const clock = { now: 0 }
  let stats = 0
  const engine = createOverlayDownloadEngine(testChannel([], null, { ownerOnline: () => false }), {
    now: () => clock.now,
    dirExists: (dir) => { stats += 1; return fs.existsSync(dir) },
  })
  const rows = (extra) => Array.from({ length: 200 }, (_, i) => ({
    spaceId: SPACE, filePath: '/Photos/f' + i + '.jpg', relPath: 'f' + i + '.jpg', overlayShare: true, shareId: 'folder1',
    ownerKey: OWNER, total: 1000, finalPath: path.join(own, 'Photos', 'f' + i + '.jpg'), destDir: own, layout: 'tree', ...extra,
  }))
  const beat = (list) => {
    stats = 0
    for (const row of list) { engine.takeUnblocked(row); engine.awaitsOwner(row) }
    return stats
  }

  t.is(beat(rows({ bytesTransferred: 10 })), 0, 'rows waiting on their owner read no folder')
  const blocked = rows({ bytesTransferred: 10, errorCode: CODES.TRANSFER_DEST_UNAVAILABLE, refusedByPreflight: true })
  t.is(beat(blocked), 1, 'rows whose fault is judged by their folder read it once between them')
  t.is(beat(blocked), 0, 'and not again within the minute')
  clock.now += DEST_VERDICT_TTL_MS
  t.is(beat(blocked), 1, 'once more when the kept reading expires')
})

// A refusal before the first byte leaves nothing in the row's own folder, and that folder is the one
// that refused it: the row follows the space, so the tick judges the space's current folder.
test('REGRESSION (FIX-DLTO-R11: a download refused before its first byte is judged against the full folder it left)', async (t) => {
  let full = ''
  const f = await realTick(t, {
    folder: (ctx) => (full = writableDir(ctx, 'dl-full')),
    engine: { freeBytes: (dir) => (dir === full ? 0 : 10 * 1024 ** 3) },
  })
  writingHolder(f.seen)
  await f.click()
  t.is((await f.row())?.errorCode, CODES.TRANSFER_DISK_FULL, 'precondition: refused as a full disk')
  t.is(f.seen.length, 0, 'precondition: before any fetch')

  const roomy = writableDir(f.ctx, 'dl-roomy')
  setSpaceDownloadRoot(f.spaceId, roomy)
  f.clock.now += DEST_VERDICT_TTL_MS + 1
  await redriveUnblockedTransfers()
  t.ok(await until(async () => !(await f.row()), 2000), 'the tick judged the space\'s folder, which has room, and re-drove the row')
  t.is(path.dirname(f.seen[0] ?? ''), roomy, 'into that folder')
  t.alike(fs.readdirSync(full), [], 'and nothing landed in the full one')
})

async function refusedOnce(t, f) {
  writingHolder(f.seen)
  await f.engine.start(f.job)
  await tick()
  t.is(f.seen.length, 1, 'precondition: the first fetch ran')
  t.is(errorsIn(f.events)[0], CODES.TRANSFER_PERMISSION, 'precondition: the folder refused the download')
}

test('REGRESSION (FIX-450: a fixed download folder is not retried while the owner stays connected)', async (t) => {
  const f = await armedTick(t)
  if (!f.dir) return skipped(t)
  await refusedOnce(t, f)

  await redriveUnblockedTransfers()
  await settle()
  t.is(f.seen.length, 1, 'a folder that still refuses writes is not re-driven')

  fs.chmodSync(f.dir, 0o755)
  await redriveUnblockedTransfers()
  await settle()
  t.is(f.seen.length, 1, 'inside the minute the kept verdict still answers, and no probe write lands in the folder')

  f.clock.now += DEST_VERDICT_TTL_MS + 1
  await redriveUnblockedTransfers()
  t.ok(await until(async () => !(await getPendingFor(SPACE, f.job.pendingKey)), 2000), 'the tick re-drove the row and the download landed')
  t.is(f.seen.length, 2, 'with one more fetch')
  t.is(f.resumed(), 1, 'through the same resume a reconnect runs')
  t.ok(f.events.some(([k]) => k === 'complete'), 'and the intent finished — no reconnect, no append, no Retry')
})

test('an owner who is not present is left for the reconnect', async (t) => {
  const f = await armedTick(t)
  if (!f.dir) return skipped(t)
  await refusedOnce(t, f)

  f.owner.online = false
  fs.chmodSync(f.dir, 0o755)
  f.clock.now += DEST_VERDICT_TTL_MS + 1
  await redriveUnblockedTransfers()
  await settle()
  t.is(f.seen.length, 1, 'no fetch was attempted')
  t.is(f.resumed(), 0, 'and no re-drive rewrote the row')
  t.is((await getPendingFor(SPACE, f.job.pendingKey))?.errorCode, CODES.TRANSFER_PERMISSION, 'the row still says what the user fixed, until the reconnect re-drives it')
})

test('a manually paused row is not re-driven by the tick', async (t) => {
  const f = await armedTick(t)
  if (!f.dir) return skipped(t)
  await refusedOnce(t, f)

  f.engine.pause(f.job.transferId)
  fs.chmodSync(f.dir, 0o755)
  f.clock.now += DEST_VERDICT_TTL_MS + 1
  await redriveUnblockedTransfers()
  await settle()
  t.is(f.seen.length, 1, 'the pause is the user\'s intent and outranks the re-drive')
})

test('a row the re-drive already restarted is not re-driven again while it fetches', async (t) => {
  const f = await armedTick(t)
  if (!f.dir) return skipped(t)
  await refusedOnce(t, f)

  let release = () => {}
  const held = new Promise((r) => { release = r })
  writingHolder(f.seen, { gate: () => held })
  fs.chmodSync(f.dir, 0o755)
  f.clock.now += DEST_VERDICT_TTL_MS + 1
  await redriveUnblockedTransfers()
  t.ok(await until(() => f.seen.length === 2, 2000), 'the first re-drive started a fetch')

  await redriveUnblockedTransfers()
  await settle()
  t.is(f.seen.length, 2, 'an active row waits on nothing, so a second tick starts nothing')
  release()
  t.ok(await until(async () => !(await getPendingFor(SPACE, f.job.pendingKey)), 2000), 'and the held fetch landed')
})

// A re-drive the reconcile cannot turn into a fetch — here the catalog yields no job — must not
// repeat every tick: the row is handed out once per clear, and the reconnect or the next catalog
// append is what reaches it again.
test('a cleared row the reconcile could not start is re-driven once, not every tick', async (t) => {
  const f = await armedTick(t, { channel: { resolvePendingRow: async () => ({ removed: false, seq: undefined, job: null }) } })
  if (!f.dir) return skipped(t)
  await refusedOnce(t, f)

  fs.chmodSync(f.dir, 0o755)
  f.clock.now += DEST_VERDICT_TTL_MS + 1
  await redriveUnblockedTransfers()
  await settle()
  await redriveUnblockedTransfers()
  await settle()
  t.is(f.resumed(), 1, 'one re-drive')
  t.is(f.seen.length, 1, 'that started nothing')
  t.is((await getPendingFor(SPACE, f.job.pendingKey))?.errorCode, CODES.TRANSFER_PERMISSION, 'and the row keeps its verdict for the reconnect')
})

test('REGRESSION (FIX-473: a disk-full download is not retried once the user frees space)', async (t) => {
  const volume = { free: 0 }
  const f = await armedTick(t, {
    dir: (ctx) => writableDir(ctx, 'dl-diskfull'),
    engine: { freeBytes: () => volume.free },
  })
  writingHolder(f.seen)

  await f.engine.start(f.job)
  await tick()
  t.is(f.seen.length, 0, 'precondition: the preflight refused before any fetch')
  t.is(errorsIn(f.events)[0], CODES.TRANSFER_DISK_FULL, 'precondition: refused as a full disk')
  t.is((await getPendingFor(SPACE, f.job.pendingKey))?.errorCode, CODES.TRANSFER_DISK_FULL, 'and the verdict is durable')

  await redriveUnblockedTransfers()
  await settle()
  t.is(f.seen.length, 0, 'a volume that is still full is not re-driven')

  volume.free = 10 * 1024 ** 3
  f.clock.now += DEST_VERDICT_TTL_MS + 1
  await redriveUnblockedTransfers()
  t.ok(await until(async () => !(await getPendingFor(SPACE, f.job.pendingKey)), 2000),
    'the tick re-drove the row once the volume had room')
  t.is(f.seen.length, 1, 'with one fetch')
  t.is(f.resumed(), 1, 'through the same resume a reconnect runs')
  t.ok(f.events.some(([k]) => k === 'complete'), 'and the intent finished — no reconnect, no append, no Retry')
})

test('REGRESSION (FIX-473: a download folder that comes back is not retried until a reconnect)', async (t) => {
  let gone = ''
  const f = await armedTick(t, { dir: (ctx) => (gone = path.join(ctx.downloads, 'ejected')) })
  writingHolder(f.seen)

  await f.engine.start(f.job)
  await tick()
  t.is(f.seen.length, 0, 'precondition: the preflight refused before any fetch')
  t.is(errorsIn(f.events)[0], CODES.TRANSFER_DEST_UNAVAILABLE, 'precondition: refused as a missing folder')

  await redriveUnblockedTransfers()
  await settle()
  t.is(f.seen.length, 0, 'a folder that is still gone is not re-driven')

  fs.mkdirSync(gone, { recursive: true })
  f.clock.now += DEST_VERDICT_TTL_MS + 1
  await redriveUnblockedTransfers()
  t.ok(await until(async () => !(await getPendingFor(SPACE, f.job.pendingKey)), 2000),
    'the re-attached folder re-drove the row')
  t.is(f.seen.length, 1, 'with one fetch, and no Retry')
})

test('REGRESSION (FIX-473: a space re-pointed at a new download folder never re-drives its blocked rows)', async (t) => {
  let gone = ''
  const f = await realTick(t, { folder: (ctx) => (gone = path.join(ctx.downloads, 'ejected')) })
  writingHolder(f.seen)
  await f.click()
  t.is((await f.row())?.errorCode, CODES.TRANSFER_DEST_UNAVAILABLE, 'precondition: the row\'s own folder is gone')

  const moved = writableDir(f.ctx, 'dl-moved')
  setSpaceDownloadRoot(f.spaceId, moved)
  f.clock.now += DEST_VERDICT_TTL_MS + 1

  await redriveUnblockedTransfers()
  t.ok(await until(async () => !(await f.row()), 2000), 'the re-pointed space re-drove the row whose own folder cannot be reached')
  t.is(f.seen.length, 1, 'with one fetch')
  t.is(path.dirname(f.seen[0] ?? ''), moved, 'into the folder the user just chose')
  t.absent(fs.existsSync(gone), 'and the missing folder was not recreated')
})

// A row whose bytes are already in its own folder keeps it, here one the user made read-only after
// the download began.
test('a re-pointed space leaves a started row in its own folder while that folder is there', async (t) => {
  const f = await realTick(t, { folder: (ctx) => readOnlyDir(t, ctx, 'dl-unblocked') })
  if (!f.folder) return skipped(t)
  writingHolder(f.seen)
  await f.click()
  t.ok(await until(async () => (await f.row())?.errorCode === CODES.TRANSFER_PERMISSION, 2000), 'precondition: the folder refused the download')
  await updatePendingProgress(f.spaceId, '/doc.bin', 4)

  const moved = writableDir(f.ctx, 'dl-moved')
  setSpaceDownloadRoot(f.spaceId, moved)
  f.clock.now += DEST_VERDICT_TTL_MS + 1
  await redriveUnblockedTransfers()
  await settle()
  t.is(f.seen.length, 1, 'the row is judged against its own folder, which still refuses writes')

  fs.chmodSync(f.folder, 0o755)
  f.clock.now += DEST_VERDICT_TTL_MS + 1
  await redriveUnblockedTransfers()
  t.ok(await until(async () => !(await f.row()), 2000), 'the fixed folder re-drove the row')
  t.is(path.dirname(f.seen[1] ?? ''), f.folder, 'into its own folder')
  t.alike(fs.readdirSync(moved), [], 'nothing landed in the space\'s new folder')
})

// A volume that reports room and refuses the write anyway — inode exhaustion, or free space it
// will not actually hand over. The preflight cannot see the difference, so a disk-full verdict the
// WRITE produced is the user's to clear; handing it to the tick costs a whole fetch and an error
// toast per beat, forever.
test('REGRESSION (FIX-473: an ENOSPC no free-space reading predicted is re-driven on every tick)', async (t) => {
  const f = await armedTick(t, {
    dir: (ctx) => writableDir(ctx, 'dl-enospc'),
    engine: { freeBytes: () => 10 * 1024 ** 3 },
  })
  enospcHolder(f.seen)

  await f.engine.start(f.job)
  await tick()
  t.is(f.seen.length, 1, 'precondition: the preflight let it through and the write failed')
  t.is(errorsIn(f.events)[0], CODES.TRANSFER_DISK_FULL, 'precondition: recorded as a full disk')

  // The second tick of each round lands while the re-driven fetch is still in flight: an active row
  // must not release the once-per-clear guard the first tick took.
  let release = () => {}
  enospcHolder(f.seen, { gate: () => new Promise((r) => { release = r }) })
  for (let round = 0; round < 3; round++) {
    f.clock.now += DEST_VERDICT_TTL_MS + 1
    await redriveUnblockedTransfers()
    await settle()
    await redriveUnblockedTransfers()
    await settle()
    release()
    await settle()
  }
  t.is(f.seen.length, 1, 'no tick re-drove the row')
  t.is(f.resumed(), 0, 'and no re-drive rewrote it')
  t.is((await getPendingFor(SPACE, f.job.pendingKey))?.errorCode, CODES.TRANSFER_DISK_FULL, 'the verdict stands, for the user to clear')
})
