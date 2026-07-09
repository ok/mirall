import { useState, type ReactNode } from 'react'
import Icon, { type IconName } from './Icon.js'

interface CollapsibleCardProps {
  icon: IconName
  title: string
  count?: number
  defaultOpen?: boolean
  fill?: boolean
  children: ReactNode
}

export default function CollapsibleCard({
  icon,
  title,
  count,
  defaultOpen = true,
  fill = false,
  children,
}: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen)

  const root = fill && open
    ? 'bg-surface-container-low rounded-2xl p-8 flex flex-col min-h-0 overflow-hidden'
    : 'bg-surface-container-low rounded-2xl p-8 shrink-0'

  return (
    <div className={root}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="shrink-0 w-full flex items-center gap-2 text-left text-xl font-headline font-bold text-accent rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
      >
        <Icon name={icon} className="text-secondary" />
        <span>{title}</span>
        {count != null && <span className="text-sm font-label text-secondary font-bold">{count}</span>}
        <Icon
          name="chevron_right"
          className={`ml-auto text-outline transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div className={fill ? 'mt-6 min-h-0 flex flex-col' : 'mt-6'}>{children}</div>
      )}
    </div>
  )
}
