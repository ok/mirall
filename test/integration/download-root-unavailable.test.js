import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initPendingTransfers, recordPending, getPendingFor } from '../../src/shared/transfer/pending-transfers.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { ErrorCodes } from '../../src/shared/core/errors.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/backends/overlay/overlay-download.js'
import { createOverlayChannel } from '../../src/shared/transfer/backends/overlay/overlay-channel.js'

// REGRESSION (FIX-DLDIR-2: a download folder that had been deleted, ejected, or replaced by a
// file produced no message the user could act on).
//
// Two separate holes, both covered here:
//
//  1. NO ERROR AT ALL for the commonest case. The receive path mkdir -p's the destination
//     (vendor/transfer.js), so a folder the user simply deleted was silently recreated and the
//     download completed into a resurrected empty folder. Nothing failed, so nothing could be
//     classified — only a preflight catches it.
//  2. THE WRONG ERROR when the mkdir did fail. Every local-fs errno fell through
//     classifyTransferError to TRANSFER_NETWORK, which the engine rewrote to DOWNLOAD_FAILED and
//     the renderer rendered as the generic "Transfer failed". macOS made it worse: /Volumes is
//     root-owned, so an ejected volume failed EACCES and reported "Permission denied", sending
//     the user to check permissions that were fine.
//
// The engine now probes the folder in both places, and a row that failed this way no longer
// auto-resumes — which is what stopped a gone folder from re-failing (and re-notifying, at
// critical urgency) on every owner reconnect.

const SPACE = 'space1'
const OWNER = 'ownerpub'
const HASH = 'b'.repeat(64)

function testChannel (events, over = {}) {
  return {
    diagLabel: 'test download',
    inPlace: false,
    ownsPendingRow: (row) => row.overlayShare === true,
    pendingExtra: (job) => ({ overlayShare: true, shareId: job.shareId, relPath: job.relPath }),
    emitProgress: () => {},
    emitError: (job, code) => events.push(['error', job, code]),
    emitComplete: () => {},
    emitCancelled: () => {},
    emitSuperseded: () => {},
    emitPaused: (job, reason) => events.push(['paused', job, reason]),
    emitUpdated: (spaceId) => events.push(['updated', spaceId]),
    emitDecorationDone: () => {},
    transferIdForRow: (spaceId, row) => spaceId + '|folder1|' + row.relPath,
    isOwnerOnline: () => true,
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

function makeJob (dir, over = {}) {
  return {
    spaceId: SPACE, pendingKey: '/Photos/doc.bin', path: '/Photos/doc.bin', relPath: 'doc.bin',
    shareId: 'folder1', transferId: SPACE + '|folder1|doc.bin',
    contentHash: HASH, size: 4096, ownerPublicKey: OWNER, verifyKey: 'folder1|doc.bin',
    finalPath: path.join(dir, 'doc.bin'), ...over,
  }
}

const errorsIn = (events) => events.filter((e) => e[0] === 'error').map((e) => e[2])
const tick = () => new Promise((r) => setTimeout(r, 60))
const settle = () => new Promise((r) => setTimeout(r, 400)) // past the 250ms resume coalescer

// Guards every assertion below. The code travels to the renderer as a bare string and is mapped
// there by literal (errorMessages.js), so this pins the wire contract — and, less obviously, keeps
// the rest of this file honest: if the constant were missing, `ErrorCodes.TRANSFER_DEST_UNAVAILABLE`
// would be undefined and each `t.is(<no error emitted>, undefined)` would pass vacuously.
test('the destination-unavailable code is the exact string the renderer maps', (t) => {
  t.is(ErrorCodes.TRANSFER_DEST_UNAVAILABLE, 'TRANSFER_DEST_UNAVAILABLE')
})

// === Preflight: the folder is already gone when the download starts ===

test('REGRESSION (FIX-DLDIR-2: a download into a deleted folder reports the folder, not "Transfer failed")', async (t) => {
  const ctx = await setup(t)
  const events = []
  const engine = createOverlayDownloadEngine(testChannel(events))
  let fetches = 0
  getOverlay().fetchFile = async () => { fetches++; return { ok: true } }

  // The user's custom download folder, then removed behind the app's back.
  const gone = ctx.tmpDir('dl-gone')
  fs.rmSync(gone, { recursive: true, force: true })
  const job = makeJob(gone)

  const res = await engine.start(job)
  await tick()

  t.is(errorsIn(events)[0], ErrorCodes.TRANSFER_DEST_UNAVAILABLE, 'the specific code reaches the renderer')
  t.is(fetches, 0, 'no bytes were requested for a folder that cannot receive them')
  t.ok(res.queued, 'start did not hand back a live transfer')
  t.absent(engine.has(job.transferId), 'no slot left registered')

  // Optional-chained on purpose: without the fix there is no row at all, and a TypeError here
  // aborts the whole file before the remaining cases get to report.
  const row = await getPendingFor(SPACE, job.pendingKey)
  t.is(row?.errorCode, ErrorCodes.TRANSFER_DEST_UNAVAILABLE, 'the reason is durable, so a restart still explains it')
})

test('REGRESSION (FIX-DLDIR-2: a download folder replaced by a file is refused, not written through)', async (t) => {
  const ctx = await setup(t)
  const events = []
  const engine = createOverlayDownloadEngine(testChannel(events))
  getOverlay().fetchFile = async () => ({ ok: true })

  const shadowed = path.join(ctx.tmpDir('dl-shadow'), 'Downloads')
  fs.writeFileSync(shadowed, 'not a folder')

  await engine.start(makeJob(shadowed))
  await tick()

  t.is(errorsIn(events)[0], ErrorCodes.TRANSFER_DEST_UNAVAILABLE, 'ENOTDIR-shaped case is the same fault to the user')
})

test('a healthy download folder is untouched by the preflight', async (t) => {
  const ctx = await setup(t)
  const events = []
  const engine = createOverlayDownloadEngine(testChannel(events))
  let fetches = 0
  getOverlay().fetchFile = async () => { fetches++; return { ok: true } }

  await engine.start(makeJob(ctx.tmpDir('dl-ok')))
  await tick()

  t.is(fetches, 1, 'the fetch ran')
  t.is(errorsIn(events).length, 0, 'no error was surfaced for a folder that is present')
})

// === Terminal classification: the folder disappears mid-transfer ===

// The preflight cannot cover this — the folder was there when the download started. Each errno
// below is one the old classifier folded into TRANSFER_NETWORK → DOWNLOAD_FAILED.
for (const code of ['ENOENT', 'ENOTDIR', 'EIO', 'EACCES']) {
  test(`REGRESSION (FIX-DLDIR-2: a mid-transfer ${code} on a vanished folder is not "Transfer failed")`, async (t) => {
    const ctx = await setup(t)
    const events = []
    const dir = ctx.tmpDir('dl-vanish-' + code)
    const job = makeJob(dir)
    const engine = createOverlayDownloadEngine(testChannel(events))

    // The folder survives the preflight, then goes away while the bytes are in flight.
    getOverlay().fetchFile = async () => {
      fs.rmSync(dir, { recursive: true, force: true })
      const err = new Error(`${code}: simulated failure, open '${job.finalPath}'`)
      err.code = code
      throw err
    }

    await engine.start(job)
    await tick()

    t.is(errorsIn(events)[0], ErrorCodes.TRANSFER_DEST_UNAVAILABLE, `${code} classified by the folder, not the errno`)
  })
}

test('a local-fs failure with the folder still present keeps its own classification', async (t) => {
  const ctx = await setup(t)
  const events = []
  const dir = ctx.tmpDir('dl-present')
  const job = makeJob(dir)
  const engine = createOverlayDownloadEngine(testChannel(events))

  // Same errno, folder intact: this is a genuine permission problem on a folder that IS there,
  // and must keep saying so. The probe is what separates the two — without it, either this case
  // or the ejected-volume case above is guaranteed to be wrong.
  getOverlay().fetchFile = async () => {
    const err = new Error("EACCES: permission denied, open '" + job.finalPath + "'")
    err.code = 'EACCES'
    throw err
  }

  await engine.start(job)
  await tick()

  t.is(errorsIn(events)[0], ErrorCodes.TRANSFER_PERMISSION, 'still a permission error, not a folder fault')
})

// === The folder-share channel must let this code cross the wire ===

// Folder rows normally surface an error only through the list refresh; just three terminal codes
// are also emitted as event:transfer-error, which is what drives the toast, the OS notification,
// and the banner's immediate re-probe. A dest-unavailable failure that stayed off the wire would
// show the right words on the row and nothing anywhere else — the exact half-fix this pins
// against. Behavioural now that the gate is one factory: build the folder channel and watch it.
test('REGRESSION (FIX-DLDIR-2: the folder-share channel emits transfer-error for a gone folder)', (t) => {
  const emitted = []
  const channel = createOverlayChannel({
    diagLabel: 'test', inPlace: false, surfaceAllErrors: false, updatedEvent: 'event:share-files-updated',
    emit: (name, payload) => emitted.push([name, payload]),
    decoKeyFor: (job) => job.relPath, decoKeyForRow: () => null,
  })
  const job = { transferId: 't', spaceId: 'S', path: '/Vault/a.bin', relPath: 'a.bin', size: 1 }
  const wired = (code) => {
    emitted.length = 0
    channel.emitError(job, code)
    return emitted.some(([name]) => name === 'event:transfer-error')
  }
  t.ok(wired(ErrorCodes.TRANSFER_DEST_UNAVAILABLE), 'the code is in the cross-the-wire set')
  t.ok(wired(ErrorCodes.TRANSFER_DISK_FULL), 'alongside disk-full')
  t.ok(wired(ErrorCodes.TRANSFER_CHECKSUM), 'and the integrity failure')
  t.absent(wired(ErrorCodes.DOWNLOAD_FAILED), 'and nothing else — a generic failure stays on the row')
})

// === Auto-resume suppression ===

test('REGRESSION (FIX-DLDIR-2: a dest-unavailable row does not re-fail on every owner reconnect)', async (t) => {
  const ctx = await setup(t)
  const events = []
  const dir = ctx.tmpDir('dl-suppress')
  const job = makeJob(dir)
  let fetches = 0

  const engine = createOverlayDownloadEngine(testChannel(events, {
    resolvePendingRow: async () => ({ removed: false, seq: undefined, job }),
  }))
  getOverlay().fetchFile = async () => { fetches++; return { ok: true } }

  // The row a gone folder leaves behind.
  await recordPending(SPACE, job.pendingKey, {
    total: job.size, inPlace: false, ownerKey: OWNER, finalPath: job.finalPath,
    contentHash: HASH, bytesTransferred: 0, overlayShare: true, shareId: 'folder1', relPath: job.relPath,
    errorCode: ErrorCodes.TRANSFER_DEST_UNAVAILABLE,
  })

  await engine.resumeForOwner(OWNER, SPACE)
  await settle()

  // Without the suppression the reconnect restarts the download, it fails again, and the renderer
  // fires another critical-urgency notification — once per reconnect, for as long as the folder
  // stays gone. The row is deliberately kept: it is the user's unfulfilled intent.
  t.is(fetches, 0, 'the reconnect did not retry a download that cannot land')
  t.ok(await getPendingFor(SPACE, job.pendingKey), 'the intent survives — this is a pause, not a drop')
})
