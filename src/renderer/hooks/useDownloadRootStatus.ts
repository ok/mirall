// Which download folders are currently unreachable — deleted, ejected, on a disconnected
// network share, or replaced by a file. Drives the app-level banner and the Storage Settings
// warning, so the user learns the folder is gone instead of reading "Transfer failed" on every
// download that tries to land there.
import { useCallback } from 'react'
import { useQuery } from '../store/useQuery.js'
import { refetchQuery } from '../store/query-store.js'

interface RootsStatus {
  unavailable?: string[]
}

const NO_ROOTS: string[] = []

const list = (res: RootsStatus | undefined) => (Array.isArray(res?.unavailable) ? res.unavailable : NO_ROOTS)

// Scope-less: `event:download-roots-status` carries the whole answer and installPushBridges
// (store/reconcile.ts) pushes it into this entry. Never subscribe here — two components mount this
// hook, and a per-hook writer double-writes (README.md). A failed read keeps the last value, so a
// worker that is not up yet cannot clear a banner that is currently correct. Reading the entry
// re-probes every folder on the worker, so a screen reads it `passive`ly: the always-mounted
// DownloadFolderToastBridge reads it once, and the pushes keep it fresh.
export function useDownloadRootStatus({ passive = false }: { passive?: boolean } = {}) {
  const { data } = useQuery('downloads:roots-status', {}, null, { passive })

  const refresh = useCallback(async () => {
    await refetchQuery<RootsStatus>('downloads:roots-status', {}, null).catch(() => undefined)
  }, [])

  return { unavailable: list(data), refresh }
}
