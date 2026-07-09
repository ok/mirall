import test from 'brittle'
import { foldPendingSet } from '../../src/shared/spaces/pending-set.js'

const C = 'c'.repeat(64), D = 'd'.repeat(64)
const req = (entries) => new Map(entries)
const tomb = (entries) => new Map(entries)

test('a fresh receipt with no membership/approval/denial is PENDING', (t) => {
  const out = foldPendingSet({
    requests: req([[C, { displayName: 'Carol', avatar: 'data:c', ts: 5 }]]),
    denied: tomb([]), members: new Set(), approved: new Set(), lefts: new Set(),
  })
  t.is(out.size, 1)
  t.is(out.get(C).displayName, 'Carol')
  t.is(out.get(C).avatar, 'data:c')
})

test('a member is never pending', (t) => {
  const out = foldPendingSet({
    requests: req([[C, { displayName: 'Carol', ts: 5 }]]),
    denied: tomb([]), members: new Set([C]), approved: new Set(), lefts: new Set(),
  })
  t.is(out.size, 0)
})

test('REGRESSION (approval window): approved-but-not-yet-a-member drops out', (t) => {
  const out = foldPendingSet({
    requests: req([[C, { displayName: 'Carol', ts: 5 }]]),
    denied: tomb([]), members: new Set(), approved: new Set([C]), lefts: new Set(),
  })
  t.is(out.size, 0)
})

const left = (entries) => new Map(entries)

test('a known leaver is not pending (leave at/after the receipt)', (t) => {
  const out = foldPendingSet({
    requests: req([[C, { displayName: 'Carol', ts: 5 }]]),
    denied: tomb([]), members: new Set(), approved: new Set(), lefts: left([[C, 5]]),
  })
  t.is(out.size, 0)
})

// REGRESSION (FIX-240c): with the tombstone now durable, a re-request that is NEWER than our leave
// stamp must surface as pending — else a co-member that learns of the rejoin only via replication
// (no direct membership:request frame → no clearLeftTombstone) would hide the request forever and
// could never re-approve the peer.
test('REGRESSION (FIX-240c): a re-request newer than the leave re-surfaces despite the tombstone', (t) => {
  const out = foldPendingSet({
    requests: req([[C, { displayName: 'Carol', ts: 9 }]]),
    denied: tomb([]), members: new Set(), approved: new Set(), lefts: left([[C, 5]]),
  })
  t.is(out.size, 1)
  t.ok(out.has(C), 'a fresh re-request (ts 9 > leaveTs 5) is pending again')
})

test('a denial >= the receipt ts suppresses the request', (t) => {
  const out = foldPendingSet({
    requests: req([[C, { displayName: 'Carol', ts: 5 }]]),
    denied: tomb([[C, 5]]), members: new Set(), approved: new Set(), lefts: new Set(),
  })
  t.is(out.size, 0)
})

test('a fresh re-knock (receipt ts > denial ts) re-surfaces', (t) => {
  const out = foldPendingSet({
    requests: req([[C, { displayName: 'Carol', ts: 9 }]]),
    denied: tomb([[C, 5]]), members: new Set(), approved: new Set(), lefts: new Set(),
  })
  t.is(out.size, 1)
})

test('independent joiners are folded independently', (t) => {
  const out = foldPendingSet({
    requests: req([[C, { displayName: 'Carol', ts: 5 }], [D, { displayName: 'Dan', ts: 6 }]]),
    denied: tomb([[C, 9]]), members: new Set(), approved: new Set(), lefts: new Set(),
  })
  t.is(out.size, 1)
  t.ok(out.has(D))
  t.absent(out.has(C))
})

test('missing avatar/displayName degrade to null/Unknown', (t) => {
  const out = foldPendingSet({
    requests: req([[C, { ts: 5 }]]),
    denied: tomb([]), members: new Set(), approved: new Set(), lefts: new Set(),
  })
  t.is(out.get(C).displayName, 'Unknown')
  t.is(out.get(C).avatar, null)
})

// REGRESSION (FIX-2): on rejoin the approver has revoked its approval (approved no longer has C)
// and onJoinRequest cleared the leave-tombstone (lefts no longer has C), so the fresh receipt must
// surface as pending — the re-approval banner. If C were still approved/left, the banner would be
// silently suppressed and the peer auto-readmitted (the bug).
test('REGRESSION (FIX-2): a revoked + un-tombstoned re-requester is pending', (t) => {
  const out = foldPendingSet({
    requests: req([[C, { displayName: 'Carol', ts: 9 }]]),
    denied: tomb([]), members: new Set(['root']), approved: new Set(), lefts: new Set(),
  })
  t.is(out.size, 1)
  t.ok(out.has(C), 'C is pending again after revoke + clearLeft')
})
