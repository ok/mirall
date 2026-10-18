import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'

interface ManagedNoteProps {
  id: string
  org: string
  className?: string
}

// "Set by Acme GmbH": the reason a locked control gives, which it names in aria-describedby.
export default function ManagedNote({ id, org, className = 'px-6 pb-5' }: ManagedNoteProps) {
  const { t } = useTranslation()
  return (
    <p id={id} className={`flex items-center gap-2 text-sm font-semibold text-on-surface-variant ${className}`}>
      <Icon name="lock" size={16} className="text-secondary shrink-0" />
      {t('managed.setBy', { org })}
    </p>
  )
}
