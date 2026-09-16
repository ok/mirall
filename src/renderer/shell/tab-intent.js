// Tells user Tab keypresses apart from Chromium's synthetic focus advance. On
// macOS, re-showing the tray-hidden window re-establishes the first responder
// through AppKit's key-view loop; Chromium treats that as tab-traversal into the
// page and focuses the first tabbable element — the skip link — with no keyboard
// input. A legitimate skip-link focus is always preceded by a real Tab keydown,
// so focus arriving without a recent one is synthetic. Timestamps are injected
// so the logic is deterministically testable.
const TAB_INTENT_MS = 250

export function makeTabIntentTracker() {
  let lastTabAt = -Infinity
  return {
    /** @param {string} key @param {number} at */
    noteKeyDown(key, at) {
      if (key === 'Tab') lastTabAt = at
    },
    /** @param {number} at */
    isTabIntent(at) {
      return at - lastTabAt <= TAB_INTENT_MS
    },
  }
}
