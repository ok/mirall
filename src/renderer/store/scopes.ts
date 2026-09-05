import type { ScopePattern } from '../../shared/contract/scope.js'

// The view scopes more than one hook re-derives on, declared once.
//
// These are load-bearing rather than cosmetic: an entry keeps the scopes it was FIRST registered
// with (entryFor only adopts them while the list is empty), so whichever hook mounts first decides
// the invalidation set for the whole session. Three copies of the same constant meant a divergence
// between them would surface as an entry that silently stops re-deriving — not as a type error.

// `owned-folder:list-all` and `foreign-folder:list-all` take no parameters, so each is ONE entry
// shared by every space. Pinning either to a spaceId would mean only the first space visited in the
// session could ever invalidate it, and a mirror toggle in any later space would leave the badge
// wrong until the user left and re-entered.
export const ANY_SHARES: ScopePattern[] = [{ kind: 'shares' }]

// `spaces:list` spans every space, so it is a WILDCARD view on the members and join-requests axes:
// any hint of either kind re-derives it.
export const SPACES_SCOPES: ScopePattern[] = [{ kind: 'members' }, { kind: 'join-requests' }]

// The per-space form, for the reads that DO take a spaceId. Both mount-status events are mapped to
// the shares scope worker-side, so this is what carries a mount transition to a view.
export const sharesScope = (spaceId: string): ScopePattern[] => [{ kind: 'shares', spaceId }]
