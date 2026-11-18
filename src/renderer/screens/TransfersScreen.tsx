// Every transfer on this device, across all spaces.
import { useTranslation } from 'react-i18next'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import PageHeader from '../components/layout/PageHeader.js'

interface TransfersScreenProps {
  onBack: () => void
}

export default function TransfersScreen({ onBack }: TransfersScreenProps) {
  const { t } = useTranslation()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-(--breakpoint-2xl) mx-auto">
        <PageHeader title={t('transfers.title')} subtitle={t('transfers.intro')} onBack={onBack} />
        <div className="text-center pt-24">
          <h2 className="text-xl font-headline font-bold text-accent">{t('transfers.emptyTitle')}</h2>
          <p className="text-sm text-on-surface-variant mt-2">{t('transfers.emptyBody')}</p>
        </div>
      </div>
    </div>
  )
}
