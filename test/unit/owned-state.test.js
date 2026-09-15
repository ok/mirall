import test from 'brittle'
import { createOwnedState } from '../../src/shared/folders/owned-state.js'
import { worsePassFault } from '../../src/shared/folders/owned-policy.js'
import { CODES } from '../../src/shared/contract/errors.js'

const diskFull = { code: 'ENOSPC' }
const permission = { code: 'EACCES' }

test('the ids behind a supervisor key are remembered, never parsed back out', (t) => {
  const state = createOwnedState()
  state.remember('sp1', 'sh1')
  t.alike(state.unit('sp1:sh1'), { spaceId: 'sp1', shareId: 'sh1' })
  t.is(state.unit('sp1:unknown'), null, 'a key nobody recorded resolves to nothing')
})

test('forgetting a unit also drops it from the abandoned set', (t) => {
  const state = createOwnedState()
  state.remember('sp1', 'sh1')
  state.abandon('sp1:sh1')
  t.alike(state.abandonedKeys(), ['sp1:sh1'])
  state.forget('sp1:sh1')
  t.is(state.unit('sp1:sh1'), null)
  t.alike(state.abandonedKeys(), [], 'an unmounted share is not an unhealthy one')
})

test('a share cache entry is scoped to its pair and dropped by space', (t) => {
  const state = createOwnedState()
  state.cacheShare('sp1', 'sh1', { id: 'sh1' })
  state.cacheShare('sp1', 'sh2', { id: 'sh2' })
  state.cacheShare('sp2', 'sh3', { id: 'sh3' })
  t.alike(state.cachedShare('sp1', 'sh2'), { id: 'sh2' })
  t.is(state.cachedShare('sp1', 'nope'), null)

  state.forgetShares('sp1')
  t.is(state.cachedShare('sp1', 'sh1'), null)
  t.is(state.cachedShare('sp1', 'sh2'), null)
  t.alike(state.cachedShare('sp2', 'sh3'), { id: 'sh3' }, 'another space keeps its entries')
})

test('a fault is held until a pass takes it, then gone', (t) => {
  const state = createOwnedState()
  t.is(state.takeFault('sp1', 'sh1'), null, 'nothing recorded, nothing to report')

  state.recordFault('sp1', 'sh1', permission)
  t.is(state.takeFault('sp1', 'sh1'), CODES.TRANSFER_PERMISSION)
  t.is(state.takeFault('sp1', 'sh1'), null, 'draining it consumes it')
})

test('a full disk outranks a permission fault whichever lands first', (t) => {
  const state = createOwnedState()
  state.recordFault('sp1', 'sh1', permission)
  state.recordFault('sp1', 'sh1', diskFull)
  t.is(state.takeFault('sp1', 'sh1'), CODES.TRANSFER_DISK_FULL, 'it stops the device, not one subtree')

  state.recordFault('sp1', 'sh1', diskFull)
  state.recordFault('sp1', 'sh1', permission)
  t.is(state.takeFault('sp1', 'sh1'), CODES.TRANSFER_DISK_FULL)
})

test('an unclassifiable failure never displaces what the pass already holds', (t) => {
  const state = createOwnedState()
  state.recordFault('sp1', 'sh1', permission)
  state.recordFault('sp1', 'sh1', new Error('no errno'))
  state.recordFault('sp1', 'sh1', undefined)
  t.is(state.takeFault('sp1', 'sh1'), CODES.TRANSFER_PERMISSION)

  state.recordFault('sp2', 'sh2', new Error('no errno'))
  t.is(state.takeFault('sp2', 'sh2'), null, 'and never records one of its own')
})

test('faults are scoped per share', (t) => {
  const state = createOwnedState()
  state.recordFault('sp1', 'sh1', diskFull)
  t.is(state.takeFault('sp1', 'sh2'), null)
  t.is(state.takeFault('sp2', 'sh1'), null)
  t.is(state.takeFault('sp1', 'sh1'), CODES.TRANSFER_DISK_FULL)
})

test('the ranking itself is decidable without a ledger', (t) => {
  t.is(worsePassFault(null, CODES.TRANSFER_PERMISSION), CODES.TRANSFER_PERMISSION)
  t.is(worsePassFault(CODES.TRANSFER_PERMISSION, null), CODES.TRANSFER_PERMISSION)
  t.is(worsePassFault(CODES.TRANSFER_DISK_FULL, CODES.TRANSFER_PERMISSION), CODES.TRANSFER_DISK_FULL)
  t.is(worsePassFault(CODES.TRANSFER_PERMISSION, CODES.TRANSFER_DISK_FULL), CODES.TRANSFER_DISK_FULL)
  t.is(worsePassFault(null, null), null)
})

test('reset empties every ledger at once', (t) => {
  const state = createOwnedState()
  state.remember('sp1', 'sh1')
  state.abandon('sp1:sh1')
  state.cacheShare('sp1', 'sh1', { id: 'sh1' })
  state.recordFault('sp1', 'sh1', diskFull)

  state.reset()
  t.is(state.unit('sp1:sh1'), null)
  t.alike(state.abandonedKeys(), [])
  t.is(state.cachedShare('sp1', 'sh1'), null)
  t.is(state.takeFault('sp1', 'sh1'), null)
})
