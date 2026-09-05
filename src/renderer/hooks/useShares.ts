// Aggregates a space's folder shares with roles (mine / mirrored / browse) and mount status;
// re-derives on shares-scoped reconcile hints, which the store delivers.
//
// The two mount listings take no parameters, so they are one store entry each, shared by every
// space.
import { useCallback, useMemo } from 'react'
import { request } from '../ipc.js'
import { useQuery } from '../store/useQuery.js'
import { invalidateKey, refetchQuery } from '../store/query-store.js'
import { unhealthyOwnedStatus } from '../ownedMount.js'
import { ANY_SHARES, sharesScope } from '../store/scopes.js'
import type { OwnedMountRow } from '../ownedMount.js'
import type { Share, ShareRole, ForeignFolderMount } from '../types.js'

// Dropped when a space leaves the roster, so re-joining the same id never renders the rows it held
// before (the twin of pruneRosterCache / pruneMirrorCache, called from the same place).
export function pruneShareCache (liveSpaceIds: string[]) {
  const live = new Set(liveSpaceIds)
  invalidateKey((key) => {
    if (!key.startsWith('share:list?')) return false
    const match = /spaceId=([^&]*)/.exec(key)
    return match ? !live.has(match[1]) : false
  })
}

export interface ShareWithRole extends Share {
  role: ShareRole
  mirrorEnabled?: boolean
  mountStatus?: string
  mirrorStatus?: string
}


const NO_SHARES: Share[] = []
const NO_FOREIGN: ForeignFolderMount[] = []
const NO_OWNED: OwnedMountRow[] = []

export function useShares(spaceId: string, myPublicKey: string | null) {
  const shareScopes = useMemo(() => sharesScope(spaceId), [spaceId])
  const params = spaceId ? { spaceId } : {}

  // Share/mirror changes — including owned and foreign mount-status transitions, both mapped to the
  // shares scope worker-side — invalidate all three entries.
  //
  // The two mount listings take no parameters, so they are ONE entry shared by every space. Their
  // scope must therefore be the WILDCARD { kind: 'shares' }: an entry keeps the scopes it was first
  // registered with, so pinning it to a spaceId would mean only the first space visited in the
  // session could ever invalidate it, and a mirror toggle in any later space would leave the role
  // badge wrong until the user left and re-entered.
  const shares = useQuery<Share[]>('share:list', params, shareScopes, { enabled: Boolean(spaceId) })
  const foreign = useQuery<ForeignFolderMount[]>('foreign-folder:list-all', {}, ANY_SHARES)
  const owned = useQuery<OwnedMountRow[]>('owned-folder:list-all', {}, ANY_SHARES)

  const { mirrored, mirrorStatus, ownedStatus } = useMemo(() => {
    const mmap = new Map<string, boolean>()
    // The mirror's own durable status, not just its enabled flag: an auto-paused mirror reads as
    // disabled, so without this the card cannot tell a user pause from a fault.
    const smap = new Map<string, string>()
    for (const m of foreign.data ?? NO_FOREIGN) {
      if (m.spaceId !== spaceId) continue
      mmap.set(m.shareId, m.enabled !== false)
      if (m.status) smap.set(m.shareId, m.status)
    }
    const omap = new Map<string, string>()
    for (const m of owned.data ?? NO_OWNED) {
      if (m.spaceId !== spaceId) continue
      const bad = unhealthyOwnedStatus(m)
      if (bad) omap.set(m.shareId, bad)
    }
    return { mirrored: mmap, mirrorStatus: smap, ownedStatus: omap }
  }, [foreign.data, owned.data, spaceId])

  const withRole: ShareWithRole[] = useMemo(() => (shares.data ?? NO_SHARES).map((s) => {
    const role = roleFor(s, myPublicKey, mirrored)
    return {
      ...s,
      // One resolution point for the whole renderer: `name` is what people read, and the immutable
      // on-disk name the worker keys drive paths with stays where the worker put it. Anything that
      // must round-trip the real name reads `s.name` off the raw record instead.
      name: s.displayName || s.name,
      role,
      mirrorEnabled: role === 'mirrored' ? mirrored.get(s.id) ?? true : undefined,
      mirrorStatus: role === 'mirrored' ? mirrorStatus.get(s.id) : undefined,
      mountStatus: role === 'mine' ? ownedStatus.get(s.id) : undefined,
    }
  }), [shares.data, myPublicKey, mirrored, mirrorStatus, ownedStatus])

  // All three reads gate it, as the pre-store refresh() did with Promise.all: with share:list alone,
  // a warm listing could paint before foreign-folder:list-all arrived, roleFor would see an empty
  // mirror map, and an already-mirrored folder would render as a browse card offering "Mirror".
  const cold = shares.data === undefined || foreign.data === undefined || owned.data === undefined
  const loading = cold && (shares.loading || foreign.loading || owned.loading)

  // Through the store, not around it: calling request() directly would pay three worker reads
  // (share:list alone costs per-member head-pulls) and throw every result away, because the entries
  // the hook renders from would never see them.
  const refresh = useCallback(async () => {
    if (!spaceId) return
    await Promise.all([
      refetchQuery('share:list', { spaceId }),
      refetchQuery('foreign-folder:list-all', {}),
      refetchQuery('owned-folder:list-all', {}),
    ]).catch(() => {})
  }, [spaceId])

  const createShare = useCallback(
    async (name: string) => (await request('share:create', { spaceId, name })) as Share,
    [spaceId],
  )

  const deleteShare = useCallback(
    async (shareId: string) => { await request('share:delete', { spaceId, shareId }) },
    [spaceId],
  )

  return { shares: spaceId ? withRole : [], loading, refresh, createShare, deleteShare }
}

function roleFor(share: Share, myPublicKey: string | null, mirrored: Map<string, boolean>): ShareRole {
  if (myPublicKey && share.owner === myPublicKey) return 'mine'
  if (mirrored.has(share.id)) return 'mirrored'
  return 'browse'
}
