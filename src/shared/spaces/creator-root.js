// The single adopt/confirm/refuse rule for a member-set (OR-Set) root assertion, shared by
// the grant path (onGrant) and the handshake cross-check so the two entry points cannot
// drift. The root of trust for a space's membership fold is its creator: a root is adopted
// only from an identity-authenticated assertion — a bearer invite's hint stays provisional.
// `pinned` is our current creatorKey (or null); `pinnedIsAuthenticated` is true once an
// identity-bound member has confirmed it (creatorUnverified cleared); `asserted` is the
// root an authenticated member is now claiming (or null when none was carried).
//   - no assertion ............................ noop
//   - nothing pinned .......................... adopt (first authenticated root wins)
//   - provisional pin, assertion matches ...... confirm (clear the unverified flag)
//   - provisional pin, assertion differs ...... adopt (authenticated > bearer hint; defeats a forged invite)
//   - authenticated pin, assertion matches .... noop
//   - authenticated pin, assertion differs .... refuse (a confirmed root can't be flipped post-hoc)
export function reconcileAssertedRoot ({ pinned, pinnedIsAuthenticated, asserted }) {
  if (!asserted) return 'noop'
  if (!pinned) return 'adopt'
  if (!pinnedIsAuthenticated) return asserted === pinned ? 'confirm' : 'adopt'
  return asserted === pinned ? 'noop' : 'refuse'
}
