// The one rule behind the folder-share file limit. The add-folder preview, the worker's mount
// gate and the renderer all read it from here so they cannot drift: a folder the gate ADMITS
// must always render in full.
import { getListFilesCap, getMaxFilesPerShare } from '../core/runtime-config.js'

export function exceedsShareFileLimit(fileCount) {
  const limit = getMaxFilesPerShare()
  return Number.isFinite(limit) && fileCount > limit
}

// The mirror's constraint, and a different one from exceedsShareFileLimit: mounting a peer share
// creates no share of your own, so admission does not apply — but the display ceiling does, and a
// mirror of an over-cap share lists short exactly like an owned one would. Reads the display cap
// rather than the admission limit because that is the ceiling a mirror actually meets — the two are
// held equal by default, so today they agree, but only one of them is the mirror's reason.
export function listingWillTruncate(fileCount) {
  const cap = getListFilesCap()
  return Number.isFinite(cap) && fileCount > cap
}

export function shareFileLimitMessage(fileCount) {
  return `This folder has ${fileCount} files. Shared folders are limited to ${getMaxFilesPerShare()} files.`
}

// Whether a listing read actually withheld rows — the fact the worker reports so the renderer never
// has to infer it. Two ways to be sure rows are missing, and the cap must have been hit for either:
//   - a COMPLETE read counted more than it returned (a folder over the limit), or
//   - the read was INCOMPLETE, so its own `total` is partial and cannot prove otherwise — assume
//     rows are missing rather than let the truncation go silent, which is how it hid before.
// A folder sitting exactly ON the cap is fully listed and is NOT truncated.
export function listingTruncated({ rowCount, total, cap, complete }) {
  if (!Number.isFinite(cap) || rowCount < cap) return false
  return total > rowCount || !complete
}
