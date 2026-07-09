// Owns the space-wide storage summary (folders + loose files) for the storage widget:
// stale-while-revalidate cache, latest-wins refresh, one coalescer over the three
// change signals (loose reconcile, share-file updates, share add/remove/mirror toggle).
import { useState, useEffect, useCallback, useRef } from 'react'
import { request, subscribe } from '../ipc.js'
import { makeCoalescer } from '../coalesce.js'
import { Scope, scopeMatches, type Scope as ScopeType } from '../scope.js'

export interface SpaceStorageSummary {
  totalBytes: number
  onDeviceBytes: number
}

// Last-known summary per space, kept across mounts and space switches so a
// reopened space renders its numbers instantly instead of flashing "0 B"
// (mirrors useFiles' listingCache).
const summaryCache = new Map<string, SpaceStorageSummary>()

export function useSpaceStorage(spaceId: string) {
  const [summary, setSummary] = useState<SpaceStorageSummary | null>(() => summaryCache.get(spaceId) ?? null)
  const seqRef = useRef(0)

  const refresh = useCallback(async () => {
    if (!spaceId) return
    // Latest-wins guard (mirrors useFiles): peer catalog drains are bounded but
    // concurrent, so a slow refresh may resolve after a newer one.
    const seq = ++seqRef.current
    try {
      const res = await request('space:storage-summary', { spaceId }) as SpaceStorageSummary
      if (seq !== seqRef.current) return
      summaryCache.set(spaceId, res)
      setSummary(res)
    } catch {
      // Keep the last-known summary; the next event-driven refresh self-corrects.
    }
  }, [spaceId])

  useEffect(() => {
    if (!spaceId) return
    setSummary(summaryCache.get(spaceId) ?? null)
    // One trailing refresh per burst — a large index emits one event per catalog
    // append, which must not become a per-append full re-drain.
    const coalescer = makeCoalescer(() => { void refresh() }, { intervalMs: 750 })
    void refresh()
    // Three change signals feed the space-wide total: loose files, folder-share files, and share
    // add/remove/mirror — all mapped to reconcile scopes worker-side (share-files as a wildcard).
    const unsubReconcile = subscribe<{ scope: ScopeType }>('event:reconcile', (msg) => {
      if (scopeMatches(msg.scope, Scope.files(spaceId)) ||
          scopeMatches(msg.scope, Scope.shares(spaceId)) ||
          scopeMatches(msg.scope, Scope.shareFiles(spaceId))) coalescer.trigger()
    })
    return () => { coalescer.cancel(); unsubReconcile() }
  }, [spaceId, refresh])

  return summary
}
