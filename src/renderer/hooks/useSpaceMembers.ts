// Shared per-space roster (avatars included) for card facepiles: spaces:list ships slim rosters, so
// avatar-rendering consumers read space:members once per space. The store holds the cache and the
// latest-wins guard now, and — because useMembers reads the same entry — the two hooks that both
// fetched this per members hint issue ONE request between them.
import { useQuery } from '../store/useQuery.js'
import { invalidateKey } from '../store/query-store.js'
import type { SpaceMember } from '../types.js'

const EMPTY: SpaceMember[] = []

export function membersScopes(spaceId: string) {
  return [{ kind: 'members', spaceId }]
}

// Left/deleted spaces must not keep their rosters (avatars included) cached for the session —
// useSpaces prunes against every fresh spaces list.
export function pruneRosterCache(liveSpaceIds: Iterable<string>) {
  const live = new Set(liveSpaceIds)
  invalidateKey((key) => {
    if (!key.startsWith('space:members?')) return false
    const spaceId = key.slice('space:members?spaceId='.length)
    return !live.has(spaceId)
  })
}

export function useSpaceMembers(spaceId: string): SpaceMember[] {
  const { data } = useQuery<SpaceMember[]>('space:members', { spaceId }, membersScopes(spaceId), { enabled: Boolean(spaceId) })
  return spaceId ? (data ?? EMPTY) : EMPTY
}
