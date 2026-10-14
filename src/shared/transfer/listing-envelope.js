// The envelope both file listings answer with. Pure, so `test/unit` drives it under plain Node. A
// loose listing is never capped — each member may share at most MAX_LOOSE_FILES_PER_SPACE — so it is
// never truncated.
/** @import { ContentListing, FileEntry, LooseFileListing } from '../contract/responses.js' */

/** @returns {ContentListing & { entries: never[] }} */
export function emptyListing() {
  return { entries: [], complete: true, total: 0, totalBytes: 0, truncated: false, fileLimit: null }
}

/** @param {FileEntry[]} entries @param {boolean} complete @returns {LooseFileListing} */
export function looseListing(entries, complete) {
  const totalBytes = entries.reduce((sum, row) => sum + (Number.isFinite(row.size) ? row.size : 0), 0)
  return { entries, complete, total: entries.length, totalBytes, truncated: false, fileLimit: null }
}
