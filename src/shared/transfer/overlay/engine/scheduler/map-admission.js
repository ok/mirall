// Whether a chunk list can describe the file being fetched. Chunking is deterministic (same bytes,
// same tier), so every honest holder of a hash sends the same map; any difference is a fault in
// the sender.

export const sameMap = (a, b) => a.length === b.length && a.every((c, i) => c.hash === b[i].hash && c.length === b[i].length)

// The most entries a map of a file this size can hold, or null with no known size.
export function maxMapEntries(expectedSize, tier) {
  return tier === null ? null : Math.ceil(expectedSize / tier.minSize) + 1
}

// Why this list cannot describe the file, or null. With a known size the list must sum to it, hold
// no more entries than the size's tier allows and keep every length inside the tier's bounds; once
// a map is adopted, any other list must equal it.
export function mapFault(chunks, { expectedSize, tier, adopted }) {
  if (expectedSize !== null) {
    if (chunks.length > maxMapEntries(expectedSize, tier)) return 'too many chunks'
    let total = 0
    for (const c of chunks) {
      if (!Number.isSafeInteger(c.length) || c.length < 1 || c.length > tier.maxSize) return 'chunk length out of range'
      total += c.length
    }
    if (total !== expectedSize) return 'size mismatch'
  }
  if (adopted && !sameMap(adopted, chunks)) return 'differs from the adopted map'
  return null
}
