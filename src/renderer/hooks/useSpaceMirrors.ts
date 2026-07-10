// Who is mirroring a given share, from the durable `mirror/<spaceId>/<shareId>` records — a
// participation fact that survives peers being offline (unlike the live serve ledger). Request-once
// + module cache, refreshed on mirrors-scoped reconcile hints, mirroring useSpaceMembers.
import { useState, useEffect } from 'react'
import { request, subscribe } from '../ipc.js'
import { Scope, scopeMatches, type Scope as ScopeType } from '../scope.js'
import type { MirrorParticipant } from '../types.js'

const cache = new Map<string, MirrorParticipant[]>()
const keyOf = (spaceId: string, shareId: string) => spaceId + '/' + shareId

// Left/deleted spaces must not keep their mirror lists cached for the session — useSpaces prunes
// against every fresh spaces list (parity with useSpaceMembers' pruneRosterCache).
export function pruneMirrorCache(liveSpaceIds: Iterable<string>) {
  const live = new Set(liveSpaceIds)
  for (const key of cache.keys()) {
    if (!live.has(key.slice(0, key.indexOf('/')))) cache.delete(key)
  }
}

export function useSpaceMirrors(spaceId: string, shareId: string): MirrorParticipant[] {
  const [mirrors, setMirrors] = useState<MirrorParticipant[]>(() => cache.get(keyOf(spaceId, shareId)) ?? [])

  useEffect(() => {
    if (!spaceId || !shareId) return
    let alive = true
    let seq = 0
    const load = () => {
      const s = ++seq
      request('space:mirrors', { spaceId, shareId }).then((result) => {
        if (!alive || s !== seq) return
        const list = result as MirrorParticipant[]
        cache.set(keyOf(spaceId, shareId), list)
        setMirrors(list)
      }).catch(() => {})
    }
    const cached = cache.get(keyOf(spaceId, shareId))
    if (cached) setMirrors(cached)
    load()
    const unsub = subscribe<{ scope: ScopeType }>('event:reconcile', (msg) => {
      if (scopeMatches(msg.scope, Scope.mirrors(spaceId, shareId))) load()
    })
    return () => { alive = false; unsub() }
  }, [spaceId, shareId])

  return mirrors
}
