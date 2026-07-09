// Shared per-space roster cache (avatars included) for card facepiles: spaces:list ships slim
// rosters, so avatar-rendering consumers read space:members once per space — stale-while-
// revalidate, refreshed on members-scoped reconcile hints.
import { useState, useEffect } from 'react'
import { request, subscribe } from '../ipc.js'
import { Scope, scopeMatches, type Scope as ScopeType } from '../scope.js'
import type { SpaceMember } from '../types.js'

const rosterCache = new Map<string, SpaceMember[]>()

// Left/deleted spaces must not keep their rosters (avatars included) cached for the
// session — useSpaces prunes against every fresh spaces list.
export function pruneRosterCache(liveSpaceIds: Iterable<string>) {
  const live = new Set(liveSpaceIds)
  for (const key of rosterCache.keys()) {
    if (!live.has(key)) rosterCache.delete(key)
  }
}

export function useSpaceMembers(spaceId: string): SpaceMember[] {
  const [members, setMembers] = useState<SpaceMember[]>(() => rosterCache.get(spaceId) ?? [])

  useEffect(() => {
    if (!spaceId) return
    let alive = true
    let seq = 0
    // Latest-wins: a stale response settling last would both render and poison the
    // module cache that seeds every later mount.
    const load = () => {
      const s = ++seq
      request('space:members', { spaceId }).then((result) => {
        if (!alive || s !== seq) return
        const roster = result as SpaceMember[]
        rosterCache.set(spaceId, roster)
        setMembers(roster)
      }).catch(() => {})
    }
    const cached = rosterCache.get(spaceId)
    if (cached) setMembers(cached)
    load()
    const unsub = subscribe<{ scope: ScopeType }>('event:reconcile', (msg) => {
      if (scopeMatches(msg.scope, Scope.members(spaceId))) load()
    })
    return () => { alive = false; unsub() }
  }, [spaceId])

  return members
}
