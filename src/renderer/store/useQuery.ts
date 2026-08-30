import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { fetchQuery, keyOf, peek, subscribeKey } from './query-store.js'
import type { QuerySnapshot } from './query-store.js'
import type { ScopePattern } from '../../shared/contract/scope.js'
import type { RequestName } from '../../shared/contract/requests.js'

// useSyncExternalStore rather than a useState mirror: the store already holds the value, and the
// five hand-rolled module caches this replaces each kept a second copy in component state that
// could disagree with it.
export function useQuery<T>(
  type: RequestName,
  params: Record<string, unknown> = {},
  scopes: ScopePattern | ScopePattern[] | null = null,
  opts: { coalesceMs?: number; enabled?: boolean } = {},
): QuerySnapshot<T> {
  const key = keyOf(type, params)
  const subscribe = useCallback((notify: () => void) => subscribeKey(key, notify), [key])
  const snapshot = useCallback(() => peek<T>(key), [key])
  const entry = useSyncExternalStore(subscribe, snapshot, snapshot)

  const enabled = opts.enabled !== false
  useEffect(() => {
    // `enabled: false` is how a hook says "the ids are not ready yet". Without it a falsy spaceId
    // would send space:members with no spaceId, which the contract validator refuses — one
    // req-invalid warn and one INVALID_ARGUMENT counter per render.
    if (!enabled) return
    // The rejection is the hook's business, not the effect's: the store keeps the error on the
    // entry and the caller renders it. Swallowed here so an unmounted view cannot warn.
    void fetchQuery<T>(type, params, scopes, opts).catch(() => {})
  }, [key, enabled])

  return entry
}
