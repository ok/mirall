// Banner under the top nav shown when an update has been downloaded and will apply on next start.
import { useRef } from 'react'
import { useBannerHeight } from '../../hooks/useBannerHeight.js'
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'

interface UpdateBannerProps {
  version: string | null
  onDismiss: () => void
}

export default function UpdateBanner({ version, onDismiss }: UpdateBannerProps) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)

  useBannerHeight(ref, version !== null)

  if (!version) return null

  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      className="bg-secondary-container px-8 py-2 flex items-center justify-between"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <div className="flex items-center gap-2">
        <Icon name="update" size={16} className="text-on-secondary-container" />
        <span className="text-sm font-semibold text-on-secondary-container">
          {t('updateBanner.available', { version })}
          <span className="ml-2 opacity-80">— {t('updateBanner.appliedOnNextStart')}</span>
        </span>
      </div>
      <button
        onClick={onDismiss}
        className="bg-secondary text-on-secondary text-xs font-bold px-3 py-1 rounded shadow-lg hover:opacity-90 active:scale-95 transition-all focus-ring"
      >
        {t('updateBanner.dismiss')}
      </button>
    </div>
  )
}
