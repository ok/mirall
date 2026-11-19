// The transfer limits the app offers as one-click choices, and how a limit is written out. A limit
// is in KB/s, a KB being 1,000 bytes as in every size the app shows; 0 means unlimited.

// Usability floor for a non-zero limit: below it the app looks broken. The worker clamps to the
// same value (bandwidth-limiter.js, which carries the rationale).
export const MIN_KBPS = 32
export const PRESET_KBPS = [0, 1000, 5000, 25000]

/** @param {number} kbps */
export function isPresetLimit(kbps) {
  return PRESET_KBPS.includes(kbps)
}

// The limit that is stored for a typed number: the worker enforces the same floor, and a lower
// stored value would read differently from the rate actually used.
/** @param {number} kbps */
export function clampLimit(kbps) {
  return kbps > 0 ? Math.max(MIN_KBPS, kbps) : 0
}

/**
 * @param {number} kbps
 * @param {string} unlimited the translated word for no limit
 */
export function limitLabel(kbps, unlimited) {
  if (kbps === 0) return unlimited
  return kbps % 1000 === 0 ? `${kbps / 1000} MB/s` : `${kbps} KB/s`
}
