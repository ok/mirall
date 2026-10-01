// The app-update store's size, read from main when the Storage screen mounts. Not a main-store fact:
// it changes on its own after every update pass, so a cached copy would go stale behind the screen.
import { useCallback, useEffect, useState } from 'react'
import type { UpdateCacheInfo } from '../platform/global.js'

export function useUpdateCacheInfo(): { info: UpdateCacheInfo | null; refresh: () => Promise<UpdateCacheInfo> } {
  const [info, setInfo] = useState<UpdateCacheInfo | null>(null)

  const refresh = useCallback(async () => {
    const next = await window.bridge.getUpdateCacheInfo()
    setInfo(next)
    return next
  }, [])

  // A failed read leaves the row at zero rather than blocking the screen; the reason is logged.
  useEffect(() => {
    let cancelled = false
    window.bridge.getUpdateCacheInfo().then(
      (next) => { if (!cancelled) setInfo(next) },
      (err: unknown) => { console.error('update cache size unavailable:', err) },
    )
    return () => { cancelled = true }
  }, [])

  return { info, refresh }
}
