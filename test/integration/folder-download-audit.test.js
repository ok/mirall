import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/backends/overlay/overlay-download.js'
import { folderChannel } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'
import { looseChannel } from '../../src/shared/transfer/loose-overlay.js'
import { queryAudit, flushAudit } from '../../src/shared/audit/audit-log.js'
import { drainTransferAudit } from '../../src/shared/transfer/transfer-audit.js'

// The audit row for a download is written by the ENGINE, so these drive the engine over the REAL
// channels. A hand-written channel double would prove nothing here: the two hand-written channels
// diverging is the defect.

const OWNER = 'p'.repeat(64)

async function rows (kind) {
  await drainTransferAudit()
  await flushAudit()
  const { entries } = await queryAudit({ limit: 100 })
  return kind ? entries.filter((e) => e.kind === kind) : entries
}

// start() hands the fetch to a background task, so the terminal row lands after it resolves.
async function settle (kind, { tries = 60 } = {}) {
  for (let i = 0; i < tries; i++) {
    const found = await rows(kind)
    if (found.length) return found
    await new Promise((r) => setTimeout(r, 25))
  }
  return await rows(kind)
}

const quiet = () => new Promise((r) => setTimeout(r, 150))

function folderJob (ctx, spaceId, over = {}) {
  return {
    spaceId,
    pendingKey: '/Brand Assets/logo.svg',
    path: '/Brand Assets/logo.svg',
    relPath: 'logo.svg',
    shareId: 'sh1',
    folderName: 'Brand Assets',
    catalogKey: 'cat-hex',
    transferId: spaceId + '|sh1|logo.svg',
    contentHash: 'h'.repeat(64),
    size: 4096,
    ownerPublicKey: OWNER,
    verifyKey: 'sh1|logo.svg',
    finalPath: path.join(ctx.tmpDir('dl'), 'logo.svg'),
    ...over,
  }
}

async function setup (t, over = {}) {
  const ctx = await freshPeer(t)
  const space = await createSpace('Design Team')
  const engine = createOverlayDownloadEngine({ ...folderChannel, isOwnerOnline: () => true })
  return { ctx, space, engine, job: folderJob(ctx, space.spaceId, over) }
}

function throwsWith (code, message) {
  return async () => {
    const err = new Error(message)
    err.code = code
    throw err
  }
}

// REGRESSION (FIX-D11-1: a folder-share download produced no audit row at all. `record(` appeared
// zero times in overlay-backend.js while the loose channel recorded from its own emitComplete, so
// "You downloaded X" existed for a space-root file and for nothing inside a folder.)
test('REGRESSION (FIX-D11-1): a completed folder-share download records transfer.completed', async (t) => {
  const { engine, job } = await setup(t)
  fs.writeFileSync(job.finalPath, 'bytes')
  getOverlay().fetchFile = async () => ({ destPath: job.finalPath, local: false, size: 5 })

  await engine.start(job)
  const found = await settle('transfer.completed')

  t.is(found.length, 1, 'exactly one row, at the terminal outcome')
  if (!found.length) return
  t.is(found[0].target.name, 'logo.svg', 'the file is named in the row — nothing is joined at render')
  t.is(found[0].subject.folder, 'Brand Assets', 'and the folder it came out of')
  t.is(found[0].subject.bytes, 4096)
  t.is(found[0].subject.shareId, 'sh1')
  t.is(found[0].outcome, 'ok')
  t.is(found[0].actor.type, 'self')
  t.is(found[0].space.name, 'Design Team', 'the space name is snapshotted, not joined')
})

// The recorder read job.ownerKey, but every job builder writes ownerPublicKey — so the holder was
// null on every transfer row ever written, loose ones included.
test('REGRESSION (FIX-D11-1b): the row attributes the holder it fetched from', async (t) => {
  const { engine, job } = await setup(t)
  fs.writeFileSync(job.finalPath, 'bytes')
  getOverlay().fetchFile = async () => ({ destPath: job.finalPath, local: false, size: 5 })

  await engine.start(job)
  const [row] = await settle('transfer.completed')
  if (!row) return t.fail('no transfer.completed row to attribute')
  t.is(row.subject.ownerKey, OWNER, 'read from job.ownerPublicKey, which is the field that exists')
})

// REGRESSION (FIX-D11-2: a holder serving bytes that fail their advertised hash was logged to the
// console and dropped. security.integrity_failure exists for exactly this and had no folder-side
// producer.)
test('REGRESSION (FIX-D11-2): a hash mismatch records security.integrity_failure, not transfer.failed', async (t) => {
  const { engine, job } = await setup(t)
  getOverlay().fetchFile = throwsWith('EHASHMISMATCH', 'hash mismatch')

  await engine.start(job)
  const found = await settle('security.integrity_failure')

  t.is(found.length, 1, 'promoted out of the generic failure kind')
  if (!found.length) return
  t.is(found[0].category, 'security', "so the viewer's security filter surfaces it")
  t.is(found[0].code, 'TRANSFER_CHECKSUM')
  t.is(found[0].outcome, 'error')
  t.is(found[0].subject.folder, 'Brand Assets')
  t.is((await rows('transfer.failed')).length, 0, 'and NOT also counted as a network failure')
})

// REGRESSION (FIX-D11-3: the folder channel only ever emitted an EVENT, and only for three codes.
// A folder download failing for any other reason left no trace anywhere.)
test('REGRESSION (FIX-D11-3): a terminal failure records transfer.failed carrying its code', async (t) => {
  const { engine, job } = await setup(t)
  getOverlay().fetchFile = throwsWith('ENOSPC', 'no space left on device')

  await engine.start(job)
  const found = await settle('transfer.failed')

  t.is(found.length, 1)
  if (!found.length) return
  t.is(found[0].code, 'TRANSFER_DISK_FULL')
  t.is(found[0].outcome, 'error')
  t.is(found[0].target.name, 'logo.svg')
})

test('a paused download records nothing — a pause is not an outcome', async (t) => {
  const { engine, job } = await setup(t)
  let rejectFetch = null
  getOverlay().fetchFile = () => new Promise((_, reject) => { rejectFetch = reject })
  getOverlay().cancelFetch = () => {
    const err = new Error('cancelled')
    err.code = 'ECANCELLED'
    rejectFetch?.(err)
    return true
  }

  await engine.start(job)
  await quiet()
  await engine.pause(job.transferId)
  await quiet()

  t.is((await rows('transfer.completed')).length, 0)
  t.is((await rows('transfer.failed')).length, 0, 'a resumable row must not read as a failure in the log')
  t.is((await rows('security.integrity_failure')).length, 0)
})

// C1 moved the recorder OUT of loose-overlay.js. A forgotten deletion shows up here as two rows.
test('a loose download still records exactly one row after the move', async (t) => {
  const ctx = await freshPeer(t)
  const space = await createSpace('Design Team')
  const engine = createOverlayDownloadEngine({ ...looseChannel, isOwnerOnline: () => true })
  const finalPath = path.join(ctx.tmpDir('dl'), 'notes.txt')
  const job = {
    spaceId: space.spaceId, pendingKey: '/notes.txt', path: '/notes.txt', relPath: 'notes.txt',
    shareId: '__loose__', transferId: space.spaceId + '|__loose__|notes.txt',
    contentHash: 'h'.repeat(64), size: 12, ownerPublicKey: OWNER, verifyKey: '__loose__|notes.txt',
    finalPath,
  }
  fs.writeFileSync(finalPath, 'x')
  getOverlay().fetchFile = async () => ({ destPath: finalPath, local: false, size: 1 })

  await engine.start(job)
  const found = await settle('transfer.completed')

  t.is(found.length, 1, 'one recorder, one row')
  if (!found.length) return
  t.is(found[0].subject.folder, null, 'a loose file has no folder — the meta line must not invent one')
  t.is(found[0].subject.ownerKey, OWNER)
})

// REGRESSION (FIX-D11-6: the guard that was missing. audit-coverage.test.js asserts every KIND has
// a call site somewhere in the data layer, which one channel satisfied for both — so a channel that
// records nothing was invisible to every suite. Recording belongs to the engine; this pins that a
// channel cannot opt out of it, which is what makes the whole class of bug unrepresentable.)
test('REGRESSION (FIX-D11-6): a channel that knows nothing about auditing still produces a row', async (t) => {
  const ctx = await freshPeer(t)
  const space = await createSpace('Design Team')
  const finalPath = path.join(ctx.tmpDir('dl'), 'third.bin')
  const bare = {
    diagLabel: 'third channel',
    inPlace: false,
    isOwnerOnline: () => true,
    ownsPendingRow: (row) => row.thirdChannel === true,
    pendingExtra: () => ({ thirdChannel: true }),
    emitProgress: () => {},
    emitError: () => {},
    emitComplete: () => {},
    emitCancelled: () => {},
    emitUpdated: () => {},
    transferIdForRow: (spaceId, row) => spaceId + '|third|' + row.relPath,
    resolvePendingRow: async () => ({ removed: false, seq: undefined, job: null }),
  }
  const engine = createOverlayDownloadEngine(bare)
  const job = {
    spaceId: space.spaceId, pendingKey: '/third.bin', path: '/third.bin', relPath: 'third.bin',
    shareId: 'third', folderName: 'Third', transferId: space.spaceId + '|third|third.bin',
    contentHash: 'h'.repeat(64), size: 3, ownerPublicKey: OWNER, verifyKey: 'third|third.bin',
    finalPath,
  }
  fs.writeFileSync(finalPath, 'abc')
  getOverlay().fetchFile = async () => ({ destPath: finalPath, local: false, size: 3 })

  await engine.start(job)
  const found = await settle('transfer.completed')
  t.is(found.length, 1, 'the engine records; the channel is not asked to')
})
