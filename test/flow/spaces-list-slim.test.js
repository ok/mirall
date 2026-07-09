import test from 'brittle'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { scaled } from '../helpers/timing.js'

// The roster in spaces:list is a summary — no avatar (a base64 data-URL up to the sanitizeAvatar
// cap, far too heavy for an every-refetch payload) and no catalog-key fields. The full roster,
// avatars included, moves to the per-space space:members request. Guards the payload contract
// both ways so the slimming can't silently regress and the avatar path can't silently vanish.
test('spaces:list ships slim rosters; space:members carries the full roster',
  { timeout: scaled(120000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const spaces = await A.request('spaces:list')
    const space = spaces.find((s) => s.spaceId === spaceId)
    t.ok(space.members.length >= 2, 'slim roster present (self + Bob)')
    for (const m of space.members) {
      t.absent('avatar' in m, `slim roster carries no avatar field (${m.displayName})`)
      t.absent('looseCatalogKey' in m, 'nor looseCatalogKey')
      t.absent('looseCatalogKeyEnc' in m, 'nor looseCatalogKeyEnc')
      t.ok(typeof m.publicKey === 'string' && typeof m.displayName === 'string', 'identity fields intact')
    }
    t.is(space.memberCount, space.members.length, 'memberCount mirrors the roster length')
    t.ok(typeof space.pendingCount === 'number', 'pendingCount preserved')

    const roster = await A.request('space:members', { spaceId })
    t.ok(roster.length >= 2, 'full roster present')
    t.is(roster[0].publicKey, aKey, 'self entry first')
    for (const m of roster) {
      t.ok('avatar' in m, `full roster carries the avatar field (${m.displayName})`)
      t.absent('looseCatalogKey' in m, 'space:members strips the catalog-key fields')
      t.absent('looseCatalogKeyEnc' in m, 'both of them')
    }

    const gone = await A.request('space:members', { spaceId: 'no-such-space' })
    t.alike(gone, [], 'unknown space resolves to an empty roster')

    A.kill()
  })
