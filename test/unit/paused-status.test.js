import test from 'brittle'
import { pausedStatusFor, pauseReasonFor, unhashedStatusFor } from '../../src/shared/transfer/transfer-status.js'

// REGRESSION (FIX-1): a mid-index (null-hash) file must degrade preparing→unavailable when the
// owner goes offline, so a peer that quit mid-add doesn't leave the file stuck on "Preparing…".
test('unhashedStatusFor: preparing only while owner reachable', (t) => {
  t.is(unhashedStatusFor(true), 'preparing', 'owner online → still preparing')
  t.is(unhashedStatusFor(false), 'unavailable', 'owner offline → unavailable, never stuck preparing')
})

// REGRESSION (FIX-EDA-20: the paused toast blamed "sender offline" for every pause; the reason
// must follow owner presence). The removal case that used to exercise this is now terminal
// (FIX-REMOVE-1) — the predicate is pinned here directly.
test('pauseReasonFor: owner online → interrupted, offline → offline', (t) => {
  t.is(pauseReasonFor(true), 'interrupted')
  t.is(pauseReasonFor(false), 'offline')
})

test('pausedStatusFor: no pending row → null (file is not paused)', (t) => {
  t.is(pausedStatusFor({ pendingRow: null, isActive: false, ownerOnline: true }), null)
  t.is(pausedStatusFor({ pendingRow: undefined, isActive: false, ownerOnline: false }), null)
})

test('pausedStatusFor: pending row but active transfer → null (still downloading)', (t) => {
  const row = { bytesTransferred: 1234, finalPath: '/dl/a.txt' }
  t.is(pausedStatusFor({ pendingRow: row, isActive: true, ownerOnline: true }), null,
    'an in-flight transfer must not surface as paused — the row is just the durable side of it')
})

test('pausedStatusFor: pending row, no active transfer, owner online → paused-interrupted', (t) => {
  const row = { bytesTransferred: 2048, finalPath: '/dl/a.txt' }
  t.alike(
    pausedStatusFor({ pendingRow: row, isActive: false, ownerOnline: true }),
    { status: 'paused-interrupted', pendingBytes: 2048 }
  )
})

test('pausedStatusFor: pending row, no active transfer, owner offline → paused-offline', (t) => {
  const row = { bytesTransferred: 4096, finalPath: '/dl/a.txt' }
  t.alike(
    pausedStatusFor({ pendingRow: row, isActive: false, ownerOnline: false }),
    { status: 'paused-offline', pendingBytes: 4096 }
  )
})

test('pausedStatusFor: missing bytesTransferred clamps to 0 (fresh pending row, no progress yet)', (t) => {
  t.alike(
    pausedStatusFor({ pendingRow: { finalPath: '/x' }, isActive: false, ownerOnline: true }),
    { status: 'paused-interrupted', pendingBytes: 0 }
  )
})
