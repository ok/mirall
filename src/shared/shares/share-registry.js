// The merged share listing for a space: own share records plus every member's,
// tagged with their owner and deduped by (owner, id).
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { getSpace } from '../spaces/space.js'
import { readOwnShares, readPeerShares } from './shares.js'
import { interactiveReadTimeoutMs } from '../core/with-timeout.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('share-registry')

export async function listSharesForSpace(spaceId) {
  const space = await getSpace(spaceId)
  if (!space) return []

  const me = getLocalPublicKeyHex()
  const own = await readOwnShares(spaceId)
  const ownTagged = own.map((s) => ({ ...s, owner: me, source: 'own' }))

  const peerKeys = (space.members || [])
    .map((m) => m.publicKey)
    .filter((k) => k && k !== me)

  // Interactive fan-out: bound each peer read to the short interactive budget so one
  // un-replicated member can't stall share:list — the renderer refreshes on event:shares-updated
  // when the peer's profile bee appends.
  const budget = interactiveReadTimeoutMs()
  const peerLists = await Promise.all(
    peerKeys.map(async (peerKey) => {
      const shares = await readPeerShares(peerKey, spaceId, budget)
      if (!shares) return []
      return shares.map((s) => ({ ...s, owner: peerKey, source: 'peer' }))
    })
  )

  const merged = [...ownTagged, ...peerLists.flat()]
  return dedupeByKey(merged)
}

export async function listOwnSharesForSpace(spaceId) {
  return await readOwnShares(spaceId)
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

export function logRegistryRefresh(spaceId, count) {
  log.debug('refreshed shares for', spaceId, '— count:', count)
}
