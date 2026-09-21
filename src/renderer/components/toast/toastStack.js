// Past MAX_VISIBLE the oldest auto-dismissing toast makes room, never the one just shown. A sticky
// toast (duration <= 0) waits on the user or on the condition it reports, so it is never evicted:
// when only stickies stand behind the newest toast, the stack grows past the cap.
/** @import { ToastItem } from './types.js' */

export const MAX_VISIBLE = 4

/**
 * @param {readonly ToastItem[]} items
 * @param {ToastItem} item
 * @returns {ToastItem[]}
 */
export function pushToast(items, item) {
  const next = [...items.filter((t) => t.id !== item.id), item]
  let excess = next.length - MAX_VISIBLE
  if (excess <= 0) return next
  const kept = []
  for (const toast of next) {
    if (excess > 0 && toast !== item && toast.duration > 0) {
      excess -= 1
      continue
    }
    kept.push(toast)
  }
  return kept
}
