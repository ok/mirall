// The claim → status decision for one downloaded-copy record, with every filesystem and config
// fact passed in. Pure and dependency-free so the ORDER below is asserted directly rather than
// through a bee and a real disk, and so the batched share listing can reach the same decision
// from a pre-read record without re-reading it.
//
// The order is load-bearing:
//   1. no record                 → not downloaded, nothing to prune
//   2. file gone, folder gone    → the VOLUME is detached (ejected drive, dropped network share),
//                                  not a deletion: report not-downloaded but KEEP the claim, so
//                                  reattaching the disk restores the status instead of having
//                                  destroyed the record and invited a duplicate re-download
//   3. file gone, folder present → the user deleted the copy → PRUNE
//   4. hash moved upstream       → the owner replaced the file → PRUNE
//   5. outside the space's pinned download folder → not downloaded, KEEP. Non-destructive by
//                                  design: pointing the space back at the old folder must restore
//                                  the status. The check keys on the space's OVERRIDE, never on
//                                  the effective root — following the global root is no promise
//                                  about where a space's downloads live, so changing the global
//                                  folder must not un-download every space that never opted in.
//   6. otherwise                 → downloaded
export function claimVerdict({ rec, exists, dirExists, currentHash = null, pinned = null, insidePinned = true }) {
  if (!rec) return { downloaded: false, prune: false, reason: 'no-claim' }
  if (!exists) {
    if (!dirExists) return { downloaded: false, prune: false, reason: 'volume-unavailable' }
    return { downloaded: false, prune: true, reason: 'local-file-gone' }
  }
  if (rec.hash && currentHash && rec.hash !== currentHash) {
    return { downloaded: false, prune: true, reason: 'content-changed-upstream' }
  }
  if (pinned && !insidePinned) return { downloaded: false, prune: false, reason: 'outside-space-folder' }
  return { downloaded: true, prune: false, reason: null }
}
