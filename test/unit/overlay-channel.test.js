import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { createOverlayChannel } from '../../src/shared/transfer/backends/overlay/overlay-channel.js'
import { ErrorCodes } from '../../src/shared/core/errors.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const readSrc = (rel) => readFileSync(path.join(here, '..', '..', 'src', rel), 'utf8')

const JOB = {
  transferId: 'S|sh|a.bin', spaceId: 'S', path: '/Vault/a.bin', relPath: 'a.bin',
  shareId: 'sh', size: 100, prevBytes: 10,
}

function build (kind, emit) {
  const loose = kind === 'loose'
  return createOverlayChannel({
    diagLabel: loose ? 'loose download' : 'overlay download',
    inPlace: loose,
    surfaceAllErrors: loose,
    updatedEvent: loose ? 'event:files-updated' : 'event:share-files-updated',
    emit,
    decoKeyFor: (job) => (loose ? job.path : job.shareId + ':' + job.relPath),
    decoKeyForRow: (row, pendingKey) => (loose ? pendingKey : (row?.shareId ? row.shareId + ':' + row.relPath : null)),
    ownsPendingRow: () => true,
    pendingExtra: () => ({}),
    transferIdForRow: () => 'id',
    resolvePendingRow: async () => ({ removed: false, seq: undefined, job: null }),
  })
}

function recorder () {
  const out = []
  return { out, emit: (name, payload) => out.push([name, payload]), names: () => out.map(([n]) => n) }
}

test('a paused folder transfer emits event:transfer-paused', (t) => {
  const r = recorder()
  build('folder', r.emit).emitPaused(JOB, 'offline')
  t.ok(r.names().includes('event:transfer-paused'), 'the notification signal crosses the wire')
  const [, payload] = r.out.find(([n]) => n === 'event:transfer-paused')
  t.is(payload.reason, 'offline', 'carrying the reason the dispatcher words the body from')
  t.is(payload.transferId, JOB.transferId, 'and the id the notification dedupes on')
})

test('REGRESSION (FIX-PI1-1: a retrying pause is decoration-only, on both kinds)', (t) => {
  for (const kind of ['loose', 'folder']) {
    const r = recorder()
    build(kind, r.emit).emitPaused(JOB, 'interrupted', { retrying: true })
    t.absent(r.names().includes('event:transfer-paused'), `${kind}: no notification per retry attempt`)
    t.ok(r.out.some(([n, p]) => n === 'event:decoration' && p.done), `${kind}: the bar still terminates`)
  }
})

test('a pause with no retry armed notifies on both kinds', (t) => {
  for (const kind of ['loose', 'folder']) {
    const r = recorder()
    build(kind, r.emit).emitPaused(JOB, 'offline')
    t.ok(r.names().includes('event:transfer-paused'), `${kind}: notifies`)
  }
})

test('the error wire filter is the only behavioural difference between the kinds', (t) => {
  const surfaced = (kind, code) => {
    const r = recorder()
    build(kind, r.emit).emitError(JOB, code)
    return r.names().includes('event:transfer-error')
  }
  for (const code of [ErrorCodes.TRANSFER_DISK_FULL, ErrorCodes.TRANSFER_CHECKSUM, ErrorCodes.TRANSFER_DEST_UNAVAILABLE]) {
    t.ok(surfaced('folder', code), `folder surfaces ${code}`)
    t.ok(surfaced('loose', code), `loose surfaces ${code}`)
  }
  t.absent(surfaced('folder', ErrorCodes.DOWNLOAD_FAILED), 'a folder row keeps a generic failure inline')
  t.ok(surfaced('loose', ErrorCodes.DOWNLOAD_FAILED), 'a loose row has no list to keep it in')

  const events = (kind, drive) => {
    const r = recorder()
    drive(build(kind, r.emit))
    return r.names()
  }
  const cases = {
    progress: (c) => c.emitProgress(JOB, { bytes: 1, total: 2, speed: 3, eta: 4 }),
    verifying: (c) => c.emitVerifying(JOB, 0.5),
    complete: (c) => c.emitComplete(JOB, '/tmp/a.bin'),
    paused: (c) => c.emitPaused(JOB, 'offline'),
    superseded: (c) => c.emitSuperseded(JOB),
    decorationDone: (c) => c.emitDecorationDone(JOB),
    removedByOwner: (c) => c.emitRemovedByOwner('S', '/Vault/a.bin', { relPath: 'a.bin' }, 'id'),
  }
  for (const [name, drive] of Object.entries(cases)) {
    t.alike(events('loose', drive), events('folder', drive), `${name} emits the same events on both kinds`)
  }
})

test('every emit carries spaceId, and a decoration without a key is not emitted', (t) => {
  const r = recorder()
  const folder = build('folder', r.emit)
  folder.emitProgress(JOB, { bytes: 1, total: 2, speed: 0, eta: null })
  t.is(r.out[0][1].spaceId, 'S', 'a bare drive path is unique per space only')
  t.is(r.out[0][1].key, 'sh:a.bin', 'keyed on the share axis')

  r.out.length = 0
  folder.emitCancelled('S', 'id', '/Vault/a.bin', null)
  t.is(r.out.length, 0, 'a cancel whose row cannot name a key emits nothing')

  r.out.length = 0
  build('loose', r.emit).emitCancelled('S', 'id', '/a.bin', null)
  t.is(r.out.length, 1, 'the loose key comes from the pending key, which is always there')
})

test('the superseded and removed events name the file, not the path', (t) => {
  const r = recorder()
  const channel = build('folder', r.emit)
  channel.emitSuperseded({ ...JOB, relPath: 'nested/deep/a.bin' })
  t.is(r.out.find(([n]) => n === 'event:transfer-superseded')[1].fileName, 'a.bin', 'a nested key still names the leaf')

  r.out.length = 0
  channel.emitRemovedByOwner('S', '/Vault/nested/a.bin', null, 'id')
  t.is(r.out[0][1].fileName, 'a.bin', 'and so does a pending key with no row behind it')
})

test('neither module hand-writes a channel bag any more', (t) => {
  for (const file of ['shared/transfer/loose-overlay.js', 'shared/transfer/backends/overlay/overlay-backend.js']) {
    const src = readSrc(file)
    t.absent(/^\s*emitProgress\s*:/m.test(src), `${file} declares no emit* members of its own`)
    t.absent(/^\s*emitPaused\s*:/m.test(src), `${file} declares no paused emitter of its own`)
    t.ok(/createOverlayChannel\(/.test(src), `${file} builds its channel from the factory`)
  }
})

test('event:transfer-paused has exactly one emitter in src/', (t) => {
  const files = ['shared/transfer/loose-overlay.js', 'shared/transfer/backends/overlay/overlay-backend.js',
    'shared/transfer/backends/overlay/overlay-channel.js', 'shared/transfer/backends/overlay/overlay-download.js']
  const emitters = files.filter((f) => /emit\(\s*'event:transfer-paused'/.test(readSrc(f)))
  t.alike(emitters, ['shared/transfer/backends/overlay/overlay-channel.js'],
    'the notification is raised in one place, so no channel can forget it')
})

test('the factory imports nothing that only loads under Bare', (t) => {
  const src = readSrc('shared/transfer/backends/overlay/overlay-channel.js')
  t.absent(/from '(bare-|node:)/.test(src), 'it stays loadable under plain Node, which is why this file can test it')
})
