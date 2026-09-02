import { useState, type ReactNode } from 'react'
import Icon, { type IconName } from './Icon.js'

interface CollapsibleCardProps {
  icon: IconName
  title: string
  count?: number
  defaultOpen?: boolean
  // Controlled when `open` is passed: the card then renders what the caller owns and
  // reports every toggle through onOpenChange, so state that has to outlive the mount
  // (per-space card state) can live outside this primitive without it importing a store.
  open?: boolean
  onOpenChange?: (open: boolean) => void
  fill?: boolean
  children: ReactNode
}

export default function CollapsibleCard({
  icon,
  title,
  count,
  defaultOpen = true,
  open: controlledOpen,
  onOpenChange,
  fill = false,
  children,
}: CollapsibleCardProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const open = controlledOpen ?? uncontrolledOpen

  const toggle = () => {
    const next = !open
    if (controlledOpen === undefined) setUncontrolledOpen(next)
    onOpenChange?.(next)
  }

  const root = fill && open
    ? 'bg-surface-container-low rounded-2xl p-8 flex flex-col min-h-0 overflow-hidden'
    : 'bg-surface-container-low rounded-2xl p-8 shrink-0'

  return (
    <div className={root}>
      {/* Heading wrapping the disclosure button, not a bare button: the non-collapsible sidebar
          tiles (Folder, Space Storage) title themselves with a real <h3>, and a card that folds
          must not drop out of the heading order for doing so. Preflight zeroes the UA margin and
          font-size, so the wrapper is invisible to layout. */}
      <h3 className="shrink-0">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="w-full flex items-center gap-2 text-left text-xl font-headline font-bold text-accent rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
        >
          <Icon name={icon} className="text-secondary" />
          <span>{title}</span>
          {count != null && <span className="text-sm font-label text-secondary font-bold">{count}</span>}
          <Icon
            name="chevron_right"
            className={`ml-auto text-outline transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
          />
        </button>
      </h3>
      {open && (
        <div className={fill ? 'mt-6 min-h-0 flex flex-col' : 'mt-6'}>{children}</div>
      )}
    </div>
  )
}
