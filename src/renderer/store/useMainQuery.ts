import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { fetchMain, peekMain, subscribeMain, writeMain } from './main-store.js'
import type { MainSnapshot } from './main-store.js'
import type { MainQueryName, MainQueryValue } from './main-queries.js'

// The thin hook over main-store.js, mirroring useQuery over query-store.js: the store owns the
// fetching, dedup and caching; this owns only the React binding.
//
// `enabled: false` is how a screen says "this fact is not needed on this platform" — the same
// escape hatch usePrefs needs for the menu-bar toggle, which does not exist on macOS.
export function useMainQuery<K extends MainQueryName>(
  name: K,
  opts: { enabled?: boolean } = {},
): MainSnapshot<MainQueryValue[K]> & { write: (value: MainQueryValue[K]) => Promise<MainQueryValue[K]> } {
  const enabled = opts.enabled !== false
  const subscribe = useCallback((notify: () => void) => subscribeMain(name, notify), [name])
  const snapshot = useCallback(() => peekMain(name), [name])
  const entry = useSyncExternalStore(subscribe, snapshot, snapshot)

  useEffect(() => {
    if (!enabled) return
    // The rejection is the caller's business, not the effect's: the store keeps the error on the
    // entry and the screen renders it. Swallowed here so an unmounted view cannot warn.
    void fetchMain(name).catch(() => {})
  }, [name, enabled])

  const write = useCallback((value: MainQueryValue[K]) => writeMain(name, value), [name])
  return { ...entry, write }
}
