import { splitPathForDisplay } from '../../sharePaths.js'

interface FilePathProps {
  path: string
  className?: string
}

// Renders a filesystem path consistently: monospace, full path in the tooltip,
// and middle truncation that keeps the filename visible — the directory part
// ellipsizes while the final segment is always shown. A bare filename simply
// ellipsizes at the end.
//
// The two visible spans are `aria-hidden` and the full path is carried by a
// single `sr-only` node, so assistive tech (and the AX-tree-driven frontend
// suite) reads one contiguous `dir/file.ext` instead of the directory and final
// segment as two separate text runs.
// A long final segment gets middle-truncated inside itself: everything but its last PIN
// characters joins the flexible run, so the ending that distinguishes it survives. LONG is the
// threshold — a segment at or under it is pinned whole, which is the ordinary case and renders
// exactly as it always did.
const PIN = 12
const LONG = 24

export default function FilePath({ path, className = '' }: FilePathProps) {
  const { head, tail } = splitPathForDisplay(path)
  if (!head) {
    return (
      <span className={`block truncate font-mono ${className}`} title={path}>
        {tail}
      </span>
    )
  }
  // The final segment can be longer than the box on its own — a folder named after a two-line
  // title, say — and a `shrink-0` tail then runs straight out of the field and over the button
  // beside it.
  const long = tail.length > LONG
  const pinned = long ? tail.slice(-PIN) : tail
  // Exactly ONE flexible run, always. Splitting the shrinking across two spans and ranking them by
  // flex-shrink does not work: once the directory freezes at zero width Chromium does not push the
  // remaining deficit onto a span with a small shrink factor, so the segment kept its full width
  // and ran straight out of the field. The pinned run is capped at the container instead, so
  // nothing can overflow even when it alone is wider than the box.
  return (
    <span className={`flex min-w-0 overflow-hidden font-mono ${className}`} title={path}>
      <span aria-hidden="true" className="truncate min-w-0">{long ? head + tail.slice(0, -PIN) : head}</span>
      <span aria-hidden="true" className="shrink-0 max-w-full overflow-hidden text-ellipsis whitespace-pre">{pinned}</span>
      <span className="sr-only">{path}</span>
    </span>
  )
}
