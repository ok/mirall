import { reconcileFiles } from './shareFilesReconcile.js'
import { deriveFolderInfo } from './folderInfo.js'

// The listing folded across successive share:list-files responses. A peer read can come back empty
// or partial while the owner is still indexing, so a response is merged into what is on screen
// rather than replacing it — reconcileFiles decides how, from the worker's `complete` flag.
//
// Kept as a pure fold so the never-blank rule is testable without React, and so the query store
// never has to interpret a response: the store holds the raw answer, this turns a sequence of
// answers into the list.
export const emptyFold = Object.freeze({ res: null, rows: [], info: null })

export function foldListing (prev, res, toEntry) {
  if (!res) return prev
  if (res === prev.res) return prev
  const mapped = res.entries.map(toEntry)
  // reconcileFiles returns the PREVIOUS array reference when nothing moved, which is what lets
  // React skip the row subtree on a listing that did not change.
  const rows = reconcileFiles(prev.rows, mapped, { complete: res.complete })
  return { res, rows, info: deriveFolderInfo(res, rows) }
}

// FolderView is reused rather than keyed per share, so a share change must clear the fold or the
// previous share's rows merge into the next one.
export function resetFold () {
  return emptyFold
}

// A gone or access-revoked share is terminal: the rows must be cleared, or a deleted share lingers
// as a phantom listing. Every other failure — a timeout, a peer that went quiet mid-read — keeps
// what is on screen, because blanking a folder on a blip is the worse outcome. The message is
// surfaced only when there is nothing left to look at.
const TERMINAL_CODES = new Set(['NOT_FOUND', 'EOWNERSHIP'])

export function resolveListing (fold, error) {
  const terminal = !!error && TERMINAL_CODES.has(error.code)
  if (terminal) return { rows: emptyFold.rows, info: null, error: error.message, terminal }
  const message = error && fold.rows.length === 0 ? error.message : null
  return { rows: fold.rows, info: fold.info, error: message, terminal }
}
