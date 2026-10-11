import { useRef } from 'react'
import useFittedName from '../../hooks/useFittedName.js'

interface FileNameProps {
  name: string
  displayName?: string
  className?: string
}

// A file or folder name, middle-truncated to its width so both the beginning and the ending stay
// readable: `report_fin…_v2_final.pdf`. The card it sits in carries the full name as its hover
// title. The visible text is `aria-hidden` and one `sr-only` node carries the full name, so
// assistive tech (and the AX-tree-driven frontend suite) never reads the `…`-truncated form.
export default function FileName({ name, displayName, className = '' }: FileNameProps) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const display = useFittedName(displayName ?? name, hostRef, textRef)
  return (
    <span ref={hostRef} className={`block truncate ${className}`}>
      <span ref={textRef} aria-hidden="true">{display}</span>
      <span className="sr-only">{name}</span>
    </span>
  )
}
