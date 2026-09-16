// Where a join link leads, by precedence: undecodable, expired past a grace for clock skew, already
// a member of the space it names, or a fresh join carrying the code and any display name.
import { decodeInvite } from '../../shared/contract/invite-envelope.js'

/** @import { DeepLinkPayload } from '../platform/global.js' */
/** @import { Space } from '../types/types.js' */

/** @typedef {{ kind: 'invalid' } | { kind: 'expired' } | { kind: 'member', space: Space } | { kind: 'join', code: string, name?: string }} DeepLinkRoute */

export const EXPIRY_GRACE_MS = 60_000

/** @param {DeepLinkPayload} link @param {Space[]} spaces @param {number} now @returns {DeepLinkRoute} */
export function routeDeepLink(link, spaces, now) {
  const decoded = decodeInvite(link.code)
  if (!decoded) return { kind: 'invalid' }
  if (decoded.v === 1 && decoded.expiresAt && decoded.expiresAt + EXPIRY_GRACE_MS < now) {
    return { kind: 'expired' }
  }
  const space = spaces.find((s) => s.topic === decoded.topic)
  if (space) return { kind: 'member', space }
  return { kind: 'join', code: link.code, name: link.name }
}
