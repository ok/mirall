// Which notice the relay section owes the user, if any. The mismatch itself is contract/ — the
// worker decides on the same rule — and the restart case is added here because it exists only in
// the renderer: a pinned identity is applied by a worker respawn this screen asks for.
/** @import { RelayStatus } from '../types/types.js' */
/** @import { RelayMode } from '../platform/config-client.js' */
import { relayMismatch } from '../../shared/contract/relay-apply.js'

/** @typedef {'restart' | 'stale-relayed' | 'stale-direct' | 'replaced-relay'} RelayApplyNotice */

/**
 * @param {{ mode: RelayMode, relay: RelayStatus | null, armed: boolean, pendingIdentity: boolean }} state
 * @returns {RelayApplyNotice | null}
 */
export function relayApplyNotice({ mode, relay, armed, pendingIdentity }) {
  // A pinned identity is fixed when the DHT node is built, so it outranks the rest: no reconnect can
  // apply it, and offering one would send the user round a loop that cannot end.
  if (pendingIdentity) return 'restart'
  if (!armed) return null
  return relayMismatch(mode, relay)
}

// Whether a restart is still owed after a relay write. A removal settles it: with no relay to dial,
// the member identity the worker booted with is presented to no one, and a restart an earlier add or
// replace was waiting on has nothing left to apply. Any other write keeps what was owed and adds what
// the worker says it needs.
/**
 * @param {{ pending: boolean, removal: boolean, identityChanged: boolean }} state
 * @returns {boolean}
 */
export function restartOwed({ pending, removal, identityChanged }) {
  if (removal) return false
  return pending || identityChanged
}
