// Canonical identity for a re-derivable view. A reconcile hint carries a Scope; a view
// consumes hints whose Scope matches its own. Kept in sync with src/renderer/scope.ts (the
// renderer can't import from the worker data layer).

export const Scope = {
  files: (spaceId) => ({ kind: 'files', spaceId }),
  shares: (spaceId) => ({ kind: 'shares', spaceId }),
  shareFiles: (spaceId, shareId) => ({ kind: 'share-files', spaceId, shareId }),
  members: (spaceId) => ({ kind: 'members', spaceId }),
  joinRequests: (spaceId) => ({ kind: 'join-requests', spaceId }),
}

// A hint matches a view iff the kind is equal and every id field the VIEW pins is equal.
// A broad hint may omit an id (e.g. shareId) to mean "every view of that kind in the space".
export function scopeMatches(hint, view) {
  if (!hint || !view || hint.kind !== view.kind) return false
  if (view.spaceId != null && hint.spaceId != null && hint.spaceId !== view.spaceId) return false
  if (view.shareId != null && hint.shareId != null && hint.shareId !== view.shareId) return false
  return true
}
