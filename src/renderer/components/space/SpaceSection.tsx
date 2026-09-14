import type { ReactNode } from 'react'

interface SpaceSectionProps {
  title: string
  /** The count beside the title, already pluralized by the caller's own i18n key. */
  count: string
  children: ReactNode
}

/**
 * One titled block in the space pane's scroll column.
 *
 * The header is `sticky top-0` against the pane, which is why the pane carries no `pt-*`: padding
 * there would pin the header that far below the scrollport edge. See SpaceScreen's pane comment.
 */
export default function SpaceSection({ title, count, children }: SpaceSectionProps) {
  return (
    <div>
      <div className="sticky top-0 z-10 bg-surface flex items-baseline gap-3 pt-1 pb-4">
        <h2 className="text-2xl font-headline font-bold text-accent">{title}</h2>
        <span className="text-sm font-label text-secondary font-bold">{count}</span>
      </div>
      <div className="grid grid-cols-1 gap-4">{children}</div>
    </div>
  )
}
