// Aggregates a space's folder shares with roles (mine / mirrored / browse) and mount status; re-derives on shares-scoped reconcile hints.
import { useState, useEffect, useCallback } from 'react'
import { request, subscribe } from '../ipc.js'
import { useLatestWins } from './useLatestWins.js'
import { Scope, scopeMatches, type Scope as ScopeType } from '../scope.js'
import { unhealthyOwnedStatus } from './useFolderMount.js'
import type { Share, ShareRole, ForeignFolderMount, OwnedFolderMount } from '../types.js'

export interface ShareWithRole extends Share {
  role: ShareRole
  mirrorEnabled?: boolean
  mountStatus?: string
}

export function useShares(spaceId: string, myPublicKey: string | null) {
  const [shares, setShares] = useState<Share[]>([])
  const [mirrored, setMirrored] = useState<Map<string, boolean>>(new Map())
  // Every non-healthy owned status has a durable form (mount.status persists paused-error
  // too), so refresh() rebuilds the whole badge map from owned-folder:list-all — a missed
  // event costs latency until the next refresh, never a stale or lost badge.
  const [ownedStatus, setOwnedStatus] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)

  const begin = useLatestWins()

  // Latest-wins guard (mirrors useFiles): share:list pays per-member ~1.5s-budget head-pulls
  // and IPC resolves concurrently, so a slow refresh can settle AFTER a newer one — without
  // the guard the stale snapshot would revert setShares/setOwnedStatus. A rejection keeps the
  // last-good rows; a later event-driven refresh re-derives.
  const refresh = useCallback(async () => {
    if (!spaceId) return
    const isCurrent = begin()
    setLoading(true)
    try {
      const [list, foreign, owned] = await Promise.all([
        request('share:list', { spaceId }) as Promise<Share[]>,
        request('foreign-folder:list-all') as Promise<ForeignFolderMount[]>,
        request('owned-folder:list-all') as Promise<(OwnedFolderMount & { mountPointMissing?: boolean })[]>,
      ])
      if (!isCurrent()) return
      setShares(list)
      const mmap = new Map<string, boolean>()
      for (const m of foreign) {
        if (m.spaceId === spaceId) mmap.set(m.shareId, m.enabled !== false)
      }
      setMirrored(mmap)
      const omap = new Map<string, string>()
      for (const m of owned) {
        if (m.spaceId !== spaceId) continue
        const bad = unhealthyOwnedStatus(m)
        if (bad) omap.set(m.shareId, bad)
      }
      setOwnedStatus(omap)
    } catch {
      // keep the last-good rows
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [spaceId, begin])

  useEffect(() => {
    if (!spaceId) return
    refresh()
    // Level-triggered: share/mirror changes (incl. owned + foreign mount-status transitions, both
    // mapped to the shares scope worker-side) re-derive via the coalesced reconcile hint.
    const unsubReconcile = subscribe<{ scope: ScopeType }>('event:reconcile', (msg) => {
      if (scopeMatches(msg.scope, Scope.shares(spaceId))) refresh()
    })
    return () => { unsubReconcile() }
  }, [spaceId, refresh])

  const withRole: ShareWithRole[] = shares.map((s) => {
    const role = roleFor(s, myPublicKey, mirrored)
    return {
      ...s,
      role,
      mirrorEnabled: role === 'mirrored' ? mirrored.get(s.id) ?? true : undefined,
      mountStatus: role === 'mine' ? ownedStatus.get(s.id) : undefined,
    }
  })

  const createShare = useCallback(
    async (name: string) => {
      return (await request('share:create', { spaceId, name })) as Share
    },
    [spaceId]
  )

  const deleteShare = useCallback(
    async (shareId: string) => {
      await request('share:delete', { spaceId, shareId })
    },
    [spaceId]
  )

  return { shares: withRole, loading, refresh, createShare, deleteShare }
}

function roleFor(share: Share, myPublicKey: string | null, mirrored: Map<string, boolean>): ShareRole {
  if (myPublicKey && share.owner === myPublicKey) return 'mine'
  if (mirrored.has(share.id)) return 'mirrored'
  return 'browse'
}
