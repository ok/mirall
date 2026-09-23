// The merged "who mirrors what" listing for a space: own mirror records plus every member's, each
// tagged with the mirroring peer. Only current members are trusted — a non-member's record is never
// read — through the one member fan-out.
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { getSpace } from '../spaces/space.js'
import { readOwnMirrors, readPeerMirrors, readOwnMirror, readPeerMirror } from './mirror-records.js'
import { peerMembersOf, readEachPeer } from '../spaces/member-fanout.js'

export async function listMirrorsForSpace(spaceId) {
  const space = await getSpace(spaceId)
  if (!space || space.leaving) return []

  const me = getLocalPublicKeyHex()
  const own = (await readOwnMirrors(spaceId)).map((m) => ({ ...m, mirrorer: me }))

  const peerLists = await readEachPeer(peerMembersOf(space.members, me), async (member, budget) => {
    const mirrors = await readPeerMirrors(member.publicKey, spaceId, budget)
    return mirrors ? mirrors.map((m) => ({ ...m, mirrorer: member.publicKey })) : []
  })

  return [...own, ...peerLists.flat()]
}

// Records are keyed mirror/<spaceId>/<shareId>, so fetch exactly the one share per peer with a point
// read rather than scanning every member's whole mirror set and filtering.
export async function listMirrorsForShare(spaceId, shareId) {
  const space = await getSpace(spaceId)
  if (!space || space.leaving) return []

  const me = getLocalPublicKeyHex()
  const own = await readOwnMirror(spaceId, shareId)
  const ownTagged = own ? [{ ...own, mirrorer: me }] : []

  const peerRecs = await readEachPeer(peerMembersOf(space.members, me), async (member, budget) => {
    const rec = await readPeerMirror(member.publicKey, spaceId, shareId, budget)
    return rec ? { ...rec, mirrorer: member.publicKey } : null
  })

  return [...ownTagged, ...peerRecs.filter(Boolean)]
}
