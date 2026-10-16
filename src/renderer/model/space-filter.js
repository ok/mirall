// The space's filter: one term over loose file names and folder card names, folded the same way
// as the folder filter and the Activity Log (contract/text-fold.js), so a name typed composed
// finds one Finder wrote decomposed. Pure, so test/unit drives it under plain Node.
import { foldSearchText } from '../../shared/contract/text-fold.js'

/** @typedef {{ path: string }} FilterableFile */
/** @typedef {{ name: string, displayName?: string }} FilterableShare */
/**
 * @template {FilterableFile} F
 * @template {FilterableShare} S
 * @typedef {{ files: F[], shares: S[], matched: number | null, total: number }} FilteredSpace
 */

/** @param {string} path */
const leafOf = (path) => path.slice(path.lastIndexOf('/') + 1)

/**
 * `matched` is null with no term, the same contract the folder filter keeps, so the controls row
 * shows a count only while filtering. The count covers files: the field says "N of M files".
 * @template {FilterableFile} F
 * @template {FilterableShare} S
 * @param {{ files: readonly F[], shares: readonly S[] }} input @param {string} term
 * @returns {FilteredSpace<F, S>}
 */
export function filterSpace({ files, shares }, term) {
  const needle = foldSearchText(String(term || '').trim())
  if (!needle) return { files: [...files], shares: [...shares], matched: null, total: files.length }
  const matchedFiles = files.filter((f) => foldSearchText(leafOf(f.path)).includes(needle))
  const matchedShares = shares.filter((s) => foldSearchText(s.displayName ?? s.name).includes(needle) || foldSearchText(s.name).includes(needle))
  return { files: matchedFiles, shares: matchedShares, matched: matchedFiles.length, total: files.length }
}
