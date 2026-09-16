import { reconcileFiles } from './share-files-reconcile.js'
import { deriveFolderInfo } from './folder-info.js'

// The listing folded across successive share:list-files responses. A peer read can come back empty
// or partial while the owner is still indexing, so a response is merged into what is on screen
// rather than replacing it — reconcileFiles decides how, from the worker's `complete` flag.
//
// Kept as a pure fold so the never-blank rule is testable without React, and so the query store
// never has to interpret a response: the store holds the raw answer, this turns a sequence of
// answers into the list.
/** @import { ShareFileEntry } from '../types/types.js' */
/** @import { FolderInfo, ListResult } from './folder-info.js' */

/**
 * @template E
 * @typedef {{ res: ListResult<E> | null, rows: ShareFileEntry[], info: FolderInfo | null }} Fold
 */

/** @typedef {Error & { code?: string }} ListingError */
/** @typedef {{ rows: ShareFileEntry[], info: FolderInfo | null, error: ListingError | null, terminal: boolean }} ResolvedListing */

/** @type {Fold<never>} */
export const emptyFold = Object.freeze({ res: null, rows: [], info: null })

/**
 * @template E
 * @param {Fold<E>} prev
 * @param {ListResult<E> | null} res
 * @param {(entry: E) => ShareFileEntry} toEntry
 * @returns {Fold<E>}
 */
export function foldListing(prev, res, toEntry) {
  if (!res) return prev
  if (res === prev.res) return prev
  const mapped = res.entries.map(toEntry)
  // reconcileFiles returns the PREVIOUS array reference when nothing moved, which is what lets
  // React skip the row subtree on a listing that did not change.
  const rows = reconcileFiles(prev.rows, mapped, { complete: res.complete })
  return { res, rows, info: deriveFolderInfo(res, rows) }
}

// A gone or access-revoked share is terminal: the rows must be cleared, or a deleted share lingers
// as a phantom listing. Every other failure — a timeout, a peer that went quiet mid-read — keeps
// what is on screen, because blanking a folder on a blip is the worse outcome. The error is
// surfaced only when there is nothing left to look at.
//
// The error is returned as it arrived, not as its message: turning it into text needs the
// translator, and this module stays pure so the never-blank rule is testable without React.
/** @type {Set<string | undefined>} */
const TERMINAL_CODES = new Set(['SHARE_NOT_FOUND', 'EOWNERSHIP'])

/**
 * @template E
 * @param {Fold<E>} fold
 * @param {ListingError | null} error
 * @returns {ResolvedListing}
 */
export function resolveListing(fold, error) {
  const terminal = !!error && TERMINAL_CODES.has(error.code)
  if (terminal) return { rows: emptyFold.rows, info: null, error, terminal }
  const surfaced = error && fold.rows.length === 0 ? error : null
  return { rows: fold.rows, info: fold.info, error: surfaced, terminal }
}
