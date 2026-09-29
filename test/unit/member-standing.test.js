import test from 'brittle'
import { verifiedMembers, isVerifiedMember, isUnverifiedMember } from '../../src/shared/spaces/member-standing.js'

const A = 'a'.repeat(64)
const M = 'm'.repeat(64)
const roster = [{ publicKey: A }, { publicKey: M, unverified: true }]

test('REGRESSION (MIR-44: an unverified invite seed counts as a member)', (t) => {
  t.alike(verifiedMembers(roster).map((m) => m.publicKey), [A], 'the seed is not a verified member')
  t.ok(isVerifiedMember(roster, A), 'a folded member is')
  t.absent(isVerifiedMember(roster, M), 'the seed is not')
  t.absent(isVerifiedMember(roster, 'z'.repeat(64)), 'a stranger is not')
  t.alike(verifiedMembers(null), [], 'a missing roster is empty')
  t.absent(isVerifiedMember(undefined, A), 'nor does a missing roster hold anyone')
})

test('only the unverified invite seed reads as unverified', (t) => {
  t.ok(isUnverifiedMember(roster, M), 'the seed is')
  t.absent(isUnverifiedMember(roster, A), 'a folded member is not')
  t.absent(isUnverifiedMember(roster, 'z'.repeat(64)), 'nor is a stranger')
  t.absent(isUnverifiedMember(null, M), 'nor anyone in a missing roster')
})
