import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initPendingTransfers, getPendingFor, _pendingBeeForTests } from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { partialPathFor } from '../../src/shared/transfer/partial-suffix.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/backends/overlay/overlay-download.js'
import { scaled } from '../helpers/bare-timing.js'

// A download whose folder the app may not write fails the same way on every attempt, so it is a
// terminal fault: the reconnect re-drive leaves it alone and only the user's Resume re-attempts.

const SPACE = 'space1'
const OWNER = 'ownerpub'
const HASH = 'c'.repeat(64)

function testChannel(events, job) {
  return {
    diagLabel: 'test download',
    inPlace: false,
    ownsPendingRow: (row) => row.overlayShare === true,
    pendingExtra: (j) => ({ overlayShare: true, shareId: j.shareId, relPath: j.relPath }),
    emitProgress: () => {},
    emitVerifying: () => {},
    emitError: (_job, code) => events.push(['error', code]),
    emitComplete: () => events.push(['complete']),
    emitCancelled: () => {},
    emitSuperseded: () => {},
    emitPaused: (_job, reason) => events.push(['paused', reason]),
    emitUpdated: () => {},
    emitDecorationDone: () => {},
    transferIdForRow: (spaceId, row) => spaceId + '|folder1|' + row.relPath,
    isOwnerOnline: () => true,
    resolvePendingRow: async () => ({ removed: false, seq: undefined, job }),
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

function makeJob(dir) {
  return {
    spaceId: SPACE, pendingKey: '/Photos/doc.bin', path: '/Photos/doc.bin', relPath: 'doc.bin',
    shareId: 'folder1', transferId: SPACE + '|folder1|doc.bin',
    contentHash: HASH, size: 11, ownerKey: OWNER, verifyKey: 'folder1|doc.bin',
    finalPath: path.join(dir, 'doc.bin'),
  }
}

// A folder this process cannot write, or null where the mode bits do not make it so: Windows
// ignores a directory's mode and root bypasses it. The probe write is the honest test of both.
function readOnlyDir(t, ctx, name) {
  const dir = ctx.tmpDir(name)
  fs.chmodSync(dir, 0o555)
  t.teardown(() => { try { fs.chmodSync(dir, 0o755) } catch {} })
  try {
    fs.writeFileSync(path.join(dir, '.probe'), 'x')
    return null
  } catch (err) {
    return ['EACCES', 'EPERM', 'EROFS'].includes(err.code) ? dir : null
  }
}

// The holder's receive path, reduced to its first local write: open the partial beside the final
// name, then rename it into place. On a read-only folder the open throws the real errno.
function writingHolder(seen) {
  getOverlay().fetchFile = async (_hash, opts) => {
    seen.push(opts.destPath)
    const part = partialPathFor(opts.destPath)
    fs.writeFileSync(part, 'hello bytes')
    fs.renameSync(part, opts.destPath)
    return { destPath: opts.destPath, local: false, size: 11 }
  }
}

const errorsIn = (events) => events.filter((e) => e[0] === 'error').map((e) => e[1])
const tick = () => new Promise((r) => setTimeout(r, scaled(60)))
const settle = () => new Promise((r) => setTimeout(r, scaled(400))) // past the 250ms resume coalescer

// Guards the file: with the constant missing every comparison below would pass vacuously.
test('the permission code is the exact string the renderer maps', (t) => {
  t.is(CODES.TRANSFER_PERMISSION, 'TRANSFER_PERMISSION')
})

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
  await tick()
  t.is(seen.length, 3)
  t.ok(events.some(([k]) => k === 'complete'), 'the download completed once the folder was writable')
  t.absent(await getPendingFor(SPACE, job.pendingKey), 'and its pending row is cleared')
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
