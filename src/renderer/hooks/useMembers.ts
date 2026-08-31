// Owns a space's member roster, online-presence set, and pending join requests; re-derives on
// members- and join-requests-scoped reconcile hints, which the store delivers by invalidating the
// three entries below. The roster is the SAME store entry useSpaceMembers reads, so one members
// hint now costs one space:members read between them rather than two.
import { useMemo } from 'react'
import { useQuery } from '../store/useQuery.js'
import { membersScopes } from './useSpaceMembers.js'
import type { JoinRequest, SpaceMember } from '../types.js'

const NO_MEMBERS: SpaceMember[] = []
const NO_REQUESTS: JoinRequest[] = []
const NO_KEYS: string[] = []

export function useMembers(spaceId: string) {
  const params = { spaceId }
  const scopes = membersScopes(spaceId)
  const joinScopes = [{ kind: 'join-requests', spaceId }]
  // A falsy id means the ids are not ready, not "fetch with no id": the contract validator would
  // refuse a space:members with no spaceId, costing a warn and a counter per render.
  const enabled = { enabled: Boolean(spaceId) }

  const { data: members } = useQuery<SpaceMember[]>('space:members', params, scopes, enabled)
  // Online status is a projection of the presence lease (members:online, self included worker-side),
  // re-fetched on every transition. Never a delta-fed Set, so a missed transition cannot strand a
  // dead peer as "online".
  const { data: online } = useQuery<string[]>('members:online', params, scopes, enabled)
  const { data: requests } = useQuery<JoinRequest[]>('space:pending-requests', params, joinScopes, enabled)

  const list = useMemo(() => {
    const keys = new Set(online ?? NO_KEYS)
    return (members ?? NO_MEMBERS)
      .map((m) => ({ ...m, online: keys.has(m.publicKey) }))
      .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0))
  }, [members, online])

  return { members: spaceId ? list : NO_MEMBERS, requests: requests ?? NO_REQUESTS }
}
