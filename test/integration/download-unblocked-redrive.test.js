import test from 'brittle'
import fs from 'bare-fs'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initPendingTransfers, getPendingFor } from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/backends/overlay/overlay-download.js'
import { OverlayBackend } from '../../src/shared/transfer/backends/overlay/overlay-runtime.js'
import { setFolderEngine } from '../../src/shared/transfer/backends/overlay/folder-downloads.js'
import { initConvergenceTick, redriveUnblockedTransfers } from '../../src/shared/network/convergence-tick.js'
import { scaled } from '../helpers/bare-timing.js'
import { until } from '../helpers/bare-poll.js'
import { SPACE, testChannel, makeJob, readOnlyDir, writingHolder, errorsIn } from '../helpers/readonly-download.js'

// The convergence tick's re-drive of a download whose folder the user fixed while the owner stayed
// connected — the case neither the reconnect nor a catalog append ever reaches.

const silent = { debug() {}, info() {}, warn() {}, error() {} }
const tick = () => new Promise((r) => setTimeout(r, scaled(60)))
const settle = () => new Promise((r) => setTimeout(r, scaled(400)))
const FOLDER_VERDICT_TTL_MS = 60_000

// The tick's arm driven as the swarm wires it, against the real backend method: this engine stands
// in as the backend's folder engine, so the backend's scan and resume are the production ones. The
// engine's clock is the test's, so the kept folder verdict can be expired; the owner's presence is
// the channel's word, as in production.
async function armedTick(t, { channel = {} } = {}) {
  const ctx = await freshPeer(t)
  await initDownloads()
  await initPendingTransfers()
  await initOverlay()
  const dir = readOnlyDir(t, ctx, 'dl-unblocked')
  const job = makeJob(dir ?? ctx.tmpDir('dl-unused'))
  const events = []
  const seen = []
  const clock = { now: 0 }
  const owner = { online: true }
  const engine = createOverlayDownloadEngine({ ...testChannel(events, job, { ownerOnline: () => owner.online }), ...channel }, { now: () => clock.now })
  let resumes = 0
  const resumeForOwner = engine.resumeForOwner
  engine.resumeForOwner = (ownerKey, spaceId) => { resumes += 1; return resumeForOwner(ownerKey, spaceId) }
  const backend = new OverlayBackend('overlay-test', { ipc: ctx.fake.ipc, broadcastSharePrepare() {} })
  backend.folderEngine = engine
  setFolderEngine(engine)
  initConvergenceTick({
    log: silent,
    getStalledOwners: () => null,
    getRedriveUnblocked: () => (opts) => backend.redriveUnblocked(opts),
    getSwarm: () => ({}),
    getIpc: () => null,
  })
  t.teardown(async () => {
    setFolderEngine(null)
    initConvergenceTick({ log: silent, getStalledOwners: () => null, getRedriveUnblocked: () => null, getSwarm: () => null, getIpc: () => null })
    await teardownOverlay()
  })
  return { dir, job, events, seen, clock, owner, engine, resumed: () => resumes }
}

const skipped = (t) => { t.comment('skipped: chmod does not make a folder read-only for this process (Windows or root)'); t.pass() }

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

  f.clock.now += FOLDER_VERDICT_TTL_MS + 1
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
  f.clock.now += FOLDER_VERDICT_TTL_MS + 1
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
  f.clock.now += FOLDER_VERDICT_TTL_MS + 1
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
  f.clock.now += FOLDER_VERDICT_TTL_MS + 1
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
  f.clock.now += FOLDER_VERDICT_TTL_MS + 1
  await redriveUnblockedTransfers()
  await settle()
  await redriveUnblockedTransfers()
  await settle()
  t.is(f.resumed(), 1, 'one re-drive')
  t.is(f.seen.length, 1, 'that started nothing')
  t.is((await getPendingFor(SPACE, f.job.pendingKey))?.errorCode, CODES.TRANSFER_PERMISSION, 'and the row keeps its verdict for the reconnect')
})
