// Past MAX_VISIBLE the oldest auto-dismissing toast makes room, never the one just shown and never
// one the user is hovering or focused on. A sticky toast waits on the user or on the condition it
// reports, so it is never evicted: when nothing behind the newest toast can go, the stack grows past
// the cap. A replacement under an id already on screen adds nothing, so it evicts nothing.
/** @import { ToastItem } from './types.js' */

/** @internal */
export const MAX_VISIBLE = 4

/** @param {number} duration */
export function isSticky(duration) {
  return !(duration > 0)
}

/**
 * @param {readonly ToastItem[]} items
 * @param {ToastItem} item
 * @param {ReadonlySet<string>} [paused]
 * @returns {ToastItem[]}
 */
export function pushToast(items, item, paused = new Set()) {
  const replacing = items.some((t) => t.id === item.id)
  const next = [...items.filter((t) => t.id !== item.id), item]
  let excess = replacing ? 0 : next.length - MAX_VISIBLE
  if (excess <= 0) return next
  const kept = []
  for (const toast of next) {
    if (excess > 0 && toast !== item && !isSticky(toast.duration) && !paused.has(toast.id)) {
      excess -= 1
      continue
    }
    kept.push(toast)
  }
  return kept
}

/**
 * @param {readonly ToastItem[]} items
 * @param {string} id
 * @param {string} message
 */
export function isShown(items, id, message) {
  return items.some((t) => t.id === id && t.message === message)
}
