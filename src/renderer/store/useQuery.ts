import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { EMPTY_SNAPSHOT, fetchQuery, keyOf, peek, subscribeKey } from './query-store.js'
import type { Snapshot } from './query-store.js'
import type { ScopePattern } from '../../shared/contract/scope.js'
import type { RequestName, RequestParams } from '../../shared/contract/requests.js'
import type { RequestResponse } from '../../shared/contract/responses.js'

// useSyncExternalStore, not a useState mirror: a second copy in component state can disagree with the store.
// Keyed by the request name, not by a free type parameter: `useQuery('spaces:list')` was a
// cast in all but syntax, with nothing relating the two halves.
export function useQuery<K extends RequestName>(
  type: K,
  params: RequestParams = {},
  scopes: ScopePattern | ScopePattern[] | null = null,
  opts: { coalesceMs?: number; enabled?: boolean } = {},
): Snapshot<RequestResponse[K]> {
  const key = keyOf(type, params)
  const enabled = opts.enabled !== false
  // A disabled hook does not fetch, and it must not SUBSCRIBE either. invalidate() refetches any
  // entry with a subscriber, so a disabled consumer — FolderScreen holding useOwnedMount for a
  // mirrored share — kept the shared listing hot and made every shares-scoped hint issue a full
  // owned-folder:list-all (one live stat per owned mount) whose result it then discards. It also
  // stopped subscribeKey minting a scope-less entry for a key nothing ever fetches.
  const subscribe = useCallback(
    (notify: () => void) => (enabled ? subscribeKey(key, notify) : () => {}),
    [key, enabled],
  )
  const snapshot = useCallback(
    () => (enabled ? peek<RequestResponse[K]>(key) : EMPTY_SNAPSHOT as Snapshot<RequestResponse[K]>),
    [key, enabled],
  )
  const entry = useSyncExternalStore(subscribe, snapshot, snapshot)

  useEffect(() => {
    // `enabled: false` is how a hook says "the ids are not ready yet". Without it a falsy spaceId
    // would send space:members with no spaceId, which the contract validator refuses — one
    // req-invalid warn and one INVALID_ARGUMENT counter per render.
    if (!enabled) return
    // The rejection is the hook's business, not the effect's: the store keeps the error on the
    // entry and the caller renders it. Swallowed here so an unmounted view cannot warn.
    void fetchQuery<RequestResponse[K]>(type, params, scopes, opts).catch(() => {})
  }, [key, enabled])

  return entry
}
