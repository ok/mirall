// The merged "who mirrors what" listing for a space: own mirror records plus every member's, each
// tagged with the mirroring peer. Only current members are trusted — a non-member's record is never
// read — mirroring share-registry's member fan-out.
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { getSpace } from '../spaces/space.js'
import { readOwnMirrors, readPeerMirrors, readOwnMirror, readPeerMirror } from './mirror-records.js'
import { interactiveReadTimeoutMs } from '../core/with-timeout.js'

function peerKeysOf(space, me) {
  return (space.members || []).map((m) => m.publicKey).filter((k) => k && k !== me)
}

export async function listMirrorsForSpace(spaceId) {
  const space = await getSpace(spaceId)
  if (!space || space.leaving) return []

  const me = getLocalPublicKeyHex()
  const own = (await readOwnMirrors(spaceId)).map((m) => ({ ...m, mirrorer: me }))

  const budget = interactiveReadTimeoutMs()
  const peerLists = await Promise.all(
    peerKeysOf(space, me).map(async (peerKey) => {
      const mirrors = await readPeerMirrors(peerKey, spaceId, budget)
      if (!mirrors) return []
      return mirrors.map((m) => ({ ...m, mirrorer: peerKey }))
    })
  )

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

  const budget = interactiveReadTimeoutMs()
  const peerRecs = await Promise.all(
    peerKeysOf(space, me).map(async (peerKey) => {
      const rec = await readPeerMirror(peerKey, spaceId, shareId, budget)
      return rec ? { ...rec, mirrorer: peerKey } : null
    })
  )

  return [...ownTagged, ...peerRecs.filter(Boolean)]
}
