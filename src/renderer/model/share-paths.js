// Pure, dependency-free path helpers for the Add-Folder flow. Kept as plain JS
// (no bare-*/node imports) so it can be the single source of truth shared by the
// sandboxed renderer bundle (esbuild/tsc) and the brittle-node unit suite.

/**
 * Folder name (last path segment) of an absolute path. Tolerant of trailing
 * separators and of both POSIX and Windows separators.
 * @param {string} p
 * @returns {string}
 */
export function basename(p) {
  if (!p || typeof p !== 'string') return ''
  const norm = p.replace(/[/\\]+$/, '')
  const idx = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'))
  return idx >= 0 ? norm.slice(idx + 1) : norm
}

/**
 * Mount path for a folder dropped onto the drop zone.
 *
 * `webUtils.getPathForFile(file)` returns the dropped folder's OWN absolute path,
 * so the mount path IS that path — we only trim trailing separators. We must NOT
 * strip the final segment: that would mount the parent directory and name the
 * share after it instead of the folder the user dropped.
 * @param {string} rawDropPath
 * @returns {string}
 */
export function mountPathFromDrop(rawDropPath) {
  if (!rawDropPath || typeof rawDropPath !== 'string') return ''
  return rawDropPath.replace(/[/\\]+$/, '')
}

/**
 * Split a path into a `head` (everything up to the last separator) and a `tail`
 * (the leading separator + final segment). Lets callers render paths so the
 * filename stays visible while the directory part truncates in the middle. A
 * bare filename (no separator) returns it all as `tail`.
 * @param {string} p
 * @returns {{ head: string, tail: string }}
 */
export function splitPathForDisplay(p) {
  if (!p || typeof p !== 'string') return { head: '', tail: '' }
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (idx < 0) return { head: '', tail: p }
  return { head: p.slice(0, idx), tail: p.slice(idx) }
}

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter() : null

/** @param {string} s */
function graphemes(s) {
  return segmenter ? Array.from(segmenter.segment(s), (g) => g.segment) : Array.from(s)
}

// A filename extension: a short final dot segment with no spaces after a non-empty stem. A dot
// earlier in a name (`Mr. Robot`, `2026.10 Masters`, `v1.5 Final Mix`) is just text.
const EXTENSION = /.\.[^.\s]{1,8}$/

/**
 * Middle-truncate a name to fit `maxWidth`, returning a single string like
 * `High.Plains.Dri…BluRay.mp4` — the beginning and at least half of what is shown
 * stay visible, with the ellipsis in the middle. The ending keeps a file's whole
 * extension when there is room for it. Cuts fall on whole characters (grapheme
 * clusters), never inside an emoji or between a letter and its accent. Rendered
 * as one text node, so it can never gap or overlap its neighbours.
 *
 * `measure(str)` returns the rendered pixel width of `str` (e.g. a canvas
 * `measureText`). A name that already fits is returned unchanged.
 *
 * @param {string} name
 * @param {number} maxWidth  target width in px
 * @param {(s: string) => number} measure  pixel width of a candidate string
 * @returns {string}
 */
export function middleTruncateToWidth(name, maxWidth, measure) {
  if (!name || typeof name !== 'string') return ''
  if (measure(name) <= maxWidth) return name
  const chars = graphemes(name)
  const ext = EXTENSION.test(name) ? graphemes(name.slice(name.lastIndexOf('.'))).length : 0
  return fitChars(chars, ext, maxWidth, measure) ?? (ext ? fitChars(chars, 0, maxWidth, measure) : null) ?? '…'
}

/**
 * The longest `head…tail` of `chars` that fits, with `tail` at least half of what is kept and
 * never shorter than `extLen`; null when even the shortest does not fit. Each extra kept
 * character widens the candidate, so the length is found by bisection.
 * @param {string[]} chars
 * @param {number} extLen
 * @param {number} maxWidth
 * @param {(s: string) => number} measure
 * @returns {string | null}
 */
function fitChars(chars, extLen, maxWidth, measure) {
  const n = chars.length
  /** @param {number} keep */
  const candidate = (keep) => {
    const tail = Math.min(n - 1, Math.max(Math.ceil(keep / 2), extLen))
    return chars.slice(0, keep - tail).join('') + '…' + chars.slice(n - tail).join('')
  }
  let lo = Math.max(2, extLen + 1)
  let hi = n - 1
  if (lo > hi || measure(candidate(lo)) > maxWidth) return null
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(candidate(mid)) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return candidate(lo)
}

// A legal share (folder) name: non-empty after trim, at most 255 chars, no path
// separators or reserved characters, and not '.' or '..'.
/** @param {string} name */
export function isValidShareName(name) {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > 255) return false
  if (/[\\/<>:"|?*\x00-\x1f]/.test(trimmed)) return false
  if (trimmed === '.' || trimmed === '..') return false
  return true
}
