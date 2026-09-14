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

/**
 * Split a filename into a `head` (stem) and a `tail` (extension, including the
 * dot) so it can be rendered with middle truncation: the stem ellipsizes while
 * the extension stays pinned and visible — the filename analogue of
 * `splitPathForDisplay`, which keeps the final path segment. A name with no
 * usable extension (no dot, a leading-dot dotfile like `.gitignore`, or a
 * trailing dot) returns the whole name as `head` so it end-truncates instead.
 * Multi-dot names pin only the final extension (`archive.tar.gz` → `.gz`).
 * @param {string} name
 * @returns {{ head: string, tail: string }}
 */
export function splitFilenameForDisplay(name) {
  if (!name || typeof name !== 'string') return { head: '', tail: '' }
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { head: name, tail: '' }
  return { head: name.slice(0, dot), tail: name.slice(dot) }
}

/**
 * Middle-truncate a filename to fit `maxWidth`, returning a single string like
 * `High.Plains.Dri…BluRay.mp4` — both the beginning and the end stay visible and
 * only the middle is replaced by an ellipsis. The trailing half always contains
 * the whole extension so the ending reads as a real filename ending, never a
 * stem fragment. Rendered as one text node (not two spans), so it can never gap
 * or overlap its neighbours the way a flex head/tail pair does.
 *
 * `measure(str)` returns the rendered pixel width of `str` (e.g. a canvas
 * `measureText`), which lets the caller account for the real, proportional font.
 * A name that already fits is returned unchanged (no ellipsis). Width is the only
 * budget — the caller decides how much room the name gets (e.g. a full line).
 *
 * @param {string} name
 * @param {number} maxWidth  target width in px
 * @param {(s: string) => number} measure  pixel width of a candidate string
 * @returns {string}
 */
export function middleTruncateToWidth(name, maxWidth, measure) {
  if (!name || typeof name !== 'string') return ''
  if (measure(name) <= maxWidth) return name
  const ell = '…'
  const dot = name.lastIndexOf('.')
  const extLen = dot > 0 && dot < name.length - 1 ? name.length - dot : 0
  // Try progressively fewer kept characters; the first (largest) candidate that
  // fits wins. The tail keeps at least half of what's shown, and never less than
  // the whole extension, so the ending is always a real filename ending.
  for (let keep = name.length - 1; keep >= 2; keep--) {
    const tail = Math.min(name.length - 1, Math.max(Math.ceil(keep / 2), extLen))
    const head = keep - tail
    if (head < 1 || head + tail > name.length) continue
    const cand = name.slice(0, head) + ell + name.slice(name.length - tail)
    if (measure(cand) <= maxWidth) return cand
  }
  return ell
}

// A legal share (folder) name: non-empty after trim, at most 255 chars, no path
// separators or reserved characters, and not '.' or '..'.
export function isValidShareName(name) {
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > 255) return false
  if (/[\\/<>:"|?*\x00-\x1f]/.test(trimmed)) return false
  if (trimmed === '.' || trimmed === '..') return false
  return true
}
