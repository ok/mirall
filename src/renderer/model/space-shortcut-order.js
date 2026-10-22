// The order the ⌘1-9 shortcuts number favorites in: the oldest created or joined on this device first.
// A space that is not a favorite gets no digit. Activity reorders the home screen, never the
// shortcuts: a digit moves only when a space is favorited or unfavorited, or a favorite before it is
// left. A new favorite goes last.
/** @import { Space } from '../../shared/contract/responses.js' */

/**
 * @template {Pick<Space, 'spaceId' | 'created' | 'favorite'>} S
 * @param {S[]} spaces
 * @returns {S[]}
 */
export function shortcutOrder(spaces) {
  return spaces.filter((s) => s.favorite).sort((a, b) =>
    (Date.parse(a.created) || 0) - (Date.parse(b.created) || 0)
    || a.spaceId.localeCompare(b.spaceId))
}
