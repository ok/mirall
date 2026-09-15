// The single-pass fold every catalog listing runs: count and byte-sum EVERY entry while
// retaining only the first `limit` rows, so the display list and its total come from one
// traversal and can never disagree. An entry whose relPath would escape the mount is in
// neither the count nor the rows. `onEach` observes every counted entry regardless of `limit`.
import { relKeyEscapes } from '../folders/path-keys.js'

export function entryTally(limit = Infinity, onEach = null) {
  const entries = []
  let total = 0
  let totalBytes = 0
  return {
    add(entry) {
      if (relKeyEscapes(entry.relPath)) return false
      total += 1
      if (Number.isFinite(entry.size)) totalBytes += entry.size
      onEach?.(entry)
      if (entries.length < limit) entries.push(entry)
      return true
    },
    result() {
      return { entries, total, totalBytes }
    },
  }
}
