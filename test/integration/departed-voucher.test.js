import test from 'brittle'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { makePeer, replicate, waitFor } from '../helpers/peer-bee.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { getStore } from '../../src/shared/core/store.js'
import { markOwnMembership, getLocalPublicKeyHex, markApproval, hasOwnApproval } from '../../src/shared/spaces/profile.js'
import { createSpace, pinCreatorKey } from '../../src/shared/spaces/space.js'
import { openMemberView, closeMemberView, isMember } from '../../src/shared/spaces/member-registry.js'

// The unit tests fold synthetic seqs; these drive real hyperbee records end to end, so they also
// prove loadMembershipRecord actually surfaces the log positions the fold compares.
//
// The departing peer is the ROOT in every case on purpose: nobody holds a vouch FOR the root, so
// applyObservedLeave's revokeApproval is a no-op and cannot tear the edge out from under the
// assertion. That isolates the fold's own behaviour from the observed-leave path.

const v2 = () => setRuntimeConfig({ ...getRuntimeConfig(), membershipApprovalEnabled: true })

async function rootedSpace (t, name, { departure }) {
  await freshPeerWithIdentity(t)
  v2()
  const { spaceId } = await createSpace(name)
  await markOwnMembership(spaceId)
  const me = getLocalPublicKeyHex()

  const R = await makePeer(t)   // the space's root, which will leave
  const D = await makePeer(t)   // vouched BEFORE the root departs
  const E = await makePeer(t)   // vouched AFTER the root departs

  await D.bee.put('member/' + spaceId, { active: true, ts: 1000 })
  await E.bee.put('member/' + spaceId, { active: true, ts: 1000 })

  await R.bee.put('member/' + spaceId, { active: true, ts: 1000 })
  await R.bee.put('approved/' + spaceId + '/' + me, { ts: 1 })
  await R.bee.put('approved/' + spaceId + '/' + D.key, { ts: 2 })
  await departure(R, spaceId)
  await R.bee.put('approved/' + spaceId + '/' + E.key, { ts: 3 })

  replicate(getStore(), R.store, t)
  replicate(getStore(), D.store, t)
  replicate(getStore(), E.store, t)

  await pinCreatorKey(spaceId, R.key)
  await openMemberView(spaceId)
  t.teardown(() => closeMemberView(spaceId))

  return { spaceId, me, R, D, E }
}

// REGRESSION (FIX-361: creator-leave collapse) + (FIX-362: post-departure vouch).
test('REGRESSION (FIX-361/FIX-362): the root leaving keeps its earlier vouches and voids its later ones', async (t) => {
  const { spaceId, me, R, D, E } = await rootedSpace(t, 'RootLeaves', {
    departure: (peer, sid) => peer.bee.put('member/' + sid, { active: false, ts: 2000 }),
  })

  t.ok(await waitFor(() => isMember(spaceId, me), 8000), 'we stay a member after the root leaves')
  t.ok(await waitFor(() => isMember(spaceId, D.key), 8000), 'a vouch authored before the departure still stands')
  t.absent(await waitFor(() => isMember(spaceId, E.key), 2000), 'a vouch authored after the departure confers nothing')
  t.absent(isMember(spaceId, R.key), 'the departed root is not itself a member')
})

// REGRESSION (FIX-363: departure orphaning). The fold keeps a departed peer's vouches, but the
// observer still revokes its OWN vouch for that peer on a leave — which unroots it, and with it
// anyone it alone vouched for. Adoption re-parents that subtree onto the observer first, so the
// revoke can keep doing its job (no silent re-admit) without stranding anyone.
//
// Unlike the tests above, the departing peer here is NOT the root: we are, so we hold a vouch for
// it and the revoke actually fires. That is the case the adoption exists for.
test('REGRESSION (FIX-363): a departing member\'s vouchees are adopted, not orphaned', async (t) => {
  await freshPeerWithIdentity(t)
  v2()
  const { spaceId } = await createSpace('AdoptOnLeave')
  await markOwnMembership(spaceId)

  const A = await makePeer(t)   // we vouch for A
  const B = await makePeer(t)   // A vouches for B — B's only path to the root runs through A

  await A.bee.put('member/' + spaceId, { active: true, ts: 1000 })
  await B.bee.put('member/' + spaceId, { active: true, ts: 1000 })
  await A.bee.put('approved/' + spaceId + '/' + B.key, { ts: 1 })
  await markApproval(spaceId, A.key)

  replicate(getStore(), A.store, t)
  replicate(getStore(), B.store, t)

  await openMemberView(spaceId)
  t.teardown(() => closeMemberView(spaceId))
  t.ok(await waitFor(() => isMember(spaceId, A.key), 8000), 'precondition: A derived as a member')
  t.ok(await waitFor(() => isMember(spaceId, B.key), 8000), 'precondition: B derived through A')

  await A.bee.put('member/' + spaceId, { active: false, ts: 2000 })   // A leaves

  t.ok(await waitFor(() => !isMember(spaceId, A.key), 8000), 'A folded out')
  t.ok(await waitFor(async () => !(await hasOwnApproval(spaceId, A.key)), 8000), 'our vouch for A is revoked')
  t.ok(await waitFor(async () => await hasOwnApproval(spaceId, B.key), 8000), 'we adopted A\'s vouchee B')
  t.ok(isMember(spaceId, B.key), 'B survives the departure of the peer that vouched for it')

  // A re-asserts with a strictly newer ts, which self-clears the leave tombstone — so what keeps A
  // out from here is the revoke alone. Adoption must not have weakened that.
  await A.bee.put('member/' + spaceId, { active: true, ts: 3000 })
  t.absent(await waitFor(() => isMember(spaceId, A.key), 2000), 'A is not silently re-admitted without fresh approval')
  t.ok(isMember(spaceId, B.key), 'and B is still held on our own adopted vouch')
})

// The compatibility direction: a peer that recorded its departure by DELETING the key carries no
// log position, so the check cannot run and every vouch must still count. Filtering on the missing
// position instead would drop that peer's whole subtree — the collapse this pair of fixes removes.
test('REGRESSION (FIX-362): a delete-style departure carries no seq, so no vouch is discounted', async (t) => {
  const { spaceId, me, D, E } = await rootedSpace(t, 'RootDeletes', {
    departure: (peer, sid) => peer.bee.del('member/' + sid),
  })

  t.ok(await waitFor(() => isMember(spaceId, me), 8000), 'we stay a member')
  t.ok(await waitFor(() => isMember(spaceId, D.key), 8000), 'the earlier vouch stands')
  t.ok(await waitFor(() => isMember(spaceId, E.key), 8000), 'the later vouch also stands — no position to compare')
})
