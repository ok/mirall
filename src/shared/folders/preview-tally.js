// The shape both scan previews return, and the one place the per-file detail cap is applied. The
// two flows classify differently — an owner compares an mtime it trusts, a mirror compares a
// verified-download record it wrote itself — but they answer the same dialog, and one component
// renders both. Keeping the accumulator here makes "the two previews agree on their shape" an
// assertion rather than a convention.
//
// No bare-* imports, so it unit-tests under Node alongside preview-detail.js.
import { PREVIEW_DETAIL_MAX_FILES, includePerFile } from './preview-detail.js'

export function createPreviewTally () {
  let count = 0
  let conflicts = 0
  let totalBytes = 0
  const candidates = []

  return {
    // One classified entry that WILL move bytes. Entries that will not move are never added.
    add ({ relPath, size = 0, conflict = false }) {
      count += 1
      if (conflict) conflicts += 1
      totalBytes += size
      if (candidates.length <= PREVIEW_DETAIL_MAX_FILES) candidates.push({ relPath, size, conflict })
    },
    // `direction` is 'upload' or 'download' — the only axis the two flows differ on, and the
    // reason one count can serve both.
    result (flow, direction, extra = {}) {
      const detailed = includePerFile(count)
      return {
        flow,
        toUpload: direction === 'upload' ? count : 0,
        toDownload: direction === 'download' ? count : 0,
        conflicts,
        totalBytes,
        perFile: detailed ? candidates : [],
        perFileOmitted: !detailed,
        ...extra,
      }
    },
  }
}
