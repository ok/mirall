import test from 'brittle'
import { ErrorCodes, classifyTransferError, isRetryableTransferError, isLocalDestFault } from '../../src/shared/core/errors.js'

test('classifyTransferError maps fs codes', (t) => {
  t.is(classifyTransferError({ code: 'ENOSPC' }), ErrorCodes.TRANSFER_DISK_FULL)
  t.is(classifyTransferError({ code: 'EACCES' }), ErrorCodes.TRANSFER_PERMISSION)
  t.is(classifyTransferError({ code: 'EPERM' }), ErrorCodes.TRANSFER_PERMISSION)
})

test('classifyTransferError maps message substrings (case-insensitive)', (t) => {
  t.is(classifyTransferError({ message: 'Bad CHECKSUM detected' }), ErrorCodes.TRANSFER_CHECKSUM)
  t.is(classifyTransferError({ message: 'Invalid signature' }), ErrorCodes.TRANSFER_CHECKSUM)
  t.is(classifyTransferError({ message: 'block not available' }), ErrorCodes.TRANSFER_REMOVED)
  t.is(classifyTransferError({ message: 'Entry not found' }), ErrorCodes.TRANSFER_REMOVED)
  t.is(classifyTransferError({ message: 'file not found' }), ErrorCodes.TRANSFER_REMOVED)
})

test('classifyTransferError falls back to NETWORK', (t) => {
  t.is(classifyTransferError({ message: 'connection reset' }), ErrorCodes.TRANSFER_NETWORK)
  t.is(classifyTransferError({}), ErrorCodes.TRANSFER_NETWORK)
})

test('classifyTransferError tolerates null/undefined and missing message', (t) => {
  t.is(classifyTransferError(null), ErrorCodes.TRANSFER_NETWORK)
  t.is(classifyTransferError(undefined), ErrorCodes.TRANSFER_NETWORK)
  t.is(classifyTransferError({ code: undefined }), ErrorCodes.TRANSFER_NETWORK)
})

test('code takes precedence over message', (t) => {
  // ENOSPC code wins even if the message looks like a checksum error
  t.is(classifyTransferError({ code: 'ENOSPC', message: 'checksum' }), ErrorCodes.TRANSFER_DISK_FULL)
})

test('isRetryableTransferError only for NETWORK', (t) => {
  t.ok(isRetryableTransferError(ErrorCodes.TRANSFER_NETWORK))
  t.absent(isRetryableTransferError(ErrorCodes.TRANSFER_DISK_FULL))
  t.absent(isRetryableTransferError(ErrorCodes.TRANSFER_PERMISSION))
  t.absent(isRetryableTransferError(ErrorCodes.TRANSFER_CHECKSUM))
  t.absent(isRetryableTransferError(ErrorCodes.TRANSFER_REMOVED))
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
  t.is(classifyTransferError({ code: 'ENOENT' }), ErrorCodes.TRANSFER_NETWORK, 'still network without a probe')
  t.is(classifyTransferError({ code: 'EACCES' }), ErrorCodes.TRANSFER_PERMISSION, 'permission still wins on its own')
  t.is(classifyTransferError({ code: 'ENOSPC' }), ErrorCodes.TRANSFER_DISK_FULL, 'disk-full untouched')
})
