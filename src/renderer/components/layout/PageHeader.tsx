import type { ReactNode, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import IconButton from '../primitives/IconButton.js'

interface PageHeaderProps {
  title: string
  subtitle?: ReactNode
  onBack?: () => void
  headingRef?: RefObject<HTMLHeadingElement | null>
}

export default function PageHeader({ title, subtitle, onBack, headingRef }: PageHeaderProps) {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-4 mb-8">
      {onBack && (
        <IconButton
          icon="arrow_back"
          onClick={onBack}
          ariaLabel={t('actions.back')}
          className="mt-1 shrink-0"
        />
      )}
      <div>
        <h1
          ref={headingRef}
          tabIndex={headingRef ? -1 : undefined}
          className="text-4xl font-headline font-extrabold text-accent tracking-tight focus:outline-none"
        >
          {title}
        </h1>
        {subtitle && (
          <p className="text-on-surface-variant text-lg leading-relaxed">{subtitle}</p>
        )}
      </div>
    </div>
  )
}
