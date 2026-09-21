import test from 'brittle'
import { preflightFault, terminalFault, faultCleared, awaitsOwner } from '../../src/shared/transfer/backends/overlay/download-faults.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { FREE_SPACE_HEADROOM } from '../../src/shared/transfer/free-space.js'

const GB = 1024 ** 3
const dest = (over = {}) => ({ dirExists: () => true, dirWritable: () => false, freeBytes: () => 10 * GB, allocatedBytes: () => 0, ...over })
const errno = (code) => Object.assign(new Error(code), { code })

test('preflight refuses a gone folder before it asks about space', (t) => {
  let asked = false
  const d = dest({ dirExists: () => false, freeBytes: () => { asked = true; return 0 } })
  t.is(preflightFault(1, d), CODES.TRANSFER_DEST_UNAVAILABLE)
  t.is(asked, false, 'freeBytes fails open on a statfs error, so a gone root must not reach it')
})

test('preflight refuses a file the volume cannot hold, with the headroom', (t) => {
  t.is(preflightFault(GB, dest({ freeBytes: () => GB + FREE_SPACE_HEADROOM })), null, 'exactly enough passes')
  t.is(preflightFault(GB, dest({ freeBytes: () => GB + FREE_SPACE_HEADROOM - 1 })), CODES.TRANSFER_DISK_FULL)
})

test('preflight credits what a resumed partial already allocated', (t) => {
  const tight = dest({ freeBytes: () => GB / 2 + FREE_SPACE_HEADROOM })
  t.is(preflightFault(GB, tight), CODES.TRANSFER_DISK_FULL)
  t.is(preflightFault(GB, dest({ ...tight, allocatedBytes: () => GB / 2 })), null)
})

test('preflight fails open on an unmeasurable volume', (t) => {
  t.is(preflightFault(GB, dest({ freeBytes: () => NaN })), null)
})

test('a hash mismatch is a checksum fault regardless of the folder', (t) => {
  t.is(terminalFault({ code: 'EHASHMISMATCH' }, dest({ dirExists: () => false })), CODES.TRANSFER_CHECKSUM)
})

test('a local-destination errno is the folder only when the folder is actually gone', (t) => {
  const eacces = { code: 'EACCES', cause: errno('EACCES') }
  t.is(terminalFault(eacces, dest({ dirExists: () => false })), CODES.TRANSFER_DEST_UNAVAILABLE, 'an ejected /Volumes root fails EACCES')
  t.is(terminalFault(eacces, dest()), CODES.TRANSFER_PERMISSION, 'with the folder present the errno stands')
  t.is(terminalFault({ code: 'ENOENT', cause: errno('ENOENT') }, dest({ dirExists: () => false })), CODES.TRANSFER_DEST_UNAVAILABLE)
})

test('a full disk classifies specifically and a network fault stays the generic failure', (t) => {
  t.is(terminalFault({ code: 'ENOSPC', cause: errno('ENOSPC') }, dest()), CODES.TRANSFER_DISK_FULL)
  t.is(terminalFault({ code: 'fetch-failed', cause: new Error('socket closed') }, dest()), CODES.DOWNLOAD_FAILED)
  t.is(terminalFault({ code: 'x', cause: new Error('block not available') }, dest()), CODES.TRANSFER_REMOVED)
})

test('REGRESSION (FIX-379: a read-only volume with the folder present is a permission fault)', (t) => {
  const erofs = { code: 'EROFS', cause: errno('EROFS') }
  t.is(terminalFault(erofs, dest()), CODES.TRANSFER_PERMISSION, 'not the generic DOWNLOAD_FAILED')
  t.is(terminalFault(erofs, dest({ dirExists: () => false })), CODES.TRANSFER_DEST_UNAVAILABLE, 'a gone folder still wins')
})

test('a permission errno from a folder that still takes a write is the retryable failure', (t) => {
  const eperm = { code: 'EPERM', cause: errno('EPERM') }
  t.is(terminalFault(eperm, dest({ dirWritable: () => true })), CODES.DOWNLOAD_FAILED,
    'a file another program held for a moment, not a read-only folder')
  t.is(terminalFault(eperm, dest()), CODES.TRANSFER_PERMISSION, 'a folder that refuses the probe is the permission fault')
})

test('a permission fault clears once its folder takes a write', (t) => {
  const writable = () => true
  const readOnly = () => false
  t.is(faultCleared(CODES.TRANSFER_PERMISSION, '/dl/a.bin', writable), true)
  t.is(faultCleared(CODES.TRANSFER_PERMISSION, '/dl/a.bin', readOnly), false)
  t.is(faultCleared(CODES.TRANSFER_PERMISSION, undefined, writable), false, 'a row without a destination has no folder to probe')
  t.is(faultCleared(CODES.TRANSFER_DISK_FULL, '/dl/a.bin', writable), false, 'a writable folder says nothing about a full disk')
})

test('a row awaits its owner unless only the user can unblock it', (t) => {
  const row = (errorCode) => ({ finalPath: '/dl/a.bin', errorCode })
  const readOnly = () => false
  t.is(awaitsOwner(row(undefined), readOnly), true)
  t.is(awaitsOwner(row(CODES.DOWNLOAD_FAILED), readOnly), true, 'a generic failure is re-driven on reconnect')
  t.is(awaitsOwner(row(CODES.TRANSFER_CHECKSUM), readOnly), false)
  t.is(awaitsOwner(row(CODES.TRANSFER_PERMISSION), readOnly), false)
  t.is(awaitsOwner(row(CODES.TRANSFER_PERMISSION), () => true), true)
})
