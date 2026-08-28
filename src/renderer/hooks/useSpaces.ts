// Owns the spaces list plus create/join/invite actions; refreshes on event:state, membership reconcile hints, and the grant/deny/divergence events.
import { useState, useEffect } from 'react'
import { request, subscribe } from '../ipc.js'
import { scopeMatches, type Scope as ScopeType } from '../scope.js'
import { pruneRosterCache } from './useSpaceMembers.js'
import { pruneMirrorCache } from './useSpaceMirrors.js'
import { pruneSpaceCardState } from './useSpaceCardState.js'
import { pruneShareCache } from './useShares.js'
import type { Space } from '../types.js'

// Last-known list, shared by every hook instance and kept across mounts. The home screen
// unmounts on every trip into a space, so without this each return starts from zero spaces
// while spaces:list resolves — long enough to paint the "no spaces yet" hero over an account
// that has spaces.
let spacesCache: Space[] | null = null

export function useSpaces() {
  const [spaces, setSpaces] = useState<Space[]>(() => spacesCache ?? [])
  const [loading, setLoading] = useState(() => spacesCache === null)

  function adopt(data: Space[]) {
    spacesCache = data
    setSpaces(data)
    pruneRosterCache(data.map((s) => s.spaceId))
    pruneMirrorCache(data.map((s) => s.spaceId))
    pruneSpaceCardState(data.map((s) => s.spaceId))
    pruneShareCache(data.map((s) => s.spaceId))
  }

  async function refresh() {
    // A rejection must still settle `loading`, or the empty-state gate below it waits forever
    // and the screen stays blank instead of saying there is nothing here.
    try {
      adopt(await request('spaces:list') as Space[])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    const unsub1 = subscribe('event:state', (msg) => {
      if (msg.spaces) adopt(msg.spaces as Space[])
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

  async function updateSpace(spaceId: string, name: string, icon: string, downloadFolder?: string | null) {
    const space = await request('space:update', {
      spaceId,
      name,
      icon,
      ...(downloadFolder !== undefined ? { downloadFolder } : {}),
    }) as Space
    await refresh()
    return space
  }

  async function toggleFavorite(spaceId: string) {
    await request('space:toggle-favorite', { spaceId })
    await refresh()
  }

  return { spaces, loading, createSpace, joinSpace, createInvite, leaveSpace, updateSpace, toggleFavorite, approveMember, denyMember, refresh }
}
