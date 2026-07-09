import test from 'brittle'
import { foldMemberSet, reconnectGrantAllowed, tombstoneActive } from '../../src/shared/spaces/member-set.js'

// Build a records Map from a terse spec: { key: { active, approvals: [...] } }.
const recs = (spec) => new Map(Object.entries(spec).map(([k, v]) => [k, v]))
const sorted = (set) => [...set].sort()

const C = 'creator'
const A = 'alice'
const B = 'bob'
const D = 'dave'

test('lone active creator is a member', (t) => {
  t.alike(sorted(foldMemberSet(recs({ [C]: { active: true, approvals: [] } }), C)), [C])
})

test('a creator who left (active:false) is not a member', (t) => {
  t.alike(sorted(foldMemberSet(recs({ [C]: { active: false, approvals: [] } }), C)), [])
})

test('the creator is the root — no approval record needed', (t) => {
  // Nobody approved the creator, yet the creator is a member.
  const r = recs({ [C]: { active: true, approvals: [A] }, [A]: { active: true, approvals: [] } })
  t.alike(sorted(foldMemberSet(r, C)), [A, C])
})

test('transitive closure: approval-of-approver (C→A→B→D)', (t) => {
  const r = recs({
    [C]: { active: true, approvals: [A] },
    [A]: { active: true, approvals: [B] },
    [B]: { active: true, approvals: [D] },
    [D]: { active: true, approvals: [] },
  })
  t.alike(sorted(foldMemberSet(r, C)), [A, B, C, D])
})

test('order-independent: shuffled insertion order yields the same set', (t) => {
  const fwd = recs({
    [C]: { active: true, approvals: [A] },
    [A]: { active: true, approvals: [B] },
    [B]: { active: true, approvals: [] },
  })
  const rev = new Map([...fwd.entries()].reverse())
  t.alike(sorted(foldMemberSet(fwd, C)), sorted(foldMemberSet(rev, C)))
  t.alike(sorted(foldMemberSet(rev, C)), [A, B, C])
})

test('leave tombstone: an approved member with active:false is excluded', (t) => {
  const r = recs({
    [C]: { active: true, approvals: [A, B] },
    [A]: { active: true, approvals: [] },
    [B]: { active: false, approvals: [] },   // B was approved but has left
  })
  t.alike(sorted(foldMemberSet(r, C)), [A, C])
})

test('an approval authored by a NON-member does not confer membership', (t) => {
  // D is active and "approves" A, but nobody approved D → D is not a member, so its
  // approval of A is inert. A has no approval from a real member.
  const r = recs({
    [C]: { active: true, approvals: [] },
    [D]: { active: true, approvals: [A] },
    [A]: { active: true, approvals: [] },
  })
  t.alike(sorted(foldMemberSet(r, C)), [C])
})

test('a self-asserting Sybil clique stays out (not rooted at the creator)', (t) => {
  // X and Y approve each other and claim active, but no member approved either.
  const r = recs({
    [C]: { active: true, approvals: [] },
    x: { active: true, approvals: ['y'] },
    y: { active: true, approvals: ['x'] },
  })
  t.alike(sorted(foldMemberSet(r, C)), [C])
})

test('partial roster: a member whose approver bee is missing stays pending', (t) => {
  // C approved A, A approved B — but A's bee has not replicated (absent from records).
  // A can't be confirmed (no record), so neither can B. Self-heals when A's bee arrives.
  const r = recs({
    [C]: { active: true, approvals: [A] },
    [B]: { active: true, approvals: [] },     // claims active; only A approved it
  })
  t.alike(sorted(foldMemberSet(r, C)), [C])
})

test('…and once the missing bee replicates, the set converges', (t) => {
  const r = recs({
    [C]: { active: true, approvals: [A] },
    [A]: { active: true, approvals: [B] },    // A's bee now present
    [B]: { active: true, approvals: [] },
  })
  t.alike(sorted(foldMemberSet(r, C)), [A, B, C])
})

test('idempotent: folding the same records twice gives the same set', (t) => {
  const r = recs({
    [C]: { active: true, approvals: [A] },
    [A]: { active: true, approvals: [] },
  })
  t.alike(sorted(foldMemberSet(r, C)), sorted(foldMemberSet(r, C)))
})

test('accepts approvals as a Set as well as an array', (t) => {
  const r = recs({
    [C]: { active: true, approvals: new Set([A]) },
    [A]: { active: true, approvals: new Set() },
  })
  t.alike(sorted(foldMemberSet(r, C)), [A, C])
})

test('empty roster yields an empty set', (t) => {
  t.alike(sorted(foldMemberSet(new Map(), C)), [])
})

// REGRESSION (FIX-2: revoking an approval drops the member; a rejoiner stays out until re-approved).
// On a leave the approver revokeApproval()s its grant — modelled here as the approval leaving the
// approver's `approvals`. The member then drops even with active:true (a rejoin re-asserts active).
test('REGRESSION (FIX-2): revoking the approval drops an active member', (t) => {
  const approved = recs({ [C]: { active: true, approvals: [A] }, [A]: { active: true, approvals: [] } })
  t.alike(sorted(foldMemberSet(approved, C)), [A, C], 'A is a member while approved')
  const revoked = recs({ [C]: { active: true, approvals: [] }, [A]: { active: true, approvals: [] } })
  t.alike(sorted(foldMemberSet(revoked, C)), [C], 'A drops out once the approval is revoked, even active:true')
})

// Documents why FIX-3 is deferred: the creator is the OR-Set root, so revoking cannot gate it —
// the stale-folder symptom is instead closed by FIX-1 (share tombstone), not by membership.
test('the creator is a member with zero approvals (revoke cannot gate the root)', (t) => {
  t.alike(sorted(foldMemberSet(recs({ [C]: { active: true, approvals: [] } }), C)), [C])
})

// REGRESSION (FIX-RACE-1: reconnect re-grant must skip a peer we observed leaving). onJoinRequest's
// idempotent SCK re-grant shortcut may only fire for a peer we still hold AND have not seen leave;
// a just-left peer can still linger in space.members before removeMember commits, so gating on
// membership alone (the bug) silently re-admits it — it must require fresh approval.
test('REGRESSION (FIX-RACE-1): reconnectGrantAllowed only for a held, not-left peer', (t) => {
  t.ok(reconnectGrantAllowed(true, false), 'still a member, no leave observed → reconnect re-grant allowed')
  t.absent(reconnectGrantAllowed(true, true), 'member still lingering mid-leave (tombstone set) → NOT re-granted')
  t.absent(reconnectGrantAllowed(false, false), 'not a member → not a reconnect')
  t.absent(reconnectGrantAllowed(false, true), 'left and already removed → not a reconnect')
})

// FIX-240b: a durable leave-tombstone suppresses the leaver until it re-asserts a NEWER membership.
// leaveTs is the leaver's clock stamp at leave; memberTs is its current member/<S> ts.
test('REGRESSION (FIX-240b): tombstoneActive honors a leave until a strictly-newer rejoin', (t) => {
  t.ok(tombstoneActive(100, 0), 'no current membership record → suppressed')
  t.ok(tombstoneActive(100, 100), 'same ts (stale, not-yet-replicated record) → suppressed')
  t.ok(tombstoneActive(100, 50), 'older membership than the leave → suppressed')
  t.absent(tombstoneActive(100, 101), 're-asserted a newer membership → back in')
  t.absent(tombstoneActive(null, 50), 'not tombstoned → never suppressed')
  t.absent(tombstoneActive(undefined, 0), 'no tombstone → never suppressed')
})
