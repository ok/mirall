// How each member of a space is reached, folded from the sockets that carry them. This is the one
// statement of both rules the roster runs on: a person is relayed when ANY of their live sockets
// runs through a relay and direct only when every one is direct — a relayed byte is a relayed byte
// whichever plane spends it — and a person no live socket carries has no entry at all, neither
// direct nor relayed. Liveness is `members:online`'s fact; this one is only the path.
//
// Pure over what the caller hands in, so the rule is testable without a swarm; the caller composes
// it with the live registries.
import { MEMBER_REACH } from '../contract/member-reach.js'

/** @import { MemberReach } from '../contract/member-reach.js' */

/**
 * @param {Iterable<[string, object[]]>} socketsByMember  personKey → the sockets carrying them
 * @param {(socket: object) => boolean} isRelayed
 * @returns {Record<string, MemberReach>}
 */
export function memberReach(socketsByMember, isRelayed) {
  /** @type {Record<string, MemberReach>} */
  const out = {}
  for (const [personKey, sockets] of socketsByMember) {
    const live = sockets.filter(Boolean)
    if (live.length === 0) continue
    out[personKey] = live.some(isRelayed) ? MEMBER_REACH.RELAYED : MEMBER_REACH.DIRECT
  }
  return out
}
