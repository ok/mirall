// How a network-status value reads: the placeholder for a value the frame does not carry, the
// masked spelling of a sensitive one, and the count/age formats the rows share. A revealable field
// and the bulk copy of a whole screen mask alike, or the copy is a quieter promise than the row.
const DOTS = '••••••••'

/** The stand-in for a value the status frame does not carry. */
export const DASH = '—'

/** @param {string | null} value @param {number} [visibleSuffix] @returns {string} */
export function maskValue(value, visibleSuffix = 0) {
  if (!value) return DASH
  if (visibleSuffix > 0 && value.length > visibleSuffix) return `${DOTS} ${value.slice(-visibleSuffix)}`
  return DOTS
}

/** @param {number | null | undefined} value @returns {string} */
export function formatNumber(value) {
  if (value === null || value === undefined) return DASH
  return value.toLocaleString()
}

/** @param {number | null} ms @param {number} now @returns {string} */
export function formatRelativeTime(ms, now) {
  if (ms === null) return DASH
  const seconds = Math.floor(Math.max(0, now - ms) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
