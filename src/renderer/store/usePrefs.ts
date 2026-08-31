import { useCallback, useSyncExternalStore } from 'react'
import { loadPrefs, peekPrefs, subscribePrefs, writePrefs } from './prefs-store.js'
import type { AppPrefs } from '../global.js'

// The thin hook over prefs-store.js, mirroring useQuery over query-store.js: the store owns the
// fetching, dedup and caching; this owns only the React binding.
//
// `enabled: false` means "this screen does not need prefs on this platform" — AppearanceSettings
// reads them only for the menu-bar toggle, which does not exist on macOS. Without it, moving that
// screen onto the store would add a prefs round-trip on every Mac.
export function usePrefs(opts: { enabled?: boolean } = {}): {
  prefs: AppPrefs | null
  update: (patch: Partial<AppPrefs>) => Promise<void>
} {
  const enabled = opts.enabled !== false
  const subscribe = useCallback((notify: () => void) => {
    const unsubscribe = subscribePrefs(notify)
    if (enabled) void loadPrefs().catch(() => {})
    return unsubscribe
  }, [enabled])

  const prefs = useSyncExternalStore(subscribe, peekPrefs, peekPrefs)
  const update = useCallback((patch: Partial<AppPrefs>) => writePrefs(patch), [])

  return { prefs, update }
}
