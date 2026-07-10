// Owns the spaces list plus create/join/invite actions; refreshes on event:state, membership reconcile hints, and the grant/deny/divergence events.
import { useState, useEffect } from 'react'
import { request, subscribe } from '../ipc.js'
import { scopeMatches, type Scope as ScopeType } from '../scope.js'
import { pruneRosterCache } from './useSpaceMembers.js'
import { pruneMirrorCache } from './useSpaceMirrors.js'
import type { Space } from '../types.js'

export function useSpaces() {
  const [spaces, setSpaces] = useState<Space[]>([])
  const [loading, setLoading] = useState(true)

  async function refresh() {
    const data = await request('spaces:list') as Space[]
    setSpaces(data)
    pruneRosterCache(data.map((s) => s.spaceId))
    pruneMirrorCache(data.map((s) => s.spaceId))
    setLoading(false)
  }

  useEffect(() => {
    refresh()
    const unsub1 = subscribe('event:state', (msg) => {
      if (msg.spaces) {
        const data = msg.spaces as Space[]
        setSpaces(data)
        pruneRosterCache(data.map((s) => s.spaceId))
        pruneMirrorCache(data.map((s) => s.spaceId))
      }
    })
    // This list spans every space, so it is a wildcard view on the members/join-requests axes:
    // any hint of those kinds re-derives it (member joins/leaves/avatars land as post-persist
    // members hints, never the pre-persist member-joined signal). membership-granted/denied/
    // divergence stay named events — they are one-shot user-level signals, not view pokes.
    const unsub2 = subscribe<{ scope?: ScopeType }>('event:reconcile', (msg) => {
      if (scopeMatches(msg.scope, { kind: 'members' }) || scopeMatches(msg.scope, { kind: 'join-requests' })) refresh()
    })
    const unsub3 = subscribe('event:membership-granted', refresh)
    const unsub4 = subscribe('event:membership-denied', refresh)
    const unsub5 = subscribe('event:membership-creator-divergence', refresh)
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5() }
  }, [])

  async function createSpace(name: string, icon: string) {
    const space = await request('space:create', { name, icon }) as Space
    await refresh()
    return space
  }

  async function joinSpace(inviteCode: string, name: string) {
    const space = await request('space:join', { inviteCode, name }) as Space
    await refresh()
    return space
  }

  async function createInvite(spaceId: string, opts: { autoApprove?: boolean; expiresInMs?: number } = {}) {
    return await request('space:invite', { spaceId, autoAdmit: !!opts.autoApprove, expiresInMs: opts.expiresInMs }) as string | null
  }

  async function approveMember(spaceId: string, publicKey: string) {
    await request('space:approve-member', { spaceId, publicKey })
    await refresh()
  }

  async function denyMember(spaceId: string, publicKey: string) {
    await request('space:deny-member', { spaceId, publicKey })
    await refresh()
  }

  async function leaveSpace(spaceId: string) {
    await request('space:leave', { spaceId })
    await refresh()
  }

  async function updateSpace(spaceId: string, name: string, icon: string) {
    const space = await request('space:update', { spaceId, name, icon }) as Space
    await refresh()
    return space
  }

  async function toggleFavorite(spaceId: string) {
    await request('space:toggle-favorite', { spaceId })
    await refresh()
  }

  return { spaces, loading, createSpace, joinSpace, createInvite, leaveSpace, updateSpace, toggleFavorite, approveMember, denyMember, refresh }
}
