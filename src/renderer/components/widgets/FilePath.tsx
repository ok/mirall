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
export default function FilePath({ path, className = '' }: FilePathProps) {
  const { head, tail } = splitPathForDisplay(path)
  if (!head) {
    return (
      <span className={`block truncate font-mono ${className}`} title={path}>
        {tail}
      </span>
    )
  }
  return (
    <span className={`flex min-w-0 font-mono ${className}`} title={path}>
      <span aria-hidden="true" className="truncate min-w-0">{head}</span>
      <span aria-hidden="true" className="shrink-0 whitespace-pre">{tail}</span>
      <span className="sr-only">{path}</span>
    </span>
  )
}
