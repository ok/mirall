// The spaces list while the user is pointing at it or tabbing through it: each space keeps the place
// it had when they started, so a card never moves under the pointer or the focus. A space that arrived
// since goes last, one that is gone drops out, and every card shows its current data.

/**
 * @template {{ spaceId: string }} S
 * @param {S[]} spaces in the order they arrived
 * @param {string[] | null} heldIds the order to hold, or null to hold none
 * @returns {S[]}
 */
export function inHeldOrder(spaces, heldIds) {
  if (!heldIds) return spaces
  const rank = new Map(heldIds.map((id, i) => [id, i]))
  const kept = spaces.filter((s) => rank.has(s.spaceId))
    .sort((a, b) => /** @type {number} */ (rank.get(a.spaceId)) - /** @type {number} */ (rank.get(b.spaceId)))
  return [...kept, ...spaces.filter((s) => !rank.has(s.spaceId))]
}
