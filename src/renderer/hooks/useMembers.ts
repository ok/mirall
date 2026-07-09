// Owns a space's member roster, online-presence set, and pending join requests; re-derives on members- and join-requests-scoped reconcile hints.
import { useState, useEffect } from 'react'
import { request, subscribe } from '../ipc.js'
import { Scope, scopeMatches, type Scope as ScopeType } from '../scope.js'
import type { JoinRequest, SpaceMember } from '../types.js'

export function useMembers(spaceId: string) {
  const [members, setMembers] = useState<SpaceMember[]>([])
  const [onlineKeys, setOnlineKeys] = useState<Set<string>>(new Set())
  const [requests, setRequests] = useState<JoinRequest[]>([])

  useEffect(() => {
    if (!spaceId) return
    setMembers([])
    setOnlineKeys(new Set())
    setRequests([])
    let alive = true
    let onlineSeq = 0
    let membersSeq = 0

    // Latest-wins: hint-driven fetches settle in completion order, so without the seq a
    // slow stale roster read can land last and latch a departed member until the next hint.
    const refreshMembers = () => {
      const seq = ++membersSeq
      request('space:members', { spaceId }).then((result) => {
        if (!alive || seq !== membersSeq) return
        setMembers(result as SpaceMember[])
      }).catch(() => {})
    }

    // Online status is a projection of the presence lease (members:online, self included
    // worker-side), re-fetched on every transition — a member-left/avatar event or a
    // members-updated (which the worker also fires on a silent-death lease expiry and a
    // same-socket lease restore). Never a delta-fed Set, so a missed transition can't
    // strand a dead peer as "online".
    const refreshOnline = () => {
      const seq = ++onlineSeq
      request('members:online', { spaceId }).then((result) => {
        if (!alive || seq !== onlineSeq) return
        setOnlineKeys(new Set(result as string[]))
      }).catch(() => {})
    }

    const refreshRequests = () => {
      request('space:pending-requests', { spaceId }).then((r) => {
        if (alive) setRequests(r as JoinRequest[])
      }).catch(() => {})
    }

    refreshMembers()
    refreshRequests()
    refreshOnline()

    // Level-triggered: the roster + online set re-derive on any members-scoped hint (join, leave,
    // avatar change, silent-death lease expiry, lease restore), the pending list on any
    // join-requests hint. A handshake join arrives as a post-persist members hint (member-joined
    // fires pre-persist and is deliberately not a poke source).
    const unsubReconcile = subscribe<{ scope: ScopeType }>('event:reconcile', (msg) => {
      if (scopeMatches(msg.scope, Scope.members(spaceId))) { refreshMembers(); refreshOnline() }
      if (scopeMatches(msg.scope, Scope.joinRequests(spaceId))) refreshRequests()
    })

    return () => { alive = false; unsubReconcile() }
  }, [spaceId])

  const list = members
    .map(m => ({ ...m, online: onlineKeys.has(m.publicKey) }))
    .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0))

  return { members: list, requests }
}
