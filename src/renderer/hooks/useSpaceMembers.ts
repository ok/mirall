// Shared per-space roster (avatars included) for card facepiles: spaces:list ships slim rosters, so
// avatar-rendering consumers read space:members once per space — the entry useMembers also reads.
import { useQuery } from '../store/useQuery.js'
import { pruneByParam } from '../store/query-store.js'
import type { SpaceMember } from '../types/types.js'

const EMPTY: SpaceMember[] = []

export function membersScopes(spaceId: string) {
  return [{ kind: 'members', spaceId }]
}

// Left/deleted spaces must not keep their rosters (avatars included) cached for the session —
// useSpaces prunes against every fresh spaces list.
export function pruneRosterCache(liveSpaceIds: Iterable<string>) {
  pruneByParam(['space:members'], 'spaceId', liveSpaceIds)
}

export function useSpaceMembers(spaceId: string): SpaceMember[] {
  const { data } = useQuery<SpaceMember[]>('space:members', { spaceId }, membersScopes(spaceId), { enabled: Boolean(spaceId) })
  return spaceId ? (data ?? EMPTY) : EMPTY
}
