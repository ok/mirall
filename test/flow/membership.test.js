import test from 'brittle'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'

test('two peers converge on shared space membership after handshake', async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })

  const spaceId = await connectInSpace(t, A, B, 'Project Aurora')

  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey

  // `event:member-joined` (which connectInSpace awaits) fires before the member
  // is persisted via updateMembers, so poll for the persisted membership rather
  // than reading once. spaces:list injects self first, then persisted peers.
  const hasMember = (key) => (list) => {
    const s = list.find((x) => x.spaceId === spaceId)
    return !!(s && s.members.some((m) => m.publicKey === key))
  }
  const aSpaces = await A.until('spaces:list', {}, hasMember(bKey))
  const bSpaces = await B.until('spaces:list', {}, hasMember(aKey))
  const aSpace = aSpaces.find((s) => s.spaceId === spaceId)
  const bSpace = bSpaces.find((s) => s.spaceId === spaceId)

  t.ok(aSpace.members.some((m) => m.publicKey === bKey), 'A sees Bob as a member')
  t.ok(bSpace.members.some((m) => m.publicKey === aKey), 'B sees Alice as a member')
  t.is(aSpace.spaceId, bSpace.spaceId, 'deterministic spaceId from the shared topic')

  // both consider each other online
  await A.until('members:online', { spaceId }, (online) => online.includes(bKey))
  await B.until('members:online', { spaceId }, (online) => online.includes(aKey))
  t.pass('each peer sees the other online')
})
