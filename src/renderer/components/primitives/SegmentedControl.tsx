// The pill row of `aria-pressed` buttons the settings screens and the Activity Log filter bar select
// with. `Segment` reserves its selected (semibold) width in every state, so only the highlight moves.
import type { ReactNode } from 'react'
import Icon, { type IconName } from './Icon.js'

interface SegmentedControlProps {
  children: ReactNode
  // A group that runs to several rows (the Activity Log's category filters) softens to
  // `rounded-3xl`: `rounded-full` on a two-row track reads as a lozenge, not a pill.
  wrap?: boolean
  className?: string
}

export default function SegmentedControl({ children, wrap, className }: SegmentedControlProps) {
  const shape = wrap ? 'flex-wrap gap-1 rounded-3xl w-fit' : 'rounded-full'
  return (
    <div className={`flex bg-surface-container-high dark:bg-surface-container-highest p-1 ${shape}${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  )
}

interface SegmentProps {
  label: string
  selected: boolean
  onSelect: () => void
  icon?: IconName
  // Only where the visible label is not the whole name — "1 MB/s" on its own does not say
  // which direction it caps.
  ariaLabel?: string
}

export function Segment({ label, selected, onSelect, icon, ariaLabel }: SegmentProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={ariaLabel}
      aria-pressed={selected}
      className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${
        selected
          ? 'bg-surface-container-lowest shadow-sm text-accent font-semibold'
          : 'text-on-surface-variant hover:text-accent font-medium'
      }`}
    >
      {icon && <Icon name={icon} size={14} />}
      {/* Both copies sit in the same grid cell, so the cell is as wide as the wider of the two —
          always the semibold ghost, whichever weight the visible label is in. The ghost is
          `invisible` rather than `hidden`: it still takes part in layout (that is the point) but
          `visibility: hidden` keeps it out of the accessibility tree, so the button's name stays
          the one visible label. */}
      <span className="grid justify-items-center">
        <span className="col-start-1 row-start-1">{label}</span>
        <span aria-hidden="true" className="col-start-1 row-start-1 invisible font-semibold">{label}</span>
      </span>
    </button>
  )
}
