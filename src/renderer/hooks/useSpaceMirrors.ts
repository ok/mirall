// Who is mirroring a given share, from the durable `mirror/<spaceId>/<shareId>` records — a
// participation fact that survives peers being offline (unlike the live serve ledger). The store
// holds the cache, the latest-wins guard and the reconcile subscription.
import { useQuery } from '../store/useQuery.js'
import { pruneByParam } from '../store/query-store.js'
import type { MirrorParticipant } from '../types/types.js'

const EMPTY: MirrorParticipant[] = []

// Left/deleted spaces must not keep their mirror lists cached for the session — useSpaces prunes
// against every fresh spaces list (parity with useSpaceMembers' pruneRosterCache).
export function pruneMirrorCache(liveSpaceIds: Iterable<string>) {
  pruneByParam(['space:mirrors'], 'spaceId', liveSpaceIds)
}

export function useSpaceMirrors(spaceId: string, shareId: string): MirrorParticipant[] {
  const ready = Boolean(spaceId && shareId)
  const { data } = useQuery(
    'space:mirrors',
    { spaceId, shareId },
    [{ kind: 'mirrors', spaceId, shareId }],
    { enabled: ready },
  )
  return ready ? (data ?? EMPTY) : EMPTY
}
