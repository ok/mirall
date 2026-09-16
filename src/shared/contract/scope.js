// Canonical identity for a re-derivable view. A reconcile hint carries a Scope; a view consumes
// hints whose Scope matches its own. One declaration for all three runtimes.

/**
 * @typedef {{ kind: 'files', spaceId: string }
 *   | { kind: 'shares', spaceId: string }
 *   | { kind: 'share-files', spaceId: string, shareId?: string }
 *   | { kind: 'members', spaceId: string }
 *   | { kind: 'mirrors', spaceId: string, shareId?: string }
 *   | { kind: 'join-requests', spaceId: string }
 *   | { kind: 'audit' }} Scope
 */

/** @typedef {{ kind: string, spaceId?: string, shareId?: string }} ScopePattern */

export const Scope = {
  /** @param {string} spaceId @returns {Scope} */
  files: (spaceId) => ({ kind: 'files', spaceId }),
  /** @param {string} spaceId @returns {Scope} */
  shares: (spaceId) => ({ kind: 'shares', spaceId }),
  /** @param {string} spaceId @param {string} [shareId] @returns {Scope} */
  shareFiles: (spaceId, shareId) => ({ kind: 'share-files', spaceId, shareId }),
  /** @param {string} spaceId @returns {Scope} */
  members: (spaceId) => ({ kind: 'members', spaceId }),
  /** @param {string} spaceId @param {string} [shareId] @returns {Scope} */
  mirrors: (spaceId, shareId) => ({ kind: 'mirrors', spaceId, shareId }),
  /** @param {string} spaceId @returns {Scope} */
  joinRequests: (spaceId) => ({ kind: 'join-requests', spaceId }),
  // Not space-scoped: the viewer's default listing is cross-space, and its space filter
  // re-derives from the same refetch.
  /** @returns {Scope} */
  audit: () => ({ kind: 'audit' }),
}

// A hint matches a view iff the kind is equal and every id field the VIEW pins is equal.
// A broad hint may omit an id (e.g. shareId) to mean "every view of that kind in the space".
/** @param {ScopePattern | null | undefined} hint @param {ScopePattern} view */
export function scopeMatches(hint, view) {
  if (!hint || !view || hint.kind !== view.kind) return false
  if (view.spaceId != null && hint.spaceId != null && hint.spaceId !== view.spaceId) return false
  if (view.shareId != null && hint.shareId != null && hint.shareId !== view.shareId) return false
  return true
}
