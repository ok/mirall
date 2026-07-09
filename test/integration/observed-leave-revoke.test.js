import test from 'brittle'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { makePeer, replicate, waitFor } from '../helpers/peer-bee.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { getStore } from '../../src/shared/core/store.js'
import { markOwnMembership, markApproval, hasOwnApproval } from '../../src/shared/spaces/profile.js'
import { createSpace, upsertMember } from '../../src/shared/spaces/space.js'
import { openMemberView, closeMemberView, isMember, isLeft } from '../../src/shared/spaces/member-registry.js'

// G6: an approver that never receives the leave FRAME must still revoke its grow-only vouch when
// the leaver's durable `del member/<S>` replicates and the fold observes it — otherwise a later
// re-assert of member/<S> {active:true} is silently re-admitted off the surviving approval.

// createSpace only mints a v2 space (schemaVersion 2 + creatorKey — what openMemberView requires)
// with the membership-approval flag on.
const v2 = () => setRuntimeConfig({ ...getRuntimeConfig(), membershipApprovalEnabled: true })

// REGRESSION (G6): before the fix, only handleLeaveFrame revoked/tombstoned — a fold-observed
// del dropped the leaver from the display set but left approved/<S>/<B> standing, so a stale
// re-assert was re-admitted with no fresh approval.
test('REGRESSION (G6): a fold-observed leave revokes our vouch and blocks silent re-admit', async (t) => {
  await freshPeerWithIdentity(t)
  v2()
  const { spaceId } = await createSpace('G6-live')
  await markOwnMembership(spaceId)

  const B = await makePeer(t)
  await B.bee.put('member/' + spaceId, { active: true, ts: 1000 })
  await markApproval(spaceId, B.key)
  replicate(getStore(), B.store, t)

  await openMemberView(spaceId)
  t.teardown(() => closeMemberView(spaceId))
  t.ok(await waitFor(() => isMember(spaceId, B.key), 8000), 'precondition: B derived as a member')
  t.ok(await hasOwnApproval(spaceId, B.key), 'precondition: our vouch stands')

  await B.bee.del('member/' + spaceId) // B leaves; only the durable del replicates — no frame

  t.ok(await waitFor(() => !isMember(spaceId, B.key), 8000), 'B folded out')
  t.ok(await waitFor(() => isLeft(spaceId, B.key), 8000), 'observed leave tombstoned')
  t.ok(await waitFor(async () => !(await hasOwnApproval(spaceId, B.key)), 8000), 'our vouch revoked')

  // A stale re-assert (same ts) must not re-admit: the tombstone suppresses it and the
  // vouch is gone.
  await B.bee.put('member/' + spaceId, { active: true, ts: 1000 })
  await new Promise((r) => setTimeout(r, 750))
  t.absent(isMember(spaceId, B.key), 'stale re-assert not re-admitted')

  // A genuine rejoin (strictly newer ts) still needs a FRESH approval — the old vouch stays
  // revoked, so B remains out until re-approved.
  await B.bee.put('member/' + spaceId, { active: true, ts: 2000 })
  await new Promise((r) => setTimeout(r, 750))
  t.absent(isMember(spaceId, B.key), 'rejoin without fresh approval stays out')
})

// REGRESSION (G6, restart edge): the del can land in our replica before the session's FIRST fold
// (approver restarted after the leave). entry.members starts empty, so without the durable-roster
// seed there is no member→inactive transition and the vouch survives forever.
test('REGRESSION (G6): a leave observed only after a restart still revokes (durable roster seed)', async (t) => {
  await freshPeerWithIdentity(t)
  v2()
  const { spaceId } = await createSpace('G6-restart')
  await markOwnMembership(spaceId)

  const B = await makePeer(t)
  await B.bee.put('member/' + spaceId, { active: true, ts: 1000 })
  await markApproval(spaceId, B.key)
  // The durable roster a prior session's reconcile persisted — prior-membership evidence
  // that survives a restart.
  await upsertMember(spaceId, { publicKey: B.key })

  await B.bee.del('member/' + spaceId) // B left while "we" were down
  replicate(getStore(), B.store, t)

  await openMemberView(spaceId) // fresh session: first fold already reads B as inactive
  t.teardown(() => closeMemberView(spaceId))

  t.ok(await waitFor(async () => !(await hasOwnApproval(spaceId, B.key)), 8000), 'vouch revoked on first fold')
  t.ok(await waitFor(() => isLeft(spaceId, B.key), 8000), 'leaver tombstoned')
  t.absent(isMember(spaceId, B.key), 'leaver not a member')
})

// REGRESSION (review): reconcile drops a held member from the durable roster on a transient
// null read (fetched-but-unreadable counts as `considered`) WITHOUT revoking — so a roster-only
// seed misses a vouchee that then leaves before our restart. The prior-belief seed therefore
// also covers our own authored approvals: exactly the keys a missed revoke matters for.
test('REGRESSION (G6): a vouched leaver absent from the roster still revokes after restart (approvals seed)', async (t) => {
  await freshPeerWithIdentity(t)
  v2()
  const { spaceId } = await createSpace('G6-seed')
  await markOwnMembership(spaceId)

  const B = await makePeer(t)
  await B.bee.put('member/' + spaceId, { active: true, ts: 1000 })
  await markApproval(spaceId, B.key)
  // NO upsertMember: the roster lost B in a prior session, but our vouch survived — the
  // approvals seed is the only prior-membership evidence left.
  await B.bee.del('member/' + spaceId)
  replicate(getStore(), B.store, t)

  await openMemberView(spaceId)
  t.teardown(() => closeMemberView(spaceId))

  t.ok(await waitFor(async () => !(await hasOwnApproval(spaceId, B.key)), 8000), 'vouch revoked via the approvals seed')
  t.ok(await waitFor(() => isLeft(spaceId, B.key), 8000), 'leaver tombstoned')
  t.absent(isMember(spaceId, B.key), 'leaver not a member')
})
