import type { ScopePattern } from '../../shared/contract/scope.js'
import type { RequestName } from '../../shared/contract/requests.js'
import type { RequestOptions } from '../ipc.js'

export interface QuerySnapshot<T> {
  data: T | undefined
  error: Error | null
  loading: boolean
}

export declare function configureQueryStore (opts: {
  request: (type: RequestName, params?: Record<string, unknown>, opts?: RequestOptions) => Promise<unknown>
}): void
export declare function keyOf (type: RequestName, params?: Record<string, unknown>): string
export declare function fetchQuery<T> (type: RequestName, params?: Record<string, unknown>, scopes?: ScopePattern | ScopePattern[] | null, opts?: { coalesceMs?: number }): Promise<T>
export declare function invalidate (hint: ScopePattern): string[]
export declare function subscribeKey (key: string, notify: () => void): () => void
export declare const EMPTY_SNAPSHOT: QuerySnapshot<never>
export declare function peek<T> (key: string): QuerySnapshot<T>
export declare function refetchQuery<T> (type: RequestName, params?: Record<string, unknown>, scopes?: ScopePattern | ScopePattern[] | null): Promise<T>
export declare function invalidateKey (shouldDrop: (key: string) => boolean): string[]
export declare function resetQueryStore (): void
export declare function setQueryData<T> (type: RequestName, params: Record<string, unknown>, data: T, scopes?: ScopePattern | ScopePattern[] | null): string
export declare function storeStats (): { entries: number; inFlight: number }
