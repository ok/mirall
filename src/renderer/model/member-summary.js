/** @import { SpaceMember } from '../types/types.js' */

/** @typedef {{ total: number, stack: SpaceMember[], overflow: number }} MemberSummary */

/** @typedef {{ stack: unknown[], overflow: number }} FacepileSlice */

/**
 * The faces a strip shows and the remainder it counts.
 *
 * A `+1` chip is never drawn: it takes exactly the disc the face it hides would have taken, so it
 * costs a face and buys nothing. A lone overflow is therefore absorbed — the strip shows one past
 * its cap and the chip starts at `+2`.
 *
 * `total` may exceed what `available` holds, because a slim roster ships names without avatars: a
 * face we do not have cannot be shown, so that remainder still counts and a `+1` can survive there.
 * That is the one case where the chip is the honest answer rather than a wasted disc.
 *
 * @template T
 * @param {T[]} available @param {number} stackMax @param {number} [total]
 * @returns {{ stack: T[], overflow: number }}
 */
export function facepileSlice(available, stackMax, total) {
  const list = Array.isArray(available) ? available : []
  const count = Math.max(total ?? list.length, 0)
  const capacity = count <= stackMax + 1 ? stackMax + 1 : stackMax
  const stack = list.slice(0, Math.min(capacity, count))
  return { stack, overflow: Math.max(0, count - stack.length) }
}

/** @param {SpaceMember[]} members @param {{ stackMax?: number }} [opts] @returns {MemberSummary} */
export function summarizeMembers(members, opts = {}) {
  const list = Array.isArray(members) ? members : []
  const { stack, overflow } = facepileSlice(list, opts.stackMax ?? 8)
  return { total: list.length, stack, overflow }
}
