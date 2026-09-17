// The grouped-row vocabulary the settings-style pages are built from: a tinted group, a leading
// icon tile, and a row that navigates. A row that leads somewhere is a button with the label as its
// accessible name; the tile and the chevron are decoration.
import type { ReactNode } from 'react'
import Icon from '../primitives/Icon.js'
import type { IconName } from '../../types/ui.js'

export const ROW_GROUP = 'bg-surface-container-low rounded-xl overflow-hidden'
export const ROW = 'w-full text-left p-6 flex items-center justify-between hover:bg-surface-container-high/50 active:scale-[0.99] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-secondary/30 cursor-pointer'

export function Tile({ icon }: { icon: IconName }) {
  return (
    <div className="w-10 h-10 rounded-full bg-icon-tile flex items-center justify-center text-on-icon-tile shrink-0">
      <Icon name={icon} />
    </div>
  )
}

interface RowBodyProps {
  leading: ReactNode
  title: string
  desc?: ReactNode
}

export function RowBody({ leading, title, desc }: RowBodyProps) {
  return (
    <div className="flex items-center gap-4 min-w-0">
      {leading}
      <div className="min-w-0">
        <p className="font-semibold text-accent">{title}</p>
        {desc && <p className="text-xs text-on-surface-variant">{desc}</p>}
      </div>
    </div>
  )
}

interface ActionRowProps {
  label: string
  desc?: ReactNode
  icon?: IconName
  leading?: ReactNode
  onClick: () => void
}

export default function ActionRow({ label, desc, icon, leading, onClick }: ActionRowProps) {
  return (
    <button type="button" onClick={onClick} aria-label={label} className={ROW}>
      <RowBody leading={leading ?? (icon ? <Tile icon={icon} /> : null)} title={label} desc={desc} />
      <Icon name="chevron_right" className="text-secondary shrink-0" />
    </button>
  )
}
