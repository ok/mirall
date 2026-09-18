// Which notice the relay section owes the user, if any. The mismatch itself is contract/ — the
// worker decides on the same rule — and the restart case is added here because it exists only in
// the renderer: a pinned identity is applied by a worker respawn this screen asks for.
/** @import { RelayStatus } from '../types/types.js' */
/** @import { RelayMode } from '../platform/config-client.js' */
import { relayMismatch } from '../../shared/contract/relay-apply.js'

/** @typedef {'restart' | 'stale-relayed' | 'stale-direct'} RelayApplyNotice */

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
