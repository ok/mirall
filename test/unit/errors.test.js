import test from 'brittle'
import { classifyTransferError, isRetryableTransferError, isLocalDestFault, classifyLocalIoFault } from '../../src/shared/core/errors.js'
import { CODES } from '../../src/shared/contract/errors.js'

test('classifyTransferError maps fs codes', (t) => {
  t.is(classifyTransferError({ code: 'ENOSPC' }), CODES.TRANSFER_DISK_FULL)
  t.is(classifyTransferError({ code: 'EACCES' }), CODES.TRANSFER_PERMISSION)
  t.is(classifyTransferError({ code: 'EPERM' }), CODES.TRANSFER_PERMISSION)
})

test('classifyTransferError maps message substrings (case-insensitive)', (t) => {
  t.is(classifyTransferError({ message: 'Bad CHECKSUM detected' }), CODES.TRANSFER_CHECKSUM)
  t.is(classifyTransferError({ message: 'Invalid signature' }), CODES.TRANSFER_CHECKSUM)
  t.is(classifyTransferError({ message: 'block not available' }), CODES.TRANSFER_REMOVED)
  t.is(classifyTransferError({ message: 'Entry not found' }), CODES.TRANSFER_REMOVED)
  t.is(classifyTransferError({ message: 'file not found' }), CODES.TRANSFER_REMOVED)
})

test('classifyTransferError falls back to NETWORK', (t) => {
  t.is(classifyTransferError({ message: 'connection reset' }), CODES.TRANSFER_NETWORK)
  t.is(classifyTransferError({}), CODES.TRANSFER_NETWORK)
})

test('classifyTransferError tolerates null/undefined and missing message', (t) => {
  t.is(classifyTransferError(null), CODES.TRANSFER_NETWORK)
  t.is(classifyTransferError(undefined), CODES.TRANSFER_NETWORK)
  t.is(classifyTransferError({ code: undefined }), CODES.TRANSFER_NETWORK)
})

test('code takes precedence over message', (t) => {
  // ENOSPC code wins even if the message looks like a checksum error
  t.is(classifyTransferError({ code: 'ENOSPC', message: 'checksum' }), CODES.TRANSFER_DISK_FULL)
})

test('isRetryableTransferError only for NETWORK', (t) => {
  t.ok(isRetryableTransferError(CODES.TRANSFER_NETWORK))
  t.absent(isRetryableTransferError(CODES.TRANSFER_DISK_FULL))
  t.absent(isRetryableTransferError(CODES.TRANSFER_PERMISSION))
  t.absent(isRetryableTransferError(CODES.TRANSFER_CHECKSUM))
  t.absent(isRetryableTransferError(CODES.TRANSFER_REMOVED))
  t.absent(isRetryableTransferError(undefined))
})

// REGRESSION (FIX-DLDIR-1: a download folder that had been deleted, ejected, or replaced by a
// file produced no specific error — every one of these errnos fell through classifyTransferError
// to TRANSFER_NETWORK, which the engine rewrote to DOWNLOAD_FAILED and the renderer rendered as
// the generic "Transfer failed"). The predicate below is what lets the caller notice the class is
// worth a folder probe at all.
test('REGRESSION (FIX-DLDIR-1: local destination faults are recognised as a class)', (t) => {
  for (const code of ['ENOENT', 'ENOTDIR', 'ENODEV', 'ENXIO', 'EIO', 'ESTALE', 'EACCES', 'EPERM', 'EROFS']) {
    t.ok(isLocalDestFault(code), code + ' is a candidate local-destination fault')
  }
})

test('isLocalDestFault ignores non-fs and absent codes', (t) => {
  // ENOSPC is a real disk-full condition on a folder that IS there — probing would only
  // mislabel it, and it has its own message.
  t.absent(isLocalDestFault('ENOSPC'), 'disk-full is not a destination fault')
  t.absent(isLocalDestFault('ECONNRESET'), 'a network errno is not a destination fault')
  t.absent(isLocalDestFault(undefined), 'no code at all')
  t.absent(isLocalDestFault(null), 'null code')
})

// The probe lives at the call site (overlay-download.js), so the classifier itself must be
// unchanged for every input it already handled — the new code is additive, not a re-bucketing.
test('classifyTransferError is unchanged by the destination-fault work', (t) => {
  t.is(classifyTransferError({ code: 'ENOENT' }), CODES.TRANSFER_NETWORK, 'still network without a probe')
  t.is(classifyTransferError({ code: 'EACCES' }), CODES.TRANSFER_PERMISSION, 'permission still wins on its own')
  t.is(classifyTransferError({ code: 'ENOSPC' }), CODES.TRANSFER_DISK_FULL, 'disk-full untouched')
})

// One classifier for both folder roles. It replaced a second copy on the mirror side and the
// owner's "collapse everything to one status with err.message in it"; the code it returns is what
// the renderer translates, which is the whole reason the reason is not a message any more.
test('classifyLocalIoFault folds the mount faults onto codes the renderer translates', (t) => {
  t.is(classifyLocalIoFault({ code: 'ENOSPC' }), CODES.TRANSFER_DISK_FULL)
  t.is(classifyLocalIoFault({ code: 'EACCES' }), CODES.TRANSFER_PERMISSION)
  t.is(classifyLocalIoFault({ code: 'EPERM' }), CODES.TRANSFER_PERMISSION)
  t.is(classifyLocalIoFault({ code: 'EROFS' }), CODES.TRANSFER_PERMISSION, 'a read-only volume is a permission fault')
})

test('classifyLocalIoFault returns null for anything it cannot name', (t) => {
  // ENOENT is deliberately unclassified: one file vanishing mid-pass is not a mount fault, and
  // only the caller can cheaply tell that from a root that went away.
  t.is(classifyLocalIoFault({ code: 'ENOENT' }), null)
  t.is(classifyLocalIoFault({ code: 'ECONNRESET' }), null)
  t.is(classifyLocalIoFault(new Error('no code at all')), null)
  t.is(classifyLocalIoFault(null), null)
  t.is(classifyLocalIoFault(undefined), null)
})
