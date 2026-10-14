import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { createOverlayChannel } from '../../src/shared/transfer/overlay/overlay-channel.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { LOOSE_SHARE_ID, looseTransferIdFor, transferIdFor } from '../../src/shared/transfer/transfer-id.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSrc = (rel) => readFileSync(path.join(here, '..', '..', 'src', rel), 'utf8')

const KEY = 'ab'.repeat(32)
const FOLDER_JOB = {
  transferId: 'S|sh|a.bin', spaceId: 'S', path: '/Vault/a.bin', relPath: 'a.bin',
  shareId: 'sh', catalogKey: KEY, size: 100, prevBytes: 10,
}
const LOOSE_JOB = {
  transferId: 'S|__loose__|a.bin', spaceId: 'S', path: '/a.bin', relPath: 'a.bin',
  shareId: LOOSE_SHARE_ID, catalogKey: KEY, size: 100, prevBytes: 10,
}
const JOBS = { loose: LOOSE_JOB, folder: FOLDER_JOB }

function build(emit = () => {}) {
  return createOverlayChannel({ emit, resolvePendingRow: async () => ({ removed: false, seq: undefined, job: null }) })
}

function recorder() {
  const out = []
  return { out, emit: (name, payload) => out.push([name, payload]), names: () => out.map(([n]) => n) }
}

test('a paused folder transfer emits event:transfer-paused', (t) => {
  const r = recorder()
  build(r.emit).emitPaused(FOLDER_JOB, 'offline')
  t.ok(r.names().includes('event:transfer-paused'), 'the notification signal crosses the wire')
  const [, payload] = r.out.find(([n]) => n === 'event:transfer-paused')
  t.is(payload.reason, 'offline', 'carrying the reason the dispatcher words the body from')
  t.is(payload.transferId, FOLDER_JOB.transferId, 'and the id the notification dedupes on')
})

test('REGRESSION (FIX-PI1-1: a retrying pause is decoration-only, on both kinds)', (t) => {
  for (const [kind, job] of Object.entries(JOBS)) {
    const r = recorder()
    build(r.emit).emitPaused(job, 'interrupted', { retrying: true })
    t.absent(r.names().includes('event:transfer-paused'), `${kind}: no notification per retry attempt`)
    t.ok(r.out.some(([n, p]) => n === 'event:decoration' && p.done), `${kind}: the bar still terminates`)
  }
})

test('a pause with no retry armed notifies on both kinds', (t) => {
  for (const [kind, job] of Object.entries(JOBS)) {
    const r = recorder()
    build(r.emit).emitPaused(job, 'offline')
    t.ok(r.names().includes('event:transfer-paused'), `${kind}: notifies`)
  }
})

test('the error wire filter is the only behavioural difference between the kinds', (t) => {
  const surfaced = (kind, code) => {
    const r = recorder()
    build(r.emit).emitError(JOBS[kind], code)
    return r.names().includes('event:transfer-error')
  }
  for (const code of [CODES.TRANSFER_DISK_FULL, CODES.TRANSFER_CHECKSUM, CODES.TRANSFER_DEST_UNAVAILABLE, CODES.TRANSFER_PERMISSION]) {
    t.ok(surfaced('folder', code), `folder surfaces ${code}`)
    t.ok(surfaced('loose', code), `loose surfaces ${code}`)
  }
  t.absent(surfaced('folder', CODES.DOWNLOAD_FAILED), 'a folder row keeps a generic failure inline')
  t.absent(surfaced('folder', CODES.TRANSFER_REMOVED), 'and a removed source, which a reconnect may still fix')
  t.ok(surfaced('loose', CODES.DOWNLOAD_FAILED), 'a loose row has no list to keep it in')

  const events = (kind, drive) => {
    const r = recorder()
    drive(build(r.emit), JOBS[kind])
    return r.names()
  }
  const cases = {
    progress: (c, job) => c.emitProgress(job, { bytes: 1, total: 2, speed: 3, eta: 4 }),
    verifying: (c, job) => c.emitVerifying(job, 0.5),
    complete: (c, job) => c.emitComplete(job, '/tmp/a.bin'),
    paused: (c, job) => c.emitPaused(job, 'offline'),
    superseded: (c, job) => c.emitSuperseded(job),
    decorationDone: (c, job) => c.emitDecorationDone(job),
    removedByOwner: (c, job) => c.emitRemovedByOwner('S', job.path, { relPath: 'a.bin' }, job.transferId),
  }
  for (const [name, drive] of Object.entries(cases)) {
    t.alike(events('loose', drive), events('folder', drive), `${name} emits the same events on both kinds`)
  }
})

test('every emit carries spaceId; each kind keys its decoration on its own axis', (t) => {
  const r = recorder()
  const channel = build(r.emit)
  channel.emitProgress(FOLDER_JOB, { bytes: 1, total: 2, speed: 0, eta: null })
  t.is(r.out[0][1].spaceId, 'S', 'a bare drive path is unique per space only')
  t.is(r.out[0][1].key, 'sh:a.bin', 'a folder file is keyed on the share axis')

  r.out.length = 0
  channel.emitProgress(LOOSE_JOB, { bytes: 1, total: 2, speed: 0, eta: null })
  t.is(r.out[0][1].key, '/a.bin', 'a loose file is keyed on its drive path')
})

test('a cancel with no row emits on the loose pending key and nothing for a folder', (t) => {
  const r = recorder()
  const channel = build(r.emit)
  channel.emitCancelled('S', FOLDER_JOB.transferId, '/Vault/a.bin', null)
  t.is(r.out.length, 0, 'a folder cancel whose row cannot name a key emits nothing')

  channel.emitCancelled('S', LOOSE_JOB.transferId, '/a.bin', null)
  t.is(r.out.length, 1, 'the loose key comes from the pending key, which is always there')
  t.is(r.out[0][1].key, '/a.bin')

  r.out.length = 0
  channel.emitCancelled('S', FOLDER_JOB.transferId, '/Vault/a.bin', { shareId: 'sh', relPath: 'a.bin' })
  t.is(r.out[0][1].key, 'sh:a.bin', 'a folder row names its share key')
})

// One event for both kinds; the share id in the payload is what keeps a loose poke off every folder
// view and a folder poke off the loose list.
test('the updated event names the listing by its share id, for both kinds', (t) => {
  const r = recorder()
  const channel = build(r.emit)
  channel.emitUpdated('S', LOOSE_SHARE_ID)
  channel.emitUpdated('S', 'sh')
  t.alike(r.out, [
    ['event:share-files-updated', { spaceId: 'S', shareId: '__loose__' }],
    ['event:share-files-updated', { spaceId: 'S', shareId: 'sh' }],
  ])
})

test('the superseded and removed events name the file, not the path', (t) => {
  const r = recorder()
  const channel = build(r.emit)
  channel.emitSuperseded({ ...FOLDER_JOB, relPath: 'nested/deep/a.bin' })
  t.is(r.out.find(([n]) => n === 'event:transfer-superseded')[1].fileName, 'a.bin', 'a nested key still names the leaf')

  r.out.length = 0
  channel.emitRemovedByOwner('S', '/Vault/nested/a.bin', null, 'id')
  t.is(r.out[0][1].fileName, 'a.bin', 'and so does a pending key with no row behind it')
})

// PERSISTED: the fields a pending row is written with, per kind. A build owns a row by them, so a
// rename strands every row an earlier build wrote.
test('the pending-row fields each kind writes are exactly these', (t) => {
  const channel = build()
  t.alike(channel.pendingExtra(LOOSE_JOB), { inPlace: true, shareId: LOOSE_SHARE_ID, relPath: 'a.bin' }, 'loose')
  t.alike(channel.pendingExtra(FOLDER_JOB), { inPlace: false, overlayShare: true, shareId: 'sh', relPath: 'a.bin', catalogKey: KEY }, 'folder, plaintext catalog')
  const encrypted = { ...FOLDER_JOB, catalogKey: undefined, catalogKeyEnc: KEY, catalogEpoch: 2 }
  t.alike(channel.pendingExtra(encrypted), {
    inPlace: false, overlayShare: true, shareId: 'sh', relPath: 'a.bin', catalogKeyEnc: KEY, catalogEpoch: 2,
  }, 'folder, encrypted catalog')
})

test('the engine owns the rows either kind writes and nothing else', (t) => {
  const { ownsPendingRow } = build()
  const loose = { inPlace: true, shareId: LOOSE_SHARE_ID, relPath: 'a.bin', ownerKey: 'O' }
  t.ok(ownsPendingRow({ ...loose, total: 100, finalPath: '/dl/a.bin', contentHash: 'h' }), 'a started loose row')
  t.ok(ownsPendingRow({ ...loose, total: 0 }), 'a loose intent row')
  t.ok(ownsPendingRow({ inPlace: false, overlayShare: true, shareId: 'sh', relPath: 'a.bin', catalogKey: KEY }), 'a folder row')
  t.absent(ownsPendingRow({ shareId: 'sh', relPath: 'a.bin', ownerKey: 'O' }), 'an unmarked row')
  t.absent(ownsPendingRow({ shareId: LOOSE_SHARE_ID, relPath: 'a.bin' }), 'a loose-named row without the in-place marker')
  t.absent(ownsPendingRow({ inPlace: true, shareId: 'sh', relPath: 'a.bin' }), 'an in-place row of a folder share')
})

test('a row maps to the id its own transfer carries, for both kinds', (t) => {
  const { transferIdForRow } = build()
  t.is(transferIdForRow('S', { shareId: LOOSE_SHARE_ID, relPath: 'a.bin' }), looseTransferIdFor('S', 'a.bin'))
  t.is(transferIdForRow('S', { shareId: 'sh', relPath: 'd/a.bin' }), transferIdFor('S', 'sh', 'd/a.bin'))
})

// A job with no share id would otherwise be persisted and announced as a folder's.
test('a job, row or id without a share id is refused, not read as a folder', (t) => {
  const channel = build()
  const noShare = { ...FOLDER_JOB, shareId: undefined }
  t.exception(() => channel.pendingExtra(noShare), /no share id/, 'no row is written for it')
  t.exception(() => channel.emitProgress(noShare, { bytes: 1, total: 2, speed: 0, eta: null }), /no share id/)
  t.exception(() => channel.emitUpdated('S', undefined), /no share id/)
})

test('the fetch diagnostics name the kind', (t) => {
  const channel = build()
  t.is(channel.diagLabelFor(LOOSE_JOB), 'loose download')
  t.is(channel.diagLabelFor(FOLDER_JOB), 'overlay download')
})

test('the download wrapper builds its channel from the factory', (t) => {
  const src = readSrc('shared/transfer/overlay/share-downloads.js')
  t.absent(/^\s*emitProgress\s*:/m.test(src), 'it declares no emit* members of its own')
  t.absent(/^\s*emitPaused\s*:/m.test(src), 'nor a paused emitter')
  t.ok(/createOverlayChannel\(/.test(src), 'it builds its channel from the factory')
})

test('event:transfer-paused has exactly one emitter in src/', (t) => {
  const files = ['shared/transfer/overlay/share-downloads.js',
    'shared/transfer/overlay/overlay-channel.js', 'shared/transfer/overlay/overlay-download.js',
    'shared/transfer/overlay/download-start.js', 'shared/transfer/overlay/fetch-settle.js',
    'shared/transfer/overlay/reconcile-scan.js']
  const emitters = files.filter((f) => /emit\(\s*'event:transfer-paused'/.test(readSrc(f)))
  t.alike(emitters, ['shared/transfer/overlay/overlay-channel.js'],
    'the notification is raised in one place, so no channel can forget it')
})

test('the factory imports nothing that only loads under Bare', (t) => {
  const src = readSrc('shared/transfer/overlay/overlay-channel.js')
  t.absent(/from '(bare-|node:)/.test(src), 'it stays loadable under plain Node, which is why this file can test it')
})
