import test from 'brittle'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')

// Approval is monotonic until the content key can be rotated: a deny aimed at a peer who already
// holds it cannot take anything back, so the decider must hear that rather than a bare false.
test('REGRESSION (FIX-395A: deny on an approved member reports nothing)', { timeout: scaled(220000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t) })

  const sid = await connectInSpaceWithApproval(t, A, B)
  const bKey = (await B.request('profile:get')).personKey

  const bannerCleared = A.waitFor('event:join-requests-updated', (m) => m.spaceId === sid, 10000)
  const res = await A.request('space:deny-member', { spaceId: sid, publicKey: bKey })
  t.alike(res, { outcome: 'already-approved' }, 'the decider is told the peer is already a member')
  await t.execution(bannerCleared, 'the stale request banner is cleared on every such deny')

  const members = (await A.request('spaces:list')).find((s) => s.spaceId === sid)?.members || []
  t.ok(members.some((m) => m.publicKey === bKey), 'Bob stays a member')
  t.is((await B.request('spaces:list')).find((s) => s.spaceId === sid)?.status, 'approved', 'Bob keeps access')
  const kinds = (await A.request('audit:list', { limit: 200 })).entries.map((e) => e.kind)
  t.absent(kinds.includes('membership.denied'), 'no denial is recorded for a deny that changed nothing')
})
