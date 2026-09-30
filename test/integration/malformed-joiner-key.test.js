import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { makePeer, replicate, waitFor } from '../helpers/peer-bee.js'
import { getStore } from '../../src/shared/core/store.js'
import {
  getLocalPublicKeyHex, getProfileBee, markOwnMembership, markApproval, hasOwnApproval,
  readMembershipRecord, readPeerRequests, readPeerDenials,
} from '../../src/shared/spaces/profile.js'
import { createMemberView } from '../../src/shared/spaces/member-view.js'
import { adoptVouchees } from '../../src/shared/spaces/member-registry.js'

const BAD = 'ab'
const VALID = 'e'.repeat(64)
const MALFORMED = [BAD, VALID.toUpperCase(), VALID.slice(1), VALID + 'e', 'z'.repeat(64)]

// A co-member B the creator approved, replicating into the local store, whose own record also
// vouches for `extra` joiner keys.
async function coMember(t, S, extra) {
  const B = await makePeer(t)
  await B.bee.put('member/' + S, { active: true, ts: 1 })
  for (const k of extra) await B.bee.put('approved/' + S + '/' + k, { ts: 1 })
  await markApproval(S, B.key)
  replicate(getStore(), B.store, t)
  return B
}

function watchRoster(t, S, creator) {
  const errors = []
  let latest = null
  const mv = createMemberView({
    spaceId: S,
    creatorKey: creator,
    selfKey: creator,
    onMembers: ({ members }) => { latest = new Set(members) },
    onError: (err) => errors.push(err),
  })
  t.teardown(() => mv.close())
  return { mv, errors, members: () => latest }
}

test('REGRESSION (MIR-49: peer reads skip every joiner key that is not lowercase 64-char hex)', async (t) => {
  await freshPeer(t)
  const me = getLocalPublicKeyHex()
  const S = 'space-mir49-read'
  await markOwnMembership(S)
  const bee = getProfileBee()
  for (const k of [VALID, ...MALFORMED]) {
    await bee.put('approved/' + S + '/' + k, { ts: 1 })
    await bee.put('request/' + S + '/' + k, { displayName: 'R', ts: 1 })
    await bee.put('denied/' + S + '/' + k, { ts: 1 })
  }

  t.alike((await readMembershipRecord(me, S)).approvals, [VALID], 'only the well-formed approval is read')
  t.alike((await readPeerRequests(me, S)).map((r) => r.joiner), [VALID], 'only the well-formed request is read')
  t.alike((await readPeerDenials(me, S)).map((d) => d.joiner), [VALID], 'only the well-formed denial is read')
})

test('REGRESSION (MIR-49: a co-member\'s malformed approval does not wedge the roster fold)', async (t) => {
  await freshPeer(t)
  const creator = getLocalPublicKeyHex()
  const S = 'space-mir49-fold'
  await markOwnMembership(S)
  const B = await coMember(t, S, [BAD])
  const roster = watchRoster(t, S, creator)

  t.ok(await waitFor(() => roster.members()?.has(B.key)), 'B is folded in beside its malformed vouch')

  const D = await makePeer(t)
  await D.bee.put('member/' + S, { active: true, ts: 1 })
  replicate(getStore(), D.store, t)
  await B.bee.put('approved/' + S + '/' + D.key, { ts: 2 })

  t.ok(await waitFor(() => roster.members()?.has(D.key)), 'a later approval still re-folds the roster')
  t.absent(roster.members()?.has(BAD), 'the malformed key is never a member')
  t.is(roster.errors.length, 0, 'no fold failed')
})

test('REGRESSION (MIR-49: a malformed vouch is not adopted from a leaver)', async (t) => {
  await freshPeer(t)
  const creator = getLocalPublicKeyHex()
  const S = 'space-mir49-adopt'
  await markOwnMembership(S)
  const B = await coMember(t, S, [BAD, VALID])

  t.ok(await waitFor(async () => (await readMembershipRecord(B.key, S))?.approvals.includes(VALID)), 'B\'s record replicated')
  t.ok(await adoptVouchees(S, B.key, new Set([creator, B.key])), 'the leaver\'s record was readable')

  t.ok(await hasOwnApproval(S, VALID), 'the well-formed vouchee is adopted')
  t.absent(await hasOwnApproval(S, BAD), 'the malformed key is not written into our bee')
})

test('REGRESSION (MIR-49: tracking a key that names no core is skipped, not fatal)', async (t) => {
  await freshPeer(t)
  const creator = getLocalPublicKeyHex()
  const S = 'space-mir49-track'
  await markOwnMembership(S)
  const roster = watchRoster(t, S, creator)
  t.ok(await waitFor(() => roster.members()?.has(creator)), 'the roster folded the creator')

  t.execution(() => roster.mv.trackKey(BAD), 'an unopenable key does not throw into the caller')

  const B = await coMember(t, S, [])
  t.ok(await waitFor(() => roster.members()?.has(B.key)), 'the view keeps folding afterwards')
  t.is(roster.errors.length, 0, 'no fold failed')
})
