import { splitFilenameForDisplay } from '../../sharePaths.js'

interface FileNameProps {
  name: string
  displayName?: string
  className?: string
}

// Renders a filename with middle truncation that keeps the extension visible —
// the stem ellipsizes while the trailing `.ext` stays pinned, so a long name
// reads `report_fin….pdf` instead of losing its end. Mirrors FilePath's two-span
// flex trick (head truncates, tail is shrink-0). Names with no usable extension
// fall back to plain end truncation. Full name is in the title for hover + a11y.
//
// The two visible spans are `aria-hidden` and the full name is carried by a
// single `sr-only` node, so assistive tech (and the AX-tree-driven frontend
// suite) reads one contiguous `report_final.pdf` instead of the stem and
// extension as two separate text runs.
export default function FileName({ name, displayName, className = '' }: FileNameProps) {
  const shown = displayName ?? name
  const { head, tail } = splitFilenameForDisplay(shown)
  const srFull = displayName != null && displayName !== name ? name : null
  if (!tail) {
    return (
      <span className={`block truncate ${className}`} title={name}>
        {srFull ? (
          <>
            <span aria-hidden="true">{head || shown}</span>
            <span className="sr-only">{srFull}</span>
          </>
        ) : (
          head || shown
        )}
      </span>
    )
  }
  return (
    <span className={`flex min-w-0 ${className}`} title={name}>
      <span aria-hidden="true" className="truncate min-w-0">{head}</span>
      <span aria-hidden="true" className="shrink-0 whitespace-pre">{tail}</span>
      <span className="sr-only">{srFull ?? name}</span>
    </span>
  )
}
