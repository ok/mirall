import test from 'brittle'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'

test('when A leaves a shared space, B prunes A from membership', { timeout: 90000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey

  const before = (await B.request('spaces:list')).find((s) => s.spaceId === spaceId)
  t.ok(before.members.some((m) => m.publicKey === aKey), 'B sees A as a member before leave')

  // A leaves: broadcasts a leave frame + clears its own membership.
  await A.request('space:leave', { spaceId })

  // B receives the leave frame and prunes A.
  await B.until('spaces:list', {}, (list) => {
    const s = list.find((x) => x.spaceId === spaceId)
    return s && !s.members.some((m) => m.publicKey === aKey)
  }, { ms: 60000 })

  const after = (await B.request('spaces:list')).find((s) => s.spaceId === spaceId)
  t.ok(after, 'B still has the space')
  t.absent(after.members.some((m) => m.publicKey === aKey), 'A pruned from B’s member list')
  t.ok(after.members.some((m) => m.publicKey === bKey), 'B (self) remains')
  const online = await B.request('members:online', { spaceId })
  t.absent(online.includes(aKey), 'A no longer shown online for B')
})
