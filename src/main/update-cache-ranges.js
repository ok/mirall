// Which blocks of the update drive's blob core one version still needs. Pure, so the range
// arithmetic is unit-tested without a store.

// Sorted, merged half-open [start, end) block ranges covering every blob one version references: a
// blob's own blocks, plus the data blocks its block map points at (a deduplicated file may reuse
// blocks an earlier version wrote).
function keptRanges(blobs) {
  const ranges = []
  for (const blob of blobs) {
    if (blob.blockLength > 0) ranges.push([blob.blockOffset, blob.blockOffset + blob.blockLength])
    for (const index of blob.mapBlocks || []) ranges.push([index, index + 1])
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

// Everything in [0, length) outside the kept ranges.
function clearableGaps(kept, length) {
  const gaps = []
  let at = 0
  for (const [start, end] of kept) {
    if (start >= length) break
    if (start > at) gaps.push([at, start])
    at = Math.max(at, end)
  }
  if (at < length) gaps.push([at, length])
  return gaps
}

module.exports = { keptRanges, clearableGaps }
