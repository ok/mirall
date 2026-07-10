// Mirror of src/shared/state/scope.js (the renderer can't import worker code). A reconcile hint
// carries a Scope; a view re-derives when a hint matches its own Scope. scopeMatches lives in the
// plain-JS sibling so it unit-tests alongside the worker copy.
export { scopeMatches } from './scope-match.js'

export type Scope =
  | { kind: 'files'; spaceId: string }
  | { kind: 'shares'; spaceId: string }
  | { kind: 'share-files'; spaceId: string; shareId?: string }
  | { kind: 'members'; spaceId: string }
  | { kind: 'mirrors'; spaceId: string; shareId?: string }
  | { kind: 'join-requests'; spaceId: string }

export const Scope = {
  files: (spaceId: string): Scope => ({ kind: 'files', spaceId }),
  shares: (spaceId: string): Scope => ({ kind: 'shares', spaceId }),
  shareFiles: (spaceId: string, shareId?: string): Scope => ({ kind: 'share-files', spaceId, shareId }),
  members: (spaceId: string): Scope => ({ kind: 'members', spaceId }),
  mirrors: (spaceId: string, shareId?: string): Scope => ({ kind: 'mirrors', spaceId, shareId }),
  joinRequests: (spaceId: string): Scope => ({ kind: 'join-requests', spaceId }),
}

