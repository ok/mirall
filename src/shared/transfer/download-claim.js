// The claim → status decision for one downloaded-copy record, with every filesystem fact passed in.
// Pure and dependency-free so the ORDER below is asserted directly rather than through a bee and a
// real disk, and so a caller holding a pre-read record need not re-read it.
//
// The order is load-bearing:
//   1. no record                 → not downloaded, nothing to prune
//   2. file gone, volume gone    → the VOLUME is detached (ejected drive, dropped network share),
//                                  not a deletion: report not-downloaded but KEEP the claim, so
//                                  reattaching the disk restores the status instead of having
//                                  destroyed the record and invited a duplicate re-download
//   3. file gone, volume present → the user deleted the copy, or the folder it was in → PRUNE
//   4. hash moved upstream       → the owner replaced the file → PRUNE
//   5. otherwise                 → downloaded, wherever the copy was downloaded to
export function claimVerdict({ rec, exists, volumePresent, currentHash = null }) {
  if (!rec) return { downloaded: false, prune: false, reason: 'no-claim' }
  if (!exists) {
    if (!volumePresent) return { downloaded: false, prune: false, reason: 'volume-unavailable' }
    return { downloaded: false, prune: true, reason: 'local-file-gone' }
  }
  if (rec.hash && currentHash && rec.hash !== currentHash) {
    return { downloaded: false, prune: true, reason: 'content-changed-upstream' }
  }
  return { downloaded: true, prune: false, reason: null }
}

// Whether a listed row's claim is that row's own copy, kept on a volume that is not connected.
// Claims are keyed by name, which another owner's file and this owner's replaced one can share, and
// rule 2 keeps a claim whatever its hash, so only a claim naming the row's content is its copy.
/**
 * @param {{ reason: string | null }} verdict @param {{ hash?: string | null } | null} rec
 * @param {string | null | undefined} contentHash @returns {boolean}
 */
export function isDetachedCopy(verdict, rec, contentHash) {
  return verdict.reason === 'volume-unavailable' && !!contentHash && rec?.hash === contentHash
}
