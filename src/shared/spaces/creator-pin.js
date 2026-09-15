// The durable creator-root pin: which key a space record trusts as the root of its membership
// OR-Set, how sure we are of it, and the two one-shot boot passes that bring older records up to
// the current shape. creator-root.js decides WHETHER an asserted root may be adopted; this module
// is what persists the outcome.
import { getLocalPublicKeyHex } from './profile.js'
import { listSpaces, mutateSpace } from './space.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('creator-pin')

// Authoritatively pin the now-authenticated OR-Set root and clear the provisional
// flag. The caller (onGrant / the handshake cross-check) has already verified the asserting
// peer's identity binding, so this root is no longer a bearer hint. creatorMigrated stamps the
// space past the one-shot migration so no later boot can downgrade this pin to provisional.
export function pinCreatorKey(spaceId, root) {
  return mutateSpace(spaceId, (s) => ({ ...s, creatorKey: root, creatorUnverified: false, creatorDivergence: false, creatorMigrated: true }))
}

// A confirmed creator-root conflict: an authenticated peer asserted a different root than our
// authenticated pin (potential roster split-brain / impersonation). Persist it durably so the UI
// surfaces a level-triggered warning that survives a missed event; the pin is left untouched (we
// refuse the assertion). Sticky while the conflict is live (the divergent peer's next assertion
// re-refuses); cleared by clearCreatorDivergence when an authenticated peer re-asserts the pin,
// or by pinCreatorKey when the root is re-authenticated.
export function markCreatorDivergence(spaceId) {
  return mutateSpace(spaceId, (s) => ({ ...s, creatorDivergence: true }))
}

// An authenticated peer re-asserted the pinned root (a `noop` reconcile decision) — the
// conflict is no longer live, so the divergence warning clears. Level-triggered lifecycle:
// re-derived per assertion, never latched.
export function clearCreatorDivergence(spaceId) {
  return mutateSpace(spaceId, (s) => (s.creatorDivergence ? { ...s, creatorDivergence: false } : s))
}

// Backfill the OR-Set root for v2 spaces whose stored record predates `creatorKey`.
// A space I created is identifiable by `sckDerivable` (set only by createSpace, never
// by a join), so I am its root — stamp myself. Joined spaces whose creatorKey is
// unknown (their invite carried no `c` hint) are deliberately left untouched: the
// membership fold falls back to seeding from the known member set for them until a
// fresh invite or an authenticated handshake assertion supplies the real creator.
// Idempotent; returns the count stamped.
export async function backfillSelfCreatedCreatorKey() {
  const me = getLocalPublicKeyHex()
  if (!me) return 0
  let stamped = 0
  for (const space of await listSpaces()) {
    if (space.creatorKey || !space.sckDerivable) continue
    const ok = await mutateSpace(space.spaceId, (s) => ({ ...s, creatorKey: me }))
    if (ok) stamped += 1
  }
  if (stamped) log.info('backfilled creatorKey on', stamped, 'self-created space(s)')
  return stamped
}

// A space we JOINED whose creatorKey is only TOFU-pinned (trust-on-first-use — it came
// from a bearer invite, not an authenticated assertion) is marked unverified, arming the
// handshake divergence cross-check and letting the UI flag an unverified owner. It does NOT
// self-heal through onGrant — an approved space never re-enters the grant flow — so the
// authenticated re-confirmation comes from the handshake `creator` assertion. Self-created
// (sckDerivable) spaces are untouched. One-shot per space (creatorMigrated stamp):
// re-flagging on every boot would downgrade an authenticated pin back to provisional,
// re-opening the adopt path to a divergent root after any restart. Returns the count flagged.
export async function flagUnverifiedJoinedCreators() {
  let flagged = 0
  for (const space of await listSpaces()) {
    if (space.sckDerivable) continue
    if (space.creatorMigrated) continue
    if (!space.creatorKey || space.creatorUnverified) {
      // Nothing to flag, but stamp it so a later authenticated pin is never re-armed either.
      await mutateSpace(space.spaceId, (s) => ({ ...s, creatorMigrated: true }))
      continue
    }
    if (await mutateSpace(space.spaceId, (s) => ({ ...s, creatorUnverified: true, creatorMigrated: true }))) flagged += 1
  }
  if (flagged) log.info('flagged', flagged, 'joined space(s) creatorKey unverified')
  return flagged
}
