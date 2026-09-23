import test from 'brittle'
import { preflightFault, terminalFault, faultCleared, faultAwaitsOwner } from '../../src/shared/transfer/backends/overlay/download-faults.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { FREE_SPACE_HEADROOM } from '../../src/shared/transfer/free-space.js'

const GB = 1024 ** 3
const dest = (over = {}) => ({ dirExists: () => true, dirWritable: () => false, dirAcceptsWrite: () => true, freeBytes: () => 10 * GB, allocatedBytes: () => 0, ...over })
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

// The preflight is what refuses a download the destination cannot take, so a row it wrote carries
// the flag; a row a failed write produced does not.
const refused = (code, size) => ({ code, size, refusedByPreflight: true })

test('a permission fault clears once its folder takes a write, whichever check refused it', (t) => {
  t.is(faultCleared(refused(CODES.TRANSFER_PERMISSION, 0), dest()), true)
  t.is(faultCleared({ code: CODES.TRANSFER_PERMISSION, size: 0 }, dest()), true,
    'the folder accepting a write is stronger than the errno that recorded it, on either route')
  t.is(faultCleared(refused(CODES.TRANSFER_PERMISSION, 0), dest({ dirAcceptsWrite: () => false })), false)
  t.is(faultCleared(refused(CODES.TRANSFER_PERMISSION, 0), dest({ dirAcceptsWrite: () => false, freeBytes: () => 10 * GB })), false,
    'a volume with room says nothing about a folder that refuses writes')
})

test('REGRESSION (FIX-473: a freed disk and a restored folder never clear their fault)', (t) => {
  t.is(faultCleared(refused(CODES.TRANSFER_DISK_FULL, GB), dest({ freeBytes: () => GB / 2 })), false,
    'a volume that still cannot hold the rest stays blocked')
  t.is(faultCleared(refused(CODES.TRANSFER_DISK_FULL, GB), dest({ freeBytes: () => GB + FREE_SPACE_HEADROOM })), true,
    'space freed since the refusal clears it')
  t.is(faultCleared(refused(CODES.TRANSFER_DISK_FULL, GB), dest({ freeBytes: () => GB / 2 + FREE_SPACE_HEADROOM, allocatedBytes: () => GB / 2 })), true,
    'the partial\'s bytes count toward the requirement, as they do in the preflight')
  t.is(faultCleared(refused(CODES.TRANSFER_DEST_UNAVAILABLE, 1), dest({ dirExists: () => false })), false)
  t.is(faultCleared(refused(CODES.TRANSFER_DEST_UNAVAILABLE, 1), dest()), true, 'the folder is back')
  t.is(faultCleared({ code: CODES.TRANSFER_DEST_UNAVAILABLE, size: 1 }, dest()), true,
    'a folder present again is stronger than the folder being gone, on either route')
  t.is(faultCleared(refused(CODES.TRANSFER_DEST_UNAVAILABLE, GB), dest({ freeBytes: () => 0 })), false,
    'a folder that came back on a full volume is not cleared — the next start would refuse it')
  t.is(faultCleared(refused(CODES.TRANSFER_CHECKSUM, 1), dest()), false, 'the owner clears a checksum fault, not the user')
  t.is(faultCleared(refused(CODES.DOWNLOAD_FAILED, 1), dest()), false, 'a non-terminal failure is re-driven without a clear')
})

test('REGRESSION (FIX-ENOSPC-3: a disk-full write was cleared by the preflight it had already passed)', (t) => {
  const roomy = dest({ freeBytes: () => 10 * GB })
  t.is(faultCleared({ code: CODES.TRANSFER_DISK_FULL, size: GB }, roomy), false,
    'a write that hit ENOSPC outranks a free-space reading that says there is room')
  t.is(faultCleared({ code: CODES.TRANSFER_DISK_FULL, size: GB }, dest({ freeBytes: () => Infinity })), false,
    'and an unmeasurable volume, which the preflight fails open on, clears nothing')
  t.is(faultCleared(refused(CODES.TRANSFER_DISK_FULL, GB), roomy), true, 'the preflight-refused row still clears')
  t.is(faultCleared({ code: CODES.TRANSFER_DISK_FULL, size: null, refusedByPreflight: true }, roomy), false,
    'a row carrying no byte count cannot be judged against the volume')
  t.is(faultCleared({ code: CODES.TRANSFER_DEST_UNAVAILABLE, size: null }, roomy), true,
    'but a missing folder is about the folder, so it clears without one')
})

test('a row awaits its owner unless only the user can unblock it', (t) => {
  const blocked = dest({ dirExists: () => false, dirAcceptsWrite: () => false, freeBytes: () => 0 })
  t.is(faultAwaitsOwner(refused(undefined, 0), blocked), true)
  t.is(faultAwaitsOwner(refused(CODES.DOWNLOAD_FAILED, 0), blocked), true, 'a generic failure is re-driven on reconnect')
  t.is(faultAwaitsOwner(refused(CODES.TRANSFER_CHECKSUM, 0), blocked), true, 'the owner clears a checksum fault by republishing')
  t.is(faultAwaitsOwner(refused(CODES.TRANSFER_DISK_FULL, GB), blocked), false)
  t.is(faultAwaitsOwner(refused(CODES.TRANSFER_DEST_UNAVAILABLE, GB), blocked), false)
  t.is(faultAwaitsOwner(refused(CODES.TRANSFER_PERMISSION, GB), blocked), false)
  t.is(faultAwaitsOwner(refused(CODES.TRANSFER_PERMISSION, GB), dest()), true)
  t.is(faultAwaitsOwner(refused(CODES.TRANSFER_DISK_FULL, GB), dest()), true, 'a volume with room no longer waits on anyone')
  t.is(faultAwaitsOwner({ code: CODES.TRANSFER_DISK_FULL, size: GB }, dest()), false,
    'a write-refused row waits on the user, whatever the volume reports')
})
