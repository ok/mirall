import test from 'brittle'
import { deriveMemberSet, viewSignature } from '../../src/shared/spaces/member-view.js'

// Fake bee-reader: a Map of key -> { active, approvals } | (absent => null record).
const reader = (db) => async (k) => db.get(k) ?? null
const sorted = (set) => [...set].sort()

const C = 'creator'
const S = 'self'
const A = 'alice'
const B = 'bob'
const X = 'sybil-x'
const Y = 'sybil-y'

test('discovers members transitively, fetching only reachable bees', async (t) => {
  const db = new Map([
    [C, { active: true, approvals: [A] }],
    [A, { active: true, approvals: [B] }],
    [B, { active: true, approvals: [] }],
    [X, { active: true, approvals: [Y] }],   // a Sybil clique nobody approved
    [Y, { active: true, approvals: [] }],
  ])
  const { members, considered } = await deriveMemberSet({ creatorKey: C, selfKey: S, readRecord: reader(db) })

  t.alike(sorted(members), [A, B, C], 'creator + transitive approvees')
  t.absent(considered.has(X), 'never fetched the Sybil — not reachable from the creator')
  t.absent(considered.has(Y), 'never fetched the Sybil approvee')
  t.ok(considered.has(S), 'self is always probed (seed), even if not a member')
})

test('self is fetched but is not a member unless approved', async (t) => {
  const db = new Map([
    [C, { active: true, approvals: [] }],
    [S, { active: true, approvals: [] }],   // self claims active but nobody approved it
  ])
  const { members } = await deriveMemberSet({ creatorKey: C, selfKey: S, readRecord: reader(db) })
  t.alike(sorted(members), [C], 'an unapproved self is not a member')
})

test('a member approved only by an unreachable bee stays pending, then heals', async (t) => {
  // C approved A, A approved B — but A is not yet replicated (no record).
  const db = new Map([
    [C, { active: true, approvals: [A] }],
    [B, { active: true, approvals: [] }],
  ])
  let res = await deriveMemberSet({ creatorKey: C, selfKey: S, readRecord: reader(db) })
  t.alike(sorted(res.members), [C], 'A absent → A and B both pending')

  db.set(A, { active: true, approvals: [B] })            // A's bee arrives
  res = await deriveMemberSet({ creatorKey: C, selfKey: S, readRecord: reader(db) })
  t.alike(sorted(res.members), [A, B, C], 'converges once A replicates')
})

test('REGRESSION (FIX-361: departure orphaning): a left member drops, its approvees keep authorization', async (t) => {
  const db = new Map([
    [C, { active: true, approvals: [A] }],
    [A, { active: false, approvals: [B] }],   // A invited B, then left
    [B, { active: true, approvals: [] }],
  ])
  const { members, considered } = await deriveMemberSet({ creatorKey: C, selfKey: S, readRecord: reader(db) })
  t.alike(sorted(members), [B, C], 'A left ⇒ A out; B keeps the authorization A conferred')
  t.ok(considered.has(B), 'discovery reaches B through a departed voucher')
})

test('REGRESSION (FIX-361: creator-leave collapse): the whole tree survives the creator leaving', async (t) => {
  const db = new Map([
    [C, { active: false, approvals: [A] }],   // the creator left
    [A, { active: true, approvals: [B] }],
    [B, { active: true, approvals: [] }],
  ])
  const { members, considered, inactive } = await deriveMemberSet({ creatorKey: C, selfKey: B, readRecord: reader(db) })
  t.alike(sorted(members), [A, B], 'the roster survives its creator leaving')
  t.ok(considered.has(A) && considered.has(B), 'every roster bee is still walked and followed')
  t.alike(sorted(inactive), [C], 'the departed creator is reported as a genuine leaver')
})

test('a Sybil bee is still never fetched once the creator has left', async (t) => {
  const db = new Map([
    [C, { active: false, approvals: [A] }],
    [A, { active: true, approvals: [] }],
    [X, { active: true, approvals: [Y] }],
    [Y, { active: true, approvals: [] }],
  ])
  const { considered } = await deriveMemberSet({ creatorKey: C, selfKey: S, readRecord: reader(db) })
  t.absent(considered.has(X), 'an unreachable clique is never opened, even with a departed root')
  t.absent(considered.has(Y))
})

test('REGRESSION (FIX-362: post-departure vouch): discovery skips a bee reachable only through one', async (t) => {
  // A recorded its departure at seq 10; the vouch for B predates it, the vouch for Y does not.
  const db = new Map([
    [C, { active: true, approvals: [A] }],
    [A, {
      active: false,
      approvals: [B, Y],
      memberSeq: 10,
      approvalSeqs: new Map([[B, 4], [Y, 20]]),
    }],
    [B, { active: true, approvals: [] }],
    [Y, { active: true, approvals: [] }],
  ])
  const { members, considered } = await deriveMemberSet({ creatorKey: C, selfKey: S, readRecord: reader(db) })
  t.alike(sorted(members), [B, C], 'the pre-departure vouch stands, the post-departure one does not')
  t.absent(considered.has(Y), 'a bee reachable only through a post-departure vouch is never opened')
})

test('lone creator with no roster', async (t) => {
  const db = new Map([[C, { active: true, approvals: [] }]])
  const { members } = await deriveMemberSet({ creatorKey: C, selfKey: C, readRecord: reader(db) })
  t.alike(sorted(members), [C])
})

test('an unknown creator (bee not yet replicated) yields an empty set', async (t) => {
  const { members } = await deriveMemberSet({ creatorKey: C, selfKey: S, readRecord: reader(new Map()) })
  t.alike(sorted(members), [], 'nothing derivable until the creator bee arrives')
})

// viewSignature gates the reconcile/IPC emit: an identical signature means an append did
// not change the membership-relevant view, so the downstream work can be skipped.
test('REGRESSION (MIR-29): viewSignature is order-independent over members/approved/requests/denied', (t) => {
  const v1 = {
    members: new Set([B, A]),
    approved: new Set([Y, X]),
    requests: new Map([['j2', { ts: 5 }], ['j1', { ts: 3 }]]),
    denied: new Map([['d2', 9], ['d1', 7]]),
  }
  const v2 = {
    members: new Set([A, B]),
    approved: new Set([X, Y]),
    requests: new Map([['j1', { ts: 3 }], ['j2', { ts: 5 }]]),
    denied: new Map([['d1', 7], ['d2', 9]]),
  }
  t.is(viewSignature(v1), viewSignature(v2), 'same content in any insertion order → same signature')
})

test('viewSignature changes on a membership or request-ts change (no missed update)', (t) => {
  const base = {
    members: new Set([A, B]), approved: new Set([X]),
    requests: new Map([['j1', { ts: 3 }]]), denied: new Map(),
  }
  const dropped = { ...base, members: new Set([A]) }
  t.not(viewSignature(dropped), viewSignature(base), 'a dropped member changes the signature')

  const reAuthored = { ...base, requests: new Map([['j1', { ts: 4 }]]) }
  t.not(viewSignature(reAuthored), viewSignature(base), 'a re-authored request (new ts) changes the signature')
})

// FIX-240b: memberTs must be part of the signature, so a rejoin that only bumps member/<S>.ts (same
// member/approved/request sets) still re-emits — that re-emit is what lets a durable leave-tombstone
// self-clear (tombstoneActive) on the co-member. Without this the fold would dedupe the rejoin away.
test('REGRESSION (FIX-240b): viewSignature changes when a member re-asserts a newer ts', (t) => {
  const base = {
    members: new Set([A, B]), approved: new Set(),
    requests: new Map(), denied: new Map(), memberTs: new Map([[A, 1000], [B, 1000]]),
  }
  const rejoined = { ...base, memberTs: new Map([[A, 1000], [B, 3000]]) }
  t.not(viewSignature(rejoined), viewSignature(base), 'a bumped member ts changes the signature (rejoin re-emits)')
  t.is(viewSignature(base), viewSignature({ ...base, memberTs: new Map([[B, 1000], [A, 1000]]) }), 'still order-independent')
})

// The roster deficit: considered keys with no readable record. Disjoint from `inactive`
// (a READ record saying not-a-member) by construction. The convergence tick keys its
// re-fold + discovery-refresh escalation on `unread`, so it must be reported and must
// re-emit through viewSignature when it heals.
test('REGRESSION (FIX-3: roster deficit): unread reports considered-but-unreplicated keys, disjoint from inactive', async (t) => {
  const db = new Map([
    [C, { active: true, approvals: [A, B] }],
    [A, { active: false, approvals: [] }],   // read, left → inactive
  ])
  const { unread, inactive } = await deriveMemberSet({ creatorKey: C, selfKey: S, readRecord: reader(db) })
  t.alike(sorted(unread), [B, S], 'B (approved, unreplicated) and self (probed, no record) are unread')
  t.alike(sorted(inactive), [A], 'a read active:false record is inactive, never unread')
  t.absent(unread.has(A), 'inactive and unread are disjoint')
  t.absent(unread.has(C), 'a readable record is not a deficit')

  db.set(B, { active: true, approvals: [] })
  const healed = await deriveMemberSet({ creatorKey: C, selfKey: S, readRecord: reader(db) })
  t.alike(sorted(healed.unread), [S], 'the deficit heals when the record replicates')
})

test('unread is empty when every considered record resolves', async (t) => {
  const db = new Map([
    [C, { active: true, approvals: [] }],
    [S, { active: true, approvals: [] }],
  ])
  const { unread } = await deriveMemberSet({ creatorKey: C, selfKey: S, readRecord: reader(db) })
  t.alike(sorted(unread), [], 'no deficit on a fully replicated roster')
})

test('viewSignature changes when only unread changes (healed deficit still re-emits)', (t) => {
  const base = {
    members: new Set([A]), approved: new Set(),
    requests: new Map(), denied: new Map(), memberTs: new Map(),
    inactive: new Set(), unread: new Set([B]),
  }
  const healed = { ...base, unread: new Set() }
  t.not(viewSignature(healed), viewSignature(base), 'an unread-only change re-emits')
  t.is(viewSignature(base), viewSignature({ ...base, unread: new Set([B]) }), 'stable when unchanged')
})
