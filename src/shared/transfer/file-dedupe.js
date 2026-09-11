// Folds a space's per-owner loose-file candidates into the listing's rows: one row per distinct
// file, the most-progressed copy winning and the rest counted as `sharedByCount`. Pure (no drive,
// no bee) so `test/unit` can drive it under plain Node.

// Most-progressed first, so the group's winner is the copy the user can act on. `downloading` and
// `publishing` tie — a peer fetch and our own indexing are equally in flight — and a tie keeps
// candidate order, which is member order. Every FILE_STATUS member carries a rank: a status
// missing from this table makes the comparator return NaN, and an inconsistent comparator leaves
// the group's winner unspecified.
// test seam
export const STATUS_RANK = Object.freeze({
  mine: 0,
  downloaded: 1,
  verifying: 2,
  downloading: 3,
  publishing: 3,
  'paused-interrupted': 4,
  'paused-offline': 5,
  remote: 6,
  preparing: 7,
  unavailable: 8,
  error: 9,
})

// Content hash identifies a file across owners, but a row whose owner is still hashing carries no
// hash yet. An empty hash is an absence, not an identity: those rows key on owner AND path, so
// each file being prepared stays its own row and two owners preparing the same name are not
// merged on the strength of the name. Once a hash lands the row folds across owners as usual.
function groupKey(candidate) {
  if (candidate.hash) return 'hash:' + candidate.hash
  return 'unhashed:' + (candidate.owner?.publicKey || '') + ':' + candidate.path
}

export function dedupeFileRows(candidates) {
  const groups = new Map()
  for (const candidate of candidates) {
    const key = groupKey(candidate)
    const group = groups.get(key)
    if (group) group.push(candidate)
    else groups.set(key, [candidate])
  }

  const files = []
  for (const group of groups.values()) {
    group.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
    const [winner] = group
    const others = group.length - 1
    files.push(others > 0 ? { ...winner, sharedByCount: others } : winner)
  }
  return files
}
