import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import IconButton from '../primitives/IconButton.js'

interface PageHeaderProps {
  title: string
  subtitle?: ReactNode
  onBack: () => void
}

export default function PageHeader({ title, subtitle, onBack }: PageHeaderProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-4 mb-8">
      <IconButton
        icon="arrow_back"
        onClick={onBack}
        ariaLabel={t('actions.back')}
        className="mt-1 shrink-0"
      />
      <div>
        <h1 className="text-4xl font-headline font-extrabold text-accent tracking-tight">{title}</h1>
        {subtitle && (
          <p className="text-on-surface-variant text-lg leading-relaxed">{subtitle}</p>
        )}
      </div>
    </div>
  )
}
