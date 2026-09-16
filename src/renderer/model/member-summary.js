/** @import { SpaceMember } from '../types/types.js' */

/** @typedef {{ total: number, stack: SpaceMember[], overflow: number }} MemberSummary */

/** @param {SpaceMember[]} members @param {{ stackMax?: number }} [opts] @returns {MemberSummary} */
export function summarizeMembers(members, opts = {}) {
  const stackMax = opts.stackMax ?? 8
  const list = Array.isArray(members) ? members : []
  const total = list.length
  return {
    total,
    stack: list.slice(0, stackMax),
    overflow: Math.max(0, total - stackMax),
  }
}
