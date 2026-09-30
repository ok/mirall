import test from 'brittle'
import { isTransientWriteCode, surfacesToCaller, isDestinationFault } from '../../src/shared/transfer/overlay/engine/local-faults.js'

test('transient write codes stay retryable', (t) => {
  for (const code of ['EBUSY', 'EAGAIN', 'EINTR', 'EMFILE', 'ENFILE']) t.ok(isTransientWriteCode(code), code)
  t.absent(isTransientWriteCode('ENOSPC'))
})

test('a coded, non-transient failure surfaces; an uncoded one does not', (t) => {
  for (const code of ['ENOTDIR', 'EIO', 'EHASHMISMATCH', 'ECANCELLED', 'ENOSPC']) t.ok(surfacesToCaller({ code }), code)
  for (const err of [new Error('stalled'), { code: '' }, { code: 'EMFILE' }, { code: 'ETARGETCHANGED' }, null, undefined, { code: 5 }]) t.absent(surfacesToCaller(err))
})

test('a destination fault is a surfaced code that is not a verdict on the bytes or the fetch', (t) => {
  for (const code of ['ENOTDIR', 'EIO', 'ENOSPC']) t.ok(isDestinationFault({ code }), code)
  for (const err of [{ code: 'EHASHMISMATCH' }, { code: 'ECANCELLED' }, { code: 'EBUSY' }, new Error('stalled')]) t.absent(isDestinationFault(err))
})
