import { subscribe } from '../ipc.js'
import { invalidate } from './query-store.js'
import type { ScopePattern } from '../../shared/contract/scope.js'

// ONE reconcile subscription for the whole app. Nine hooks each held their own and each ran
// scopeMatches; the store now does it once and invalidates by predicate.
export function installReconcileBridge(): () => void {
  return subscribe<{ scope?: ScopePattern }>('event:reconcile', (msg) => {
    if (msg.scope) invalidate(msg.scope)
  })
}
