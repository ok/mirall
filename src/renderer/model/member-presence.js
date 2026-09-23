// What the roster says under a member's name. The presence lease decides online vs offline; among
// the online, the reach decides whether the line names the relay. One key per state, so the label
// renders as one text node and assistive tech reads one string.
import { MEMBER_REACH } from '../../shared/contract/member-reach.js'

/** @import { SpaceMember } from '../types/types.js' */

export const MEMBER_PRESENCE = Object.freeze({
  ONLINE: 'online',
  RELAYED: 'relayed',
  OFFLINE: 'offline',
})

/** @typedef {(typeof MEMBER_PRESENCE)[keyof typeof MEMBER_PRESENCE]} MemberPresence */

/** @type {Record<MemberPresence, string>} */
export const PRESENCE_LABEL = Object.freeze({
  online: 'member.online',
  relayed: 'member.relayed',
  offline: 'member.offline',
})

/**
 * An absent `online` reads as online: a row the presence fold has not touched comes from the member
 * list, which only lists members that exist.
 * @param {Pick<SpaceMember, 'online' | 'reach'>} member
 * @returns {MemberPresence}
 */
export function memberPresence(member) {
  if (member.online === false) return MEMBER_PRESENCE.OFFLINE
  return member.reach === MEMBER_REACH.RELAYED ? MEMBER_PRESENCE.RELAYED : MEMBER_PRESENCE.ONLINE
}
