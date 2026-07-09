import test from 'brittle'
import { ErrorCodes, classifyTransferError, isRetryableTransferError } from '../../src/shared/core/errors.js'

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
