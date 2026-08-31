// Owns the space-wide storage summary (folders + loose files) for the storage widget. The store
// holds the stale-while-revalidate cache and the latest-wins guard; the 750 ms window stays here
// because it is per-view tuning — a large index emits one hint per catalog append, which must not
// become a per-append full re-drain.
import { useQuery } from '../store/useQuery.js'

export interface SpaceStorageSummary {
  totalBytes: number
  onDeviceBytes: number
}

// Three change signals feed the space-wide total: loose files, folder-share files, and share
// add/remove/mirror — all mapped to reconcile scopes worker-side (share-files as a wildcard).
function storageScopes(spaceId: string) {
  return [
    { kind: 'files', spaceId },
    { kind: 'shares', spaceId },
    { kind: 'share-files', spaceId },
  ]
}

export function useSpaceStorage(spaceId: string): SpaceStorageSummary | null {
  const { data } = useQuery<SpaceStorageSummary>(
    'space:storage-summary',
    { spaceId },
    storageScopes(spaceId),
    { coalesceMs: 750, enabled: Boolean(spaceId) },
  )
  return spaceId ? (data ?? null) : null
}
