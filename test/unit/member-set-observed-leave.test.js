import test from 'brittle'
import { deriveMemberSet } from '../../src/shared/spaces/member-view.js'
import { observedLeavers } from '../../src/shared/spaces/member-set.js'

const rec = (active, approvals = [], memberTs = 1) => ({ active, approvals, memberTs })
const reader = (db) => async (k) => db.get(k) ?? null

// `inactive` is the fold's positive-evidence leave signal: a peer whose bee we READ and whose
// record says active:false (its own replicated departure). A null (unreplicated) peer, or one
// that merely lost an approver, must never surface there — a false positive would revoke a
// legitimate member's approval.

test('deriveMemberSet reports an observed leave (active:false record) as inactive', async (t) => {
  const db = new Map([
    ['C', rec(true, ['B', 'D'])],
    ['B', rec(false)], // B's del observed: bee readable, member/<S> gone
    ['D', rec(true)],
  ])
  const { members, inactive, considered } = await deriveMemberSet({
    creatorKey: 'C', selfKey: 'C', readRecord: reader(db),
  })
  t.ok(members.has('C') && members.has('D') && !members.has('B'), 'B folded out')
  t.ok(inactive.has('B'), 'B surfaced as inactive (observed leave)')
  t.absent(inactive.has('C') || inactive.has('D'), 'active members not inactive')
  t.ok(considered.has('B'), 'B was considered (bee read)')
})

test('deriveMemberSet does NOT mark an unreplicated peer inactive', async (t) => {
  const db = new Map([['C', rec(true, ['B'])]]) // B never read → null, not a record
  const { inactive } = await deriveMemberSet({
    creatorKey: 'C', selfKey: 'C', readRecord: reader(db),
  })
  t.absent(inactive.has('B'), 'a not-yet-replicated peer is not "inactive" (no false leave)')
})

test('deriveMemberSet marks only the genuine leaver inactive', async (t) => {
  // B left. E, which B had vouched for while a member, keeps that authorization and stays —
  // and since E never departed, it must not be reported inactive either.
  const db = new Map([
    ['C', rec(true, ['B'])],
    ['B', rec(false, ['E'])],
    ['E', rec(true)],
  ])
  const { members, inactive } = await deriveMemberSet({
    creatorKey: 'C', selfKey: 'C', readRecord: reader(db),
  })
  t.ok(members.has('E'), 'E keeps the authorization B conferred before leaving')
  t.absent(inactive.has('E'), 'a peer that did not leave is never inactive')
  t.ok(inactive.has('B'), 'only the genuine leaver is inactive')
})

test('observedLeavers = prev members that are now inactive (never a cascade / never a stranger)', (t) => {
  const prev = new Set(['B', 'D'])
  const inactive = new Set(['B', 'E']) // B left; E inactive but never our member; D still active
  t.alike(observedLeavers(prev, inactive), ['B'], 'only a former member now inactive')
  t.alike(observedLeavers(new Set(), inactive), [], 'no prior members → nothing to reconcile')
  t.alike(observedLeavers(prev, new Set()), [], 'nothing inactive → nothing to reconcile')
  t.alike(observedLeavers(null, inactive), [], 'missing prior set tolerated')
  t.alike(observedLeavers(prev, null), [], 'missing inactive set tolerated')
  // The registry passes prior as a Map<key, lastTs> — only has/size are consumed.
  t.alike(observedLeavers(new Map([['B', 1000], ['D', 2000]]), inactive), ['B'], 'a Map prior works identically')
})
