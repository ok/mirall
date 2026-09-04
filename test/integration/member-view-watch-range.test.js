import test from 'brittle'
import b4a from 'b4a'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { makePeer, replicate, waitFor } from '../helpers/peer-bee.js'
import { getStore } from '../../src/shared/core/store.js'
import { getLocalPublicKeyHex, markOwnMembership, markApproval } from '../../src/shared/spaces/profile.js'
import { createMemberView } from '../../src/shared/spaces/member-view.js'

// The member fold's watch ranges ARE its convergence guarantee, and a wrong one is silent: the view
// is correct at fold time and then simply never re-folds. So this file is written as a closed
// world — every key family the fold reads must wake it, and every family it does not read must
// not. Checking only the first half would pass a range set that still watches the whole bee, which
// is the defect this exists to catch.

// The fold reads each roster peer through withPeerBee, which opens a FRESH core session per read
// (profile.js openProfileBee → store.get). Counting the sessions opened against one peer's key is
// therefore a direct count of folds that read it — and unlike onMembers, it is not suppressed by
// viewSignature, which drops the emit only after the fold has already run.
function countReadsOf (t, keyHex) {
  const store = getStore()
  const original = store.get.bind(store)
  const state = { reads: 0 }
  store.get = (arg, ...rest) => {
    const key = b4a.isBuffer(arg) ? arg : arg?.key
    if (key && b4a.toString(key, 'hex') === keyHex) state.reads += 1
    return original(arg, ...rest)
  }
  t.teardown(() => { store.get = original })
  return state
}

// deriveDebounceMs is 150; this leaves room for the debounced fold's reads to land. No scaled():
// test/helpers/timing.js reads process.env, which Bare does not provide.
const SETTLE_MS = 600

// Quiet for a full settle window is what "did not wake" means; there is no negative event to await.
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS))

async function foldedRoster (t, spaceId) {
  await freshPeerWithIdentity(t)
  const creator = getLocalPublicKeyHex()
  await markOwnMembership(spaceId)

  const B = await makePeer(t)
  await B.bee.put('member/' + spaceId, { active: true, ts: 1 })
  await markApproval(spaceId, B.key)
  replicate(getStore(), B.store, t)

  let members = null
  let shareAppends = 0
  const mv = createMemberView({
    spaceId,
    creatorKey: creator,
    selfKey: creator,
    onMembers: (result) => { members = new Set(result.members) },
    onBeeAppend: () => { shareAppends += 1 },
  })
  t.teardown(() => mv.close())

  t.ok(await waitFor(() => members?.has(B.key)), 'the roster folded B in before the range assertions')
  await settle()
  return { creator, B, mv, appends: () => shareAppends }
}

test('every key family the member fold reads wakes a re-fold', async (t) => {
  const S = 'space-wake'
  const { B } = await foldedRoster(t, S)

  // The approval target is a real replicated peer: an approval of a key with no bee anywhere makes
  // every later fold spend a full peerReadTimeoutMs on it, which would swamp the settle window.
  const C = await makePeer(t)
  await C.bee.put('member/' + S, { active: true, ts: 1 })
  replicate(getStore(), C.store, t)

  const wakes = [
    ['caps/membership-manifest', 1, 'the cap gate all three peer loaders read first'],
    ['member/' + S, { active: true, ts: 2 }, 'own membership, the record the OR-Set folds'],
    ['approved/' + S + '/' + C.key, { ts: 2 }, 'an approval — the OR-Set edge that grows the roster'],
    ['request/' + S + '/joiner-1', { displayName: 'Joiner', ts: 2 }, 'a join request receipt'],
    ['denied/' + S + '/joiner-2', { ts: 2 }, 'a denial'],
  ]

  const counter = countReadsOf(t, B.key)
  for (const [key, value, why] of wakes) {
    const before = counter.reads
    await B.bee.put(key, value)
    t.ok(await waitFor(() => counter.reads > before, 5000), `${key} woke the fold — ${why}`)
    await settle()
  }
})

test('no key family the member fold ignores wakes a re-fold', async (t) => {
  const S = 'space-quiet'
  const { B, appends } = await foldedRoster(t, S)

  const quiet = [
    ['displayName', 'Renamed', 'read by no part of the fold'],
    ['avatar', 'data:image/png;base64,AAAA', 'the motivating case — a profile picture re-folded the whole roster'],
    ['publicKey', 'abcd', 'written on every profile save, alongside avatar'],
    ['invite/' + S + '/inv1', { ts: 1 }, 'invites are read by the invite listing, not the fold'],
    ['drive/' + S, { key: 'ff' }, 'the space drive key'],
    ['loosecat/' + S, { key: 'ee' }, 'the loose-file catalog key'],
    ['mirror/' + S + '/sh1', { ts: 1 }, 'a mirror participation record'],
    ['member/' + S + '-other', { active: true, ts: 1 }, 'ANOTHER space — a prefix range here would wake this fold'],
    ['member/other-' + S, { active: true, ts: 1 }, 'another space sorting before this one'],
  ]

  const counter = countReadsOf(t, B.key)
  for (const [key, value, why] of quiet) {
    const before = counter.reads
    await B.bee.put(key, value)
    await settle()
    t.is(counter.reads, before, `${key} did not wake the fold — ${why}`)
  }

  t.is(appends(), 0, 'and none of them reached the share watcher either')
})

// The fix. Before it, createMemberView passed no range at all, so createDerivedView watched the
// whole bee and any profile write — an avatar most of all, since it is rewritten on every profile
// save — triggered a full serial roster re-fold at one network-bounded read per member.
test('REGRESSION (ADOPT-D1: an avatar append triggered a full serial roster re-fold)', async (t) => {
  const S = 'space-avatar'
  const { B } = await foldedRoster(t, S)
  const counter = countReadsOf(t, B.key)

  await B.bee.put('avatar', 'data:image/png;base64,' + 'A'.repeat(64))
  await B.bee.put('displayName', 'Renamed')
  await B.bee.put('publicKey', 'deadbeef')
  await settle()

  t.is(counter.reads, 0, 'the three keys a profile save rewrites cost zero roster reads')
})

test('a share append still wakes the share watcher and not the fold', async (t) => {
  const S = 'space-share'
  const { B, appends } = await foldedRoster(t, S)
  const counter = countReadsOf(t, B.key)

  await B.bee.put('share/' + S + '/sh1', { id: 'sh1', name: 'Docs' })

  t.ok(await waitFor(() => appends() > 0, 5000), 'the share watcher fired')
  await settle()
  t.is(counter.reads, 0, 'and the membership fold stayed asleep — the two watches are independent')
})

test('close() releases every watcher on every tracked bee', async (t) => {
  const S = 'space-close'
  const creator = await (async () => {
    await freshPeerWithIdentity(t)
    const me = getLocalPublicKeyHex()
    await markOwnMembership(S)
    return me
  })()

  const B = await makePeer(t)
  await B.bee.put('member/' + S, { active: true, ts: 1 })
  await markApproval(S, B.key)
  replicate(getStore(), B.store, t)

  let members = null
  const mv = createMemberView({
    spaceId: S,
    creatorKey: creator,
    selfKey: creator,
    onMembers: (result) => { members = new Set(result.members) },
  })
  t.ok(await waitFor(() => members?.has(B.key)), 'two bees are tracked, five watchers each')

  await mv.close()

  // A watcher left open keeps diffing every append forever; five ranges per bee is five chances to
  // leak one, so the proof is that a post-close append reaches nothing.
  const counter = countReadsOf(t, B.key)
  await B.bee.put('member/' + S, { active: true, ts: 3 })
  await settle()
  t.is(counter.reads, 0, 'no watcher survived close()')
})
