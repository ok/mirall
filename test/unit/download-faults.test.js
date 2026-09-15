import test from 'brittle'
import { preflightFault, terminalFault } from '../../src/shared/transfer/backends/overlay/download-faults.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { FREE_SPACE_HEADROOM } from '../../src/shared/transfer/free-space.js'

const GB = 1024 ** 3
const dest = (over = {}) => ({ dirExists: () => true, freeBytes: () => 10 * GB, allocatedBytes: () => 0, ...over })
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
