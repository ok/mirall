import test from 'brittle'
import fs from 'bare-fs'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initPendingTransfers, getPendingFor, _pendingBeeForTests } from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/backends/overlay/overlay-download.js'
import { scaled } from '../helpers/bare-timing.js'
import { until } from '../helpers/bare-poll.js'
import { SPACE, OWNER, testChannel, makeJob, readOnlyDir, writingHolder, errorsIn } from '../helpers/readonly-download.js'

// A download whose folder the app may not write fails the same way on every attempt, so it is a
// terminal fault: the reconnect re-drive leaves it alone and only the user's Resume re-attempts.

async function setup(t) {
  const ctx = await freshPeer(t)
  await initDownloads()
  await initPendingTransfers()
  await initOverlay()
  t.teardown(async () => { await teardownOverlay() })
  return ctx
}

const tick = () => new Promise((r) => setTimeout(r, scaled(60)))
const settle = () => new Promise((r) => setTimeout(r, scaled(400))) // past the 250ms resume coalescer

test('REGRESSION (FIX-379: a read-only download folder is not re-fetched on every owner reconnect)', async (t) => {
  const ctx = await setup(t)
  const dir = readOnlyDir(t, ctx, 'dl-readonly')
  if (!dir) { t.comment('skipped: chmod does not make a folder read-only for this process (Windows or root)'); t.pass(); return }

  const job = makeJob(dir)
  const events = []
  const seen = []
  const engine = createOverlayDownloadEngine(testChannel(events, job))
  writingHolder(seen)

  await engine.start(job)
  await tick()

  t.is(seen.length, 1, 'precondition: the first fetch ran')
  t.is(errorsIn(events)[0], CODES.TRANSFER_PERMISSION, 'the real errno classified as a permission fault')
  t.is((await getPendingFor(SPACE, job.pendingKey))?.errorCode, CODES.TRANSFER_PERMISSION, 'the verdict is durable')

  // The owner reconnects twice. The folder is still read-only, so an attempt could only fail again.
  await engine.resumeForOwner(OWNER, SPACE)
  await settle()
  await engine.resumeForOwner(OWNER, SPACE)
  await settle()

  t.is(seen.length, 1, 'no reconnect re-fetched a download that cannot land')
  t.is(errorsIn(events).length, 1, 'and none re-raised the error')
  t.is((await getPendingFor(SPACE, job.pendingKey))?.errorCode, CODES.TRANSFER_PERMISSION, 'the row still says why')

  // The user's Resume is the same two calls folderRequestDownload makes, and it outranks the verdict.
  engine.clearPauseMarker(job.transferId)
  await engine.start(job)
  await tick()
  t.is(seen.length, 2, 'an explicit Resume re-attempts')
  t.is((await getPendingFor(SPACE, job.pendingKey))?.errorCode, CODES.TRANSFER_PERMISSION, 'and still fails while the folder is read-only')

  // The user fixes the folder and presses Resume again: the download lands and the intent is finished.
  fs.chmodSync(dir, 0o755)
  engine.clearPauseMarker(job.transferId)
  await engine.start(job)
  t.ok(await until(async () => !(await getPendingFor(SPACE, job.pendingKey)), 2000), 'its pending row is cleared')
  t.is(seen.length, 3)
  t.ok(events.some(([k]) => k === 'complete'), 'the download completed once the folder was writable')
})

// Fixing the folder is the action a permission fault waits for, so the reconnect after it is enough.
test('once the folder takes a write again, the next reconnect re-drives the row', async (t) => {
  const ctx = await setup(t)
  const dir = readOnlyDir(t, ctx, 'dl-readonly-fixed')
  if (!dir) { t.comment('skipped: chmod does not make a folder read-only for this process (Windows or root)'); t.pass(); return }

  const job = makeJob(dir)
  const events = []
  const seen = []
  const engine = createOverlayDownloadEngine(testChannel(events, job))
  writingHolder(seen)

  await engine.start(job)
  await tick()
  t.is(errorsIn(events)[0], CODES.TRANSFER_PERMISSION, 'precondition: the folder refused the download')

  fs.chmodSync(dir, 0o755)
  await engine.resumeForOwner(OWNER, SPACE)
  t.ok(await until(async () => !(await getPendingFor(SPACE, job.pendingKey)), 2000), 'the reconnect landed the download')
  t.is(seen.length, 2, 'with one more fetch, and no Retry')
})

test('REGRESSION (FIX-379: a permission verdict whose write fails still suppresses auto-resume)', async (t) => {
  const ctx = await setup(t)
  const dir = readOnlyDir(t, ctx, 'dl-readonly-mem')
  if (!dir) { t.comment('skipped: chmod does not make a folder read-only for this process (Windows or root)'); t.pass(); return }

  const job = makeJob(dir)
  const events = []
  const seen = []
  const engine = createOverlayDownloadEngine(testChannel(events, job))
  writingHolder(seen)

  // Only the verdict write fails: start()'s own row write carries no errorCode.
  const bee = _pendingBeeForTests()
  const realPut = bee.put.bind(bee)
  bee.put = (key, value, opts) => value?.errorCode !== undefined
    ? Promise.reject(new Error('EIO: injected put failure'))
    : realPut(key, value, opts)
  t.teardown(() => { bee.put = realPut })

  await engine.start(job)
  await tick()
  t.is(seen.length, 1, 'precondition: the first fetch ran')
  t.absent((await getPendingFor(SPACE, job.pendingKey))?.errorCode, 'precondition: the durable verdict really did not land')

  await engine.resumeForOwner(OWNER, SPACE)
  await settle()
  t.is(seen.length, 1, 'the in-memory verdict keeps the row out of the re-drive for this process')
})
