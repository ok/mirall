import { useRef } from 'react'
import useFittedName from '../../hooks/useFittedName.js'

interface FileNameProps {
  name: string
  displayName?: string
  className?: string
}

// A file or folder name, middle-truncated to its width so both the beginning and the ending stay
// readable: `report_fin…_v2_final.pdf`. The full name is its hover title; a card that wants the
// tooltip over more than the name line carries the same title on a wider `role="none"` block.
// The visible text is `aria-hidden` and one `sr-only` node carries the full name, so assistive
// tech (and the AX-tree-driven frontend suite) never reads the `…`-truncated form.
//
// The invisible full-length sizer keeps the name's intrinsic width that of the whole name: flex
// shrinks siblings in proportion to that width, so if it followed the truncated text every cut
// would hand room to the row's lane and trigger another cut.
export default function FileName({ name, displayName, className = '' }: FileNameProps) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const shown = displayName ?? name
  const display = useFittedName(shown, hostRef)
  return (
    <span ref={hostRef} role="none" title={name} className={`block truncate ${className}`}>
      <span aria-hidden="true">{display}</span>
      <span aria-hidden="true" className="block h-0 invisible">{shown}</span>
      <span className="sr-only">{name}</span>
    </span>
  )
}
