// What a backup holds and what it does not, said the same way wherever the backup is offered.
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import type { IconName } from '../../types/ui.js'

const ROWS: Array<{ icon: IconName; lead: string; body: string }> = [
  { icon: 'check', lead: 'backup.scopeIncludedLead', body: 'backup.scopeIncluded' },
  { icon: 'info', lead: 'backup.scopeExcludedLead', body: 'backup.scopeExcluded' },
  { icon: 'lock', lead: 'backup.scopePrivateLead', body: 'backup.scopePrivate' },
]

export default function BackupScopeList() {
  const { t } = useTranslation()
  return (
    <ul className="space-y-3 text-sm text-on-surface-variant">
      {ROWS.map((row) => (
        <li key={row.lead} className="flex gap-3">
          <Icon name={row.icon} size={18} className="text-secondary shrink-0" />
          <span><strong className="text-on-surface">{t(row.lead)}</strong> {t(row.body)}</span>
        </li>
      ))}
    </ul>
  )
}
