import { splitPathForDisplay } from '../../sharePaths.js'

interface FilePathProps {
  path: string
  className?: string
}

// A filesystem path: monospace, full path in the tooltip, middle-truncated so the final segment
// stays visible (a bare filename ellipsizes at the end). The visible spans are `aria-hidden` and one
// `sr-only` node carries the whole path, so assistive tech reads one `dir/file.ext`. A final segment
// longer than LONG is itself middle-truncated: all but its last PIN characters join the flexible run.
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
  const long = tail.length > LONG
  const pinned = long ? tail.slice(-PIN) : tail
  // Exactly ONE flexible run: once the directory freezes at zero width Chromium does not push the
  // remaining deficit onto a span with a small shrink factor, so the pinned run is capped at the
  // container instead and nothing can overflow.
  return (
    <span className={`flex min-w-0 overflow-hidden font-mono ${className}`} title={path}>
      <span aria-hidden="true" className="truncate min-w-0">{long ? head + tail.slice(0, -PIN) : head}</span>
      <span aria-hidden="true" className="shrink-0 max-w-full overflow-hidden text-ellipsis whitespace-pre">{pinned}</span>
      <span className="sr-only">{path}</span>
    </span>
  )
}
