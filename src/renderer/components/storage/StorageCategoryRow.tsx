// One row of the App Storage list: what it is and what frees it, its size, and the action that frees
// it when there is one. The item is named "heading, size", so a screen reader hears each row once.
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { formatSize } from '../../format/utils.js'

interface StorageCategoryRowProps {
  heading: string
  desc: string
  bytes: number
  color?: string
  action?: ReactNode
}

export default function StorageCategoryRow({ heading, desc, bytes, color, action }: StorageCategoryRowProps) {
  const { t } = useTranslation()
  const size = formatSize(bytes)
  return (
    <li aria-label={t('storageSettings.rowLabel', { heading, size })} className="flex items-start justify-between gap-4">
      <div className="flex items-start gap-3 min-w-0">
        <span aria-hidden="true" className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${color ?? 'bg-transparent'}`} />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-on-surface-variant">{heading}</p>
          <p className="text-xs text-on-surface-variant">{desc}</p>
          {action && <div className="mt-1">{action}</div>}
        </div>
      </div>
      <p className="text-sm font-semibold text-on-surface-variant shrink-0 tabular-nums">{size}</p>
    </li>
  )
}
