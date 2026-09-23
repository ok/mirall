// The merged share listing for a space: own share records plus every member's,
// tagged with their owner and deduped by (owner, id).
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { getSpace } from '../spaces/space.js'
import { readOwnShares, readPeerShares } from './shares.js'
import { peerMembersOf, readEachPeer } from '../spaces/member-fanout.js'

export async function listSharesForSpace(spaceId) {
  const space = await getSpace(spaceId)
  if (!space) return []

  const me = getLocalPublicKeyHex()
  const own = await readOwnShares(spaceId)
  const ownTagged = own.map((s) => ({ ...s, owner: me, source: 'own' }))

  // The renderer refreshes on event:shares-updated when a peer's profile bee appends.
  const peerLists = await readEachPeer(peerMembersOf(space.members, me), async (m, budget) => {
    const shares = await readPeerShares(m.publicKey, spaceId, budget)
    return shares ? shares.map((s) => ({ ...s, owner: m.publicKey, source: 'peer' })) : []
  })

  const merged = [...ownTagged, ...peerLists.flat()]
  return dedupeByKey(merged)
}

function dedupeByKey(shares) {
  const seen = new Map()
  for (const share of shares) {
    if (!share.id) continue
    const key = share.owner + ':' + share.id
    if (!seen.has(key)) seen.set(key, share)
  }
  return [...seen.values()]
}
