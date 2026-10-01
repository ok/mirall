// One safeguard on the Protection screen: its state in words, a tile whose colour repeats it, and the one
// action that helps, if any. A plain row, not a button: the action is the control.
import type { ReactNode } from 'react'
import type { IconName } from '../../types/ui.js'
import type { Health } from '../../model/protection-view.js'
import Icon from '../primitives/Icon.js'

const TILE: Record<Health, string> = {
  ok: 'bg-success text-on-success',
  attention: 'bg-warning-container text-on-warning-container',
  tip: 'bg-icon-tile text-on-icon-tile',
  off: 'bg-surface-container-high text-on-surface-variant',
}

interface StatusRowProps {
  icon: IconName
  health: Health
  label: string
  desc: string
  action?: ReactNode
}

export default function StatusRow({ icon, health, label, desc, action }: StatusRowProps) {
  return (
    <div className="p-6 flex items-center justify-between gap-4">
      <div className="flex items-center gap-4 min-w-0">
        <div className={`w-10 h-10 rounded-full ${TILE[health]} flex items-center justify-center shrink-0`}>
          <Icon name={icon} size={20} />
        </div>
        <div className="min-w-0">
          <p className="font-semibold text-accent">{label}</p>
          <p className="text-xs text-on-surface-variant">{desc}</p>
        </div>
      </div>
      {action}
    </div>
  )
}
