// Owns a space's member roster, online-presence set, and pending join requests; re-derives on the
// members and join-requests scopes (README.md). The roster is the SAME store entry useSpaceMembers
// reads: one space:members read between them.
import { useMemo } from 'react'
import { useQuery } from '../store/useQuery.js'
import { membersScopes } from './useSpaceMembers.js'
import type { JoinRequest, SpaceMember } from '../types/types.js'
import type { MemberReach } from '../../shared/contract/member-reach.js'

const NO_MEMBERS: SpaceMember[] = []
const NO_REQUESTS: JoinRequest[] = []
const NO_KEYS: string[] = []
const NO_REACH: Record<string, MemberReach> = {}

export function useMembers(spaceId: string) {
  const params = { spaceId }
  const scopes = membersScopes(spaceId)
  const joinScopes = [{ kind: 'join-requests', spaceId }]
  // A falsy id means the ids are not ready, not "fetch with no id": the contract validator would
  // refuse a space:members with no spaceId, costing a warn and a counter per render.
  const enabled = { enabled: Boolean(spaceId) }

  const { data: members } = useQuery('space:members', params, scopes, enabled)
  // Online status is a projection of the presence lease (members:online, self included worker-side),
  // re-fetched on every transition. Never a delta-fed Set, so a missed transition cannot strand a
  // dead peer as "online".
  const { data: online } = useQuery('members:online', params, scopes, enabled)
  // How each of them is reached, on the same scope: a relay↔direct flip pokes `members` exactly as
  // a presence transition does, so one invalidation refreshes both facts together.
  const { data: reach } = useQuery('members:reach', params, scopes, enabled)
  const { data: requests } = useQuery('space:pending-requests', params, joinScopes, enabled)

  const list = useMemo(() => {
    const keys = new Set(online ?? NO_KEYS)
    const paths = reach?.members ?? NO_REACH
    return (members ?? NO_MEMBERS)
      .map((m) => ({ ...m, online: keys.has(m.publicKey), reach: paths[m.publicKey] ?? null }))
      .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0))
  }, [members, online, reach])

  return { members: spaceId ? list : NO_MEMBERS, requests: requests ?? NO_REQUESTS }
}
