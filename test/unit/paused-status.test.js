import test from 'brittle'
import { pausedStatusFor, pauseReasonFor, unhashedStatusFor, consumerRowStatusFor } from '../../src/shared/transfer/transfer-status.js'

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

// REGRESSION (FIX-PREP4: the republish park KEEPS the pending row — zeroed — through the owner's
// re-hash, precisely so the wait derives 'preparing' and the materialized-hash append restarts it.
// The folder path read the pending row FIRST, so that wait surfaced as an amber "Paused" row
// nobody paused, offering Resume against a content hash that no longer exists. The loose path,
// which tests the null hash first, always read it correctly — this pins the order for both.)
test('REGRESSION (FIX-PREP4): a null hash outranks the parked pending row → preparing, not paused', (t) => {
  const parked = { bytesTransferred: 0, finalPath: '/dl/a.txt' }
  t.alike(
    consumerRowStatusFor({ hashed: false, isActive: false, pendingRow: parked, ownerOnline: true }),
    { status: 'preparing' },
    "the owner is re-hashing — the row is waiting on them, not paused by us"
  )
  t.alike(
    consumerRowStatusFor({ hashed: false, isActive: false, pendingRow: parked, ownerOnline: false }),
    { status: 'unavailable' },
    'an offline owner can never complete the hash, so the placeholder degrades'
  )
})

test('consumerRowStatusFor: an in-flight fetch outranks everything and carries its bytes', (t) => {
  t.alike(
    consumerRowStatusFor({ hashed: true, isActive: true, pendingRow: { bytesTransferred: 512 }, ownerOnline: true }),
    { status: 'downloading', pendingBytes: 512 }
  )
})

test('consumerRowStatusFor: a hashed entry falls through error → paused → remote', (t) => {
  t.alike(
    consumerRowStatusFor({ hashed: true, isActive: false, pendingRow: { errorCode: 'EHASHMISMATCH' }, ownerOnline: true }),
    { status: 'error', errorCode: 'EHASHMISMATCH' }
  )
  t.alike(
    consumerRowStatusFor({ hashed: true, isActive: false, pendingRow: { bytesTransferred: 900 }, ownerOnline: true }),
    { status: 'paused-interrupted', pendingBytes: 900 }
  )
  t.alike(consumerRowStatusFor({ hashed: true, isActive: false, pendingRow: null, ownerOnline: true }), { status: 'remote' })
  t.alike(consumerRowStatusFor({ hashed: true, isActive: false, pendingRow: null, ownerOnline: false }), { status: 'unavailable' })
})

// A parked row is ZEROED, so "has partial bytes" is what separates the owner's re-hash from a
// genuinely interrupted download. Offline, the null-hash wait cannot resolve, and answering
// 'unavailable' would stand a row with bytes on disk down to no affordance at all — no Discard,
// no bytes shown — until the owner comes back.
test('consumerRowStatusFor: an offline owner cannot mask a partial — it keeps paused-offline and its bytes', (t) => {
  t.alike(
    consumerRowStatusFor({ hashed: false, isActive: false, pendingRow: { bytesTransferred: 4096 }, ownerOnline: false }),
    { status: 'paused-offline', pendingBytes: 4096 }
  )
  t.alike(
    consumerRowStatusFor({ hashed: false, isActive: false, pendingRow: { bytesTransferred: 0 }, ownerOnline: false }),
    { status: 'unavailable' },
    'a parked (zeroed) row has nothing to discard, so the frozen placeholder still wins'
  )
})

test('consumerRowStatusFor: a reachable owner mid-re-hash outranks a partial (the restart discards it)', (t) => {
  t.alike(
    consumerRowStatusFor({ hashed: false, isActive: false, pendingRow: { bytesTransferred: 4096 }, ownerOnline: true }),
    { status: 'preparing' }
  )
})
