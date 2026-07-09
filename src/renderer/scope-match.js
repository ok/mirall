// Pure hint↔view matcher, kept as plain JS so it unit-tests in the same runner as the worker
// scope.js (test/unit/scope.test.js asserts the two agree pairwise-exhaustively). scope.ts
// re-exports this alongside the Scope type. Byte-identical to the worker matcher: a null/absent
// id on EITHER side is a wildcard on that axis, for every kind — any drift between the two
// copies silently drops or misroutes reconcile hints once POKE_SCOPE grows a new kind.
export function scopeMatches(hint, view) {
  if (!hint || !view || hint.kind !== view.kind) return false
  if (hint.spaceId != null && view.spaceId != null && hint.spaceId !== view.spaceId) return false
  if (hint.shareId != null && view.shareId != null && hint.shareId !== view.shareId) return false
  return true
}
